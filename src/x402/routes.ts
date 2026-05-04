/**
 * x402 route handlers — topup, withdraw, balance, health.
 */

import type { Request, Response } from "express";
import {
  getBalance,
  getBalanceByPayer,
  setBalance,
  generateApiKey,
  type AccountBalance,
} from "./balance.js";
import { getBuyerByPayer, logTransaction } from "./db.js";
import { extractKey } from "./middleware.js";
import { refundBuyer } from "./refund.js";
import { TOPUP_USD, TOPUP_TIERS, NETWORK, PAY_TO } from "../config.js";
import { resetGrace } from "../grace.js";
import { getTotalTokensConsumed, getBuyerCount } from "./db.js";

// Prevents concurrent withdrawals for the same key (TOCTOU race condition).
const withdrawLocks = new Set<string>();

/**
 * POST /v1/buyer/topup — x402 payment settled by middleware, then issue API key.
 *
 * If the payer already has a key, top up that existing account instead
 * of creating a new one.
 */
export function handleTopup(req: Request, res: Response): void {
  // ── 1. Require payment header (defense-in-depth) ──
  const paymentSig = (req.headers["payment-signature"] || req.headers["x-payment"]) as string;
  if (!paymentSig) {
    res.status(402).json({
      error: { message: "Payment required. Send x402 payment to this endpoint.", topup_url: "/v1/buyer/topup" },
    });
    return;
  }

  // ── 2. Extract and validate payer address ──
  let payer: string | null = null;
  try {
    const decoded = JSON.parse(Buffer.from(paymentSig, "base64").toString());
    const from = decoded?.payload?.authorization?.from;
    if (typeof from === "string" && /^0x[0-9a-fA-F]{40}$/.test(from)) {
      payer = from.toLowerCase();
    }
  } catch { /* decode failed */ }

  if (!payer) {
    res.status(400).json({
      error: { message: "Invalid payment: could not extract payer address from payment header." },
    });
    return;
  }

  // ── 3. Resolve topup amount from path (e.g. /v1/buyer/topup/0.5 → $0.50) ──
  const pathMatch = req.path.match(/^\/v1\/buyer\/topup\/(.+)$/);
  const paramUsd = pathMatch ? parseFloat(pathMatch[1]) : NaN;
  const topupUsd = !isNaN(paramUsd) && TOPUP_TIERS.includes(paramUsd) ? paramUsd : TOPUP_USD;

  if (!Number.isFinite(topupUsd) || topupUsd <= 0) {
    res.status(400).json({ error: { message: "Invalid topup amount." } });
    return;
  }

  // ── 4. Check if this payer already has an account ──
  const existing = getBuyerByPayer(payer);

  let apiKey: string;
  const isNew = !existing;
  if (existing) {
    // Top up existing account
    apiKey = existing.api_key;
    const account = getBalance(apiKey)!;
    account.balanceUsd += topupUsd;
    setBalance(apiKey, account);
    logTransaction(apiKey, "topup", topupUsd);
    resetGrace(apiKey); // balance restored — clear grace state
    console.log(`[topup] existing key=${apiKey.slice(0, 16)}... +$${topupUsd} balance=$${account.balanceUsd.toFixed(6)} payer=${payer}`);
  } else {
    // New buyer
    apiKey = generateApiKey();
    const account: AccountBalance = {
      apiKey,
      balanceUsd: topupUsd,
      usedUsd: 0,
      payer,
      createdAt: Date.now(),
    };
    setBalance(apiKey, account);
    logTransaction(apiKey, "topup", topupUsd);
    console.log(`[topup] new key=${apiKey.slice(0, 16)}... balance=$${topupUsd} payer=${payer}`);
  }

  res.json({
    api_key: apiKey,
    balance: `$${(getBalance(apiKey)!.balanceUsd).toFixed(2)}`,
    created: isNew,
    pricing: "real token usage — varies by model",
    withdraw_url: "/v1/buyer/withdraw",
    usage: `Authorization: Bearer ${apiKey}`,
    command: `ANTHROPIC_BASE_URL=https://api.weclaude.cc ANTHROPIC_API_KEY=${apiKey} claude --dangerously-skip-permissions`,
    message: `✅ Topup successful! Balance: $${(getBalance(apiKey)!.balanceUsd).toFixed(2)}. Grace mode OFF — you can now continue using WeClaude normally.`,
  });
}

