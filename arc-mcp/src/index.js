// Arc MCP: a read-only Model Context Protocol server for Circle's Arc mainnet (chain 5042).
// It lets an AI assistant (Claude, ChatGPT, Cursor...) read Arc balances, quote Uniswap pools, read Riptide's
// price gaps and rug alarms, make Crescent payment links and check whether a payment arrived.
// No wallet, no keys, nothing sent: every tool only reads public data, builds a link, or prepares an unsigned
// Chord OTC transaction for the user to review and sign in their own wallet.
//
// Transport: MCP "Streamable HTTP" in its simplest stateless form. Clients POST JSON-RPC to /mcp and get JSON back.
//
// Public name: Cadence (https://chordotc.com/cadence/). The ten tools below are free. The Pro tools further down
// cost a fraction of a cent each, paid by the agent in USDC on Arc through x402 (see x402.js).

import { requirements, paymentRequired, checkPayment, settle, seller, sweep, NETWORK } from "./x402.js";

const SERVER = { name: "cadence", title: "Cadence (Arc MCP)", version: "0.4.1" };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const ARC_RPC = "https://rpc.mainnet.arc.io";
const EXPLORER = "https://explorer.arc.io";
const RIPTIDE = "https://riptide.benjiprojects1404.workers.dev";
const CRESCENT = "https://chordotc.com/crescent/";
const USDC = "0x3600000000000000000000000000000000000000";
const QUOTER_V3 = "0x7dfd4f31be6814d2906bde155c3e1b146eac1468";
const CHORD_V2 = "0x41a2bb48a9271c7dc4cf3e36d70f497abf2878e8"; // ChordOTCv2: offers never hold funds
// ChordOTC v2.1 (committed amounts per maker, maker's max fee). Fill in the address once deployed; until then
// Cadence keeps using v2. v2.1's create functions take one more argument (maxFeeBps).
const CHORD_V21 = "0xcDAA3E1A661B59f7eA9d8804c971C12D2A0dE5c4"; // deployed 24 Nov 2026
const CHORD = (CHORD_V21 || CHORD_V2).toLowerCase();
const CHORD_SITE = "https://chordotc.com/";
// Arc's explorer (Blockscout) refuses requests without a browser-like User-Agent, which Workers don't send.
const EXPLORER_HEADERS = { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; Cadence/0.3; +https://chordotc.com/cadence/)" };
const SEL = { nextOfferId: "0x5f5d0655", getOffer: "0x4579268a", offerReady: "0xb9c73968", feeBps: "0x24a9d853", paused: "0x5c975abb",
  createUsdc: "0xdc94e565", createToken: "0x6332c991", fill: "0x85dba861", cancel: "0xef706adf", approve: "0x095ea7b3",
  allowance: "0xdd62ed3e", balanceOf: "0x70a08231", symbol: "0x95d89b41", decimals: "0x313ce567", maxOfferAmount: "0x8848bfa6",
  createUsdc21: "0x784ff6ea", createToken21: "0xb9e5709e", committed: "0x0423dfab" };

// The ten tokens listed on Chord OTC, matched by address (Arc has look-alike tokens with the same names).
const TOKENS = {
  USDC:    { addr: USDC, dec: 6 },
  EURC:    { addr: "0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1", dec: 6,  v3Fee: 500 },
  WETH:    { addr: "0x128cc466b61f542da60c70e3aa11c10e19b84edb", dec: 18, v3Fee: 3000 },
  cirBTC:  { addr: "0x171a4217b86a807a64eb94757db6849fb4bdbaa0", dec: 8,  v3Fee: 100 },
  LINK:    { addr: "0x76a443768a5e3b8d1aed0105fc250877841deb40", dec: 18 },
  VIRTUAL: { addr: "0x8c4252c87081c88c6ad57d6dd97e1cafebf842b7", dec: 18 },
  ARGUS:   { addr: "0xece5ca8bf9220718e5727754026757512212cb3c", dec: 18, v3Fee: 10000 },
  ARCUS:   { addr: "0xb7c934ff18730c24e6113bb4bc5a68feef16fd29", dec: 18 },
  GBPA:    { addr: "0xbbe6aab0ed76e90aea0d1cd978ec231c8adcdf8b", dec: 6 },
  MXNB:    { addr: "0xf197ffc28c23e0309b5559e7a166f2c6164c80aa", dec: 6 },
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

// Arc's public endpoints (docs.arc.io "RPC endpoints"), no key needed. They're tried first, starting on a different
// one each time, and ARC_RPC_URL (a private key, e.g. Alchemy) is only the last resort, so its monthly plan lasts.
const PUBLIC_RPCS = [["public arc.io", ARC_RPC], ["public dRPC", "https://rpc.drpc.mainnet.arc.io"],
  ["public QuickNode", "https://rpc.quicknode.mainnet.arc.io"], ["public Blockdaemon", "https://rpc.blockdaemon.mainnet.arc.io"]];
let rpcTurn = 0;
async function rpc(env, method, params) {
  // Labels only — never include the URL itself, since ARC_RPC_URL may embed an API key.
  const k = rpcTurn++ % PUBLIC_RPCS.length;
  const pub = [...PUBLIC_RPCS.slice(k), ...PUBLIC_RPCS.slice(0, k)];
  const endpoints = (env.ARC_RPC_URL && env.PRIVATE_RPC_FIRST === "1" ? [["custom ARC_RPC_URL", env.ARC_RPC_URL], ...pub] : [...pub, ["custom ARC_RPC_URL", env.ARC_RPC_URL]]).filter(([, url]) => url);
  const failures = [];
  for (const [label, url] of endpoints) {
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 600));
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        if (!r.ok) { last = `HTTP ${r.status} ${r.statusText}`.trim(); continue; }
        const j = await r.json();
        if (j.error) { last = j.error.message; continue; }
        return j.result;
      } catch (e) { last = e.message; }
    }
    failures.push(`${label}: ${last}`);
  }
  throw new Error("Arc RPC unavailable: " + failures.join("; "));
}
const call = (env, to, data) => rpc(env, "eth_call", [{ to, data }, "latest"]);
const chordAddr = env => (env.CHORD_OTC && isAddr(env.CHORD_OTC) ? env.CHORD_OTC : CHORD).toLowerCase();
const isV21 = env => !!CHORD_V21 && chordAddr(env) === CHORD_V21.toLowerCase();
// Share links: v2.1 links carry c=2.1 so the site can tell them from older v2 links with the same id.
const offerLink = (env, id) => CHORD_SITE + (isV21(env) ? "#c=2.1&offer=" : "#offer=") + id;
const words = hex => (hex || "0x").slice(2).match(/.{64}/g) || [];
const wAddr = w => "0x" + w.slice(24);
function decodeString(hex) {
  const h = (hex || "0x").slice(2); if (!h) return null;
  try {
    let bytes;
    if (h.length >= 128 && BigInt("0x" + h.slice(0, 64)) === 32n) bytes = h.slice(128, 128 + Number(BigInt("0x" + h.slice(64, 128))) * 2);
    else bytes = h.slice(0, 64).replace(/(00)+$/, "");
    return decodeURIComponent(bytes.replace(/../g, "%$&")).replace(/[^\x20-\x7e]/g, "").slice(0, 16) || null;
  } catch { return null; }
}
// Listed tokens by address; anything else is read from the chain and marked unlisted.
const BY_ADDR = Object.fromEntries(Object.entries(TOKENS).map(([sym, t]) => [t.addr, { sym, dec: t.dec, listed: true }]));
async function tokenMeta(env, addr) {
  const a = addr.toLowerCase();
  if (BY_ADDR[a]) return BY_ADDR[a];
  const [s, d] = await Promise.all([call(env, a, SEL.symbol).catch(() => "0x"), call(env, a, SEL.decimals).catch(() => "0x")]);
  return { sym: decodeString(s) || "TOKEN", dec: d && d !== "0x" ? Number(BigInt(d)) : 18, listed: false };
}
const STATUS = ["none", "open", "filled", "cancelled"];
async function readOffer(env, id) {
  const w = words(await call(env, chordAddr(env), SEL.getOffer + word(id)));
  if (w.length < 10) throw new Error("couldn't read offer " + id);
  const o = { id, maker: wAddr(w[0]), taker: wAddr(w[1]), token: wAddr(w[2]), amountUsdc: BigInt("0x" + w[3]), amountToken: BigInt("0x" + w[4]),
    makerGivesUsdc: BigInt("0x" + w[5]) === 1n, status: STATUS[Number(BigInt("0x" + w[6]))] || "unknown",
    createdAt: Number(BigInt("0x" + w[7])), expiresAt: Number(BigInt("0x" + w[8])), feeBps: Number(BigInt("0x" + w[9])) };
  if (o.maker === "0x0000000000000000000000000000000000000000") throw new Error("offer " + id + " doesn't exist");
  return o;
}
async function describeOffer(env, o, withReady = true) {
  const t = await tokenMeta(env, o.token);
  const usdc = fromUnits(o.amountUsdc, 6), tok = fromUnits(o.amountToken, t.dec);
  const open = o.status === "open" && (!o.expiresAt || o.expiresAt * 1000 > Date.now());
  const ready = withReady && open ? BigInt(await call(env, chordAddr(env), SEL.offerReady + word(o.id))) === 1n : null;
  return { id: o.id, status: open ? "open" : o.status === "open" ? "expired" : o.status,
    maker_gives: o.makerGivesUsdc ? `${usdc} USDC` : `${tok} ${t.sym}`, maker_wants: o.makerGivesUsdc ? `${tok} ${t.sym}` : `${usdc} USDC`,
    price_usdc_per_token: Number(tok) ? +(Number(usdc) / Number(tok)).toPrecision(8) : null,
    token: { address: o.token, symbol: t.sym, decimals: t.dec, listed_on_chord: t.listed, ...(t.listed ? {} : { warning: "Not on Chord's token list: check the address, and run chord_token_check." }) },
    maker: o.maker, private_taker: o.taker === "0x0000000000000000000000000000000000000000" ? null : o.taker,
    expires: o.expiresAt ? new Date(o.expiresAt * 1000).toISOString() : null, fee_pct: o.feeBps / 100,
    fillable_now: ready, ...(ready === false ? { why_not: "The maker no longer has the balance or approval for this offer, so a fill would fail." } : {}),
    link: offerLink(env, o.id) };
}
const tx = (to, data, what) => ({ to, value: "0", data, what });

