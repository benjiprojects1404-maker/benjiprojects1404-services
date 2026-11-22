// x402 payments for Cadence's Pro tools: an agent pays a few tenths of a cent in USDC on Arc per call.
//
// Standard: x402 v2, scheme "exact" (an EIP-3009 transferWithAuthorization the agent signs), network eip155:5042,
// settled by Circle's Facilitator Service (https://developers.circle.com/facilitator-service), which broadcasts the
// transfer and pays the gas. Over MCP the payment rides in params._meta["x402/payment"] (x402 MCP transport spec);
// over plain HTTP in the PAYMENT-SIGNATURE header (x402 HTTP transport).
//
// Money only ever moves from the agent's wallet to PAY_TO, the address of SELLER_PRIVATE_KEY (a receive-only wallet
// that exists just for this). Circle wants every request signed by that key ("seller proof"). The Worker never
// sends anything except sweep(): all of PAY_TO's USDC to the Chord Treasury Safe, a fixed address.

import { Wallet, JsonRpcProvider, Contract, keccak256, toUtf8Bytes, hexlify, randomBytes, verifyTypedData, getAddress } from "ethers";

export const NETWORK = "eip155:5042";
export const CHAIN_ID = 5042;
export const USDC = "0x3600000000000000000000000000000000000000";
export const SAFE = "0xc3FC2A5D1E7e2F5d597bE891e4BC36F117D9d4B6"; // Chord Treasury Safe on Arc (2 of 2)
const FACILITATOR = "https://api.circle.com/v1/facilitator/x402";
const USDC_DOMAIN = { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: USDC };
const AUTH_TYPES = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };
const PROOF_DOMAIN = { name: "Circle Facilitator Seller Request", version: "1", chainId: CHAIN_ID };
const PROOF_TYPES = { SellerRequest: [
  { name: "purpose", type: "string" }, { name: "method", type: "string" }, { name: "bodyHash", type: "bytes32" },
  { name: "network", type: "string" }, { name: "payTo", type: "address" }, { name: "nonce", type: "bytes32" },
  { name: "issuedAt", type: "uint64" }, { name: "expiresAt", type: "uint64" }] };

/** The seller wallet, or null when payments aren't set up (Pro tools then say so instead of charging). */
export function seller(env) {
  const k = (env.SELLER_PRIVATE_KEY || "").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(k)) return null;
  return new Wallet(k.startsWith("0x") ? k : "0x" + k);
}

export function requirements(env, price, resourceUrl, description) {
  const w = seller(env);
  return {
    scheme: "exact", network: NETWORK, amount: String(price), asset: USDC, payTo: w ? w.address : null,
    maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" },
    _resource: { url: resourceUrl, description, mimeType: "application/json" },
  };
}
const accepts = r => { const { _resource, ...a } = r; return a; };

export function paymentRequired(req, error = "Payment required") {
  return { x402Version: 2, error, resource: req._resource, accepts: [accepts(req)] };
}

/** Checks a payment payload against what we asked for, before doing any work. Returns the payer or throws. */
export async function checkPayment(payment, req, { rpcCall } = {}) {
  if (!payment || typeof payment !== "object") throw new Error("missing payment");
  if (payment.x402Version !== 2) throw new Error("x402Version must be 2");
  const a = payment.accepted || {};
  if (a.scheme !== "exact" || a.network !== NETWORK || String(a.asset).toLowerCase() !== USDC || String(a.amount) !== req.amount
    || String(a.payTo || "").toLowerCase() !== String(req.payTo).toLowerCase()) throw new Error("payment doesn't match the price or payee for this tool");
  const p = payment.payload || {}, au = p.authorization || {};
  if (!p.signature || !au.from) throw new Error("payment payload needs signature and authorization");
  if (String(au.to).toLowerCase() !== String(req.payTo).toLowerCase()) throw new Error("authorization pays the wrong address");
  if (String(au.value) !== req.amount) throw new Error("authorization amount doesn't match the price");
  const now = Math.floor(Date.now() / 1000);
  if (Number(au.validAfter) > now) throw new Error("authorization isn't valid yet");
  if (Number(au.validBefore) < now + 10) throw new Error("authorization has expired");
  if (!/^0x[0-9a-fA-F]{64}$/.test(au.nonce || "")) throw new Error("authorization nonce must be 32 bytes");
  let signer;
  try {
    signer = verifyTypedData(USDC_DOMAIN, AUTH_TYPES, { from: au.from, to: au.to, value: au.value, validAfter: au.validAfter, validBefore: au.validBefore, nonce: au.nonce }, p.signature);
  } catch { throw new Error("payment signature is invalid"); }
  if (signer.toLowerCase() !== String(au.from).toLowerCase()) throw new Error("payment isn't signed by the payer");
  if (rpcCall) {
    const bal = BigInt(await rpcCall(USDC, "0x70a08231" + au.from.toLowerCase().slice(2).padStart(64, "0")));
    if (bal < BigInt(req.amount)) throw new Error("the paying wallet doesn't hold enough USDC on Arc");
  }
  return getAddress(au.from);
}

