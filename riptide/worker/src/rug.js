// Rug alarm: watches every pool Riptide quotes for the two signs of a rug pull, minute by minute.
//   - a sudden price drop (>= PRICE_DROP between two checks), or
//   - liquidity pulled (>= LIQ_DROP of the pool's liquidity gone between two checks, or the pool empty).
// When either fires, the event is logged and that pair is paused for PAUSE_MIN minutes: its rows are marked
// and can't count as "would trade", because a huge apparent gap during a rug is a trap, not an opportunity.
// Read-only like the rest of Riptide: it only reads pool state.

export const PRICE_DROP = 0.20;
export const LIQ_DROP = 0.50;
export const PAUSE_MIN = 60;

const USDC = "0x3600000000000000000000000000000000000000";
const NATIVE = "0x0000000000000000000000000000000000000000";
const STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b"; // Uniswap v4 StateView on Arc

// Every pool Riptide quotes. v3 pools by address; v4 pools by pool id.
export const WATCH = [
  { pair: "cirBTC", pool: "v3 0.01%", kind: "v3", address: "0x82916bee18fcef517b26c72d7cb5f13694e1db41", token: "0x171a4217b86a807a64eb94757db6849fb4bdbaa0", dec: 8 },
  { pair: "EURC",   pool: "v3 0.05%", kind: "v3", address: "0x6fd5f2fb831940dcd61a98c5b3acb7d8c6f3bfc1", token: "0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1", dec: 6 },
  { pair: "WETH",   pool: "v3 0.3%",  kind: "v3", address: "0x964cff2cccb9059e83d507df348f070e5257a2e0", token: "0x128cc466b61f542da60c70e3aa11c10e19b84edb", dec: 18 },
  { pair: "ARGUS",  pool: "v3 1%",    kind: "v3", address: "0x6a3bacaa6493734c1ac221ebf42cf530a96c1e02", token: "0xece5ca8bf9220718e5727754026757512212cb3c", dec: 18 },
  { pair: "ARGUS",  pool: "v4 0.985%", kind: "v4", id: "0xb3f441e8871840ecfcb284e5cbb5b9c21a50e961e1c50109bdced25e429f00cc", token: "0xece5ca8bf9220718e5727754026757512212cb3c", dec: 18 },
  { pair: "ARGUS",  pool: "v4 4%",    kind: "v4", id: "0xebde8959fac1a0a1f837189e7f00f40566f4c1fc6efa3b3c987222222fd31455", token: "0xece5ca8bf9220718e5727754026757512212cb3c", dec: 18 },
  // Faze (faze.fun) coins. Their main pools are the graduated Faze pools: native USDC (18 decimals) against the coin,
  // through Faze's launchpad hook, which takes the trading fee. Pool ids checked on Arc mainnet, 2 Nov 2026.
  { pair: "FAZE",   pool: "Faze pool", kind: "v4", id: "0xd9133187331e20885fd1b4ff2f18b892f94793ddaf808b1db6d4ef29ca58b943", token: "0x394d38f807ee0027a182216f5e67a15ae441fa2e", dec: 18, quote: NATIVE, qdec: 18 },
  { pair: "FAZE",   pool: "v4 5%",     kind: "v4", id: "0xcb4925117715e6983ee6e03d491d90bbc498776b761714c447a9ea80265ca846", token: "0x394d38f807ee0027a182216f5e67a15ae441fa2e", dec: 18 },
  { pair: "AF",     pool: "Faze pool", kind: "v4", id: "0x1c0523377296238f6a2fd25cb3b15f75e280eb330ad29f843b974eec264dfe31", token: "0x75d658f8101fbe6dc217fbba7e20a0312af5fa2e", dec: 18, quote: NATIVE, qdec: 18 },
];

const addrWord = a => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const first = r => (r && r.length >= 66 ? BigInt(r.slice(0, 66)) : null);

// Price of the token in its quote currency (USD for USDC or native USDC) from a Uniswap sqrtPriceX96
// (token1 per token0, in base units). quote defaults to the USDC ERC-20 (6 decimals).
export function usdPerToken(sqrtPriceX96, token, dec, quote = USDC, qdec = 6) {
  const raw = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  if (!raw) return null;
  return token.toLowerCase() < quote.toLowerCase() ? raw * 10 ** (dec - qdec) : 10 ** (dec - qdec) / raw;
}

