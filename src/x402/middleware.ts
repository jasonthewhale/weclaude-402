/**
 * x402 middleware — API key extraction and balance gating.
 *
 * Pre-flight check estimates the cost of the request based on input tokens
 * and max_tokens, then rejects if estimated cost exceeds the balance.
 * Actual cost is deducted after the API call completes (see index.ts).
 */

import type express from "express";
import { getBalance } from "./balance.js";
import { MIN_BALANCE_USD, TOPUP_TIERS, LOW_BALANCE_THRESHOLD_USD } from "../config.js";
import { estimateCost } from "../pricing.js";

export function extractKey(req: express.Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const xKey = req.headers["x-api-key"];
  if (typeof xKey === "string") return xKey;
  return null;
}

/**
 * Require a valid API key with sufficient balance.
 *
 * For gated (LLM) paths, estimates the request cost from the body
 * and rejects if the balance can't cover it.
 * For free paths (token counting), only checks key validity.
 */
export function requireBalanceFor(estimatedCost: number): express.RequestHandler {
  return (req, res, next) => {
    const key = extractKey(req);
    if (!key) {
      res.status(401).json({ error: { message: "Missing API key. Top up first: POST /v1/buyer/topup" } });
      return;
    }
    const account = getBalance(key);
    if (!account) {
      res.status(403).json({ error: { message: "Invalid API key. Top up first: POST /v1/buyer/topup" } });
      return;
    }
    // Stash balance for low-balance warning injection downstream
    res.locals.weclaudeBalance = account.balanceUsd;

    // Set balance headers — sent with both streaming (flushHeaders) and non-streaming responses
    res.setHeader("X-WeClaude-Balance", account.balanceUsd.toFixed(6));
    if (account.balanceUsd < LOW_BALANCE_THRESHOLD_USD) {
      res.setHeader("X-WeClaude-Warning", "low_balance");
      res.setHeader("X-WeClaude-Message", `Balance is low ($${account.balanceUsd.toFixed(2)}). Top up to avoid interruption.`);
    }

    const threshold = Math.max(estimatedCost, MIN_BALANCE_USD);
    if (account.balanceUsd < threshold) {
      res.status(402).json({
        error: {
          message: "Insufficient balance. Top up by sending an x402 payment to /v1/buyer/topup.",
          type: "insufficient_balance",
          balance: `$${account.balanceUsd.toFixed(6)}`,
          estimated_cost: `$${estimatedCost.toFixed(6)}`,
          topup_tiers: TOPUP_TIERS.map((t) => ({ amount: `$${t.toFixed(2)}`, url: t === 0.1 ? "/v1/buyer/topup" : `/v1/buyer/topup/${t.toFixed(1)}` })),
          instructions: [
            "1. POST /v1/buyer/topup (or /v1/buyer/topup/<amount> for larger tiers) — returns a 402 with x402 payment details in the body",
            "2. Follow the 'instructions' array in that 402 response to sign and replay the payment",
            "3. Same wallet gets the same API key with added balance — no need to reconfigure",
          ],
        },
      });
      return;
    }
    next();
  };
}

/** Simple key + balance check (no cost estimation, used for free endpoints). */
export const requireBalance: express.RequestHandler = (req, res, next) => {
  const key = extractKey(req);
  if (!key) {
    res.status(401).json({ error: { message: "Missing API key. Top up first: POST /v1/buyer/topup" } });
    return;
  }
  const account = getBalance(key);
  if (!account) {
    res.status(403).json({ error: { message: "Invalid API key. Top up first: POST /v1/buyer/topup" } });
    return;
  }
  next();
};
