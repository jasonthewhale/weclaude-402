# CLAUDE.md — WeClaude Server

Developer context for Claude Code working in this repo.

## What this repo is

`weclaude-402` is the **server** — an x402-gated Claude API proxy. Buyers pay USDG on X Layer to get an API key, use it to call Claude models at real token pricing, and can withdraw unused balance on-chain.

Skill/onboarding logic for buyers lives in the separate `weclaude` repo (sibling directory).

## Running the server

```bash
bun run dev    # auto-restart on changes (development)
bun run start  # production
```

Server starts on `http://127.0.0.1:4021`. Requires a `.env` file — copy from `.env.example`.

## Adding Claude OAuth accounts

The server proxies to Claude via OAuth. Add accounts before starting:

```bash
bun run login         # auto mode (local callback on port 54545)
bun run login:manual  # manual mode (paste redirect URL)
```

Tokens are saved to `~/.weclaude/auth/`. Run again to add more accounts. The server rotates across all accounts.

## Key environment variables

| Variable | Purpose |
|----------|---------|
| `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` | x402 facilitator (required) |
| `SELLER_ADDRESS` | Wallet that receives USDG payments |
| `DEBUG=verbose` | Verbose logging from oauth2api proxy |

## Architecture

```
src/
├── index.ts          # Express app — wires everything together
├── config.ts         # Constants: network, topup tiers, pricing, ports
├── pricing.ts        # estimateCost() (pre-flight) + calculateCost() (post-call)
├── x402/
│   ├── setup.ts      # x402 resource server + HTTP server init
│   ├── middleware.ts  # extractKey(), requireBalance(), requireBalanceFor()
│   ├── routes.ts     # /v1/topup, /v1/close, /v1/balance, /health handlers
│   ├── balance.ts    # Read/write buyer balances → SQLite
│   ├── db.ts         # SQLite schema + queries (buyers, transactions, requests)
│   └── refund.ts     # onchainos on-chain refund logic
└── oauth2api/        # Claude proxy
    ├── manager.ts    # Multi-account OAuth token manager + auto-refresh
    ├── proxy.ts      # Proxies requests to Claude, returns usage for billing
    ├── router.ts     # Express router: /v1/messages, /v1/chat/completions, etc.
    ├── translator.ts # OpenAI ↔ Anthropic format translation
    └── streaming.ts  # SSE streaming support
```

## Data persistence

- **SQLite DB**: `data/weclaude.db` — buyers, transactions, requests tables
- **Request log**: `data/request-log.jsonl` — JSONL log of all requests/responses (temp, testing)
- **OAuth tokens**: `~/.weclaude/auth/` — persists across restarts

All buyer data (API keys, balances) survives server restarts.

## Important behaviors and constraints

**x402 route registration**: Payment amounts are registered at startup in `src/x402/setup.ts`. Adding a new topup tier requires updating `TOPUP_TIERS` in `src/config.ts` AND restarting the server. The middleware cannot validate amounts that weren't registered at boot.

**Topup tiers**: Supported amounts are `[0.1, 0.5, 1.0, 5.0]` USD. Each maps to a route:
- `POST /v1/topup` → $0.10 (default)
- `POST /v1/topup/0.5` → $0.50
- `POST /v1/topup/1.0` → $1.00
- `POST /v1/topup/5.0` → $5.00

**Balance deduction**: Pre-flight uses `estimateCost()` (character count ÷ 4 for input, capped at 1024 output tokens). Post-call deducts `calculateCost()` from actual usage. Balance is clamped at zero — never goes negative.

**Cost estimation cap**: `estimateCost()` caps `max_tokens` at 1024 to avoid false 402s. Claude Code sends `max_tokens=32000`; using it raw would reject almost all requests on a $0.10 balance.

**Same-wallet topup**: If a payer address already has an account, `handleTopup` adds to the existing balance and returns the same API key (identified via `payment-signature` header).

## Inspecting the database

```bash
bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('data/weclaude.db');
console.log(db.query('SELECT api_key, balance_usd, used_usd, payer FROM buyers').all());
db.close();
"
```

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/v1/topup[/<amount>]` | x402 payment | Issue/top up API key |
| `POST` | `/v1/chat/completions` | Bearer | OpenAI format (balance-gated) |
| `POST` | `/v1/messages` | Bearer | Anthropic format (balance-gated) |
| `POST` | `/v1/responses` | Bearer | Responses API (balance-gated) |
| `POST` | `/v1/messages/count_tokens` | Bearer | Token count (gated, free) |
| `GET`  | `/v1/models` | none | List supported models |
| `GET`  | `/v1/balance` | Bearer | Check balance |
| `POST` | `/v1/close` | Bearer | Refund unused USDG |
| `GET`  | `/health` | none | Health check |
| `GET`  | `/admin/accounts` | none | OAuth account status |
