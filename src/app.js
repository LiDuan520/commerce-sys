'use strict';
// =====================================================================
// 应用组装（Composition Root）—— 唯一知道「所有模块」的地方
// 依赖注入在此完成；模块之间互相只见接口/门面，实现可替换（可扩展铁律）
// =====================================================================
const express = require('express');
const mysql = require('mysql2/promise');
const { notFoundHandler, errorHandler } = require('./common/error-handler');
const { GoodsService, buildRouter: goodsRouter } = require('./goods');
const { PriceService, buildRouter: priceRouter } = require('./price');
const { AuditService, InProcessAuditBus, buildRouter: auditRouter } = require('./audit');
const { OrderService, buildRouter: tradeOrderRouter } = require('./trade/order');
const { PayService, MockChannel, buildRouter: tradePayRouter } = require('./trade/pay');
const { FulfillService, MockEntitlementAdapter } = require('./trade/fulfill');
const { TradeScheduler } = require('./trade/scheduler');

function buildApp({ db, auditBus, schedulerEnabled = true, schedulerIntervalMs = 5000, onStarted }) {
  const app = express();
  app.use(express.json({ limit: '256kb' })); // 请求体上限：防大包攻击

  // ---- 模块实例化与依赖注入 ----
  const auditService = new AuditService(db);
  const bus = auditBus || new InProcessAuditBus(auditService);

  // 商品类型注册表（扩展点：读 bmp_common.goods_type；DB 未初始化时走静态兜底便于测试）
  const goodsTypeRegistry = createGoodsTypeRegistry(db);

  // 价格模块：注入受控 goodsWriter（唯一写 goods.sale_price 的通道）
  const goodsWriter = createGoodsWriter(db);
  const priceService = new PriceService(db, goodsWriter, bus);

  // 商品模块：注入价格门面（建品初始价）+ 类型注册表
  const priceFacade = {
    initPrice: (goodsId, price, operator, traceId) => priceService.initPrice(goodsId, price, operator, traceId),
  };
  const goodsService = new GoodsService(db, bus, priceFacade, goodsTypeRegistry);

  // ---- 交易模块（二期）----
  // goodsReader：交易域对商品域的唯一依赖（只读快照 + 原子扣减/回补，受控通道）
  const goodsReader = createGoodsReader(db, goodsService);
  const orderService = new OrderService(db, goodsReader, bus);
  const fulfillService = new FulfillService(db, new MockEntitlementAdapter(), bus);
  const channels = { MOCK: new MockChannel(process.env.MOCK_CHANNEL_SECRET) };
  const payService = new PayService(db, orderService, fulfillService, channels, bus);

  // ---- 路由组装（RESTful 契约见 api/openapi.yaml） ----
  app.use('/api/v1/goods', goodsRouter(goodsService));
  app.use('/api/v1/goods/:goodsId/price', priceRouter(priceService));
  app.use('/api/v1/audits', auditRouter(auditService));
  // 交易路由（订单 + 支付回调）
  app.use('/api/v1/trade', tradeOrderRouter(orderService));
  app.use('/api/v1/trade', tradePayRouter(payService));
  app.get('/healthz', (_req, res) => res.json({ status: 'UP' }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  // ---- 定时调度器 ----
  let scheduler = null;
  let tradeScheduler = null;
  if (schedulerEnabled) {
    scheduler = new Scheduler({
      goodsSvc: goodsService, priceSvc: priceService,
      scheduleRepo: goodsService.schedules, intervalMs: schedulerIntervalMs,
    }).start();
    // 交易调度：超时关单 + 权益补偿（周期独立，30s 量级）
    tradeScheduler = new TradeScheduler({ orderSvc: orderService, fulfillSvc: fulfillService }).start();
    app.locals.scheduler = scheduler;
    app.locals.tradeScheduler = tradeScheduler;
  }
  if (onStarted) onStarted({ goodsService, priceService, auditService, scheduler, orderService, payService, fulfillService, tradeScheduler });
  return app;
}

// ---- 受控写通道：价格模块写 goods.sale_price 的唯一合法路径 ----
function createGoodsWriter(db) {
  return {
    /** @param conn 可选事务连接；为 null 时用池直连（schedule 生效场景） */
    async applySalePrice(conn, goodsId, price) {
      const executor = conn || db;
      const [res] = await executor.query(
        `UPDATE goods SET sale_price=?, version=version+1 WHERE goods_id=?`,
        [price, goodsId]);
      if (res.affectedRows !== 1) {
        const { err } = require('./common');
        throw err.notFound(`商品不存在: ${goodsId}`);
      }
    },
  };
}

// ---- 交易域对商品域的只读接口（快照 + 原子库存扣减/回补） ----
function createGoodsReader(db, goodsSvc) {
  return {
    /** 下单快照：直接复用商品模块查询（只读） */
    async getSnapshot(goodsId) {
      return goodsSvc.getGoods(goodsId);
    },
    /** 防超卖原子扣减：单语句条件更新，0 行 → 库存不足/不在售 */
    async deductStock(goodsId, quantity) {
      const [res] = await db.query(
        `UPDATE goods SET stock = stock - ? WHERE goods_id=? AND status='A' AND stock >= ?`,
        [quantity, goodsId, quantity]);
      return res.affectedRows === 1;
    },
    /** 取消/关单回补库存 */
    async restoreStock(goodsId, quantity) {
      await db.query(`UPDATE goods SET stock = stock + ? WHERE goods_id=?`, [quantity, goodsId]);
    },
  };
}

// ---- 商品类型注册表：读 bmp_common.goods_type；查询失败时静态兜底 ----
function createGoodsTypeRegistry(db) {
  const fallback = new Map([['ROBOT', { typeCode: 'ROBOT', status: 'A' }], ['NT', { typeCode: 'NT', status: 'A' }]]);
  return {
    async get(typeCode) {
      try {
        const [rows] = await db.query('SELECT type_code, status FROM goods_type WHERE type_code=?', [typeCode]);
        if (rows.length) return { typeCode: rows[0].type_code, status: rows[0].status };
        return fallback.get(typeCode) || null;
      } catch (e) {
        // goods_type 表未初始化（如单库测试环境）→ 静态注册兜底
        return fallback.get(typeCode) || null;
      }
    },
  };
}

function createPool(config) {
  return mysql.createPool({
    host: config.host, port: config.port, user: config.user,
    password: config.password, database: config.database,
    waitForConnections: true, connectionLimit: 10, namedPlaceholders: false,
    dateStrings: true, // DATETIME 以字符串返回，模块层统一转 UTC
  });
}

module.exports = { buildApp, createPool };

// ---- 直接启动入口 ----
if (require.main === module) {
  const config = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'bmp',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'bmp_goods',
    port_app: Number(process.env.PORT || 3000),
  };
  const db = createPool(config);
  const app = buildApp({ db });
  app.listen(config.port_app, () => {
    console.log(`[BMP] listening on :${config.port_app}`);
  });
}
