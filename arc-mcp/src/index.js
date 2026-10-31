// Arc MCP: a read-only Model Context Protocol server for Circle's Arc mainnet (chain 5042).
// It lets an AI assistant (Claude, ChatGPT, Cursor...) read Arc balances, quote Uniswap pools, read Riptide's
// price gaps and rug alarms, make Crescent payment links and check whether a payment arrived.
// No wallet, no keys, no transactions: every tool only reads public data or builds a link.
//
// Transport: MCP "Streamable HTTP" in its simplest stateless form. Clients POST JSON-RPC to /mcp and get JSON back.

const SERVER = { name: "arc-mcp", version: "0.1.0" };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const ARC_RPC = "https://rpc.mainnet.arc.io";
const EXPLORER = "https://explorer.arc.io";
const RIPTIDE = "https://riptide.benjiprojects1404.workers.dev";
const CRESCENT = "https://chordotc.com/crescent/";
const USDC = "0x3600000000000000000000000000000000000000";
const QUOTER_V3 = "0x7dfd4f31be6814d2906bde155c3e1b146eac1468";

// The eight tokens listed on Chord OTC, matched by address (Arc has look-alike tokens with the same names).
const TOKENS = {
  USDC:    { addr: USDC, dec: 6 },
  EURC:    { addr: "0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1", dec: 6,  v3Fee: 500 },
  WETH:    { addr: "0x128cc466b61f542da60c70e3aa11c10e19b84edb", dec: 18, v3Fee: 3000 },
  cirBTC:  { addr: "0x171a4217b86a807a64eb94757db6849fb4bdbaa0", dec: 8,  v3Fee: 100 },
  LINK:    { addr: "0x76a443768a5e3b8d1aed0105fc250877841deb40", dec: 18 },
  VIRTUAL: { addr: "0x8c4252c87081c88c6ad57d6dd97e1cafebf842b7", dec: 18 },
  ARGUS:   { addr: "0xece5ca8bf9220718e5727754026757512212cb3c", dec: 18, v3Fee: 10000 },
  ARCUS:   { addr: "0xb7c934ff18730c24e6113bb4bc5a68feef16fd29", dec: 18 },
};
const QUOTABLE = Object.keys(TOKENS).filter(k => TOKENS[k].v3Fee);

// ---------- helpers ----------
const isAddr = a => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const word = v => BigInt(v).toString(16).padStart(64, "0");
const addrWord = a => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const toUnits = (s, dec) => {
  const str = String(s).trim();
  if (!/^\d+(\.\d+)?$/.test(str)) throw new Error("amount must be a positive number");
  const [i, f = ""] = str.split(".");
  if (f.length > dec) throw new Error(`amount has more than ${dec} decimal places`);
  return BigInt(i) * 10n ** BigInt(dec) + BigInt((f + "0".repeat(dec)).slice(0, dec) || "0");
};
const fromUnits = (v, dec) => { const s = BigInt(v).toString().padStart(dec + 1, "0"); const i = s.slice(0, -dec) || "0", f = s.slice(-dec).replace(/0+$/, ""); return dec ? (f ? `${i}.${f}` : i) : s; };

async function rpc(env, method, params) {
  let last;
  for (const url of [env.ARC_RPC_URL, ARC_RPC].filter(Boolean)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 800 * attempt));
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        const j = await r.json();
        if (j.error) { last = j.error.message; continue; }
        return j.result;
      } catch (e) { last = e.message; }
    }
  }
  throw new Error("Arc RPC unavailable: " + last);
}
const call = (env, to, data) => rpc(env, "eth_call", [{ to, data }, "latest"]);

