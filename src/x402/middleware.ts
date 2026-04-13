/**
 * x402 middleware — API key extraction and balance gating.
 *
 * Pre-flight check estimates the cost of the request based on input tokens
 * and max_tokens, then rejects if estimated cost exceeds the balance.
 * Actual cost is deducted after the API call completes (see index.ts).
 */

import type express from "express";
import { getBalance } from "./balance.js";
import { MIN_BALANCE_USD } from "../config.js";
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
      res.status(401).json({ error: { message: "Missing API key. Top up first: POST /v1/topup" } });
      return;
    }
    const account = getBalance(key);
    if (!account) {
      res.status(403).json({ error: { message: "Invalid API key. Top up first: POST /v1/topup" } });
      return;
    }
    const threshold = Math.max(estimatedCost, MIN_BALANCE_USD);
    if (account.balanceUsd < threshold) {
      res.status(402).json({
        error: {
          message: "Insufficient balance. Please top up before sending request.",
          type: "insufficient_balance",
          balance: `$${account.balanceUsd.toFixed(6)}`,
          estimated_cost: `$${estimatedCost.toFixed(6)}`,
          topup_url: "/v1/topup",
          close_url: "/v1/close",
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
    res.status(401).json({ error: { message: "Missing API key. Top up first: POST /v1/topup" } });
    return;
  }
  const account = getBalance(key);
  if (!account) {
    res.status(403).json({ error: { message: "Invalid API key. Top up first: POST /v1/topup" } });
    return;
  }
  next();
};
