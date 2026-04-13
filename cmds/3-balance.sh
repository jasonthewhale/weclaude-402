#!/usr/bin/env bash
# 3-balance.sh — Check remaining balance for current API key.
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:4021}"

if [ -z "${API_KEY:-}" ]; then
  ENV_FILE="$(dirname "$0")/.env.test"
  [ -f "$ENV_FILE" ] && source "$ENV_FILE" || { echo "ERROR: No API_KEY. Run 2-topup.sh first."; exit 1; }
fi

echo "==> GET /v1/balance"
curl -s "$BASE_URL/v1/balance" -H "Authorization: Bearer $API_KEY" | jq .
