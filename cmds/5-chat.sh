#!/usr/bin/env bash
# 5-chat.sh — Send a chat completion (OpenAI format). Deducts $0.001.
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:4021}"

if [ -z "${API_KEY:-}" ]; then
  ENV_FILE="$(dirname "$0")/.env.test"
  [ -f "$ENV_FILE" ] && source "$ENV_FILE" || { echo "ERROR: No API_KEY. Run 2-topup.sh first."; exit 1; }
fi

PROMPT="${1:-Say hello in one sentence.}"

echo "==> POST /v1/chat/completions"
echo "    Prompt: $PROMPT"
echo ""

curl -s "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg p "$PROMPT" '{
    model: "claude-sonnet-4-20250514",
    max_tokens: 256,
    messages: [{role: "user", content: $p}]
  }')" | jq .
