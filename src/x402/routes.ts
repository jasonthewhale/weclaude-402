/**
 * x402 route handlers — topup, withdraw, balance, health.
 */

import type { Request, Response } from "express";
import {
  getBalance,
  setBalance,
  generateApiKey,
  type AccountBalance,
} from "./balance.js";
import { getBuyerByPayer, logTransaction } from "./db.js";
import { extractKey } from "./middleware.js";
import { refundBuyer } from "./refund.js";
import { TOPUP_USD, NETWORK, PAY_TO } from "../config.js";

/**
 * POST /v1/topup — x402 payment settled by middleware, then issue API key.
 *
 * If the payer already has a key, top up that existing account instead
 * of creating a new one.
 */
export function handleTopup(req: Request, res: Response): void {
  let payer = "unknown";
  const paymentSig = req.headers["payment-signature"] as string;
  if (paymentSig) {
    try {
      const decoded = JSON.parse(Buffer.from(paymentSig, "base64").toString());
      payer = decoded?.payload?.authorization?.from || "unknown";
    } catch { /* ignore */ }
  }

  // Check if this payer already has an account
  const existing = payer !== "unknown" ? getBuyerByPayer(payer) : undefined;

  let apiKey: string;
  if (existing) {
    // Top up existing account
    apiKey = existing.api_key;
    const account = getBalance(apiKey)!;
    account.balanceUsd += TOPUP_USD;
    setBalance(apiKey, account);
    logTransaction(apiKey, "topup", TOPUP_USD);
    console.log(`[topup] existing key=${apiKey.slice(0, 16)}... +$${TOPUP_USD} balance=$${account.balanceUsd.toFixed(6)} payer=${payer}`);
  } else {
    // New buyer
    apiKey = generateApiKey();
    const account: AccountBalance = {
      apiKey,
      balanceUsd: TOPUP_USD,
      usedUsd: 0,
      payer,
      createdAt: Date.now(),
    };
    setBalance(apiKey, account);
    logTransaction(apiKey, "topup", TOPUP_USD);
    console.log(`[topup] new key=${apiKey.slice(0, 16)}... balance=$${TOPUP_USD} payer=${payer}`);
  }

  res.json({
    api_key: apiKey,
    balance: `$${(getBalance(apiKey)!.balanceUsd).toFixed(2)}`,
    pricing: "real token usage — varies by model",
    close_url: "/v1/close",
    usage: `Authorization: Bearer ${apiKey}`,
  });
}

/**
 * POST /v1/close — withdraw remaining balance, keep the account.
 */
export async function handleClose(req: Request, res: Response): Promise<void> {
  const key = extractKey(req);
  if (!key) { res.status(401).json({ error: { message: "Missing API key" } }); return; }
  const account = getBalance(key);
  if (!account) { res.status(403).json({ error: { message: "Invalid API key" } }); return; }

  const withdrawUsd = account.balanceUsd;
  if (withdrawUsd <= 0) {
    res.json({ status: "nothing_to_withdraw", used: `$${account.usedUsd.toFixed(6)}`, balance: "$0.000000" });
    return;
  }

  const refund = account.payer !== "unknown"
    ? refundBuyer(account.payer, withdrawUsd)
    : { success: true, output: "no-refund-needed" };

  // Zero the balance but keep the row
  account.balanceUsd = 0;
  setBalance(key, account);
  logTransaction(key, "withdraw", withdrawUsd);

  console.log(`[close] key=${key.slice(0, 16)}... withdrew=$${withdrawUsd.toFixed(6)} used=$${account.usedUsd.toFixed(6)}`);

  res.json({
    status: "withdrawn",
    used: `$${account.usedUsd.toFixed(6)}`,
    withdrawn: `$${withdrawUsd.toFixed(6)}`,
    refund_result: refund.success ? refund.output : null,
    refund_error: refund.success ? undefined : (refund as any).error,
    message: refund.success
      ? `Withdrew $${withdrawUsd.toFixed(6)} to ${account.payer}. Total used: $${account.usedUsd.toFixed(6)}.`
      : `Withdraw failed: ${(refund as any).error}`,
  });
}

/**
 * GET /v1/balance — check remaining balance.
 */
export function handleBalance(req: Request, res: Response): void {
  const key = extractKey(req);
  if (!key) { res.status(401).json({ error: { message: "Missing API key" } }); return; }
  const account = getBalance(key);
  if (!account) { res.status(403).json({ error: { message: "Invalid API key" } }); return; }
  res.json({
    balance: `$${account.balanceUsd.toFixed(6)}`,
    used: `$${account.usedUsd.toFixed(6)}`,
    topup: `$${TOPUP_USD.toFixed(2)}`,
  });
}

/**
 * GET /health — service health check.
 */
export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    network: NETWORK,
    topup_price: `$${TOPUP_USD} USDG`,
    pricing: "real token usage — varies by model",
  });
}
