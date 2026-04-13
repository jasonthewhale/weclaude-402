#!/usr/bin/env bash
# 8-close.sh — Close session, refund unused USDG back to buyer.
#
# The server calls `onchainos wallet send` to return the unused portion
# of the topup amount to the buyer's on-chain address.
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:4021}"

if [ -z "${API_KEY:-}" ]; then
  ENV_FILE="$(dirname "$0")/.env.test"
  [ -f "$ENV_FILE" ] && source "$ENV_FILE" || { echo "ERROR: No API_KEY. Run 2-topup.sh first."; exit 1; }
fi

echo "==> POST /v1/close (refund unused USDG to buyer)"
curl -s "$BASE_URL/v1/close" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -X POST | jq .

echo ""
echo "Session closed. API key is now invalid."
