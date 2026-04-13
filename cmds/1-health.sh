#!/usr/bin/env bash
# 1-health.sh — Verify the WeClaude server is running.
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:4021}"

echo "==> GET /health"
curl -s "$BASE_URL/health" | jq .