// Reach Riptide through the service binding when present (required on Cloudflare: error 1042 otherwise).
async function riptide(env, path) {
  const r = await (env.RIPTIDE ? env.RIPTIDE.fetch(RIPTIDE + path) : fetch(RIPTIDE + path));
  const text = await r.text();
  if (!r.ok) throw new Error(`Riptide ${path} failed: HTTP ${r.status} ${text.slice(0, 120)}`);
  try { return JSON.parse(text); } catch { throw new Error(`Riptide ${path} returned non-JSON: ${text.slice(0, 120)}`); }
}

// ---------- tools ----------
const TOOLS = [
  {
    name: "arc_balances",
    description: "Balances of the ten Chord-listed tokens (USDC, EURC, GBPA, MXNB, WETH, cirBTC, LINK, VIRTUAL, ARGUS, ARCUS) for any Arc mainnet address. Read-only.",
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
      token: { type: "string", enum: QUOTABLE, description: "Token to quote against USDC" }, side: { type: "string", enum: ["buy", "sell"], description: "buy: spend USDC for the token; sell: sell the token for USDC" },
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
    async run(_, env) {
      const j = await riptide(env, "/api/latest");
      return { checked_at: j.rows?.[0] ? new Date(j.rows[0].ts * 1000).toISOString() : null,
        rows: (j.rows || []).map(r => ({ pair: r.pair, size_usd: r.size, against: r.ref_src, best_gap_after_costs_pct: r.net_best == null ? null : +(r.net_best * 100).toFixed(3),
          would_trade: !!r.would_trade, paused: r.alert || null, error: r.error || null })),
        dashboard: "https://benjiprojects1404-services.pages.dev/riptide/" };
    },
  },
  {
    name: "riptide_rug_alarms",
    description: "Rug-alarm events from Riptide: sudden price drops (20%+) or liquidity pulled (50%+) between two checks five minutes apart, on the Arc pools it watches.",
    inputSchema: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 30, description: "Look-back in days (default 7)" } } },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run({ days = 7 }, env) {
      const j = await riptide(env, `/api/events?days=${Math.min(30, Math.max(1, days | 0))}`);
      return { days, thresholds: j.rugAlarm, events: (j.rows || []).map(e => ({ at: new Date(e.ts * 1000).toISOString(), pair: e.pair, pool: e.pool, kind: e.kind, change_pct: +(e.change * 100).toFixed(1) })) };
    },
  },
  {
    name: "crescent_payment_link",
    description: "Make a Crescent payment link: whoever opens it can pay `amount` of `token` straight to `to` on Arc mainnet (no contract in between), and the page shows when the payment arrives. Only builds the link; nothing is signed or sent.",
    inputSchema: { type: "object", properties: {
      to: { type: "string", description: "Recipient Arc address" }, token: { type: "string", enum: Object.keys(TOKENS), description: "Token to be paid in" },
      amount: { type: "string", description: "Decimal amount, e.g. 25 or 12.5" }, note: { type: "string", maxLength: 120, description: "Optional note shown to the payer, e.g. an invoice number" } }, required: ["to", "token", "amount"] },
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
      to: { type: "string", description: "Recipient Arc address from the payment link" }, token: { type: "string", enum: Object.keys(TOKENS), description: "Token the link asks for" }, amount: { type: "string", description: "Exact decimal amount the link asks for" },
      from_block: { type: "integer", minimum: 0, description: "Optional: only look at transfers from this Arc block on (the link's b= value)" } }, required: ["to", "token", "amount"] },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run({ to, token, amount, from_block = 0 }) {
      if (!isAddr(to)) throw new Error("to must be a 0x address");
      const t = TOKENS[token]; if (!t) throw new Error("unknown token");
      const want = toUnits(amount, t.dec).toString();
      const r = await fetch(`${EXPLORER}/api/v2/addresses/${to}/token-transfers?type=ERC-20&filter=to&token=${t.addr}`, { headers: EXPLORER_HEADERS });
      if (!r.ok) throw new Error("explorer " + r.status);
      const j = await r.json();
      const hit = (j.items || []).find(i => i.to?.hash?.toLowerCase() === to.toLowerCase() && i.token?.address_hash?.toLowerCase() === t.addr
        && i.total?.value === want && Number(i.block_number) >= from_block);
      return hit ? { paid: true, tx: `${EXPLORER}/tx/${hit.transaction_hash}`, from: hit.from?.hash, at: hit.timestamp, block: hit.block_number }
        : { paid: false, note: "No matching transfer among the address's latest transfers of this token." };
    },
  },
  {
    name: "chord_offers",
    description: "Open offers on Chord OTC (peer-to-peer ERC-20 <-> USDC trades on Arc mainnet where funds never leave the maker's wallet until a fill). Newest first, with price, token (listed or not), private taker if any, expiry and whether each can be filled right now. Read-only.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, description: "How many recent offers to scan (default 20)" },
      token: { type: "string", description: "Optional: only offers in this token (symbol of a listed token, or an address)" } } },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run({ limit = 20, token }, env) {
      const next = Number(BigInt(await call(env, chordAddr(env), SEL.nextOfferId)));
      const n = Math.min(50, Math.max(1, limit | 0));
      const want = token ? (isAddr(token) ? token.toLowerCase() : TOKENS[token]?.addr) : null;
      if (token && !want) throw new Error("token must be a listed symbol (" + Object.keys(TOKENS).join(", ") + ") or an address");
      const out = [];
      for (let id = next - 1; id >= 1 && id >= next - n; id--) {
        const o = await readOffer(env, id);
        if (o.status !== "open" || (o.expiresAt && o.expiresAt * 1000 <= Date.now())) continue;
        if (want && o.token.toLowerCase() !== want) continue;
        out.push(await describeOffer(env, o));
      }
      const [fee, paused] = await Promise.all([call(env, chordAddr(env), SEL.feeBps), call(env, chordAddr(env), SEL.paused)]);
      return { contract: chordAddr(env), network: "Arc mainnet (5042)", desk_fee_pct: Number(BigInt(fee)) / 100, paused: BigInt(paused) === 1n,
        scanned_latest: Math.min(n, next - 1), open_offers: out, site: CHORD_SITE };
    },
  },
  {
    name: "chord_offer",
    description: "One Chord OTC offer by id: terms, status, whether it can be filled right now, and what a taker must approve first. Read-only.",
    inputSchema: { type: "object", properties: { id: { type: "integer", minimum: 1, description: "Chord OTC offer id" } }, required: ["id"] },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run({ id }, env) {
      const o = await readOffer(env, id | 0);
      const d = await describeOffer(env, o);
      const t = await tokenMeta(env, o.token);
      d.taker_must_approve = o.makerGivesUsdc ? `${fromUnits(o.amountToken, t.dec)} ${t.sym} (token ${o.token}) to ${chordAddr(env)}` : `${fromUnits(o.amountUsdc, 6)} USDC to ${chordAddr(env)}`;
      return d;
    },
  },
  {
    name: "chord_prepare",
    description: "Prepare UNSIGNED Chord OTC transactions for the user to review and sign in their own wallet: create an offer, fill one, or cancel one. Returns the transactions in order (an approval first when needed) plus a plain-English summary. Nothing is signed or sent by this tool. Funds never sit in Chord: the maker's side stays in their wallet under an approval until a fill moves both sides in one transaction.",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["create", "fill", "cancel"], description: "create a new offer, fill an open one, or cancel your own" },
      wallet: { type: "string", description: "The user's Arc address (used to check balance, approval and eligibility)" },
      id: { type: "integer", minimum: 1, description: "Offer id (fill or cancel)" },
      give: { type: "string", enum: ["USDC", "token"], description: "create: which side the user gives" },
      token: { type: "string", description: "create: the non-USDC token (listed symbol or address)" },
      token_amount: { type: "string", description: "create: amount of the token" },
      usdc_amount: { type: "string", description: "create: amount of USDC" },
      private_taker: { type: "string", description: "create, optional: only this address may fill" },
      expires_in_hours: { type: "number", minimum: 0, description: "create, optional: 0 or omitted = no expiry" } }, required: ["action", "wallet"] },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(a, env) {
      if (!isAddr(a.wallet)) throw new Error("wallet must be a 0x address");
      const chord = chordAddr(env), me = a.wallet.toLowerCase();
      const bal = async (tok) => BigInt(await call(env, tok, SEL.balanceOf + addrWord(me)));
      const allowed = async (tok) => BigInt(await call(env, tok, SEL.allowance + addrWord(me) + addrWord(chord)));
      const steps = [], notes = [];
      if (BigInt(await call(env, chord, SEL.paused)) === 1n && a.action !== "cancel") throw new Error("Chord is paused for new offers and fills right now. Cancelling still works.");

      if (a.action === "cancel") {
        const o = await readOffer(env, a.id | 0);
        if (o.status !== "open") throw new Error(`offer ${o.id} is ${o.status}, so there's nothing to cancel`);
        if (o.maker.toLowerCase() !== me) throw new Error("only the offer's maker can cancel it");
        steps.push(tx(chord, SEL.cancel + word(o.id), `Cancel offer #${o.id}`));
        notes.push("Nothing comes back to your wallet because nothing ever left it. Revoking the approval also stops any fill.");
        return { action: "cancel", summary: `Cancel Chord offer #${o.id}.`, transactions: steps, notes, network: "Arc mainnet (5042)" };
      }

      if (a.action === "fill") {
        const o = await readOffer(env, a.id | 0);
        const d = await describeOffer(env, o);
        if (d.status !== "open") throw new Error(`offer ${o.id} is ${d.status}`);
        if (o.maker.toLowerCase() === me) throw new Error("you can't fill your own offer");
        if (d.private_taker && d.private_taker.toLowerCase() !== me) throw new Error("this offer is private to another address");
        if (d.fillable_now === false) throw new Error(d.why_not);
        const [payTok, payAmt, payDec, paySym] = o.makerGivesUsdc ? [o.token, o.amountToken, (await tokenMeta(env, o.token)).dec, d.token.symbol] : [USDC, o.amountUsdc, 6, "USDC"];
        // v2.1: the wallet's own open offers on this asset must stay backed after the fill, so the balance and
        // approval have to cover them plus this fill.
        const mine = isV21(env) ? BigInt(await call(env, chord, SEL.committed + addrWord(me) + addrWord(payTok))) : 0n;
        if (await bal(payTok) < payAmt + mine) throw new Error(mine
          ? `the wallet needs ${fromUnits(payAmt + mine, payDec)} ${paySym}: ${fromUnits(payAmt, payDec)} for this fill plus ${fromUnits(mine, payDec)} backing its own open Chord offers`
          : `the wallet holds less than the ${fromUnits(payAmt, payDec)} ${paySym} this fill needs`);
        if (await allowed(payTok) < payAmt + mine) steps.push(tx(payTok, SEL.approve + addrWord(chord) + word(payAmt + mine), mine
          ? `Approve Chord for ${fromUnits(payAmt + mine, payDec)} ${paySym}: this fill plus the ${fromUnits(mine, payDec)} behind your own open offers`
          : `Approve Chord to move exactly ${fromUnits(payAmt, payDec)} ${paySym}`));
        steps.push(tx(chord, SEL.fill + word(o.id), `Fill offer #${o.id}`));
        const fee = (o.amountUsdc * BigInt(o.feeBps)) / 10000n;
        if (!d.token.listed_on_chord) notes.push(d.token.warning);
        if (fee) notes.push(`The ${o.feeBps / 100}% fee (${fromUnits(fee, 6)} USDC) comes out of the USDC side.`);
        return { action: "fill", summary: `You pay ${d.maker_wants} and receive ${d.maker_gives}${fee && o.makerGivesUsdc ? " (minus the fee)" : ""}, wallet to wallet, in one transaction.`, offer: d, transactions: steps, notes, network: "Arc mainnet (5042)" };
      }

      if (a.action === "create") {
        if (a.give !== "USDC" && a.give !== "token") throw new Error("give must be USDC or token");
        const tokAddr = (isAddr(a.token) ? a.token : TOKENS[a.token]?.addr || "").toLowerCase();
        if (!isAddr(tokAddr) || tokAddr === USDC) throw new Error("token must be a listed symbol or an address, and not USDC");
        const t = await tokenMeta(env, tokAddr);
        const amtTok = toUnits(a.token_amount, t.dec), amtUsdc = toUnits(a.usdc_amount, 6);
        if (!amtTok || !amtUsdc) throw new Error("token_amount and usdc_amount must both be above zero");
        let taker = "0x0000000000000000000000000000000000000000";
        if (a.private_taker) { if (!isAddr(a.private_taker)) throw new Error("private_taker must be a 0x address"); taker = a.private_taker; }
        if (taker.toLowerCase() === me) throw new Error("you can't make an offer to yourself");
        const exp = a.expires_in_hours ? Math.floor(Date.now() / 1000 + a.expires_in_hours * 3600) : 0;
        const [giveTok, giveAmt, giveDec, giveSym] = a.give === "USDC" ? [USDC, amtUsdc, 6, "USDC"] : [tokAddr, amtTok, t.dec, t.sym];
        const v21 = isV21(env);
        const mine = v21 ? BigInt(await call(env, chord, SEL.committed + addrWord(me) + addrWord(giveTok))) : 0n;
        const needGive = giveAmt + mine; // v2.1: every open offer on this asset plus the new one
        if (await bal(giveTok) < needGive) throw new Error(mine
          ? `the wallet needs ${fromUnits(needGive, giveDec)} ${giveSym}: ${fromUnits(giveAmt, giveDec)} for this offer plus ${fromUnits(mine, giveDec)} already promised in its open Chord offers`
          : `the wallet holds less than ${fromUnits(giveAmt, giveDec)} ${giveSym}, and Chord checks the balance when the offer is made`);
        for (const [tok, amt, dec, sym] of [[USDC, amtUsdc, 6, "USDC"], [tokAddr, amtTok, t.dec, t.sym]]) {
          const cap = BigInt(await call(env, chord, SEL.maxOfferAmount + addrWord(tok)));
          if (cap && amt > cap) throw new Error(`${fromUnits(amt, dec)} ${sym} is over Chord's per-offer limit of ${fromUnits(cap, dec)} ${sym} during the beta`);
        }
        if (await allowed(giveTok) < needGive) steps.push(tx(giveTok, SEL.approve + addrWord(chord) + word(needGive), mine
          ? `Approve Chord for ${fromUnits(needGive, giveDec)} ${giveSym}: this offer plus your ${fromUnits(mine, giveDec)} in open offers (it all stays in your wallet until filled)`
          : `Approve Chord to move exactly ${fromUnits(giveAmt, giveDec)} ${giveSym} when the offer is filled (it stays in your wallet until then)`));
        let data;
        if (v21) {
          // maxFeeBps = today's fee: if the fee goes up before this is signed, the create fails instead of charging more.
          const fee = BigInt(await call(env, chord, SEL.feeBps));
          data = (a.give === "USDC" ? SEL.createUsdc21 : SEL.createToken21) + addrWord(tokAddr) + word(amtTok) + word(amtUsdc) + addrWord(taker) + word(exp) + word(fee);
          notes.push(`The fee is locked at today's ${Number(fee) / 100}%: if it rises before you sign, the transaction fails rather than charging more.`);
        } else {
          data = (a.give === "USDC" ? SEL.createUsdc : SEL.createToken) + addrWord(tokAddr) + word(amtTok) + word(amtUsdc) + addrWord(taker) + word(exp);
        }
        steps.push(tx(chord, data, "Create the offer"));
        if (!t.listed) notes.push("This token isn't on Chord's list. Run chord_token_check before trading it.");
        notes.push("After it's created, the site shows it at " + CHORD_SITE + "; share the offer link with your counterparty.");
        return { action: "create", summary: `Offer ${a.give === "USDC" ? `${fromUnits(amtUsdc, 6)} USDC for ${fromUnits(amtTok, t.dec)} ${t.sym}` : `${fromUnits(amtTok, t.dec)} ${t.sym} for ${fromUnits(amtUsdc, 6)} USDC`}${taker !== "0x0000000000000000000000000000000000000000" ? `, only for ${taker}` : ""}${exp ? `, expiring ${new Date(exp * 1000).toISOString()}` : ""}. Your side stays in your wallet until someone fills it.`,
          transactions: steps, notes, network: "Arc mainnet (5042)" };
      }
      throw new Error("action must be create, fill or cancel");
    },
  },
  {
    name: "chord_token_check",
    description: "Safety check of any Arc token's code, the same check Chord's site runs on unlisted tokens: upgradeable proxy, owner powers (mint, pause, block wallets, change a tax, cap wallets, switch trading off) and a live transfer tax (which Chord refuses). Facts, not a rating. Read-only.",
    inputSchema: { type: "object", properties: { token: { type: "string", description: "Token address on Arc" } }, required: ["token"] },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run({ token }, env) {
      if (!isAddr(token)) throw new Error("token must be a 0x address");
      const a = token.toLowerCase(), meta = await tokenMeta(env, a);
      const code = await rpc(env, "eth_getCode", [a, "latest"]);
      if (!code || code === "0x") return { token: a, verdict: "no contract at this address" };
      const [impl, beacon] = await Promise.all(["0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50"]
        .map(slot => rpc(env, "eth_getStorageAt", [a, slot, "latest"])));
      let logic = code, upgradeable = false;
      if (BigInt(impl) > 0n) { upgradeable = true; logic = await rpc(env, "eth_getCode", ["0x" + impl.slice(26), "latest"]); }
      else if (BigInt(beacon) > 0n) { upgradeable = true; try { const bi = await call(env, "0x" + beacon.slice(26), "0x5c60da1b"); logic = await rpc(env, "eth_getCode", ["0x" + bi.slice(26), "latest"]); } catch {} }
      const sels = new Set(); for (const c of upgradeable ? [logic, code] : [logic]) { const h = c.slice(2); for (let i = 0; i < h.length;) { const op = parseInt(h.substr(i, 2), 16); i += 2; if (op >= 0x60 && op <= 0x7f) { if (op === 0x63) sels.add(h.substr(i, 8)); else if (op === 0x62) sels.add("00" + h.substr(i, 6)); i += (op - 0x5f) * 2; } } }
      const POW = { "mint new tokens": ["40c10f19", "a0712d68", "4e6ec247", "449a52f8", "cc872b66"], "block wallets": ["f9f92be4", "44337ea1", "153b0d1e", "455a4396", "342aa8b5", "9c0db5f3", "ffecf516", "00b8cf2a", "a0e38492", "8d1fdf2f"],
        "pause transfers": ["8456cb59", "16c38b3c"], "change a transfer tax": ["69fe0e2d", "0b78f9c0", "2e5bb6ff", "c647b20e", "6db79437", "0cc835a3", "8b4cee08", "061c82d0", "8095d564", "c17b5b8c", "7ce3489b"],
        "cap wallet sizes": ["ec28438a", "5d0044ca", "d543dbeb", "203e727e", "c18bc195", "ea1644d5"], "switch trading off": ["8a8c523c", "c9567bf9", "c2e5ec04", "8f70ccf7", "293230b8"] };
      let owner = null; try { const r = await call(env, a, "0x8da5cb5b"); if (r && r.length >= 66) owner = "0x" + r.slice(26, 66); } catch {}
      const renounced = owner && /^0x0{40}$|^0x0{36}dead$/i.test(owner) && !sels.has("91d14854");
      const powers = renounced ? [] : Object.entries(POW).filter(([, s]) => s.some(x => sels.has(x))).map(([k]) => k);
      let tax = null;
      for (const x of ["24a9d853", "3eacd2f8", "5de78d7a", "77d2300e", "23cbe1f3", "a071dcf4", "3b124fe7", "4f7041a5", "cc1776d3", "42a11095", "ca9ec199", "47062402", "2b14ca56", "8124f7ac", "acb2ad6f", "13114a9d", "d85ba063", "6a486a8e", "98118cb4", "771a3a1d", "7fd6f15c"]) {
        if (!sels.has(x)) continue;
        try { const v = BigInt((await call(env, a, "0x" + x)).slice(0, 66)); if (v > 0n && v < 10n ** 6n) { tax = "0x" + x; break; } } catch {}
      }
      const flags = [...(tax ? ["charges a transfer tax, so a Chord trade with it will fail"] : []), ...(upgradeable ? ["upgradeable: its code can be replaced"] : []), ...powers.map(p => "the owner can " + p)];
      return { token: a, symbol: meta.sym, listed_on_chord: meta.listed, owner: owner && !renounced ? owner : renounced ? "renounced" : null,
        flags, clean: !flags.length, note: meta.listed ? "Listed on Chord (official tokens like USDC and EURC are upgradeable by design)." : "Facts read from the code, not a rating. Always check the address is the token you mean." };
    },
  },
];

