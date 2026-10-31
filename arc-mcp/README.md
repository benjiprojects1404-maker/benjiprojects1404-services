# Arc MCP

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server for Circle's Arc mainnet (chain 5042).
Plug it into an AI assistant and it can answer questions like "what's in this Arc wallet?", "what would $1,000 of
cirBTC cost on Arc right now?", "any rug alarms on Arc today?" or "make me a payment link for 25 USDC".

No wallet, no keys, no transactions. Every tool only reads public data or builds a link.

## Tools

| Tool | What it does |
|---|---|
| `arc_balances` | Balances of the eight Chord-listed tokens for any Arc address |
| `arc_quote` | Real Uniswap v3 quote (buy or sell) for cirBTC, EURC, WETH or ARGUS, incl. pool fee and slippage |
| `riptide_latest` | Riptide's latest price-gap check (Arc vs Coinbase, ARGUS v3 vs v4) after fees |
| `riptide_rug_alarms` | Riptide's rug-alarm events (sudden price drops, liquidity pulled) |
| `crescent_payment_link` | A Crescent link that lets anyone pay an exact amount straight to an address |
| `crescent_check_payment` | Whether that payment has arrived (via the Arc explorer) |

## Deploy (Cloudflare Workers, free tier)

From this folder (`arc-mcp`):

```bash
npx wrangler deploy
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
