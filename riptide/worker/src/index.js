// Riptide: a read-only monitor of price gaps between Arc (Uniswap v3) and centralised exchanges.
// PAPER TRADING ONLY. No wallet, no keys, no accounts, no orders. It only reads public prices.
//
// Every minute (cron) it:
//   1. asks Arc's Uniswap v3 QuoterV2 what a $10 and a $1,000 trade would return, both directions;
//   2. reads the live bid/ask on the reference exchange (Binance or Coinbase);
//   3. works out the gap both ways, minus the exchange fee and Arc gas, and stores it in D1.
// The same Worker serves a small JSON API for the dashboard.

const ARC_RPC = "https://rpc.mainnet.arc.io";
const QUOTER = "0x7dfd4f31be6814d2906bde155c3e1b146eac1468"; // Uniswap QuoterV2 on Arc (chain 5042)
const USDC = "0x3600000000000000000000000000000000000000";    // USDC ERC-20 interface, 6 decimals
const SIZES = [10, 1000];                                     // trade sizes in USD

// cexFee is the assumed taker fee per trade (fraction). Shown on the dashboard as an assumption.
// Binance blocks Cloudflare's servers, so Binance pairs fall back to Coinbase (cb), where USDC converts 1:1 to USD.
const COINBASE_FEE = 0.006;
export const PAIRS = [
  { id: "cirBTC", token: "0x171a4217b86a807a64eb94757db6849fb4bdbaa0", dec: 8,  poolFee: 100, ref: "binance",  sym: "BTCUSDC",   cexFee: 0.001, cb: "BTC-USD" },
  { id: "EURC",   token: "0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1", dec: 6,  poolFee: 500, ref: "coinbase", sym: "EURC-USDC", cexFee: 0.006 },
  { id: "WETH",   token: "0x128cc466b61f542da60c70e3aa11c10e19b84edb", dec: 18, poolFee: 3000, ref: "binance", sym: "ETHUSDC",   cexFee: 0.001, cb: "ETH-USD" },
];
const QUOTE_SELECTOR = "0xc6a5026a"; // quoteExactInputSingle((address,address,uint256,uint24,uint160))
const GAS_UNITS = 110000n;          // typical v3 single swap on Arc, from QuoterV2's gasEstimate

const word = v => BigInt(v).toString(16).padStart(64, "0");
const addrWord = a => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

function quoteCall(tokenIn, tokenOut, amountIn, fee) {
  return QUOTE_SELECTOR + addrWord(tokenIn) + addrWord(tokenOut) + word(amountIn) + word(fee) + word(0);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Sends the calls as one JSON-RPC batch. Calls that fail (often "rate limit" on shared Cloudflare IPs) are
// retried a few times, then on the next endpoint. Returns results by index plus the last error seen.
async function rpcBatch(calls, endpoints) {
  const out = new Array(calls.length).fill(null);
  let todo = calls.map((_, i) => i), lastErr = null;
  for (const url of endpoints) {
    for (let attempt = 0; attempt < 3 && todo.length; attempt++) {
      if (attempt) await sleep(1500 * attempt);
      try {
        const body = todo.map(i => ({ jsonrpc: "2.0", id: i, method: calls[i].method, params: calls[i].params }));
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        if (!r.ok) { lastErr = "http " + r.status; continue; }
        const res = await r.json();
        for (const x of Array.isArray(res) ? res : [res]) {
          if (x.error) lastErr = (x.error.code ? x.error.code + " " : "") + (x.error.message || "error");
          else if (x.id != null) out[x.id] = x.result;
        }
      } catch (e) { lastErr = String(e.message || e); }
      todo = todo.filter(i => out[i] == null);
    }
    if (!todo.length) break;
  }
  return { out, lastErr: todo.length ? lastErr : null };
}

async function refPrice(p) {
  const coinbase = async sym => {
    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(1000 * attempt);
      r = await fetch(`https://api.exchange.coinbase.com/products/${sym}/ticker`, { headers: { "user-agent": "riptide-monitor" } });
      if (r.status !== 429) break;   // shared Cloudflare IPs sometimes get "too many requests"
    }
    if (!r.ok) throw new Error("coinbase " + r.status);
    const j = await r.json();
    return { bid: Number(j.bid), ask: Number(j.ask), src: "coinbase", fee: COINBASE_FEE };
  };
  if (p.ref === "coinbase") return coinbase(p.sym);
  // Binance blocks some server regions; fall back to its public market-data mirror.
  for (const host of ["https://api.binance.com", "https://data-api.binance.vision"]) {
    try {
      const r = await fetch(`${host}/api/v3/ticker/bookTicker?symbol=${p.sym}`);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.bidPrice) return { bid: Number(j.bidPrice), ask: Number(j.askPrice), src: host.includes("vision") ? "binance-mirror" : "binance", fee: p.cexFee };
    } catch (_) { /* try next host */ }
  }
  if (p.cb) return coinbase(p.cb);
  throw new Error("binance unavailable");
}