// ---------- tools ----------
const TOOLS = [
  {
    name: "arc_balances",
    description: "Balances of the eight Chord-listed tokens (USDC, EURC, WETH, cirBTC, LINK, VIRTUAL, ARGUS, ARCUS) for any Arc mainnet address. Read-only.",
    inputSchema: { type: "object", properties: { address: { type: "string", description: "Arc address, 0x… (40 hex chars)" } }, required: ["address"] },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run({ address }, env) {
      if (!isAddr(address)) throw new Error("address must be a 0x address");
      const out = {};
      for (const [sym, t] of Object.entries(TOKENS)) {
        const r = await call(env, t.addr, "0x70a08231" + addrWord(address));
        out[sym] = fromUnits(BigInt(r), t.dec);
      }
      return { address, network: "Arc mainnet (5042)", balances: out };
    },
  },
  {
    name: "arc_quote",
    description: "Real Uniswap v3 quote on Arc mainnet, including pool fee and slippage. side=buy: spend `amount` USDC on the token. side=sell: sell `amount` of the token for USDC. Tokens: " + QUOTABLE.join(", ") + ". Read-only; nothing is traded.",
    inputSchema: { type: "object", properties: {
      token: { type: "string", enum: QUOTABLE }, side: { type: "string", enum: ["buy", "sell"] },
      amount: { type: "string", description: "Decimal amount: USDC when buying, token units when selling" } }, required: ["token", "side", "amount"] },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run({ token, side, amount }, env) {
      const t = TOKENS[token]; if (!t || !t.v3Fee) throw new Error("token must be one of " + QUOTABLE.join(", "));
      if (side !== "buy" && side !== "sell") throw new Error("side must be buy or sell");
      const [tin, tout, din, dout] = side === "buy" ? [USDC, t.addr, 6, t.dec] : [t.addr, USDC, t.dec, 6];
      const amt = toUnits(amount, din);
      if (amt === 0n) throw new Error("amount must be above zero");
      const data = "0xc6a5026a" + addrWord(tin) + addrWord(tout) + word(amt) + word(t.v3Fee) + word(0);
      const r = await call(env, QUOTER_V3, data);
      const out = BigInt(r.slice(0, 66));
      const inN = Number(fromUnits(amt, din)), outN = Number(fromUnits(out, dout));
      const usdPerToken = side === "buy" ? inN / outN : outN / inN;
      return { venue: `Uniswap v3 on Arc, ${t.v3Fee / 10000}% pool`, side, token,
        you_pay: `${fromUnits(amt, din)} ${side === "buy" ? "USDC" : token}`, you_get: `${fromUnits(out, dout)} ${side === "buy" ? token : "USDC"}`,
        effective_price_usd: usdPerToken, note: "Quote only; prices move every block." };
    },
  },
  {
    name: "riptide_latest",
    description: "Latest Riptide check: the gap between Arc's Uniswap pools and Coinbase (or, for ARGUS, between Arc's v3 and v4 pools) at $10 and $1,000, after fees, and whether any pair is paused by the rug alarm. Riptide is a paper-trading monitor; it never trades.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run() {
      const j = await (await fetch(RIPTIDE + "/api/latest")).json();
      return { checked_at: j.rows?.[0] ? new Date(j.rows[0].ts * 1000).toISOString() : null,
        rows: (j.rows || []).map(r => ({ pair: r.pair, size_usd: r.size, against: r.ref_src, best_gap_after_costs_pct: r.net_best == null ? null : +(r.net_best * 100).toFixed(3),
          would_trade: !!r.would_trade, paused: r.alert || null, error: r.error || null })),
        dashboard: "https://benjiprojects1404-services.pages.dev/riptide/" };
    },
  },
  {
    name: "riptide_rug_alarms",
    description: "Rug-alarm events from Riptide: sudden price drops (20%+) or liquidity pulled (50%+) between two one-minute checks, on the Arc pools it watches.",
    inputSchema: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 30, description: "Look-back in days (default 7)" } } },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run({ days = 7 }) {
      const j = await (await fetch(`${RIPTIDE}/api/events?days=${Math.min(30, Math.max(1, days | 0))}`)).json();
      return { days, thresholds: j.rugAlarm, events: (j.rows || []).map(e => ({ at: new Date(e.ts * 1000).toISOString(), pair: e.pair, pool: e.pool, kind: e.kind, change_pct: +(e.change * 100).toFixed(1) })) };
    },
  },
  {
    name: "crescent_payment_link",
    description: "Make a Crescent payment link: whoever opens it can pay `amount` of `token` straight to `to` on Arc mainnet (no contract in between), and the page shows when the payment arrives. Only builds the link; nothing is signed or sent.",
    inputSchema: { type: "object", properties: {
      to: { type: "string", description: "Recipient Arc address" }, token: { type: "string", enum: Object.keys(TOKENS) },
      amount: { type: "string", description: "Decimal amount, e.g. 25 or 12.5" }, note: { type: "string", maxLength: 120 } }, required: ["to", "token", "amount"] },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run({ to, token, amount, note }, env) {
      if (!isAddr(to)) throw new Error("to must be a 0x address");
      const t = TOKENS[token]; if (!t) throw new Error("unknown token");
      const amt = toUnits(amount, t.dec); if (amt === 0n) throw new Error("amount must be above zero");
      const block = parseInt(await rpc(env, "eth_blockNumber", []), 16);
      const q = new URLSearchParams({ to, t: token, a: fromUnits(amt, t.dec), b: String(block) });
      if (note) q.set("n", String(note).slice(0, 120));
      return { link: CRESCENT + "?" + q.toString(), from_block: block, check_with: "crescent_check_payment" };
    },
  },
  {
    name: "crescent_check_payment",
    description: "Check whether a payment of exactly `amount` `token` has reached `to` on Arc mainnet, optionally only counting transfers from `from_block` on (the `b` in a Crescent link). Uses the Arc explorer.",
    inputSchema: { type: "object", properties: {
      to: { type: "string" }, token: { type: "string", enum: Object.keys(TOKENS) }, amount: { type: "string" },
      from_block: { type: "integer", minimum: 0 } }, required: ["to", "token", "amount"] },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run({ to, token, amount, from_block = 0 }) {
      if (!isAddr(to)) throw new Error("to must be a 0x address");
      const t = TOKENS[token]; if (!t) throw new Error("unknown token");
      const want = toUnits(amount, t.dec).toString();
      const r = await fetch(`${EXPLORER}/api/v2/addresses/${to}/token-transfers?type=ERC-20&filter=to&token=${t.addr}`, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error("explorer " + r.status);
      const j = await r.json();
      const hit = (j.items || []).find(i => i.to?.hash?.toLowerCase() === to.toLowerCase() && i.token?.address_hash?.toLowerCase() === t.addr
        && i.total?.value === want && Number(i.block_number) >= from_block);
      return hit ? { paid: true, tx: `${EXPLORER}/tx/${hit.transaction_hash}`, from: hit.from?.hash, at: hit.timestamp, block: hit.block_number }
        : { paid: false, note: "No matching transfer among the address's latest transfers of this token." };
    },
  },
];

