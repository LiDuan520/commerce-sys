# 交易系统技术方案（二期 / FREE-4 交易链路）

> 前置：一期经营管理平台已交付（商品/上下架/调价/审计，commit bd63876）。本方案在其之上补齐**用户侧交易能力**：浏览 → 下单 → 支付 → 权益到账，形成「经营（FREE-2/3）+ 交易（FREE-4）」闭环。
> 仓库现状：远端 main 已含一期代码（bd63876，已核实推送成功）。

## 1. 技术选型（建议）

**延续一期：Node.js 20 / Express 4 / mysql2 / zod / MySQL 8**。理由：
- 同栈复用一期基础设施（错误码/审计总线/雪花ID/统一响应/部署管线），零新增运维面；
- 交易链路是 IO 密集型（DB + 支付渠道 HTTP），Node 事件循环模型匹配，无计算瓶颈；
- 队长无既定偏好时，避免引入第二技术栈的集成/招聘成本。

支付渠道抽象为 `PaymentChannel` 接口，一期落地** Mock 渠道**（沙箱语义：验签规则同真实渠道），接微信/支付宝时仅新增适配器（见 §7 扩展点）。

## 2. 模块划分（原子化 + 解耦）

```
src/
├── trade/          交易模块（本方案核心）
│   ├── order/      订单域：下单/取消/超时关单/状态机
│   ├── pay/        支付域：渠道接口/回调验签/幂等
│   └── fulfill/    权益域：机器人/NT 发放 + 补偿重试
├── goods/ price/ audit/ common/   （一期已有，交易只读引用商品快照）
└── app.js          组装根：新增 trade 路由与 TradeScheduler
```

**模块边界铁律**：
- trade 只通过 goods 模块公开的**只读查询接口**取「下单时点」的商品快照（名称/价格/状态），**禁止跨模块 JOIN goods 表** —— 价格后续调价不影响已下订单；
- 权益发放经 `fulfill` 域的 `EntitlementService`（对 Workspace 主系统的发放动作抽象为接口，一期 Mock 落库，后续接真实账户服务）；
- 全链路审计继续走 `AuditBus`。

## 3. 数据库设计（bmp_trade 库）

```sql
-- 订单主表：状态机唯一写入点
CREATE TABLE trade_order (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    order_id      CHAR(32)  NOT NULL COMMENT '业务单号（雪花），对外唯一标识',
    user_id       CHAR(32)  NOT NULL COMMENT '买家（一期外部账号ID透传）',
    goods_id      CHAR(32)  NOT NULL COMMENT '商品快照来源',
    goods_name    VARCHAR(128) NOT NULL COMMENT '下单时商品名快照（防调价/改名后歧义）',
    goods_type    VARCHAR(32)  NOT NULL COMMENT 'ROBOT / NT',
    unit_price    BIGINT UNSIGNED NOT NULL COMMENT '成交单价（分，下单时快照）',
    quantity      INT UNSIGNED NOT NULL COMMENT '数量（≥1）',
    total_amount  BIGINT UNSIGNED NOT NULL COMMENT '总额 = unit_price * quantity（分）',
    status        CHAR(1)   NOT NULL DEFAULT 'W' COMMENT 'W=待支付 P=已支付 C=已取消 X=已关闭(超时) R=退款中 D=已退款',
    pay_deadline  DATETIME  NOT NULL COMMENT '支付截止（下单+30min，超时关单）',
    version       BIGINT    NOT NULL DEFAULT 0 COMMENT '乐观锁',
    created_at    DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_order_id (order_id),
    KEY idx_user_status (user_id, status),
    KEY idx_status_deadline (status, pay_deadline)   -- 关单扫描索引
) ENGINE=InnoDB COMMENT='交易订单';

-- 支付单表：一笔订单可能多渠道多尝试；回调按 pay_id 幂等
CREATE TABLE trade_pay (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    pay_id        CHAR(32)  NOT NULL COMMENT '支付单号（雪花）',
    order_id      CHAR(32)  NOT NULL COMMENT '关联业务单号',
    channel       VARCHAR(16) NOT NULL COMMENT 'MOCK / WXPAY / ALIPAY（渠道编码）',
    channel_trade_no VARCHAR(64) DEFAULT NULL COMMENT '渠道方交易号（回调回填）',
    amount        BIGINT UNSIGNED NOT NULL COMMENT '应付金额（分）= 订单总额',
    status        CHAR(1)   NOT NULL DEFAULT 'I' COMMENT 'I=已发起 S=支付成功 F=支付失败',
    paid_at       DATETIME  DEFAULT NULL,
    created_at    DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_pay_id (pay_id),
    UNIQUE KEY uk_channel_tradeno (channel, channel_trade_no) COMMENT '渠道号防重放（空值不冲突）',
    KEY idx_order (order_id)
) ENGINE=InnoDB COMMENT='支付单';

-- 权益发放表：支付成功的异步动作，失败补偿重试
CREATE TABLE trade_entitlement (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    entitlement_id CHAR(32) NOT NULL COMMENT '发放流水号（雪花）',
    order_id      CHAR(32)  NOT NULL,
    goods_id      CHAR(32)  NOT NULL,
    goods_type    VARCHAR(32) NOT NULL,
    user_id       CHAR(32)  NOT NULL,
    quantity      INT UNSIGNED NOT NULL,
    status        CHAR(1)  NOT NULL DEFAULT 'P' COMMENT 'P=待发放 S=已发放 F=失败(待重试)',
    retry_count   INT UNSIGNED NOT NULL DEFAULT 0,
    last_error    VARCHAR(512) DEFAULT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_entitlement_id (entitlement_id),
    UNIQUE KEY uk_order (order_id) COMMENT '一单一权益：天然幂等',
    KEY idx_status (status, retry_count)
) ENGINE=InnoDB COMMENT='权益发放流水';

-- 交易事件流水（对账底座）：状态每次迁移追加一行
CREATE TABLE trade_event (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    order_id      CHAR(32) NOT NULL,
    event_type    VARCHAR(32) NOT NULL COMMENT 'CREATE/PAY_SUCCESS/PAY_FAIL/CANCEL/CLOSE/REFUND_APPLY/REFUND_DONE/ENTITLE_FAIL',
    payload       JSON NOT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_order (order_id),
    KEY idx_type_time (event_type, created_at)
) ENGINE=InnoDB COMMENT='交易事件流水（审计/对账）';
```