// ---------- Pro tools (paid per call with x402) ----------
// Heavier reports built from Arc's explorer plus on-chain reads. Prices are in USDC base units (6 decimals).
async function explorer(path) {
  const r = await fetch(EXPLORER + "/api/v2" + path, { headers: EXPLORER_HEADERS });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Arc explorer ${path.split("?")[0]} failed: HTTP ${r.status}`);
  return r.json();
}
const usd = (amount, rate) => rate == null || amount == null ? null : +(Number(amount) * Number(rate)).toFixed(2);
const label = a => a ? (a.name || a.implementations?.[0]?.name || (/^0x0{36}dead$/i.test(a.hash) || /^0x0{40}$/.test(a.hash) ? "burn address" : null)) : null;

const PRO_TOOLS = [
  {
    name: "pro_wallet_report",
    price: 5000n, // $0.005
    description: "PRO ($0.005 per call, paid in USDC on Arc via x402). Full report on any Arc address: every ERC-20 it holds (not just Chord's list) with the explorer's USD estimate and scam flags, whether it's a wallet or a contract (and which kind, e.g. a Safe), when it was created, its 20 latest token transfers in and out with counterparties, and any open Chord OTC offers it made. Read-only.",
    inputSchema: { type: "object", properties: { address: { type: "string", description: "Arc address, 0x…" } }, required: ["address"] },
    annotations: { readOnlyHint: true, openWorldHint: true },
    summary: "Full report on any Arc wallet or contract",
    example: { address: "0xc3FC2A5D1E7e2F5d597bE891e4BC36F117D9d4B6" },
    outputExample: { address: "0xc3FC…d4B6", network: "Arc mainnet (5042)", kind: "contract (GnosisSafeL2)", total_usd_estimate: 120.5,
      holdings: [{ symbol: "USDC", amount: "120.5", usd_estimate: 120.5, listed_on_chord: true }],
      latest_transfers: [{ at: "2026-11-24T08:00:00Z", direction: "in", token: "USDC", amount: "0.005" }], open_chord_offers: [] },
    async run({ address }, env) {
      if (!isAddr(address)) throw new Error("address must be a 0x address");
      const a = address.toLowerCase();
      const [info, toks, xfers] = await Promise.all([explorer(`/addresses/${a}`), explorer(`/addresses/${a}/tokens?type=ERC-20`), explorer(`/addresses/${a}/token-transfers?type=ERC-20`)]);
      const holdings = (toks?.items || []).map(i => {
        const dec = Number(i.token?.decimals ?? 18), amt = fromUnits(BigInt(i.value || 0), dec), addr = i.token?.address_hash?.toLowerCase();
        return { symbol: i.token?.symbol, name: i.token?.name, address: addr, amount: amt, usd_estimate: usd(amt, i.token?.exchange_rate),
          listed_on_chord: !!BY_ADDR[addr], reputation: i.token?.reputation || null };
      }).sort((x, y) => (y.usd_estimate || 0) - (x.usd_estimate || 0));
      const transfers = (xfers?.items || []).slice(0, 20).map(t => {
        const out = t.from?.hash?.toLowerCase() === a, other = out ? t.to : t.from, dec = Number(t.total?.decimals ?? t.token?.decimals ?? 18);
        return { at: t.timestamp, direction: out ? "out" : "in", token: t.token?.symbol, amount: fromUnits(BigInt(t.total?.value || 0), dec),
          counterparty: other?.hash, counterparty_label: label(other), method: t.method || null, tx: `${EXPLORER}/tx/${t.transaction_hash}` };
      });
      const offers = [];
      try {
        const next = Number(BigInt(await call(env, chordAddr(env), SEL.nextOfferId)));
        for (let id = next - 1; id >= 1 && id >= next - 50; id--) {
          const o = await readOffer(env, id);
          if (o.maker.toLowerCase() === a && o.status === "open" && (!o.expiresAt || o.expiresAt * 1000 > Date.now())) offers.push(await describeOffer(env, o));
        }
      } catch { /* Chord read failed: report the rest */ }
      return { address, network: "Arc mainnet (5042)",
        kind: info?.is_contract ? (info.implementations?.[0]?.name ? `contract (${info.implementations[0].name})` : "contract") : "wallet",
        created: info?.creation_transaction_hash ? { by: info.creator_address_hash, tx: `${EXPLORER}/tx/${info.creation_transaction_hash}` } : null,
        explorer_flags: { scam: !!info?.is_scam, reputation: info?.reputation || null },
        total_usd_estimate: +holdings.reduce((s, h) => s + (h.usd_estimate || 0), 0).toFixed(2), holdings, latest_transfers: transfers,
        open_chord_offers: offers, note: "USD figures are the Arc explorer's estimates, not a price quote." };
    },
  },
  {
    name: "pro_token_report",
    price: 5000n, // $0.005
    description: "PRO ($0.005 per call, paid in USDC on Arc via x402). Deep report on any Arc token: the code check from chord_token_check (upgradeable, owner powers, transfer tax), plus holders count, supply, 24h volume, the top 10 holders with their share of supply and who they are (burn address, Uniswap pool, contract, wallet), how concentrated it is outside burns and pools, and any Riptide rug alarms on it in the last 30 days. Facts, not a rating. Read-only.",
    inputSchema: { type: "object", properties: { token: { type: "string", description: "Token address on Arc" } }, required: ["token"] },
    annotations: { readOnlyHint: true, openWorldHint: true },
    summary: "Deep safety and holder report on any Arc token",
    example: { token: "0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1" },
    outputExample: { symbol: "EURC", upgradeable: true, flags: ["upgradeable: its code can be replaced"], holders_count: 1520,
      top_holders: [{ address: "0x…", kind: "liquidity pool", pct_of_supply: 12.4 }],
      concentration: { top10_outside_burn_and_pools_pct: 31.2, largest_single_holder_pct: 9.8 }, riptide_rug_alarms_30d: [] },
    async run({ token }, env) {
      if (!isAddr(token)) throw new Error("token must be a 0x address");
      const a = token.toLowerCase();
      const check = await TOOLS.find(t => t.name === "chord_token_check").run({ token: a }, env);
      if (check.verdict) return check;
      const [info, holders, alarms] = await Promise.all([explorer(`/tokens/${a}`), explorer(`/tokens/${a}/holders`), riptide(env, "/api/events?days=30").catch(() => null)]);
      const dec = Number(info?.decimals ?? 18), supply = BigInt(info?.total_supply || 0);
      const pct = v => supply ? +(Number((BigInt(v) * 1000000n) / supply) / 10000).toFixed(2) : null;
      const top = (holders?.items || []).slice(0, 10).map(h => {
        const l = label(h.address);
        const kind = l === "burn address" ? "burn" : /pool|pair/i.test(l || "") ? "liquidity pool" : h.address?.is_contract ? "contract" : "wallet";
        return { address: h.address?.hash, label: l, kind, amount: fromUnits(BigInt(h.value || 0), dec), pct_of_supply: pct(h.value || 0) };
      });
      const other = top.filter(h => h.kind === "wallet" || h.kind === "contract");
      const sym = (info?.symbol || check.symbol || "").toUpperCase();
      return { ...check, name: info?.name || null, holders_count: info?.holders_count ? Number(info.holders_count) : null,
        total_supply: supply ? fromUnits(supply, dec) : null, volume_24h_usd: info?.volume_24h ? Number(info.volume_24h) : null,
        explorer_reputation: info?.reputation || null, top_holders: top,
        concentration: { top10_outside_burn_and_pools_pct: +other.reduce((s, h) => s + (h.pct_of_supply || 0), 0).toFixed(2),
          largest_single_holder_pct: other[0]?.pct_of_supply ?? 0 },
        riptide_rug_alarms_30d: alarms ? (alarms.rows || []).filter(e => String(e.pair || "").toUpperCase().includes(sym) && sym).map(e => ({ at: new Date(e.ts * 1000).toISOString(), pair: e.pair, kind: e.kind, change_pct: +(e.change * 100).toFixed(1) })) : null,
        note: "Facts from the token's code and Arc's explorer, not a rating or advice." };
    },
  },
];
const priceText = p => "$" + (Number(p) / 1e6).toString();

// x402 Bazaar discovery metadata (extensions.bazaar), so catalogs such as Circle's Agent Marketplace can list each tool.
const bazaar = tool => ({ bazaar: { info: {
  input: { type: "http", method: "POST", bodyType: "json", body: tool.example },
  output: { type: "json", example: tool.outputExample } },
  schema: { input: tool.inputSchema } } });

// OpenAPI 3.1 for the paid HTTP routes (POST /x402/<tool>), with x-payment-info so agents can see what each call costs.
function openapi(origin, env) {
  const w = seller(env);
  const paths = {};
  for (const t of PRO_TOOLS) paths["/x402/" + t.name] = { post: {
    operationId: t.name, summary: t.summary, description: t.description, tags: ["Pro"],
    "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: (Number(t.price) / 1e6).toFixed(6) },
      protocols: [{ x402: { version: 2, scheme: "exact", network: NETWORK, asset: USDC, payTo: w ? w.address : null } }] },
    requestBody: { required: true, content: { "application/json": { schema: t.inputSchema, example: t.example } } },
    responses: {
      200: { description: "The report. The PAYMENT-RESPONSE header carries the settlement.", content: { "application/json": { schema: { type: "object" }, example: t.outputExample } } },
      402: { description: "Payment Required. The PAYMENT-REQUIRED header (base64 JSON) lists the price; retry with a PAYMENT-SIGNATURE header." },
      400: { description: "Bad input. Nothing is charged." } } } };
  return { openapi: "3.1.0",
    info: { title: "Cadence", version: SERVER.version,
      description: "Pay-per-call reports on Circle's Arc mainnet: any wallet or token, read live from the chain and Arc's explorer. $0.005 in USDC on Arc per call via x402, settled by Circle. Read-only: nothing signs or sends on your behalf. Free tools are on the MCP endpoint at /mcp.",
      contact: { name: "Undercurrent Works", url: "https://chordotc.com/cadence/", email: "benjamin@chordotc.com" },
      "x-guidance": "POST JSON arguments to /x402/<tool>. The first call returns 402 with PAYMENT-REQUIRED; sign the x402 v2 exact (EIP-3009) authorization for USDC on eip155:5042 and retry with PAYMENT-SIGNATURE. A failed report is never charged." },
    servers: [{ url: origin }], tags: [{ name: "Pro", description: "Paid tools, $0.005 each" }], paths };
}

// Runs a Pro tool with x402: no payment -> PaymentRequired; payment -> check it, run the tool, settle, return.
// The tool runs before settling so a failed tool never charges; its result is only released once Circle settles.
async function runPaid(tool, args, payment, env, resourceUrl) {
  if (!seller(env)) return { status: 503, error: "Pro tools aren't switched on yet (no payment wallet configured)." };
  const req = requirements(env, tool.price, resourceUrl, `${tool.name}: ${priceText(tool.price)} per call`);
  req._resource = { ...req._resource, serviceName: "Cadence", tags: ["arc", "wallet", "token-safety", "onchain-data"] };
  req._extensions = bazaar(tool);
  if (!payment) return { status: 402, required: paymentRequired(req) };
  let payer;
  try { payer = await checkPayment(payment, req, { rpcCall: (to, data) => call(env, to, data) }); }
  catch (e) { return { status: 402, required: paymentRequired(req, "Payment invalid: " + e.message) }; }
  let result;
  try { result = await tool.run(args || {}, env); }
  catch (e) { return { status: 400, error: (e.message || String(e)) + " (nothing was charged)" }; }
  const s = await settle(env, payment, req);
  if (!s.success) return { status: 402, required: paymentRequired(req, "Payment could not be settled: " + s.error) };
  return { status: 200, result, settlement: { success: true, transaction: s.transaction, network: s.network || NETWORK, payer: s.payer || payer } };
}

// ---------- MCP over HTTP (stateless JSON-RPC) ----------
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id, payment-signature, x-payment",
  "access-control-expose-headers": "mcp-session-id, payment-required, payment-response" };
const b64 = o => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const unb64 = s => JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/")))));
const reply = (body, status = 200) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg, env, origin) {
  const { id, method, params = {} } = msg || {};
  const isNotification = id === undefined || id === null;
  switch (method) {
    case "initialize": {
      const v = PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
      return ok(id, { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER,
        instructions: "Cadence: tools for Circle's Arc mainnet: balances, Uniswap quotes, Riptide price gaps and rug alarms, Crescent payment links, and Chord OTC (open offers, token checks, and unsigned create/fill/cancel transactions for the user to sign in their own wallet). Nothing here signs or sends anything on the user's behalf. Tools named pro_* cost a fraction of a cent in USDC on Arc per call, paid with x402: call once to get the price, then retry with params._meta[\"x402/payment\"]. Use the free tools unless the user wants the deeper report." });
    }
    case "notifications/initialized": case "notifications/cancelled": return null;
    case "ping": return ok(id, {});
    case "tools/list": return ok(id, { tools: [...TOOLS.map(({ run, ...t }) => t), ...PRO_TOOLS.map(({ run, price, summary, example, outputExample, ...t }) => ({ ...t, _meta: { "x402/price": { amount: String(price), asset: "USDC", network: NETWORK } } }))] });
    case "tools/call": {
      const pro = PRO_TOOLS.find(t => t.name === params.name);
      if (pro) {
        const r = await runPaid(pro, params.arguments, params._meta?.["x402/payment"], env, `${origin}/mcp#${pro.name}`);
        if (r.status === 200) return ok(id, { content: [{ type: "text", text: JSON.stringify(r.result, null, 2) }], structuredContent: r.result, isError: false, _meta: { "x402/payment-response": r.settlement } });
        if (r.required) return ok(id, { content: [{ type: "text", text: JSON.stringify(r.required) }], structuredContent: r.required, isError: true });
        return ok(id, { content: [{ type: "text", text: "Error: " + r.error }], isError: true });
      }
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