// ---------- MCP over HTTP (stateless JSON-RPC) ----------
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id", "access-control-expose-headers": "mcp-session-id" };
const reply = (body, status = 200) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg, env) {
  const { id, method, params = {} } = msg || {};
  const isNotification = id === undefined || id === null;
  switch (method) {
    case "initialize": {
      const v = PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
      return ok(id, { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER,
        instructions: "Read-only tools for Circle's Arc mainnet: balances, Uniswap quotes, Riptide price gaps and rug alarms, Crescent payment links. Nothing here can move funds." });
    }
    case "notifications/initialized": case "notifications/cancelled": return null;
    case "ping": return ok(id, {});
    case "tools/list": return ok(id, { tools: TOOLS.map(({ run, ...t }) => t) });
    case "tools/call": {
      const tool = TOOLS.find(t => t.name === params.name);
      if (!tool) return err(id, -32602, "Unknown tool: " + params.name);
      try {
        const result = await tool.run(params.arguments || {}, env);
        return ok(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false });
      } catch (e) {
        return ok(id, { content: [{ type: "text", text: "Error: " + (e.message || e) }], isError: true });
      }
    }
    default:
      return isNotification ? null : err(id, -32601, "Method not found: " + method);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/" && req.method === "GET") {
      return reply({ name: SERVER.name, version: SERVER.version, mcp_endpoint: url.origin + "/mcp", transport: "streamable-http (stateless)",
        tools: TOOLS.map(t => t.name), read_only: true, source: "https://github.com/benjiprojects1404-maker/benjiprojects1404-services/tree/main/arc-mcp" });
    }
    if (url.pathname !== "/mcp") return reply({ error: "not found" }, 404);
    if (req.method === "GET") return new Response("This MCP server doesn't stream; POST JSON-RPC to /mcp.", { status: 405, headers: { allow: "POST", ...CORS } });
    if (req.method !== "POST") return reply({ error: "method not allowed" }, 405);
    let body;
    try { body = await req.json(); } catch { return reply(err(null, -32700, "Parse error"), 400); }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(m => handle(m, env)))).filter(Boolean);
      return out.length ? reply(out) : new Response(null, { status: 202, headers: CORS });
    }
    const res = await handle(body, env);
    return res ? reply(res) : new Response(null, { status: 202, headers: CORS });
  },
};