const units = (n, dec) => BigInt(Math.round(n * 10 ** Math.min(dec, 12))) * 10n ** BigInt(Math.max(0, dec - 12));
const fromUnits = (v, dec) => Number(v) / 10 ** dec;

export async function sample(env = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const refs = [];
  for (const p of PAIRS) { refs.push(await refPrice(p).catch(e => ({ error: String(e.message || e) }))); await sleep(250); }

  // One JSON-RPC batch for every quote plus the gas price.
  const calls = [{ method: "eth_gasPrice", params: [] }];
  const plan = [];
  PAIRS.forEach((p, i) => {
    const ref = refs[i]; if (ref.error) return;
    const mid = (ref.bid + ref.ask) / 2;
    for (const usd of SIZES) {
      plan.push({ i, usd, dir: "buy", idx: calls.length });   // USDC -> token on Arc
      calls.push({ method: "eth_call", params: [{ to: QUOTER, data: quoteCall(USDC, p.token, units(usd, 6), p.poolFee) }, "latest"] });
      plan.push({ i, usd, dir: "sell", idx: calls.length, tokIn: usd / mid }); // token -> USDC on Arc
      calls.push({ method: "eth_call", params: [{ to: QUOTER, data: quoteCall(p.token, USDC, units(usd / mid, p.dec), p.poolFee) }, "latest"] });
    }
  });
  // If Arc can't be reached, still log the minute with the reason instead of saving nothing.
  // ARC_RPC_URL (optional secret, e.g. a free Alchemy / dRPC Arc endpoint) is tried before the public RPC.
  const endpoints = [env.ARC_RPC_URL, ARC_RPC].filter(Boolean);
  const { out: res, lastErr } = await rpcBatch(calls, endpoints);
  const arcError = lastErr ? "arc: " + lastErr.slice(0, 120) : null;
  const gasPrice = res[0] ? BigInt(res[0]) : 20000000000n;
  const gasUsd = Number(GAS_UNITS * gasPrice) / 1e18; // native USDC has 18 decimals

  const rows = [];
  for (const [i, p] of PAIRS.entries()) {
    const ref = refs[i];
    for (const usd of SIZES) {
      const row = { ts, pair: p.id, size: usd, ref_src: ref.src || null, cex_bid: ref.bid ?? null, cex_ask: ref.ask ?? null,
        arc_buy: null, arc_sell: null, gross_a: null, gross_b: null, net_a: null, net_b: null, net_best: null, would_trade: 0,
        cex_fee: ref.fee ?? p.cexFee, gas_usd: gasUsd, error: ref.error || null };
      if (!row.error) {
        const b = plan.find(x => x.i === i && x.usd === usd && x.dir === "buy");
        const s = plan.find(x => x.i === i && x.usd === usd && x.dir === "sell");
        const outTok = res[b.idx] && res[b.idx].length >= 66 ? fromUnits(BigInt(res[b.idx].slice(0, 66)), p.dec) : 0;
        const outUsd = res[s.idx] && res[s.idx].length >= 66 ? fromUnits(BigInt(res[s.idx].slice(0, 66)), 6) : 0;
        if (outTok > 0) row.arc_buy = usd / outTok;          // USDC per token paid on Arc (includes pool fee and slippage)
        if (outUsd > 0) row.arc_sell = outUsd / s.tokIn;     // USDC per token received on Arc
        const costs = (ref.fee ?? p.cexFee) + gasUsd / usd;
        if (row.arc_buy) { row.gross_a = ref.bid / row.arc_buy - 1; row.net_a = row.gross_a - costs; }   // buy Arc, sell exchange
        if (row.arc_sell) { row.gross_b = row.arc_sell / ref.ask - 1; row.net_b = row.gross_b - costs; } // buy exchange, sell Arc
        const nets = [row.net_a, row.net_b].filter(v => v !== null);
        if (nets.length) { row.net_best = Math.max(...nets); row.would_trade = row.net_best > 0 ? 1 : 0; }
        if (!row.arc_buy && !row.arc_sell) row.error = arcError || "no arc quote";
      }
      rows.push(row);
    }
  }
  return rows;
}

