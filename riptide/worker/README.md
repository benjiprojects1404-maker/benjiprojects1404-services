# Riptide Worker

Read-only monitor: every minute it quotes Arc's Uniswap v3 pools (cirBTC, EURC, WETH against USDC, at $10 and $1,000),
compares them with Binance / Coinbase, and logs the gap after fees to a Cloudflare D1 database.
It never trades and needs no wallet, keys or exchange accounts.

Free tier is enough: about 8,600 rows a day, 30 days kept.

## Deploy (once, about 10 minutes)

From this folder (`riptide/worker`), on your computer:

```bash
npx wrangler login                       # opens Cloudflare in your browser
npx wrangler d1 create riptide           # prints a database_id
```

Paste that `database_id` into `wrangler.toml`, then:

```bash
npx wrangler d1 execute riptide --remote --file=schema.sql
npx wrangler deploy
```

`deploy` prints the Worker's address, e.g. `https://riptide.<your-subdomain>.workers.dev`.
Open `<that address>/api/latest` after a minute or two: it should show six rows.

Then set `DEFAULT_API` near the top of the script in `riptide/index.html` to that address (or send it to Claude to do).

## If Arc quotes keep failing (optional)

Cloudflare's servers are shared, so Arc's public RPC sometimes rate-limits them (the dashboard shows "arc: -32005 rate limit…").
The Worker retries, but if it still misses a lot, give it a private Arc endpoint: create a free Arc mainnet app at a
provider such as Alchemy, copy its HTTPS URL, then run:

```bash
npx wrangler secret put ARC_RPC_URL     # paste the URL when asked; it is stored encrypted in Cloudflare
```

No redeploy needed. The public RPC stays as the fallback. Never commit that URL: it contains your key.

## Endpoints

- `/api/latest` latest check for every pair and size
- `/api/summary?days=7` totals per pair and size
- `/api/series?days=7&size=1000` 15-minute averages for the chart
- `/api/opps?days=7` checks where the gap beat all costs
- `/api/csv?days=7` everything, as CSV

## Assumptions (edit in `src/index.js`)

- Exchange taker fees: Binance 0.1%, Coinbase 0.6% (`cexFee` per pair).
- Arc gas: 110,000 gas at the live gas price, paid in USDC.
- Not counted: withdrawal / bridge fees and transfer time between Arc and an exchange.

## Stop it

`npx wrangler delete riptide` removes the Worker; `npx wrangler d1 delete riptide` removes the data.
