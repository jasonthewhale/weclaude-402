#!/usr/bin/env bash
# 2-topup.sh — Buyer pays USDG via x402, gets API key.
#
# Flow:
#   1. POST /v1/topup → 402 + PAYMENT-REQUIRED header
#   2. onchainos payment x402-pay --accepts <json> → signed payment proof
#   3. Replay POST /v1/topup with PAYMENT-SIGNATURE header → 200 + API key
#
# Requires: onchainos wallet logged in, USDG on X Layer (chain 196).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:4021}"
BUYER_ADDRESS="${BUYER_ADDRESS:-0x5f70b9d96b369e046d838d1581560bd45e558405}"

echo "==> Step 1: POST /v1/topup (expecting 402 challenge)..."
BODYFILE=$(mktemp)
HEADERFILE=$(mktemp)
HTTP_CODE=$(curl -s -o "$BODYFILE" -D "$HEADERFILE" -w "%{http_code}" \
  "$BASE_URL/v1/topup" -X POST -H "Content-Type: application/json" 2>/dev/null)
HEADERS=$(cat "$HEADERFILE")

if [ "$HTTP_CODE" != "402" ]; then
  echo "Expected 402, got $HTTP_CODE"
  cat "$BODYFILE" | jq . 2>/dev/null || cat "$BODYFILE"
  rm -f "$BODYFILE" "$HEADERFILE"
  exit 1
fi

echo "Got 402 Payment Required."

# Extract PAYMENT-REQUIRED header (base64-encoded)
PAYMENT_REQUIRED_B64=$(echo "$HEADERS" | grep -i "^payment-required:" | sed 's/^[^:]*: *//' | tr -d '\r\n')
rm -f "$BODYFILE" "$HEADERFILE"

if [ -z "$PAYMENT_REQUIRED_B64" ]; then
  echo "ERROR: No PAYMENT-REQUIRED header in 402 response."
  exit 1
fi

# Decode payment-required to get the accepts array
PAYMENT_REQUIRED_JSON=$(echo "$PAYMENT_REQUIRED_B64" | base64 -d 2>/dev/null)
ACCEPTS=$(echo "$PAYMENT_REQUIRED_JSON" | jq -c '.accepts')

echo ""
echo "Payment details:"
echo "$PAYMENT_REQUIRED_JSON" | jq '{
  scheme: .accepts[0].scheme,
  network: .accepts[0].network,
  amount: .accepts[0].price.amount,
  asset: .accepts[0].price.asset,
  payTo: .accepts[0].payTo
}' 2>/dev/null

echo ""
echo "==> Step 2: Signing payment with onchainos..."
SIGN_RESULT=$(onchainos payment x402-pay --accepts "$ACCEPTS" --from "$BUYER_ADDRESS" 2>&1)
SIGN_EXIT=$?

if [ $SIGN_EXIT -ne 0 ] || [ -z "$SIGN_RESULT" ]; then
  echo "ERROR: onchainos payment signing failed (exit $SIGN_EXIT)."
  echo "$SIGN_RESULT"
  echo ""
  echo "Make sure:"
  echo "  1. onchainos wallet is logged in: onchainos wallet login"
  echo "  2. You have USDG on X Layer: onchainos wallet balance --chain 196"
  exit 1
fi

echo "Payment signed."
echo "$SIGN_RESULT" | jq . 2>/dev/null || echo "$SIGN_RESULT"

# Build PAYMENT-SIGNATURE: base64-encode the x402 v2 payment payload
# Per official x402 docs, the payload includes: x402Version, resource, accepted, payload
PAYMENT_SIGNATURE=$(python3 -c "
import json, base64

payment_required = json.loads('''$(echo "$PAYMENT_REQUIRED_JSON")''')
sign_result = json.loads('''$(echo "$SIGN_RESULT")''')

# The signed payload from onchainos: { authorization, signature }
data = sign_result.get('data', sign_result)

payload = {
    'x402Version': payment_required.get('x402Version', 2),
    'resource': payment_required.get('resource', {}),
    'accepted': payment_required['accepts'][0],
    'payload': {
        'signature': data['signature'],
        'authorization': data['authorization'],
    }
}

print(base64.b64encode(json.dumps(payload, separators=(',', ':')).encode()).decode())
")

echo ""
echo "==> Step 3: Replaying POST /v1/topup with signed payment..."
TOPUP_TMPBODY=$(mktemp)
TOPUP_TMPHEADER=$(mktemp)
TOPUP_HTTP_CODE=$(curl -s -o "$TOPUP_TMPBODY" -D "$TOPUP_TMPHEADER" -w "%{http_code}" \
  "$BASE_URL/v1/topup" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Payment-Signature: $PAYMENT_SIGNATURE")

echo "HTTP $TOPUP_HTTP_CODE"
TOPUP_RESPONSE=$(cat "$TOPUP_TMPBODY")
rm -f "$TOPUP_TMPBODY" "$TOPUP_TMPHEADER"

echo "$TOPUP_RESPONSE" | jq .

# Save API key
API_KEY=$(echo "$TOPUP_RESPONSE" | jq -r '.api_key // empty')
if [ -n "$API_KEY" ]; then
  echo "API_KEY=$API_KEY" > "$SCRIPT_DIR/.env.test"
  echo ""
  echo "API key saved to cmds/.env.test"
  echo "Run: source cmds/.env.test"
else
  echo ""
  echo "ERROR: No api_key in response."
  exit 1
fi
