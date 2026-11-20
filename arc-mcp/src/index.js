// Arc MCP: a read-only Model Context Protocol server for Circle's Arc mainnet (chain 5042).
// It lets an AI assistant (Claude, ChatGPT, Cursor...) read Arc balances, quote Uniswap pools, read Riptide's
// price gaps and rug alarms, make Crescent payment links and check whether a payment arrived.
// No wallet, no keys, nothing sent: every tool only reads public data, builds a link, or prepares an unsigned
// Chord OTC transaction for the user to review and sign in their own wallet.
//
// Transport: MCP "Streamable HTTP" in its simplest stateless form. Clients POST JSON-RPC to /mcp and get JSON back.

const SERVER = { name: "arc-mcp", version: "0.2.0" };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const ARC_RPC = "https://rpc.mainnet.arc.io";
const EXPLORER = "https://explorer.arc.io";
const RIPTIDE = "https://riptide.benjiprojects1404.workers.dev";
const CRESCENT = "https://chordotc.com/crescent/";
const USDC = "0x3600000000000000000000000000000000000000";
const QUOTER_V3 = "0x7dfd4f31be6814d2906bde155c3e1b146eac1468";
const CHORD = "0x41a2bb48a9271c7dc4cf3e36d70f497abf2878e8"; // ChordOTCv2: offers never hold funds
const CHORD_SITE = "https://chordotc.com/";
const SEL = { nextOfferId: "0x5f5d0655", getOffer: "0x4579268a", offerReady: "0xb9c73968", feeBps: "0x24a9d853", paused: "0x5c975abb",
  createUsdc: "0xdc94e565", createToken: "0x6332c991", fill: "0x85dba861", cancel: "0xef706adf", approve: "0x095ea7b3",
  allowance: "0xdd62ed3e", balanceOf: "0x70a08231", symbol: "0x95d89b41", decimals: "0x313ce567", maxOfferAmount: "0x8848bfa6" };

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
  // Labels only — never include the URL itself, since ARC_RPC_URL may embed an API key.
  const endpoints = [["custom ARC_RPC_URL", env.ARC_RPC_URL], ["public ARC_RPC", ARC_RPC]].filter(([, url]) => url);
  const failures = [];
  for (const [label, url] of endpoints) {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 800 * attempt));
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
    link: CHORD_SITE + "#offer=" + o.id };
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
    description: "Rug-alarm events from Riptide: sudden price drops (20%+) or liquidity pulled (50%+) between two one-minute checks, on the Arc pools it watches.",
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
    inputSchema: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"] },
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
      action: { type: "string", enum: ["create", "fill", "cancel"] },
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
        if (await bal(payTok) < payAmt) throw new Error(`the wallet holds less than the ${fromUnits(payAmt, payDec)} ${paySym} this fill needs`);
        if (await allowed(payTok) < payAmt) steps.push(tx(payTok, SEL.approve + addrWord(chord) + word(payAmt), `Approve Chord to move exactly ${fromUnits(payAmt, payDec)} ${paySym}`));
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
        if (await bal(giveTok) < giveAmt) throw new Error(`the wallet holds less than ${fromUnits(giveAmt, giveDec)} ${giveSym}, and Chord checks the balance when the offer is made`);
        for (const [tok, amt, dec, sym] of [[USDC, amtUsdc, 6, "USDC"], [tokAddr, amtTok, t.dec, t.sym]]) {
          const cap = BigInt(await call(env, chord, SEL.maxOfferAmount + addrWord(tok)));
          if (cap && amt > cap) throw new Error(`${fromUnits(amt, dec)} ${sym} is over Chord's per-offer limit of ${fromUnits(cap, dec)} ${sym} during the beta`);
        }
        if (await allowed(giveTok) < giveAmt) steps.push(tx(giveTok, SEL.approve + addrWord(chord) + word(giveAmt), `Approve Chord to move exactly ${fromUnits(giveAmt, giveDec)} ${giveSym} when the offer is filled (it stays in your wallet until then)`));
        const sel = a.give === "USDC" ? SEL.createUsdc : SEL.createToken;
        steps.push(tx(chord, sel + addrWord(tokAddr) + word(amtTok) + word(amtUsdc) + addrWord(taker) + word(exp), "Create the offer"));
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
        instructions: "Tools for Circle's Arc mainnet: balances, Uniswap quotes, Riptide price gaps and rug alarms, Crescent payment links, and Chord OTC (open offers, token checks, and unsigned create/fill/cancel transactions for the user to sign in their own wallet). Nothing here signs or sends anything." });
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
        tools: TOOLS.map(t => t.name), read_only: true, signs_or_sends: false, source: "https://github.com/benjiprojects1404-maker/benjiprojects1404-services/tree/main/arc-mcp" });
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
