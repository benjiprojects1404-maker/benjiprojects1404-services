// Tests for Cadence's paid (x402) Pro tools. Run: npm test (from arc-mcp/). Everything external is mocked:
// Arc RPC, the Arc explorer, Riptide and Circle's facilitator. Real EIP-712 signatures are used throughout.
import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, verifyTypedData, keccak256, toUtf8Bytes, hexlify, randomBytes } from "ethers";
import worker from "../src/index.js";

const SELLER = Wallet.createRandom();
const BUYER = Wallet.createRandom();
const OTHER = Wallet.createRandom();
const USDC = "0x3600000000000000000000000000000000000000";
const TOKEN = "0xece5ca8bf9220718e5727754026757512212cb3c";
const USDC_DOMAIN = { name: "USDC", version: "2", chainId: 5042, verifyingContract: USDC };
const AUTH_TYPES = { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };
const PROOF_DOMAIN = { name: "Circle Facilitator Seller Request", version: "1", chainId: 5042 };
const PROOF_TYPES = { SellerRequest: [{ name: "purpose", type: "string" }, { name: "method", type: "string" }, { name: "bodyHash", type: "bytes32" },
  { name: "network", type: "string" }, { name: "payTo", type: "address" }, { name: "nonce", type: "bytes32" }, { name: "issuedAt", type: "uint64" }, { name: "expiresAt", type: "uint64" }] };

let state;
function reset() { state = { settles: [], statuses: 0, settleMode: "success", buyerBalance: 10_000000n }; }
const word = v => "0x" + BigInt(v).toString(16).padStart(64, "0");
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://api.circle.com/v1/facilitator/x402/settle")) {
    state.settles.push({ headers: init.headers, body: init.body });
    if (state.settleMode === "success") return json({ success: true, payer: BUYER.address, transaction: "0xsettled", network: "eip155:5042", amount: "5000" });
    if (state.settleMode === "pending") return json({ success: false, errorReason: "settlement_pending", transaction: "", extensions: { "settlement-status": { status: "pending", paymentId: "pay_123" } } });
    return json({ success: false, errorReason: "insufficient_funds" }, 400);
  }
  if (url.startsWith("https://api.circle.com/v1/facilitator/x402/status/")) {
    state.statuses++; state.statusHeaders = init.headers;
    return json({ paymentId: "pay_123", status: state.statuses >= 2 ? "completed" : "pending", transaction: "0xlater", network: "eip155:5042", payer: BUYER.address });
  }
  if (url.startsWith("https://explorer.arc.io/api/v2/")) {
    const p = url.slice("https://explorer.arc.io/api/v2".length);
    if (p.startsWith(`/tokens/${TOKEN}/holders`)) return json({ items: [
      { address: { hash: "0x000000000000000000000000000000000000dEaD", is_contract: false }, value: "500000000000000000000000000" },
      { address: { hash: "0x6A3bAcAa6493734c1Ac221EBF42CF530A96C1e02", is_contract: true, name: "UniswapV3Pool" }, value: "200000000000000000000000000" },
      { address: { hash: "0x1111111111111111111111111111111111111111", is_contract: false }, value: "50000000000000000000000000" }] });
    if (p.startsWith(`/tokens/${TOKEN}`)) return json({ name: "Argus", symbol: "ARGUS", decimals: "18", total_supply: "1000000000000000000000000000", holders_count: "20323", volume_24h: "1478824", reputation: "ok" });
    if (p.includes("/tokens?type=ERC-20")) return json({ items: [{ token: { address_hash: USDC, symbol: "USDC", name: "USDC", decimals: "6", exchange_rate: "1" }, value: "22250000" },
      { token: { address_hash: TOKEN, symbol: "ARGUS", name: "Argus", decimals: "18", exchange_rate: "0.002" }, value: "1000000000000000000000" }] });
    if (p.includes("/token-transfers")) return json({ items: [{ timestamp: "2026-11-12T05:41:33Z", from: { hash: "0x112a05D335c36881887568Ce924CcaEB0c52F097", name: "ChordOTC" }, to: { hash: BUYER.address },
      token: { symbol: "USDC", decimals: "6" }, total: { value: "22250000", decimals: "6" }, transaction_hash: "0xabc", method: "fillOffer" }] });
    if (p.startsWith("/addresses/")) return json({ is_contract: false, reputation: "ok", is_scam: false });
    return json({}, 404);
  }
  // Arc JSON-RPC
  const body = JSON.parse(init.body || "{}");
  const [arg0] = body.params || [];
  let result = "0x";
  if (body.method === "eth_call") {
    const d = arg0.data;
    if (arg0.to.toLowerCase() === USDC && d.startsWith("0x70a08231")) result = word(state.buyerBalance);
    else if (d === "0x5f5d0655") result = word(1); // Chord nextOfferId: no offers
    else if (d === "0x95d89b41") result = "0x" + "0".repeat(62) + "20" + "0".repeat(63) + "5" + Buffer.from("ARGUS").toString("hex").padEnd(64, "0");
    else if (d === "0x313ce567") result = word(18);
    else result = word(0);
  } else if (body.method === "eth_getCode") result = "0x6080604052";
  else if (body.method === "eth_getStorageAt") result = word(0);
  else if (body.method === "eth_blockNumber") result = "0x10";
  return json({ jsonrpc: "2.0", id: 1, result });
};

