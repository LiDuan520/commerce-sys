-- =====================================================================
-- 经营管理平台（commerce-sys）一期 DDL — MySQL 8.0
-- 金额一律使用分（BIGINT）存储，杜绝浮点误差；CHAR(1) 状态位 + CHECK 约束
-- 模块边界：本文件仅含公共库与商品域表；价格域、审计域表在各自模块
--           schema 文件中维护（模块间严禁直接跨库操作对方表，见 docs/architecture.md）
-- =====================================================================

-- ---------------------------------------------------------------
-- 公共库 bmp_common：商品类型注册表（扩展点，见 docs/architecture.md §扩展性）
-- ---------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS bmp_common
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

USE bmp_common;

-- 商品类型注册表：新增 Robot / NT 之外的类型 = 插一行注册数据，不改代码
CREATE TABLE goods_type (
    id          BIGINT UNSIGNED    NOT NULL AUTO_INCREMENT,
    type_code   VARCHAR(32)        NOT NULL COMMENT '类型编码，如 ROBOT / NT，全局唯一',
    type_name   VARCHAR(64)        NOT NULL COMMENT '类型名称，如 机器人 / NpcToken',
    status      CHAR(1)            NOT NULL DEFAULT 'A' COMMENT 'A=启用 D=停用',
    remark      VARCHAR(255)       DEFAULT NULL,
    created_at  DATETIME           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME           NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_type_code (type_code),
    KEY idx_status (status)
) ENGINE = InnoDB COMMENT = '商品类型注册表（扩展点）';

-- 初始类型注册数据（一期两类）
INSERT INTO goods_type (type_code, type_name, status, remark) VALUES
    ('ROBOT', '机器人', 'A', '服务类商品：机器人'),
    ('NT',    'NpcToken', 'A', '代币类商品：NT');

-- ---------------------------------------------------------------
-- 商品库 bmp_goods：商品表 + 操作计划表（定时上下架/定时调价统一抽象）
-- ---------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS bmp_goods
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

USE bmp_goods;

-- 商品主表：经营域核心实体。status 仅由 GoodsStateMachine 驱动变更
CREATE TABLE goods (
    id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
    goods_id      CHAR(32)         NOT NULL COMMENT '业务主键（雪花ID），对外暴露，避免泄漏自增序号',
    type_code     VARCHAR(32)      NOT NULL COMMENT '商品类型编码，关联 bmp_common.goods_type',
    sku           VARCHAR(64)      NOT NULL COMMENT '库存单位编码，同类型内唯一',
    name          VARCHAR(128)     NOT NULL COMMENT '商品名称',
    -- NT 类资金属性商品必填校验在应用层；精度语义见 docs/architecture.md §数据模型
    unit          DECIMAL(18, 6)   DEFAULT NULL COMMENT '代币面额/机器人配额等类型相关数值属性',
    sale_price    BIGINT UNSIGNED  NOT NULL DEFAULT 0 COMMENT '当前售价（分）；仅 PriceService 可写',
    market_price  BIGINT UNSIGNED  DEFAULT NULL COMMENT '划线价（分），仅展示用',
    stock         BIGINT           NOT NULL DEFAULT 0 COMMENT '库存（-1=无限库存）',
    status        CHAR(1)          NOT NULL DEFAULT 'D' COMMENT 'D=草稿 A=在售 S=停售(下架) P=上架中(定时待生效)',
    effective_time DATETIME        DEFAULT NULL COMMENT '定时上下架计划的生效时间（P 态挂起计划）',
    version       BIGINT           NOT NULL DEFAULT 0 COMMENT '乐观锁版本号',
    created_at    DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_goods_id (goods_id),
    UNIQUE KEY uk_type_sku (type_code, sku),
    KEY idx_type_status (type_code, status),
    KEY idx_status_updated (status, updated_at),
    KEY idx_effective_time (effective_time)
) ENGINE = InnoDB COMMENT = '商品主表';

