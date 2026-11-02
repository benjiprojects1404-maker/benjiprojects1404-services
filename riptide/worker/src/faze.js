// Faze watch: follows Faze (faze.fun), the memecoin launchpad on Arc, read-only.
//   - Launches: every coin created on Faze's bonding curve (BondingCurveV4 "Launched" events).
//   - Graduations: every coin whose curve filled and moved into a locked Uniswap v4 pool
//     (UniswapV4Migrator "MigratedV4" events).
//   - After graduation, the new pool is read every minute for 7 days by the rug alarm (rug.js), so a sudden
//     price collapse or liquidity leaving the "locked" pool is flagged.
// Contract addresses were read from faze.fun's own app config and checked on Arc mainnet (2 Nov 2026).
// Nothing here trades or signs anything; it only reads public logs and pool state.

export const BONDING_CURVE = "0x6a62919ccbf0c19e0c4e084f986b582b4492dda4";
export const MIGRATOR = "0x7c8de42426a058b778dce8530537cd62ef0178c4";
export const LAUNCHPAD_HOOK = "0x47e7936ae9891e61c5123db720593c05de7120cc";
export const FAZE = "0x394d38f807ee0027a182216f5e67a15ae441fa2e";
export const NATIVE = "0x0000000000000000000000000000000000000000"; // Arc's native USDC (18 decimals)

const T_LAUNCHED = "0xac320ff805a1bd9194660602c2ad1ec5198a9c9ebf5539e8ffc8faae8b5a6574";
const T_MIGRATED = "0x437100021b2f241d36840eb0754de9ca44a281c5d4eda3ab393e8e14184eadf4";

const CHUNK = 1900;          // Arc's public RPC refuses log ranges much over 2,000 blocks
const CHUNKS_PER_RUN = 3;    // catch up at most ~5,700 blocks (~48 minutes of Arc) per minute
const BACKFILL_DAYS = 3;     // on the first run, start this far back (Arc makes ~2 blocks a second; ~1.5 h to catch up)
export const WATCH_DAYS = 7; // watch each graduated pool this long

const words = data => (data || "0x").slice(2).match(/.{64}/g) || [];
const addr = w => "0x" + w.slice(24);          // from a 64-char data word
const topicAddr = t => "0x" + t.slice(26);    // from a 0x-prefixed log topic
function str(ws, offsetWord) {
  const at = Number(BigInt("0x" + ws[offsetWord])) / 32;
  const len = Number(BigInt("0x" + ws[at]));
  const hex = ws.slice(at + 1, at + 1 + Math.ceil(len / 32)).join("").slice(0, len * 2);
  try { return new TextDecoder().decode(Uint8Array.from(hex.match(/.{2}/g) || [], b => parseInt(b, 16))).slice(0, 40); } catch (_) { return ""; }
}

export async function ensureFazeSchema(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS faze_events (ts INTEGER NOT NULL, block INTEGER NOT NULL, kind TEXT NOT NULL,
      token TEXT NOT NULL, name TEXT, symbol TEXT, quote TEXT, pool_id TEXT, quote_seeded REAL, tx TEXT,
      PRIMARY KEY (tx, kind, token)) WITHOUT ROWID`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_faze_events_ts ON faze_events (ts)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`),
  ]);
}