const COLS = ["ts", "pair", "size", "ref_src", "cex_bid", "cex_ask", "arc_buy", "arc_sell", "gross_a", "gross_b", "net_a", "net_b", "net_best", "would_trade", "cex_fee", "gas_usd", "error"];

async function store(env, rows) {
  const stmt = env.DB.prepare(`INSERT INTO samples (${COLS.join(",")}) VALUES (${COLS.map(() => "?").join(",")})`);
  await env.DB.batch(rows.map(r => stmt.bind(...COLS.map(c => r[c]))));
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET", "cache-control": "public, max-age=30" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...CORS } });

async function api(url, env) {
  const p = url.pathname;
  const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days")) || 7));
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  if (p === "/api/latest") {
    const r = await env.DB.prepare(`SELECT * FROM samples WHERE ts = (SELECT MAX(ts) FROM samples) ORDER BY pair, size`).all();
    return json({ rows: r.results, pairs: PAIRS.map(({ id, ref, sym, cexFee, poolFee }) => ({ id, ref, sym, cexFee, poolFee })) });
  }
  if (p === "/api/summary") {
    const r = await env.DB.prepare(`SELECT pair, size, COUNT(*) n, SUM(would_trade) hits, MAX(net_best) best_net,
        AVG(MAX(COALESCE(gross_a, -1), COALESCE(gross_b, -1))) avg_best_gross, MIN(ts) first_ts, MAX(ts) last_ts,
        SUM(CASE WHEN would_trade=1 THEN net_best*size ELSE 0 END) paper_pnl
      FROM samples WHERE ts >= ? AND error IS NULL GROUP BY pair, size ORDER BY pair, size`).bind(since).all();
    const start = await env.DB.prepare(`SELECT MIN(ts) t FROM samples`).first();
    return json({ days, since, started: start ? start.t : null, rows: r.results });
  }
  if (p === "/api/series") {
    // One point per 15 minutes (average) so a week is ~670 points per line.
    const size = Number(url.searchParams.get("size")) || 1000;
    const r = await env.DB.prepare(`SELECT pair, (ts/900)*900 t, AVG(gross_a) ga, AVG(gross_b) gb, AVG(net_best) nb
      FROM samples WHERE ts >= ? AND size = ? AND error IS NULL GROUP BY pair, t ORDER BY t`).bind(since, size).all();
    return json({ size, rows: r.results });
  }
  if (p === "/api/opps") {
    const r = await env.DB.prepare(`SELECT * FROM samples WHERE ts >= ? AND would_trade = 1 ORDER BY ts DESC LIMIT 200`).bind(since).all();
    return json({ rows: r.results });
  }
  if (p === "/api/csv") {
    const r = await env.DB.prepare(`SELECT * FROM samples WHERE ts >= ? ORDER BY ts`).bind(since).all();
    const lines = [COLS.join(",")].concat(r.results.map(x => COLS.map(c => x[c] ?? "").join(",")));
    return new Response(lines.join("\n"), { headers: { "content-type": "text/csv", "content-disposition": `attachment; filename=riptide-${days}d.csv`, ...CORS } });
  }
  return json({ name: "Riptide", endpoints: ["/api/latest", "/api/summary?days=7", "/api/series?days=7&size=1000", "/api/opps?days=7", "/api/csv?days=7"] });
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const rows = await sample(env);
      await store(env, rows);
      const errs = [...new Set(rows.map(r => r.error).filter(Boolean))];
      console.log(`riptide: saved ${rows.length} rows` + (errs.length ? `; issues: ${errs.join(" | ")}` : "; all sources ok"));
      // Keep 30 days.
      await env.DB.prepare(`DELETE FROM samples WHERE ts < ?`).bind(Math.floor(Date.now() / 1000) - 30 * 86400).run();
    })());
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method !== "GET") return json({ error: "read-only" }, 405);
    try { return await api(url, env); } catch (e) { return json({ error: String(e.message || e) }, 500); }
  },
};