// Plain-HTTP x402 for the Pro tools: POST /x402/<tool> with JSON arguments (or GET with ?query). Without a
// PAYMENT-SIGNATURE header the answer is 402 with PAYMENT-REQUIRED; with one, 200 plus PAYMENT-RESPONSE.
async function httpPaid(req, env, url) {
  const name = decodeURIComponent(url.pathname.slice("/x402/".length));
  const tool = PRO_TOOLS.find(t => t.name === name);
  if (!tool) return reply({ error: "unknown Pro tool", tools: PRO_TOOLS.map(t => t.name) }, 404);
  let args = Object.fromEntries(url.searchParams);
  if (req.method === "POST") { try { const t = await req.text(); if (t) args = { ...args, ...JSON.parse(t) }; } catch { return reply({ error: "body must be JSON arguments" }, 400); } }
  let payment = null;
  const h = req.headers.get("payment-signature") || req.headers.get("x-payment");
  if (h) { try { payment = unb64(h); } catch { return reply({ error: "PAYMENT-SIGNATURE must be base64 JSON" }, 400); } }
  const r = await runPaid(tool, args, payment, env, url.origin + url.pathname);
  if (r.status === 200) return new Response(JSON.stringify(r.result), { status: 200, headers: { "content-type": "application/json", "payment-response": b64(r.settlement), ...CORS } });
  if (r.required) return new Response(JSON.stringify(r.required), { status: 402, headers: { "content-type": "application/json", "payment-required": b64(r.required), ...CORS } });
  return reply({ error: r.error }, r.status);
}

