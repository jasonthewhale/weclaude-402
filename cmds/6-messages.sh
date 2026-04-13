#!/usr/bin/env bash
# 6-messages.sh — Send a message (Anthropic native format). Deducts $0.001.
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:4021}"

if [ -z "${API_KEY:-}" ]; then
  ENV_FILE="$(dirname "$0")/.env.test"
  [ -f "$ENV_FILE" ] && source "$ENV_FILE" || { echo "ERROR: No API_KEY. Run 2-topup.sh first."; exit 1; }
fi

PROMPT="${1:-What is 2+2? Answer in one word.}"

echo "==> POST /v1/messages"
echo "    Prompt: $PROMPT"
echo ""

curl -s "$BASE_URL/v1/messages" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d "$(jq -n --arg p "$PROMPT" '{
    model: "claude-sonnet-4-20250514",
    max_tokens: 256,
    messages: [{role: "user", content: $p}]
  }')" | jq .
