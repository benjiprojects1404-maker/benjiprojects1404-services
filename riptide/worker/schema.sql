-- Riptide: one row per pair, trade size and minute.
CREATE TABLE IF NOT EXISTS samples (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,  -- unix seconds
  pair        TEXT    NOT NULL,  -- cirBTC | EURC | WETH
  size        INTEGER NOT NULL,  -- trade size in USD (10 or 1000)
  ref_src     TEXT,              -- binance | binance-mirror | coinbase
  cex_bid     REAL,
  cex_ask     REAL,
  arc_buy     REAL,              -- USDC per token paid on Arc (incl. pool fee + slippage)
  arc_sell    REAL,              -- USDC per token received on Arc
  gross_a     REAL,              -- buy on Arc, sell on exchange, before costs
  gross_b     REAL,              -- buy on exchange, sell on Arc, before costs
  net_a       REAL,              -- after exchange fee and Arc gas
  net_b       REAL,
  net_best    REAL,
  would_trade INTEGER NOT NULL DEFAULT 0,
  cex_fee     REAL,
  gas_usd     REAL,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples (ts);
CREATE INDEX IF NOT EXISTS idx_samples_pair_size_ts ON samples (pair, size, ts);
