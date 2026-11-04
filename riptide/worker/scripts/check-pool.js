// Checks a Uniswap v4 pool on Arc before adding it to Riptide's watch list. Read-only.
// Prints the token's symbol and decimals, the pool's liquidity, and the price it implies for each quote
// currency the pool could be paired with (the USDC ERC-20, 6 decimals, or Arc's native USDC, 18 decimals).
// The one that gives a sensible dollar price is the pool's quote currency.
//
// Run from riptide/worker/ (Node 18+, no installs):
//   node scripts/check-pool.js <token address> <v4 pool id>
// Optional: RPC=https://... (default: Arc's public RPC)

const RPC = process.env.RPC || "https://rpc.mainnet.arc.io";
const STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b"; // Uniswap v4 StateView on Arc
const QUOTES = [
  { label: "USDC ERC-20 (quote: USDC, qdec: 6)", address: "0x3600000000000000000000000000000000000000", dec: 6 },
  { label: "native USDC (quote: NATIVE, qdec: 18)", address: "0x0000000000000000000000000000000000000000", dec: 18 },
];

const [token, poolId] = process.argv.slice(2);
if (!/^0x[0-9a-fA-F]{40}$/.test(token || "") || !/^0x[0-9a-fA-F]{64}$/.test(poolId || "")) {
  console.error("usage: node scripts/check-pool.js <token address> <v4 pool id>");
  process.exit(2);
}

async function call(to, data) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const word = (hex, i = 0) => BigInt("0x" + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
function str(hex) { // ABI-encoded string
  const len = Number(word(hex, 1));
  return Buffer.from(hex.slice(2 + 128, 2 + 128 + len * 2), "hex").toString("utf8");
}

(async () => {
  const chain = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) })).json();
  console.log(`RPC ${RPC}, chain id ${BigInt(chain.result)} (Arc mainnet is 5042)`);

  const dec = Number(word(await call(token, "0x313ce567")));
  let sym = "?";
  try { sym = str(await call(token, "0x95d89b41")); } catch (_) { /* no symbol() */ }
  console.log(`Token ${token}: ${sym}, ${dec} decimals`);

  const slot0 = await call(STATE_VIEW, "0xc815641c" + poolId.slice(2));
  const liq = word(await call(STATE_VIEW, "0xfa6793d5" + poolId.slice(2)));
  const sqrtP = word(slot0);
  console.log(`Pool ${poolId}: liquidity ${liq}, sqrtPriceX96 ${sqrtP}`);
  if (sqrtP === 0n) { console.log("NOT A LIVE POOL: no price. Check the pool id."); process.exit(1); }

  const raw = (Number(sqrtP) / 2 ** 96) ** 2;
  for (const q of QUOTES) {
    const usd = token.toLowerCase() < q.address.toLowerCase() ? raw * 10 ** (dec - q.dec) : 10 ** (dec - q.dec) / raw;
    console.log(`  If paired with ${q.label}: $${usd.toPrecision(4)} per ${sym}`);
  }
  console.log("Use the line whose price matches the market price; the other will be off by a factor of about 10^12.");
})().catch(e => { console.error("ERROR: " + e.message); process.exit(2); });
