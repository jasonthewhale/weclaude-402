#!/usr/bin/env bash
# 0-wallet-setup.sh — Ensure onchainos wallet is logged in and has USDG on X Layer.
set -euo pipefail

echo "==> Checking onchainos wallet status..."
STATUS=$(onchainos wallet status 2>/dev/null)
LOGGED_IN=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['loggedIn'])")

if [ "$LOGGED_IN" = "False" ]; then
  echo "Wallet is NOT logged in."
  echo ""
  echo "  onchainos wallet login"
  echo "  onchainos wallet verify --code <OTP>"
  exit 1
fi

echo "Wallet is logged in."
echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)['data']
print(f\"  Account: {d['currentAccountName']}\")
print(f\"  Email:   {d['email']}\")
"

echo ""
echo "==> EVM address..."
onchainos wallet addresses 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)['data']['evm']
print(f\"  {d[0]['address']}\" if d else '  (none)')
"

echo ""
echo "==> X Layer (chain 196) balance..."
onchainos wallet balance --chain 196 2>/dev/null | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  if d.get('ok'):
    balances = d.get('data', {}).get('balances', d.get('data', []))
    if isinstance(balances, list):
      for b in balances:
        sym = b.get('symbol', b.get('tokenSymbol', '?'))
        amt = b.get('balance', b.get('amount', '0'))
        print(f'  {sym}: {amt}')
      if not balances: print('  (no balances)')
    else: print(f'  {json.dumps(balances, indent=2)}')
  else: print(f'  Error: {d}')
except: print('  (could not parse)')
" 2>/dev/null || echo "  (balance check failed)"
