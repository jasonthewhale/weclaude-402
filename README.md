# WeClaude

An x402-gated Claude API proxy built for the OKX Hackathon. Buyers make a single USDG micropayment on X Layer to receive an API key, then use it to call Claude models at real token pricing. Unused balance is refunded on-chain when the session closes.

## How it works

```
Phase 1 — Topup (one-time x402 payment)
  Buyer ──x402──► POST /v1/topup ──► x402 middleware verifies on X Layer
                                   ──► issue API key + credit balance

Phase 2 — Usage (API key auth, many requests)
  Buyer ──Bearer──► POST /v1/chat/completions ──► balance check
                                               ──► proxy to Claude API
                                               ──► deduct real token cost

Phase 3 — Close (refund unused portion)
  Buyer ──────────► POST /v1/close ──► on-chain refund (gas-free) ──► X Layer
```

Two on-chain transactions total: topup (buyer → seller) and close (seller → buyer).

**Chain:** X Layer (`eip155:196`) — gas-free, USDG supported.  
**Topup amount:** $0.10 USDG per session.  
**Token pricing:** real Anthropic pricing, deducted per call.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- [onchainos CLI](https://github.com/aspect-build/onchainos) — for on-chain refunds and x402 payment signing
- OKX API credentials (Web3 scope) — for the x402 facilitator
- A Claude account — for the OAuth2 proxy

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Anthropic API key (for token counting endpoint)
ANTHROPIC_API_KEY=sk-ant-...

# OKX API credentials (Web3 scope) — x402 facilitator
OKX_API_KEY=
OKX_SECRET_KEY=
OKX_PASSPHRASE=

# Seller wallet address — receives USDG payments
SELLER_ADDRESS=0x...

# Buyer wallet address (reference only)
BUYER_ADDRESS=0x...
```

### 3. Log in to Claude

WeClaude proxies to Claude via OAuth. Run the login script once per account:

```bash
# Auto mode (starts a local callback server on port 54545)
bun run login

# Manual mode (paste the redirect URL from your browser)
bun run login:manual
```

Tokens are saved to `~/.weclaude/auth/`. Add more accounts by running login again.

### 4. Set up your seller wallet

```bash
# Log in to onchainos
onchainos wallet login

# Verify your wallet has enough OKX for gas (X Layer is gas-free, but recommended)
onchainos wallet balance --chain 196
```

## Running the server

```bash
# Development (auto-restart on changes)
bun run dev

# Production
bun run start
```

The server starts on `http://127.0.0.1:4021`.

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/topup` | Pay $0.10 USDG via x402 → get API key |
| `POST` | `/v1/chat/completions` | OpenAI-format chat (balance-gated) |
| `POST` | `/v1/messages` | Anthropic-format messages (balance-gated) |
| `POST` | `/v1/responses` | Responses API (balance-gated) |
| `POST` | `/v1/messages/count_tokens` | Token counting (balance-gated, free) |
| `GET`  | `/v1/models` | List supported models |
| `GET`  | `/v1/balance` | Check remaining balance |
| `POST` | `/v1/close` | Refund unused USDG and revoke API key |
| `GET`  | `/health` | Service health check |
| `GET`  | `/admin/accounts` | OAuth account status |

## Demo scripts

The `cmds/` directory contains shell scripts that walk through the full flow end-to-end:

```bash
# Run all steps in sequence
bash cmds/run-all.sh

# Or individually:
bash cmds/0-wallet-setup.sh   # Verify onchainos wallet
bash cmds/1-health.sh         # Health check
bash cmds/2-topup.sh          # Pay USDG → get API key (saves to cmds/.env.test)
bash cmds/3-balance.sh        # Check balance
bash cmds/4-models.sh         # List models
bash cmds/5-chat.sh           # Chat completions (OpenAI format)
bash cmds/6-messages.sh       # Messages (Anthropic format)
bash cmds/7-count-tokens.sh   # Count tokens
bash cmds/8-close.sh          # Close session + refund
```

Scripts read `BASE_URL` from the environment (default: `http://127.0.0.1:4021`). After topup, the API key is saved to `cmds/.env.test`.

## Exposing to the internet (ngrok)

To test the x402 payment flow with a remote client:

```bash
# Install ngrok
brew install ngrok
ngrok config add-authtoken <your-token>

# In terminal 1
bun run dev

# In terminal 2
ngrok http 4021
```

See [NGROK.md](NGROK.md) for full details.

## Architecture

```
src/
├── index.ts          # Express app entry point
├── config.ts         # Network, pricing, and server constants
├── pricing.ts        # Token cost estimation and calculation
├── tokenCounter.ts   # Token counting helpers
├── x402/             # Payment infrastructure
│   ├── setup.ts      # x402 resource server + HTTP server init
│   ├── middleware.ts  # API key extraction, balance guards
│   ├── routes.ts     # /v1/topup, /v1/close, /v1/balance, /health
│   ├── balance.ts    # In-memory balance store
│   ├── db.ts         # Session persistence
│   └── refund.ts     # onchainos refund logic
└── oauth2api/        # Claude OAuth2 proxy
    ├── manager.ts    # Multi-account OAuth token manager
    ├── proxy.ts      # Request proxying to Claude API
    ├── router.ts     # Express router for LLM endpoints
    ├── translator.ts # OpenAI ↔ Anthropic format translation
    ├── streaming.ts  # SSE streaming support
    ├── oauth.ts      # PKCE OAuth flow
    ├── cloaking.ts   # Client version spoofing
    └── storage.ts    # Token persistence (~/.weclaude/auth/)
```

## Environment variables reference

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Used for `/v1/messages/count_tokens` |
| `OKX_API_KEY` | Yes | OKX Web3 API key for x402 facilitator |
| `OKX_SECRET_KEY` | Yes | OKX API secret |
| `OKX_PASSPHRASE` | Yes | OKX API passphrase |
| `SELLER_ADDRESS` | Yes | Wallet address that receives USDG payments |
| `BUYER_ADDRESS` | No | Reference only |
| `PORT` | No | Server port (default: `4021`) |
| `DEBUG` | No | Set to `verbose` for detailed logging |
