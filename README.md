# commerce-sys — 经营管理平台（BMP）服务后端

面向经营部门的经营管理平台一期：**商品管理 / 上下架 / 调价 / 经营审计**，替代直接操作数据库。

- 技术栈：Node.js 20+ / Express 4 / mysql2 / zod（参数校验）
- 数据库：MySQL 8（`sql/001_init.sql`，4 库：bmp_common / bmp_goods / bmp_price / bmp_audit）
- API 契约：`api/openapi.yaml`（OpenAPI 3.1）
- 测试：`node --test test/`（内存 MySQL 兼容层直测真实仓储/服务代码）

## 快速开始

```bash
npm install
mysql -uroot -p < sql/001_init.sql    # 初始化库表与类型注册数据
DB_HOST=127.0.0.1 DB_USER=bmp DB_PASSWORD=*** DB_NAME=bmp_goods npm start
# 或 docker compose up -d --build
```

## 模块结构（模块化单体：模块间仅经接口/事件通信）

```
src/
├── common/      横切支撑：统一错误码 / 异常中间件 / 雪花ID / 分页 / 响应包
├── goods/       商品模块：CRUD + 状态机 + 定时上下架计划
├── price/       价格模块：立即/定时调价 + 价格履历
├── audit/       审计模块：事件总线消费 + 统一审计查询
├── scheduler.js 定时调度器：轮询到期计划，回调模块幂等 apply 方法
└── app.js       组装根（Composition Root）：唯一知道所有模块的地方
```

## 商品状态机

```
D(草稿) --上架--> A(在售) --下架--> S(停售) --重新上架--> A
   |                                    |
   +----定时上架----> P(上架中) <----定时上架----+
                        |到期生效/取消回退
```

## 关键设计决策

1. **金额一律分（整数 BIGINT）**：杜绝浮点误差；`unit`（面额）除外（DECIMAL）。
2. **乐观锁**：`goods.version`，编辑冲突返回 `409 STATE_CONFLICT`。
3. **计划幂等生效**：定时计划/价格方案 `W→S/A` 条件更新，Scheduler 重复执行无副作用。
4. **审计旁路**：审计失败不阻断业务（先记后补），经事件总线解耦。
5. **类型注册制**：新商品类型 = `bmp_common.goods_type` 插一行，代码不改。
6. **受控写通道**：`goods.sale_price` 仅价格模块经 `goodsWriter.applySalePrice` 可写。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| DB_HOST / DB_PORT | 127.0.0.1 / 3306 | MySQL 地址 |
| DB_USER / DB_PASSWORD | bmp / 空 | 账号（建议只授 bmp_* 四库权限） |
| DB_NAME | bmp_goods | 主库（连接池绑定库） |
| PORT | 3000 | HTTP 端口 |

架构与安全/性能设计细节见 `docs/architecture.md`。