async function proofHeader(env, purpose, method, rawBody) {
  const w = seller(env);
  const issuedAt = Math.floor(Date.now() / 1000);
  const message = { purpose, method, bodyHash: keccak256(rawBody ? toUtf8Bytes(rawBody) : "0x"), network: NETWORK, payTo: w.address,
    nonce: hexlify(randomBytes(32)), issuedAt, expiresAt: issuedAt + 300 };
  const signature = await w.signTypedData(PROOF_DOMAIN, PROOF_TYPES, message);
  const envelope = { version: 1, signature, network: NETWORK, payTo: w.address, nonce: message.nonce, issuedAt, expiresAt: issuedAt + 300 };
  return btoa(JSON.stringify(envelope)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function headers(env, proof) {
  const h = { "content-type": "application/json", "Facilitator-Seller-Proof": proof };
  if (env.CIRCLE_API_KEY) h.authorization = "Bearer " + env.CIRCLE_API_KEY;
  return h;
}

/** Asks Circle to settle. Returns { success, transaction, payer, network } or { success:false, error }. */
export async function settle(env, payment, req, fetchImpl = fetch) {
  const body = JSON.stringify({ x402Version: 2, paymentPayload: payment, paymentRequirements: accepts(req) });
  let r, j;
  try {
    r = await fetchImpl(FACILITATOR + "/settle", { method: "POST", headers: headers(env, await proofHeader(env, "settle", "POST", body)), body });
    j = await r.json().catch(() => ({}));
  } catch (e) { return { success: false, error: "facilitator unreachable: " + e.message }; }
  if (j.success) return { success: true, transaction: j.transaction, payer: j.payer, network: j.network || NETWORK };
  const status = j.extensions?.["settlement-status"];
  if (j.errorReason === "settlement_pending" && status?.paymentId) {
    for (let i = 0; i < 8; i++) {
      await new Promise(res => setTimeout(res, 1000));
      try {
        const s = await fetchImpl(FACILITATOR + "/status/" + status.paymentId, { method: "GET", headers: headers(env, await proofHeader(env, "status", "GET", "")) });
        const sj = await s.json();
        if (sj.status === "completed") return { success: true, transaction: sj.transaction, payer: sj.payer, network: sj.network || NETWORK };
        if (sj.status === "failed") return { success: false, error: "settlement failed: " + (sj.reason || "unknown") };
      } catch { /* keep polling */ }
    }
    return { success: false, error: "settlement still pending; nothing was delivered. Payment id " + status.paymentId };
  }
  return { success: false, error: `settlement refused (HTTP ${r.status}${j.errorReason ? ", " + j.errorReason : ""}${j.message ? ": " + j.message : ""})` };
}

/** Sends everything PAY_TO holds (minus a little for gas) to the Safe. Only when there's at least `min` USDC. */
export async function sweep(env, rpcUrl, min = 1_000000n) {
  const w = seller(env);
  if (!w) return { swept: false, reason: "payments not set up" };
  const provider = new JsonRpcProvider(rpcUrl, CHAIN_ID, { staticNetwork: true });
  const signer = w.connect(provider);
  const usdc = new Contract(USDC, ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"], signer);
  const bal = await usdc.balanceOf(w.address);
  const reserve = 20000n; // 0.02 USDC stays behind to pay Arc gas (gas on Arc is paid in USDC)
  if (bal < min) return { swept: false, reason: `balance ${bal} below the ${min} minimum`, balance: bal.toString() };
  const t = await usdc.transfer(SAFE, bal - reserve);
  return { swept: true, amount: (bal - reserve).toString(), to: SAFE, tx: t.hash };
}