-- 操作计划表：定时上下架、定时调价的统一抽象（policy_kind 区分），失败重试不丢任务
CREATE TABLE goods_schedule (
    id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
    biz_id        CHAR(32)         NOT NULL COMMENT '业务ID（雪花）：定时上架/下架=goods_id，定时调价=price_plan_id',
    policy_kind   VARCHAR(16)      NOT NULL COMMENT 'SHELF：定时上下架 PRICE：定时调价',
    -- SHELF: DRAFT_TO_ON / OFF_SHELF / ON_AGAIN；PRICE: APPLY_PRICE
    action_code   VARCHAR(32)      NOT NULL COMMENT '计划动作编码（见 api/openapi.yaml 枚举）',
    payload       JSON             NOT NULL COMMENT '动作参数（如目标状态、目标价格），应用层 schema 校验',
    status        CHAR(1)          NOT NULL DEFAULT 'W' COMMENT 'W=待生效 S=已生效 F=失败 C=已取消',
    effective_time DATETIME        NOT NULL COMMENT '计划生效时间',
    fail_reason   VARCHAR(512)     DEFAULT NULL COMMENT '失败原因（排障用，不回滚已提交事务）',
    version       BIGINT           NOT NULL DEFAULT 0 COMMENT '乐观锁版本号（取消计划防并发）',
    created_at    DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_biz_kind_status (biz_id, policy_kind, status),
    KEY idx_status_effective (status, effective_time)
) ENGINE = InnoDB COMMENT = '商品经营操作计划表（定时上下架/定时调价）';

-- ---------------------------------------------------------------
-- 价格库 bmp_price：价格方案表（生效价存储在 goods.sale_price，由 PriceService 写入）
-- ---------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS bmp_price
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

USE bmp_price;

-- 价格方案表：每次调价（立即/定时）生成一条记录，构成价格履历；当前生效=生效时间
-- 最新且 status=ACTIVE 的那条，goods.sale_price 冗余该值用于高频读
CREATE TABLE price_plan (
    id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    price_plan_id  CHAR(32)        NOT NULL COMMENT '业务主键（雪花ID）',
    goods_id       CHAR(32)        NOT NULL COMMENT '商品业务ID，冗余存储避免跨库 JOIN',
    price          BIGINT UNSIGNED NOT NULL COMMENT '价格（分）',
    effective_time DATETIME        NOT NULL COMMENT '生效时间（立即调价=创建时刻）',
    status         CHAR(1)         NOT NULL DEFAULT 'W' COMMENT 'W=待生效 A=已生效 C=已取消 F=已失败',
    operator       VARCHAR(64)     NOT NULL COMMENT '操作人（审计用，权限模型后置）',
    remark         VARCHAR(255)    DEFAULT NULL,
    created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_price_plan_id (price_plan_id),
    KEY idx_goods_status_time (goods_id, status, effective_time),
    KEY idx_effective_time (status, effective_time)
) ENGINE = InnoDB COMMENT = '价格方案表（价格履历）';

-- ---------------------------------------------------------------
-- 审计库 bmp_audit：经营操作统一审计
-- ---------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS bmp_audit
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

USE bmp_audit;

-- 经营操作审计表：所有经营变更（建品/改品/上下架/调价/取消计划）统一落审计
CREATE TABLE audit_log (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    biz_id        CHAR(32)        NOT NULL COMMENT '变更对象业务ID（goods_id / price_plan_id / schedule_id）',
    biz_type      VARCHAR(32)     NOT NULL COMMENT '对象类型：GOODS / PRICE_PLAN / SCHEDULE',
    action        VARCHAR(64)     NOT NULL COMMENT '操作动作：CREATE / UPDATE / LISTING / DELISTING / CANCEL_PLAN',
    before_value  JSON            DEFAULT NULL COMMENT '变更前快照',
    after_value   JSON            DEFAULT NULL COMMENT '变更后快照',
    operator      VARCHAR(64)     NOT NULL COMMENT '操作人',
    trace_id      VARCHAR(64)     DEFAULT NULL COMMENT '链路追踪ID（跨模块排障）',
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_biz (biz_type, biz_id, created_at),
    KEY idx_operator_time (operator, created_at)
) ENGINE = InnoDB COMMENT = '经营操作统一审计表';
