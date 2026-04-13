#!/usr/bin/env bash
# 4-models.sh — List available Claude models (open, no auth required).
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:4021}"

echo "==> GET /v1/models"
curl -s "$BASE_URL/v1/models" | jq .