// Reads new Launched / MigratedV4 logs since the last block processed and stores them.
export async function scanFaze(env, rpcBatch, endpoints) {
  const head = await rpcBatch([{ method: "eth_blockNumber", params: [] }], endpoints);
  if (!head.out[0]) throw new Error("faze: no block number (" + head.lastErr + ")");
  const latest = parseInt(head.out[0], 16);
  const m = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'faze_block'`).first();
  let from = m ? Number(m.v) + 1 : latest - BACKFILL_DAYS * 86400 * 2;
  if (from > latest) return [];

  // One getLogs per chunk covering both contracts and both events (the public RPC rate-limits busy batches).
  const calls = [], ranges = [];
  for (let i = 0; i < CHUNKS_PER_RUN && from <= latest; i++) {
    const to = Math.min(latest, from + CHUNK - 1);
    calls.push({ method: "eth_getLogs", params: [{ fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16),
      address: [BONDING_CURVE, MIGRATOR], topics: [[T_LAUNCHED, T_MIGRATED]] }] });
    ranges.push(to); from = to + 1;
  }
  const { out: results } = await rpcBatch(calls, endpoints); // an empty list of logs is a valid answer
  let done = null;
  const evs = [];
  for (let i = 0; i < ranges.length; i++) {
    const logs = results[i];
    if (!Array.isArray(logs)) break; // stop at the first failed chunk; it is retried next minute
    for (const l of logs) {
      const ws = words(l.data), ts = parseInt(l.blockTimestamp || "0x0", 16) || Math.floor(Date.now() / 1000), block = parseInt(l.blockNumber, 16);
      if (l.address.toLowerCase() === BONDING_CURVE && l.topics[0] === T_LAUNCHED)
        evs.push({ ts, block, kind: "launch", token: topicAddr(l.topics[1]), name: str(ws, 15), symbol: str(ws, 16),
          quote: ws[13] ? addr(ws[13]) : null, pool_id: null, quote_seeded: null, tx: l.transactionHash });
      else if (l.address.toLowerCase() === MIGRATOR && l.topics[0] === T_MIGRATED)
        evs.push({ ts, block, kind: "graduate", token: topicAddr(l.topics[2]), name: null, symbol: null, quote: topicAddr(l.topics[3]), pool_id: l.topics[1],
          quote_seeded: ws[1] ? Number(BigInt("0x" + ws[1])) / 1e18 : null, tx: l.transactionHash }); // native USDC and FAZE both use 18 decimals
    }
    done = ranges[i];
  }
  if (done === null) return [];

  // Graduations don't carry the coin's name: read its symbol and name from the token itself.
  const grads = evs.filter(e => e.kind === "graduate");
  if (grads.length) {
    const { out: meta } = await rpcBatch(grads.flatMap(e => [{ method: "eth_call", params: [{ to: e.token, data: "0x95d89b41" }, "latest"] },
      { method: "eth_call", params: [{ to: e.token, data: "0x06fdde03" }, "latest"] }]), endpoints);
    grads.forEach((e, i) => { e.symbol = decodeString(meta[2 * i]); e.name = decodeString(meta[2 * i + 1]); });
  }
  const ins = env.DB.prepare(`INSERT OR IGNORE INTO faze_events (ts, block, kind, token, name, symbol, quote, pool_id, quote_seeded, tx) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  await env.DB.batch(evs.map(e => ins.bind(e.ts, e.block, e.kind, e.token, e.name, e.symbol, e.quote, e.pool_id, e.quote_seeded, e.tx))
    .concat(env.DB.prepare(`INSERT INTO meta (k, v) VALUES ('faze_block', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`).bind(String(done))));
  return evs;
}

function decodeString(r) {
  if (typeof r !== "string" || r.length < 130) return null;
  return str(words(r), 0) || null;
}

// Pools graduated in the last WATCH_DAYS days, in the shape rug.js's WATCH list uses.
export async function graduatedWatch(env, ts) {
  let r = { results: [] };
  try {
    r = await env.DB.prepare(`SELECT token, symbol, quote, pool_id FROM faze_events WHERE kind = 'graduate' AND ts >= ? ORDER BY ts DESC LIMIT 10`)
      .bind(ts - WATCH_DAYS * 86400).all();
  } catch (_) { /* table not created yet */ }
  return (r.results || []).map(g => ({ pair: g.symbol || g.token.slice(0, 8), pool: "Faze graduated", kind: "v4", id: g.pool_id,
    token: g.token, dec: 18, quote: g.quote, qdec: 18 }));
}