/**
 * POST /v1/buyer/withdraw — withdraw remaining balance, keep the account.
 */
export async function handleClose(req: Request, res: Response): Promise<void> {
  const key = extractKey(req);
  if (!key) { res.status(401).json({ error: { message: "Missing API key" } }); return; }

  // Prevent concurrent withdrawals — the on-chain tx takes ~2s, creating a TOCTOU window.
  if (withdrawLocks.has(key)) {
    res.status(429).json({ error: { message: "A withdrawal is already in progress. Try again shortly." } });
    return;
  }

  const account = getBalance(key);
  if (!account) { res.status(403).json({ error: { message: "Invalid API key" } }); return; }

  const withdrawUsd = account.balanceUsd;
  if (withdrawUsd <= 0) {
    res.json({ status: "nothing_to_withdraw", used: `$${account.usedUsd.toFixed(6)}`, balance: "$0.000000",
      message: `Nothing to withdraw. Total used: $${account.usedUsd.toFixed(6)}.` });
    return;
  }

  withdrawLocks.add(key);
  try {
    // Attempt refund BEFORE zeroing balance — if it fails, keep balance intact
    const refund = account.payer !== "unknown"
      ? refundBuyer(account.payer, withdrawUsd)
      : { success: true, output: "no-refund-needed" };

    if (!refund.success) {
      console.error(`[close] refund failed for key=${key.slice(0, 16)}... amount=$${withdrawUsd.toFixed(6)}: ${(refund as any).error}`);
      res.status(500).json({
        status: "refund_failed",
        balance: `$${account.balanceUsd.toFixed(6)}`,
        message: `Refund failed — your balance of $${account.balanceUsd.toFixed(6)} is unchanged. Please try again later.`,
      });
      return;
    }

    // Refund succeeded — now zero the balance
    account.balanceUsd = 0;
    setBalance(key, account);
    logTransaction(key, "withdraw", withdrawUsd);

    console.log(`[close] key=${key.slice(0, 16)}... withdrew=$${withdrawUsd.toFixed(6)} used=$${account.usedUsd.toFixed(6)}`);

    res.json({
      status: "withdrawn",
      used: `$${account.usedUsd.toFixed(6)}`,
      withdrawn: `$${withdrawUsd.toFixed(6)}`,
      refund_tx: refund.output,
      message: `Refund of $${withdrawUsd.toFixed(6)} USDG sent to ${account.payer}. Total used: $${account.usedUsd.toFixed(6)}. Thank you for using WeClaude!`,
    });
  } finally {
    withdrawLocks.delete(key);
  }
}

/**
 * GET /v1/buyer/balance — check remaining balance.
 *
 * Accepts either:
 *   - Authorization: Bearer <apiKey>   (existing)
 *   - ?payer=0x<address>               (read-only lookup by wallet)
 */
export function handleBalance(req: Request, res: Response): void {
  // Try API key first, then fall back to payer query param
  const key = extractKey(req);
  const payerParam = typeof req.query.payer === "string" ? req.query.payer.toLowerCase() : null;

  let account: AccountBalance | undefined;

  if (key) {
    account = getBalance(key);
  } else if (payerParam && /^0x[0-9a-f]{40}$/.test(payerParam)) {
    account = getBalanceByPayer(payerParam);
  } else {
    res.status(401).json({ error: { message: "Provide an API key (Bearer header) or ?payer=0x... address" } });
    return;
  }

  if (!account) {
    res.status(404).json({ error: { message: "No account found" } });
    return;
  }

  res.json({
    ...(payerParam && !key ? { api_key: account.apiKey } : {}),
    balance: `$${account.balanceUsd.toFixed(6)}`,
    used: `$${account.usedUsd.toFixed(6)}`,
    payer: account.payer,
  });
}

/**
 * GET /health — service health check.
 * Extra fields (accounts, models) are injected by the caller via setHealthExtras().
 */
let healthExtras: Record<string, unknown> = {};
export function setHealthExtras(extras: Record<string, unknown>): void {
  healthExtras = extras;
}

export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    network: NETWORK,
    topup_price: `$${TOPUP_USD} USDG`,
    pricing: "real token usage — varies by model",
    total_tokens: getTotalTokensConsumed(),
    buyers: getBuyerCount(),
    ...healthExtras,
  });
}