**设计理由**：订单与支付分离（一订单多支付尝试）；商品快照冗余进订单（解耦商品域后续变更）；`uk_order` 唯一键让权益发放天然幂等；事件流水表是对账与审计的数据底座。

## 4. 接口契约（REST /api/v1/trade）

| 方法 | 路径 | 说明 | 出参/错误码 |
|---|---|---|---|
| POST | /trade/orders | 下单（goodsId, quantity, userId） | 201 订单（含支付参数）；`GOODS_NOT_SELLING` `STOCK_NOT_ENOUGH` `PARAM_INVALID` |
| GET  | /trade/orders/:orderId | 订单详情（含支付/权益状态） | `NOT_FOUND` |
| GET  | /trade/orders?userId=&status= | 用户订单列表（分页） | 分页包 |
| POST | /trade/orders/:orderId/cancel | 用户取消（仅 W 态） | `STATE_CONFLICT` |
| POST | /trade/orders/:orderId/pay | 发起支付（channel） | 支付参数（Mock: payId+签名串） |
| POST | /trade/pay/callback/:channel | 渠道回调（验签+幂等） | 200 空体（渠道要求）；失败 4xx 文本 |
| POST | /trade/admin/refund | 经营侧退款（orderId, reason, operator） | `STATE_CONFLICT`（仅 P 态可退） |

**状态机**：`W --支付成功--> P --退款申请--> R --退款完成--> D`；`W --用户取消--> C`；`W --超时--> X`。非法迁移一律 `409 STATE_CONFLICT`。

## 5. 异常与安全防御

1. **下单防超卖**：`UPDATE goods SET stock = stock - ? WHERE goods_id=? AND status='A' AND stock >= ?` 单语句原子扣减，affectedRows=0 → `STOCK_NOT_ENOUGH`；下单失败（后续步骤异常）在同一事务回滚。库存 -1（无限）跳过扣减。
2. **回调防重放/防伪造**：
   - 验签：`PaymentChannel.verify()`（Mock 渠道 = HMAC-SHA256(payId+amount+ts, channelSecret)，密钥仅存服务端环境变量）；
   - 幂等：按 `pay_id` 条件更新 `I→S`，重复回调 affectedRows=0 直接返回成功（渠道要求重复回调也 200）；
   - 渠道号唯一键 `uk_channel_tradeno` 兜底防伪造重放。
3. **金额校验**：回调金额 ≠ 订单应付金额 → 记 PAY_FAIL 事件、返回 4xx，**不推进状态机**（防篡改攻击）。
4. **超时关单**：TradeScheduler 每 30s 扫 `W AND pay_deadline < now`，批量关单 `W→X` 并回补库存（原子 `stock + ?`）。
5. **退款**：仅 P 态可申请；退款完成才落 D；NT 类资金商品退款走权益回收（发放表状态联动）。
6. **全链路审计**：下单/支付/关单/退款均发 AuditBus 事件（operator=用户ID或SYSTEM）。

## 6. 性能与扩展性

- **性能**：读路径订单详情单表命中（快照冗余）；列表走 `idx_user_status`；关单批量扫描走 `idx_status_deadline`；回调处理 O(1) 条件更新，无长事务。支付回调与权益发放解耦（成功即记账，发放异步补偿），回调响应恒为快速 200。
- **扩展点**：
  - 新支付渠道 = 实现 `PaymentChannel` 接口 + 注册工厂，零侵入核心链路；
  - 优惠活动（后置）= 下单金额计算前插入 `PromotionStrategy`，表结构预留 `discount_amount` 列即可；
  - 权益发放对接真实账户系统 = 替换 `EntitlementService` 实现；
  - 对账 = trade_event 流水已完备，二期加定时比对任务即可。

## 7. 一期（交易）里程碑拆解

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | DDL + 订单域（下单/取消/关单状态机） | 下单防超卖集成测试绿 |
| M2 | 支付域（Mock 渠道 + 回调验签幂等） | 回调重放/篡改用例绿 |
| M3 | 权益发放 + 补偿 + 事件流水 | 到账/重试/幂等用例绿 |
| M4 | 退款 + 经营侧查单 + 联调 | 全链路 5 用例（UC1-UC5）绿 |
