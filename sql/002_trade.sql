-- =====================================================================
-- 交易模块 DDL（二期）— bmp_trade 库
-- 前置：sql/001_init.sql（一期四库）
-- 金额一律分（BIGINT）；订单冗余商品快照，禁止跨库 JOIN goods
-- =====================================================================

CREATE DATABASE IF NOT EXISTS bmp_trade
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

USE bmp_trade;

-- 订单主表：状态机唯一写入点 W/P/C/X/R/D
CREATE TABLE trade_order (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    order_id      CHAR(32)  NOT NULL COMMENT '业务单号（雪花），对外唯一标识',
    user_id       CHAR(32)  NOT NULL COMMENT '买家（一期外部账号ID透传）',
    goods_id      CHAR(32)  NOT NULL COMMENT '商品快照来源',
    goods_name    VARCHAR(128) NOT NULL COMMENT '下单时商品名快照',
    goods_type    VARCHAR(32)  NOT NULL COMMENT 'ROBOT / NT',
    unit_price    BIGINT UNSIGNED NOT NULL COMMENT '成交单价（分，下单时快照）',
    quantity      INT UNSIGNED NOT NULL COMMENT '数量（≥1）',
    total_amount  BIGINT UNSIGNED NOT NULL COMMENT '总额 = unit_price * quantity（分）',
    status        CHAR(1)   NOT NULL DEFAULT 'W' COMMENT 'W=待支付 P=已支付 C=已取消 X=已关闭(超时) R=退款中 D=已退款',
    pay_deadline  DATETIME  NOT NULL COMMENT '支付截止（下单+30min）',
    version       BIGINT    NOT NULL DEFAULT 0 COMMENT '乐观锁',
    created_at    DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_order_id (order_id),
    KEY idx_user_status (user_id, status),
    KEY idx_status_deadline (status, pay_deadline)
) ENGINE=InnoDB COMMENT='交易订单';

-- 支付单表：回调按 pay_id 幂等；渠道号唯一键防伪造重放
CREATE TABLE trade_pay (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    pay_id        CHAR(32)  NOT NULL COMMENT '支付单号（雪花）',
    order_id      CHAR(32)  NOT NULL COMMENT '关联业务单号',
    channel       VARCHAR(16) NOT NULL COMMENT 'MOCK / WXPAY / ALIPAY',
    channel_trade_no VARCHAR(64) DEFAULT NULL COMMENT '渠道方交易号（回调回填）',
    amount        BIGINT UNSIGNED NOT NULL COMMENT '应付金额（分）',
    status        CHAR(1)   NOT NULL DEFAULT 'I' COMMENT 'I=已发起 S=支付成功 F=支付失败',
    paid_at       DATETIME  DEFAULT NULL,
    created_at    DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_pay_id (pay_id),
    UNIQUE KEY uk_channel_tradeno (channel, channel_trade_no),
    KEY idx_order (order_id)
) ENGINE=InnoDB COMMENT='支付单';

-- 权益发放表：uk_order 唯一键 → 天然幂等；失败补偿重试
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
    UNIQUE KEY uk_order (order_id),
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