const env = () => ({ SELLER_PRIVATE_KEY: SELLER.privateKey, RIPTIDE: { fetch: async () => json({ rows: [{ ts: 1795300000, pair: "ARGUS/USDC v3", kind: "liquidity", change: -0.6 }] }) } });
const mcp = async (e, message) => (await (await worker.fetch(new Request("https://cadence.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) }), e)).json());

async function pay(required, { signer = BUYER, value, to, validBefore, accepted } = {}) {
  const a = accepted || required.accepts[0];
  const now = Math.floor(Date.now() / 1000);
  const authorization = { from: BUYER.address, to: to || a.payTo, value: value || a.amount, validAfter: "0", validBefore: String(validBefore ?? now + 300), nonce: hexlify(randomBytes(32)) };
  const signature = await signer.signTypedData(USDC_DOMAIN, AUTH_TYPES, authorization);
  return { x402Version: 2, resource: required.resource, accepted: a, payload: { signature, authorization } };
}
const call = (name, args, payment) => ({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args, ...(payment ? { _meta: { "x402/payment": payment } } : {}) } });

test("tools/list shows 10 free tools and the Pro tools with their price", async () => {
  reset();
  const r = await mcp(env(), { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = r.result.tools.map(t => t.name);
  assert.equal(names.filter(n => !n.startsWith("pro_")).length, 10);
  const pro = r.result.tools.find(t => t.name === "pro_token_report");
  assert.deepEqual(pro._meta["x402/price"], { amount: "5000", asset: "USDC", network: "eip155:5042" });
  assert.ok(!("price" in pro) && !("run" in pro));
});

test("no payment: PaymentRequired in structuredContent and content[0].text (x402 MCP spec)", async () => {
  reset();
  const r = (await mcp(env(), call("pro_token_report", { token: TOKEN }))).result;
  assert.equal(r.isError, true);
  const pr = r.structuredContent;
  assert.equal(pr.x402Version, 2);
  assert.deepEqual(JSON.parse(r.content[0].text), pr);
  assert.deepEqual(pr.accepts[0], { scheme: "exact", network: "eip155:5042", amount: "5000", asset: USDC, payTo: SELLER.address, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } });
  assert.equal(pr.resource.url, "https://cadence.test/mcp#pro_token_report");
  assert.equal(state.settles.length, 0);
});

test("valid payment: tool runs, Circle settles once with a valid seller proof, settlement in _meta", async () => {
  reset();
  const pr = (await mcp(env(), call("pro_token_report", { token: TOKEN }))).result.structuredContent;
  const r = (await mcp(env(), call("pro_token_report", { token: TOKEN }, await pay(pr)))).result;
  assert.equal(r.isError, false);
  assert.equal(r.structuredContent.holders_count, 20323);
  assert.equal(r.structuredContent.top_holders[0].kind, "burn");
  assert.equal(r.structuredContent.top_holders[1].kind, "liquidity pool");
  assert.equal(r.structuredContent.concentration.top10_outside_burn_and_pools_pct, 5);
  assert.equal(r.structuredContent.riptide_rug_alarms_30d.length, 1);
  assert.deepEqual(r._meta["x402/payment-response"], { success: true, transaction: "0xsettled", network: "eip155:5042", payer: BUYER.address });
  assert.equal(state.settles.length, 1);
  const { headers, body } = state.settles[0];
  const sent = JSON.parse(body);
  assert.equal(sent.x402Version, 2);
  assert.deepEqual(sent.paymentRequirements, pr.accepts[0]);
  assert.equal(sent.paymentPayload.payload.authorization.from, BUYER.address);
  assert.ok(!headers.authorization, "no API key header unless CIRCLE_API_KEY is set");
  const env2 = JSON.parse(Buffer.from(headers["Facilitator-Seller-Proof"], "base64url").toString());
  assert.equal(env2.version, 1); assert.equal(env2.network, "eip155:5042"); assert.equal(env2.payTo, SELLER.address);
  assert.ok(env2.expiresAt - env2.issuedAt === 300);
  const signer = verifyTypedData(PROOF_DOMAIN, PROOF_TYPES, { purpose: "settle", method: "POST", bodyHash: keccak256(toUtf8Bytes(body)), network: "eip155:5042",
    payTo: SELLER.address, nonce: env2.nonce, issuedAt: env2.issuedAt, expiresAt: env2.expiresAt }, env2.signature);
  assert.equal(signer, SELLER.address, "seller proof recovers to payTo over the exact body sent");
});

test("wallet report runs and pays the same way", async () => {
  reset();
  const pr = (await mcp(env(), call("pro_wallet_report", { address: BUYER.address }))).result.structuredContent;
  const r = (await mcp(env(), call("pro_wallet_report", { address: BUYER.address }, await pay(pr)))).result;
  assert.equal(r.isError, false);
  assert.equal(r.structuredContent.kind, "wallet");
  assert.equal(r.structuredContent.holdings[0].symbol, "USDC");
  assert.equal(r.structuredContent.total_usd_estimate, 24.25);
  assert.equal(r.structuredContent.latest_transfers[0].direction, "in");
  assert.equal(state.settles.length, 1);
});

for (const [label, opts, msg] of [
  ["too little", { value: "4999" }, /amount/],
  ["pays someone else", { to: OTHER.address }, /wrong address/],
  ["expired", { validBefore: Math.floor(Date.now() / 1000) - 5 }, /expired/],
  ["signed by another key", { signer: OTHER }, /signed by the payer|invalid/],
]) {
  test(`rejected before any work: ${label}`, async () => {
    reset();
    const pr = (await mcp(env(), call("pro_token_report", { token: TOKEN }))).result.structuredContent;
    const r = (await mcp(env(), call("pro_token_report", { token: TOKEN }, await pay(pr, opts)))).result;
    assert.equal(r.isError, true);
    assert.match(r.structuredContent.error, /Payment invalid/);
    assert.match(r.structuredContent.error, msg);
    assert.equal(state.settles.length, 0);
  });
}

test("accepted terms changed by the client (cheaper price) are refused", async () => {
  reset();
  const pr = (await mcp(env(), call("pro_token_report", { token: TOKEN }))).result.structuredContent;
  const cheap = { ...pr.accepts[0], amount: "1" };
  const r = (await mcp(env(), call("pro_token_report", { token: TOKEN }, await pay(pr, { accepted: cheap, value: "1" })))).result;
  assert.match(r.structuredContent.error, /doesn't match the price/);
  assert.equal(state.settles.length, 0);
});

test("payer without enough USDC is refused before settling", async () => {
  reset(); state.buyerBalance = 100n;
  const pr = (await mcp(env(), call("pro_token_report", { token: TOKEN }))).result.structuredContent;
  const r = (await mcp(env(), call("pro_token_report", { token: TOKEN }, await pay(pr)))).result;
  assert.match(r.structuredContent.error, /enough USDC/);
  assert.equal(state.settles.length, 0);
});

test("tool fails: nothing is charged", async () => {
  reset();
  const pr = (await mcp(env(), call("pro_token_report", { token: TOKEN }))).result.structuredContent;
  const r = (await mcp(env(), call("pro_token_report", { token: "not-an-address" }, await pay(pr)))).result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /nothing was charged/);
  assert.equal(state.settles.length, 0);
});

test("settlement refused: no report is released", async () => {
  reset(); state.settleMode = "fail";
  const pr = (await mcp(env(), call("pro_token_report", { token: TOKEN }))).result.structuredContent;
  const r = (await mcp(env(), call("pro_token_report", { token: TOKEN }, await pay(pr)))).result;
  assert.equal(r.isError, true);
  assert.match(r.structuredContent.error, /could not be settled/);
  assert.ok(!JSON.stringify(r).includes("000000000000000000000000000000000000dEaD")) // no real report data (the 402 carries only the made-up example);
});

test("pending settlement is polled via /status (signed GET proof) until completed", async () => {
  reset(); state.settleMode = "pending";
  const pr = (await mcp(env(), call("pro_token_report", { token: TOKEN }))).result.structuredContent;
  const r = (await mcp(env(), call("pro_token_report", { token: TOKEN }, await pay(pr)))).result;
  assert.equal(r.isError, false);
  assert.equal(r._meta["x402/payment-response"].transaction, "0xlater");
  const p = JSON.parse(Buffer.from(state.statusHeaders["Facilitator-Seller-Proof"], "base64url").toString());
  const signer = verifyTypedData(PROOF_DOMAIN, PROOF_TYPES, { purpose: "status", method: "GET", bodyHash: keccak256("0x"), network: "eip155:5042",
    payTo: SELLER.address, nonce: p.nonce, issuedAt: p.issuedAt, expiresAt: p.expiresAt }, p.signature);
  assert.equal(signer, SELLER.address, "status proof: purpose status, GET, hash of empty body");
});

test("CIRCLE_API_KEY, when set, is sent as a Bearer token alongside the proof", async () => {
  reset();
  const e = { ...env(), CIRCLE_API_KEY: "LIVE_API_KEY:abc:def" };
  const pr = (await mcp(e, call("pro_token_report", { token: TOKEN }))).result.structuredContent;
  await mcp(e, call("pro_token_report", { token: TOKEN }, await pay(pr)));
  assert.equal(state.settles[0].headers.authorization, "Bearer LIVE_API_KEY:abc:def");
});

test("plain HTTP x402: 402 with PAYMENT-REQUIRED, then 200 with PAYMENT-RESPONSE", async () => {
  reset();
  const u = `https://cadence.test/x402/pro_token_report?token=${TOKEN}`;
  const r1 = await worker.fetch(new Request(u), env());
  assert.equal(r1.status, 402);
  const pr = JSON.parse(Buffer.from(r1.headers.get("payment-required"), "base64").toString());
  assert.equal(pr.accepts[0].payTo, SELLER.address);
  assert.equal(pr.resource.url, "https://cadence.test/x402/pro_token_report");
  const sig = Buffer.from(JSON.stringify(await pay(pr))).toString("base64");
  const r2 = await worker.fetch(new Request(u, { headers: { "PAYMENT-SIGNATURE": sig } }), env());
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).symbol, "ARGUS");
  assert.equal(JSON.parse(Buffer.from(r2.headers.get("payment-response"), "base64").toString()).transaction, "0xsettled");
});

test("without a seller key, Pro tools say they're off and never ask for money", async () => {
  reset();
  const r = (await mcp({}, call("pro_token_report", { token: TOKEN }))).result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /aren't switched on/);
  const h = await worker.fetch(new Request("https://cadence.test/"), {});
  assert.equal((await h.json()).payments.enabled, false);
});

test("root lists Pro tools, prices and the receive address", async () => {
  reset();
  const j = await (await worker.fetch(new Request("https://cadence.test/"), env())).json();
  assert.equal(j.name, "cadence");
  assert.equal(j.payments.pay_to, SELLER.address);
  assert.deepEqual(j.pro_tools.map(t => t.price_usdc), [0.005, 0.005]);
});

test("openapi.json lists the Pro tools with price, x402 terms and schemas", async () => {
  for (const path of ["/openapi.json", "/.well-known/openapi.json"]) {
    const r = await worker.fetch(new Request("https://cadence.test" + path), env());
    assert.equal(r.status, 200);
    const o = await r.json();
    assert.equal(o.openapi, "3.1.0");
    assert.equal(o.servers[0].url, "https://cadence.test");
    for (const name of ["pro_wallet_report", "pro_token_report"]) {
      const op = o.paths["/x402/" + name].post;
      assert.equal(op.operationId, name);
      assert.equal(op["x-payment-info"].price.amount, "0.005000");
      assert.equal(op["x-payment-info"].protocols[0].x402.network, "eip155:5042");
      assert.equal(op["x-payment-info"].protocols[0].x402.payTo, SELLER.address);
      assert.ok(op.requestBody.content["application/json"].schema.required.length);
      assert.ok(op.responses[402]);
    }
  }
  const d = await (await worker.fetch(new Request("https://cadence.test/.well-known/x402"), env())).json();
  assert.deepEqual(d.resources, ["https://cadence.test/x402/pro_wallet_report", "https://cadence.test/x402/pro_token_report"]);
});

test("402 carries Bazaar discovery metadata; tools/list doesn't leak it", async () => {
  const r = await worker.fetch(new Request("https://cadence.test/x402/pro_token_report", { method: "POST", body: JSON.stringify({ token: TOKEN }) }), env());
  assert.equal(r.status, 402);
  const req = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString());
  assert.equal(req.extensions.bazaar.info.input.type, "http");
  assert.equal(req.extensions.bazaar.info.input.method, "POST");
  assert.equal(req.extensions.bazaar.info.output.type, "json");
  assert.equal(req.resource.serviceName, "Cadence");
  assert.ok(req.resource.tags.length <= 5);
  assert.equal(req.accepts[0].extensions, undefined);
  const l = await mcp(env(), { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const pro = l.result.tools.find(t => t.name === "pro_token_report");
  assert.equal(pro.example, undefined); assert.equal(pro.outputExample, undefined);
});
