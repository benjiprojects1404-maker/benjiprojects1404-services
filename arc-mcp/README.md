# Cadence (Arc MCP)

**Cadence** is the public name of this server. Landing page and how to connect: https://chordotc.com/cadence/

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server for Circle's Arc mainnet (chain 5042).
Plug it into an AI assistant and it can answer questions like "what's in this Arc wallet?", "what would $1,000 of
cirBTC cost on Arc right now?", "any rug alarms on Arc today?", "make me a payment link for 25 USDC", "what's open on
Chord OTC?" or "set up an offer to sell 50 EURC for 54 USDC".

No wallet, no keys, nothing signed or sent. Every tool reads public data, builds a link, or prepares an unsigned
Chord OTC transaction that the user reviews and signs in their own wallet.

## Tools

| Tool | What it does |
|---|---|
| `arc_balances` | Balances of the ten Chord-listed tokens for any Arc address |
| `arc_quote` | Real Uniswap v3 quote (buy or sell) for cirBTC, EURC, WETH or ARGUS, incl. pool fee and slippage |
| `riptide_latest` | Riptide's latest price-gap check (Arc vs Coinbase, ARGUS v3 vs v4) after fees |
| `riptide_rug_alarms` | Riptide's rug-alarm events (sudden price drops, liquidity pulled) |
| `crescent_payment_link` | A Crescent link that lets anyone pay an exact amount straight to an address |
| `crescent_check_payment` | Whether that payment has arrived (via the Arc explorer) |
| `chord_offers` | Open Chord OTC offers, newest first: price, token (listed or not), private taker, expiry, fillable right now |
| `chord_offer` | One offer by id, plus what a taker must approve first |
| `chord_prepare` | Unsigned transactions to create, fill or cancel an offer (approval first when needed), with a plain-English summary. Checks balance, approval, caps, private taker and pause first |
| `chord_token_check` | The same code check Chord's site runs on unlisted tokens: upgradeable, mint/pause/block/tax powers, live transfer tax |

## Pro tools (paid per call with x402)

| Tool | Price | What it does |
|---|---|---|
| `pro_wallet_report` | $0.005 | Every ERC-20 an address holds (with the explorer's USD estimate and scam flags), wallet or contract (e.g. a Safe), creator, its 20 latest token transfers with counterparties, and its open Chord OTC offers |
| `pro_token_report` | $0.005 | The `chord_token_check` code check plus holders count, supply, 24h volume, top 10 holders by type (burn, pool, contract, wallet), concentration outside burns and pools, and Riptide rug alarms in the last 30 days |

The agent pays in USDC on Arc with [x402](https://x402.org) v2, scheme `exact` (an EIP-3009 authorization it signs),
network `eip155:5042`, settled by [Circle's Facilitator Service](https://developers.circle.com/facilitator-service),
which broadcasts the transfer and pays the gas.

- **Over MCP:** call the tool; the result is `isError: true` with the `PaymentRequired` object in `structuredContent`.
  Retry with the signed payment in `params._meta["x402/payment"]`. The settlement comes back in
  `result._meta["x402/payment-response"]` ([x402 MCP transport](https://github.com/coinbase/x402/blob/main/specs/transports-v2/mcp.md)).
- **Over plain HTTP:** `GET` or `POST /x402/<tool>` (arguments as query or JSON body). The first answer is `402` with a
  `PAYMENT-REQUIRED` header; retry with `PAYMENT-SIGNATURE`; the `200` carries `PAYMENT-RESPONSE`. Works with standard
  x402 clients.
- **Discovery:** `GET /openapi.json` (also `/.well-known/openapi.json`) describes both paid routes with their price in
  `x-payment-info`; `GET /.well-known/x402` lists them; every `402` carries x402 Bazaar metadata
  (`extensions.bazaar`: input, output example, input schema). This is what Circle's Agent Marketplace and other x402
  catalogs read to list Cadence.
- **Never charged for nothing:** the payment is checked (amount, payee, expiry, signature, the payer's USDC balance)
  before any work; the report is built before settling, so a failed report charges nothing; and the report is only
  released once Circle confirms the transfer.

**Where the money goes.** Circle's facilitator needs every request signed by the wallet being paid (a "seller proof"),
so payments go to a receive-only wallet whose key is the Worker secret `SELLER_PRIVATE_KEY`. The key is created by the
one-off GitHub Action *Cadence payment wallet*, straight into Cloudflare: nobody ever sees it. Each Monday the Worker
sweeps that wallet's USDC (when there's at least 1 USDC) to the Chord Treasury Safe `0xc3FC…d4B6`, the only place it
can send to. Anyone can trigger a sweep early with `POST /sweep`. Optional: a Circle API key as `CIRCLE_API_KEY` is
sent alongside the proof (needed once Circle's keyless allowance runs out).

Tests: `npm test` (17 tests: price signals, payment checks, seller proof, settlement success/pending/failure, plain HTTP
x402), with every outside service mocked.

## Deploy (Cloudflare Workers, free tier)

Automatic: the GitHub Action *Deploy Cadence* tests and deploys on every change to `arc-mcp/` on main (needs the
repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`). By hand, from this folder:

```bash
npm ci && npx wrangler deploy
```

It prints the address, e.g. `https://arc-mcp.<your-subdomain>.workers.dev`. The MCP endpoint is that address + `/mcp`.

Optional, for reliable Arc reads (same as Riptide): `npx wrangler secret put ARC_RPC_URL` with your Alchemy Arc **mainnet** HTTPS URL.

## Connect it

- **Claude Code:** `claude mcp add --transport http arc https://arc-mcp.<your-subdomain>.workers.dev/mcp`
- **Claude (web / desktop) and other MCP apps:** add a custom connector / remote MCP server with the `/mcp` URL.
- **Check it by hand:** `curl -s -X POST <url>/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`

## Notes

- Transport: MCP Streamable HTTP, stateless (each POST is answered with JSON; no sessions, no streaming).
- Tokens are matched by contract address, because Arc has look-alike tokens with the same names.
- Quotes are a snapshot; prices move every block. Not financial advice.
- Chord OTC v2 (`0x41a2…78e8`) never holds funds: an offer is an approval, and a fill moves both sides wallet to
  wallet in one transaction. `chord_prepare` only returns `{to, value, data}`; the user's wallet signs.
- For tests, the `CHORD_OTC` variable points the Chord tools at another deployment.
