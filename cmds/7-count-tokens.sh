#!/usr/bin/env bash
# 7-count-tokens.sh — Count tokens (free, no balance deduction).
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:4021}"

if [ -z "${API_KEY:-}" ]; then
  ENV_FILE="$(dirname "$0")/.env.test"
  [ -f "$ENV_FILE" ] && source "$ENV_FILE" || { echo "ERROR: No API_KEY. Run 2-topup.sh first."; exit 1; }
fi

echo "==> POST /v1/messages/count_tokens (free)"
curl -s "$BASE_URL/v1/messages/count_tokens" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "messages": [{"role": "user", "content": "Hello, how are you today?"}]
  }' | jq .