export async function ensureSchema(env, COLS, BUCKET) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS pool_state (ts INTEGER NOT NULL, pair TEXT NOT NULL, pool TEXT NOT NULL, price REAL, liq REAL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_pool_state ON pool_state (pool, pair, ts)`),
    // The retention DELETE filters on ts alone; without this it scans the whole table.
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_pool_state_ts ON pool_state (ts)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS events (ts INTEGER NOT NULL, pair TEXT NOT NULL, pool TEXT NOT NULL, kind TEXT NOT NULL,
      change REAL, before REAL, after REAL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts)`),
  ]);
  try { await env.DB.prepare(`ALTER TABLE samples ADD COLUMN alert TEXT`).run(); } catch (_) { /* already there */ }

  // Read-saving tables (see store() in index.js). WITHOUT ROWID so each upsert is one row written.
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS rollup (bucket INTEGER NOT NULL, pair TEXT NOT NULL, size INTEGER NOT NULL,
      n INTEGER NOT NULL, hits INTEGER NOT NULL, sum_best_gross REAL NOT NULL, max_net REAL, paper_pnl REAL NOT NULL,
      first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, sum_ga REAL NOT NULL, n_ga INTEGER NOT NULL,
      sum_gb REAL NOT NULL, n_gb INTEGER NOT NULL, sum_nb REAL NOT NULL, n_nb INTEGER NOT NULL,
      PRIMARY KEY (bucket, pair, size)) WITHOUT ROWID`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS opps (${COLS.join(",")})`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_opps_ts ON opps (ts)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`),
    // Nothing queries samples by (pair, size, ts) any more; dropping it saves a write per sample.
    env.DB.prepare(`DROP INDEX IF EXISTS idx_samples_pair_size_ts`),
  ]);

  // One-off: fill rollup and opps from the history already saved. Runs once, in one transaction.
  const done = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'backfill_v1'`).first();
  if (!done) {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO rollup (bucket, pair, size, n, hits, sum_best_gross, max_net, paper_pnl, first_ts, last_ts,
          sum_ga, n_ga, sum_gb, n_gb, sum_nb, n_nb)
        SELECT (ts / ${BUCKET}) * ${BUCKET}, pair, size, COUNT(*), SUM(would_trade),
          SUM(MAX(COALESCE(gross_a, -1), COALESCE(gross_b, -1))), MAX(net_best),
          SUM(CASE WHEN would_trade = 1 THEN COALESCE(net_best, 0) * size ELSE 0 END), MIN(ts), MAX(ts),
          TOTAL(gross_a), COUNT(gross_a), TOTAL(gross_b), COUNT(gross_b), TOTAL(net_best), COUNT(net_best)
        FROM samples WHERE error IS NULL GROUP BY 1, pair, size`),
      env.DB.prepare(`INSERT INTO opps (${COLS.join(",")}) SELECT ${COLS.join(",")} FROM samples WHERE would_trade = 1`),
      env.DB.prepare(`INSERT INTO meta (k, v) VALUES ('backfill_v1', ?)`).bind(String(Math.floor(Date.now() / 1000))),
    ]);
  }
}

// Reads every watched pool, compares with its previous reading, stores both, logs events.
// extra: pools added at run time (Faze coins that graduated in the last week, from faze.js).
export async function checkPools(env, ts, rpcBatch, endpoints, extra = []) {
  const ids = new Set(WATCH.map(w => w.id).filter(Boolean));
  const all = WATCH.concat(extra.filter(w => w.id && !ids.has(w.id)));
  const calls = [], plan = [];
  for (const w of all) {
    const c = n => { plan.push({ w, n, idx: calls.length }); };
    if (w.kind === "v3") {
      c("slot0"); calls.push({ method: "eth_call", params: [{ to: w.address, data: "0x3850c7bd" }, "latest"] });
      c("tok");   calls.push({ method: "eth_call", params: [{ to: w.token, data: "0x70a08231" + addrWord(w.address) }, "latest"] });
      c("usdc");  calls.push({ method: "eth_call", params: [{ to: USDC, data: "0x70a08231" + addrWord(w.address) }, "latest"] });
    } else {
      c("slot0"); calls.push({ method: "eth_call", params: [{ to: STATE_VIEW, data: "0xc815641c" + w.id.slice(2) }, "latest"] });
      c("liq");   calls.push({ method: "eth_call", params: [{ to: STATE_VIEW, data: "0xfa6793d5" + w.id.slice(2) }, "latest"] });
    }
  }
  const { out } = await rpcBatch(calls, endpoints);
  const get = (w, n) => first(out[plan.find(x => x.w === w && x.n === n).idx]);

  const events = [], states = [];
  for (const w of all) {
    const sp = get(w, "slot0");
    if (sp === null) continue; // couldn't read this minute; don't guess
    const price = usdPerToken(sp, w.token, w.dec, w.quote, w.qdec);
    let liq;
    if (w.kind === "v3") {
      const tok = get(w, "tok"), usdc = get(w, "usdc");
      if (tok === null || usdc === null) continue;
      liq = Number(usdc) / 1e6 + (Number(tok) / 10 ** w.dec) * (price || 0); // pool value in USD
    } else {
      const l = get(w, "liq"); if (l === null) continue;
      liq = Number(l);                                                          // v4 liquidity units (compared only with itself)
    }
    states.push({ w, price, liq });
    const prev = await env.DB.prepare(`SELECT price, liq FROM pool_state WHERE pool = ? AND pair = ? ORDER BY ts DESC LIMIT 1`).bind(w.pool, w.pair).first();
    if (prev) {
      if (prev.liq > 0 && liq <= 0) events.push({ w, kind: "pool_empty", change: -1, before: prev.liq, after: liq });
      else if (prev.liq > 0 && liq / prev.liq - 1 <= -LIQ_DROP) events.push({ w, kind: "liquidity_drop", change: liq / prev.liq - 1, before: prev.liq, after: liq });
      if (prev.price > 0 && price && price / prev.price - 1 <= -PRICE_DROP) events.push({ w, kind: "price_drop", change: price / prev.price - 1, before: prev.price, after: price });
    }
  }
  const stmts = states.map(s => env.DB.prepare(`INSERT INTO pool_state (ts, pair, pool, price, liq) VALUES (?,?,?,?,?)`).bind(ts, s.w.pair, s.w.pool, s.price, s.liq))
    .concat(events.map(e => env.DB.prepare(`INSERT INTO events (ts, pair, pool, kind, change, before, after) VALUES (?,?,?,?,?,?,?)`)
      .bind(ts, e.w.pair, e.w.pool, e.kind, e.change, e.before, e.after)));
  if (stmts.length) await env.DB.batch(stmts);
  return events;
}

// Pairs with an alarm in the last PAUSE_MIN minutes.
export async function pausedPairs(env, ts) {
  const r = await env.DB.prepare(`SELECT pair, MAX(ts) t, kind FROM events WHERE ts >= ? GROUP BY pair`).bind(ts - PAUSE_MIN * 60).all();
  return new Map((r.results || []).map(x => [x.pair, x]));
}
