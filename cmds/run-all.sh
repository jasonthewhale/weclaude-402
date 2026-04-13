#!/usr/bin/env bash
# run-all.sh — Walk through the full x402 buyer flow interactively.
#
# Prerequisites:
#   1. Server running: bun run dev
#   2. onchainos wallet logged in with USDG on X Layer
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:4021}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

step() { echo -e "\n${CYAN}━━━ Step $1: $2 ━━━${NC}\n"; }
pause() { echo ""; read -p "Press Enter to continue..." </dev/tty; }

# ── Step 0: Wallet check ──
step 0 "Wallet setup"
bash "$SCRIPT_DIR/0-wallet-setup.sh" || { echo -e "${RED}Fix wallet setup first.${NC}"; exit 1; }
pause

# ── Step 1: Health ──
step 1 "Health check"
bash "$SCRIPT_DIR/1-health.sh" || { echo -e "${RED}Server not running. Start: bun run dev${NC}"; exit 1; }
pause

# ── Step 2: Topup via x402 ──
step 2 "Topup — pay USDG via x402"
bash "$SCRIPT_DIR/2-topup.sh"
source "$SCRIPT_DIR/.env.test"
echo -e "\nAPI Key: ${YELLOW}${API_KEY:0:24}...${NC}"
pause

# ── Step 3: Check balance ──
step 3 "Check balance (\$0.10)"
bash "$SCRIPT_DIR/3-balance.sh"
pause

# ── Step 4: List models ──
step 4 "List models (open, no auth)"
bash "$SCRIPT_DIR/4-models.sh"
pause

# ── Step 5: Chat completion ──
step 5 "Chat completion (OpenAI format) — deducts \$0.001"
bash "$SCRIPT_DIR/5-chat.sh" "Say hello in one sentence."
pause

# ── Step 6: Messages ──
step 6 "Messages (Anthropic format) — deducts \$0.001"
bash "$SCRIPT_DIR/6-messages.sh" "What is 2+2? One word."
pause

# ── Step 7: Count tokens ──
step 7 "Count tokens (free, no deduction)"
bash "$SCRIPT_DIR/7-count-tokens.sh"
pause

# ── Step 8: Balance after usage ──
step 8 "Balance after 2 calls (\$0.002 used)"
bash "$SCRIPT_DIR/3-balance.sh"
pause

# ── Step 9: Close & refund ──
step 9 "Close session — refund unused USDG to buyer"
bash "$SCRIPT_DIR/8-close.sh"

echo ""
echo -e "${GREEN}━━━ Full flow complete ━━━${NC}"
echo ""
echo "  Topped up:  \$0.10 USDG via x402"
echo "  Used:       \$0.002 (2 LLM calls)"
echo "  Refunded:   \$0.098 USDG back to buyer"
