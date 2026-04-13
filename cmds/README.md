# WeClaude Test Commands

Step-by-step scripts to test the full x402 payment flow — buyer topup to seller refund.

## Prerequisites

1. **onchainos** v2.2+ with wallet logged in and USDG on X Layer (chain 196)
2. **Server running**: `bun run dev`
3. **OAuth account**: `bun run login` (at least one Claude OAuth token)
4. **OKX API credentials** in `.env`: `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`

## Scripts

```
0-wallet-setup.sh   — check onchainos wallet status & X Layer USDG balance
1-health.sh         — verify server is up
2-topup.sh          — x402 payment: 402 challenge → onchainos sign → API key
3-balance.sh        — check remaining balance
4-models.sh         — list available models (open, no auth)
5-chat.sh           — chat completion, OpenAI format (deducts $0.001)
6-messages.sh       — messages, Anthropic format (deducts $0.001)
7-count-tokens.sh   — count tokens (free, no deduction)
8-close.sh          — close session, refund unused USDG to buyer
run-all.sh          — interactive walkthrough of full flow
```

## Quick Start

```bash
# Terminal 1 — seller
bun run dev

# Terminal 2 — buyer
bash cmds/0-wallet-setup.sh
bash cmds/1-health.sh
bash cmds/2-topup.sh              # pays $0.10 USDG via x402
source cmds/.env.test             # loads API_KEY
bash cmds/5-chat.sh "Hi Claude"   # uses the API ($0.001)
bash cmds/3-balance.sh            # check balance
bash cmds/8-close.sh              # refund unused USDG

# Or all at once:
bash cmds/run-all.sh
```

## x402 Payment Flow

```
Buyer (onchainos)              Seller (WeClaude)               OKX Facilitator
  |                                |                                |
  |-- POST /v1/topup ------------->|                                |
  |<-- 402 + PAYMENT-REQUIRED ----|                                |
  |                                |                                |
  | onchainos payment x402-pay     |                                |
  |   --accepts <json>             |                                |
  |   (signs via TEE wallet)       |                                |
  |                                |                                |
  |-- POST /v1/topup ------------->|                                |
  |   + PAYMENT-SIGNATURE header   |-- verify + settle ----------->|
  |                                |<-- settlement confirmed ------|
  |<-- 200 { api_key, balance } --|                                |
  |                                |                                |
  | ... use api_key for LLM calls  |                                |
  |   (no more x402, just Bearer)  |                                |
  |                                |                                |
  |-- POST /v1/close ------------->|                                |
  |                                |-- onchainos wallet send ------>|
  |                                |   (refund unused USDG)         |
  |<-- 200 { used, refunded } ----|                                |
```