const RPC_FOR_SWEEP = env => env.ARC_RPC_URL || ARC_RPC;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/" && req.method === "GET") {
      const w = seller(env);
      return reply({ name: SERVER.name, title: SERVER.title, version: SERVER.version, home: "https://chordotc.com/cadence/", mcp_endpoint: url.origin + "/mcp", transport: "streamable-http (stateless)",
        tools: TOOLS.map(t => t.name), openapi: url.origin + "/openapi.json",
        pro_tools: PRO_TOOLS.map(t => ({ name: t.name, price_usdc: Number(t.price) / 1e6, http: url.origin + "/x402/" + t.name })),
        payments: { protocol: "x402 v2, scheme exact", network: NETWORK, asset: "USDC", pay_to: w ? w.address : null, settled_by: "Circle Facilitator Service", enabled: !!w },
        read_only: true, signs_or_sends: "never on your behalf; payments only move USDC you authorise to Cadence's receive wallet", source: "https://github.com/benjiprojects1404-maker/benjiprojects1404-services/tree/main/arc-mcp" });
    }
    if ((url.pathname === "/openapi.json" || url.pathname === "/.well-known/openapi.json") && req.method === "GET") return reply(openapi(url.origin, env));
    if (url.pathname === "/.well-known/x402" && req.method === "GET") return reply({ version: 1, resources: PRO_TOOLS.map(t => url.origin + "/x402/" + t.name), openapi: url.origin + "/openapi.json" });
    if (url.pathname.startsWith("/x402/") && (req.method === "GET" || req.method === "POST")) return httpPaid(req, env, url);
    // Anyone may trigger a sweep: it can only send the receive wallet's USDC to the Chord Treasury Safe.
    if (url.pathname === "/sweep" && req.method === "POST") {
      try { return reply(await sweep(env, RPC_FOR_SWEEP(env))); } catch (e) { return reply({ swept: false, error: e.shortMessage || e.message }, 500); }
    }
    if (url.pathname !== "/mcp") return reply({ error: "not found" }, 404);
    if (req.method === "GET") return new Response("This MCP server doesn't stream; POST JSON-RPC to /mcp.", { status: 405, headers: { allow: "POST", ...CORS } });
    if (req.method !== "POST") return reply({ error: "method not allowed" }, 405);
    let body;
    try { body = await req.json(); } catch { return reply(err(null, -32700, "Parse error"), 400); }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(m => handle(m, env, url.origin)))).filter(Boolean);
      return out.length ? reply(out) : new Response(null, { status: 202, headers: CORS });
    }
    const res = await handle(body, env, url.origin);
    return res ? reply(res) : new Response(null, { status: 202, headers: CORS });
  },
  // Weekly: move Pro income from the receive wallet to the Chord Treasury Safe (only if there's at least 1 USDC).
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sweep(env, RPC_FOR_SWEEP(env)).then(r => console.log("sweep", JSON.stringify(r))).catch(e => console.log("sweep failed", e.message)));
  },
};

