/**
 * Seller OAuth endpoints — allow users to contribute their Claude OAuth tokens.
 *
 * Flow (skill + manual paste):
 *   1. POST /v1/seller/auth/start  { seller_address }  → { auth_url, state }
 *   2. Seller visits auth_url, logs into Claude, approves
 *   3. POST /v1/seller/auth/complete { state, callback_url | code } → { status, account_id }
 *   4. GET  /v1/seller/status?address=0x...  → usage stats
 */

import type { Request, Response } from "express";
import crypto from "crypto";
import { generatePKCECodes } from "./pkce.js";
import { generateAuthURL, exchangeCodeForTokens } from "./oauth.js";
import type { AccountManager } from "./manager.js";
import { SELLER_AUTH_TTL_MS } from "../config.js";
import {
  upsertOAuthAccount,
  getOAuthAccountBySeller,
  getOAuthAccount,
  incrementOAuthAccountClaimed,
  revokeOAuthAccount,
  logTransaction,
  createSellerAuthSession,
  getSellerAuthSession,
  completeSellerAuthSession,
  cleanupExpiredSessions,
} from "../x402/db.js";
import { refundBuyer } from "../x402/refund.js";

const MIN_CLAIM_USD = 0.01;

// Prevents concurrent claims for the same seller (TOCTOU race condition).
const claimLocks = new Set<string>();

/**
 * POST /v1/seller/auth/start — begin OAuth flow for a seller.
 */
export function handleSellerAuthStart(req: Request, res: Response): void {
  const { seller_address } = req.body;

  if (!seller_address || !/^0x[0-9a-fA-F]{40}$/.test(seller_address)) {
    res.status(400).json({ error: { message: "Invalid seller_address — must be 0x + 40 hex chars" } });
    return;
  }

  const address = seller_address.toLowerCase();

  // Check if seller already has an active account
  const existing = getOAuthAccountBySeller(address);
  if (existing && existing.status === "active") {
    res.status(409).json({
      error: { message: "This address already has an active OAuth account" },
      account_id: existing.account_id,
    });
    return;
  }

  // Generate PKCE + state
  const pkce = generatePKCECodes();
  const state = crypto.randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + SELLER_AUTH_TTL_MS).toISOString();

  // Store pending session
  createSellerAuthSession(state, address, pkce.codeVerifier, expiresAt);

  // Clean up any old expired sessions
  cleanupExpiredSessions();

  // Build auth URL
  const authUrl = generateAuthURL(state, pkce);

  console.log(`[seller] auth start for ${address}, state=${state.slice(0, 8)}...`);

  res.json({
    auth_url: authUrl,
    state,
    expires_in: Math.round(SELLER_AUTH_TTL_MS / 1000),
    instructions: [
      "1. Visit auth_url in your browser",
      "2. Log into Claude and approve access",
      "3. After redirect, copy the full URL from your browser address bar",
      "4. POST /v1/seller/auth/complete with { \"state\": \"...\", \"callback_url\": \"<pasted URL>\" }",
    ],
  });
}

/**
 * POST /v1/seller/auth/complete — exchange OAuth code for tokens and add to pool.
 */
export async function handleSellerAuthComplete(
  req: Request,
  res: Response,
  manager: AccountManager,
): Promise<void> {
  const { state, callback_url, code: directCode } = req.body;

  if (!state) {
    res.status(400).json({ error: { message: "state is required" } });
    return;
  }

  // Look up pending session
  const session = getSellerAuthSession(state);
  if (!session) {
    res.status(404).json({ error: { message: "Auth session not found or expired" } });
    return;
  }

  if (session.status !== "pending") {
    res.status(409).json({ error: { message: "Auth session already completed" } });
    return;
  }

  if (new Date(session.expires_at) < new Date()) {
    res.status(410).json({ error: { message: "Auth session expired — start a new one" } });
    return;
  }

  // Extract authorization code
  let code: string | null = null;
  if (directCode && typeof directCode === "string") {
    code = directCode;
  } else if (callback_url && typeof callback_url === "string") {
    try {
      const url = new URL(callback_url);
      code = url.searchParams.get("code");
    } catch {
      res.status(400).json({ error: { message: "Invalid callback_url" } });
      return;
    }
  }

  if (!code) {
    res.status(400).json({
      error: { message: "Provide callback_url (the full redirect URL) or code (the authorization code)" },
    });
    return;
  }

  // Exchange code for tokens
  try {
    const pkce = { codeVerifier: session.pkce_verifier, codeChallenge: "" };
    const token = await exchangeCodeForTokens(code, state, state, pkce);

    // Persist to oauth_accounts
    upsertOAuthAccount({
      account_id: token.email,
      account_uuid: token.accountUuid,
      seller_address: session.seller_address,
      source: "seller",
      status: "active",
    });

    // Add to in-memory pool + disk
    manager.addAccount(token);

    // Mark session as completed
    completeSellerAuthSession(state);

    console.log(`[seller] auth complete: ${token.email} → ${session.seller_address}`);

    res.json({
      status: "ok",
      account_id: token.email,
      seller_address: session.seller_address,
      message: "OAuth token added to pool. Your account is now serving requests.",
    });
  } catch (err: any) {
    console.error(`[seller] token exchange failed: ${err.message}`);
    res.status(500).json({
      error: { message: `Token exchange failed: ${err.message}` },
    });
  }
}

/**
 * GET /v1/seller/status?address=0x... — view seller account stats.
 */
export function handleSellerStatus(req: Request, res: Response): void {
  const address =
    typeof req.query.address === "string" ? req.query.address.toLowerCase() : null;

  if (!address || !/^0x[0-9a-f]{40}$/.test(address)) {
    res.status(400).json({ error: { message: "Provide ?address=0x... (40 hex chars)" } });
    return;
  }

  const account = getOAuthAccountBySeller(address);
  if (!account) {
    res.status(404).json({ error: { message: "No account found for this address" } });
    return;
  }

  res.json({
    account_id: account.account_id,
    seller_address: account.seller_address,
    source: account.source,
    status: account.status,
    earned_usd: account.earned_usd,
    claimed_usd: account.claimed_usd,
    total_requests: account.total_requests,
    total_input_tokens: account.total_input_tokens,
    total_output_tokens: account.total_output_tokens,
    total_cache_creation_tokens: account.total_cache_creation_tokens,
    total_cache_read_tokens: account.total_cache_read_tokens,
    created_at: account.created_at,
  });
}

/**
 * GET /v1/seller/earn?address=0x... — earnings breakdown for a seller.
 *
 * Also supports ?account_id=email for server-owned accounts.
 */
export function handleSellerEarn(req: Request, res: Response): void {
  const address =
    typeof req.query.address === "string" ? req.query.address.toLowerCase() : null;
  const accountId =
    typeof req.query.account_id === "string" ? req.query.account_id : null;

  let account;
  if (address && /^0x[0-9a-f]{40}$/.test(address)) {
    account = getOAuthAccountBySeller(address);
  } else if (accountId) {
    account = getOAuthAccount(accountId);
  } else {
    res.status(400).json({
      error: { message: "Provide ?address=0x... or ?account_id=<email>" },
    });
    return;
  }

  if (!account) {
    res.status(404).json({ error: { message: "No account found" } });
    return;
  }

  const claimable = Math.max(0, account.earned_usd - account.claimed_usd);

  res.json({
    account_id: account.account_id,
    seller_address: account.seller_address,
    source: account.source,
    status: account.status,
    earned_usd: account.earned_usd,
    claimed_usd: account.claimed_usd,
    claimable_usd: claimable,
    total_requests: account.total_requests,
    created_at: account.created_at,
  });
}

/**
 * POST /v1/seller/claim — claim accumulated earnings as USDG on-chain.
 *
 * Body: { "seller_address": "0x..." }
 */
export async function handleSellerClaim(req: Request, res: Response): Promise<void> {
  const { seller_address } = req.body;

  if (!seller_address || !/^0x[0-9a-fA-F]{40}$/.test(seller_address)) {
    res.status(400).json({
      error: { message: "Invalid seller_address — must be 0x + 40 hex chars" },
    });
    return;
  }

  const address = seller_address.toLowerCase();

  // Prevent concurrent claims — the on-chain tx takes ~2s, creating a TOCTOU window.
  if (claimLocks.has(address)) {
    res.status(429).json({
      error: { message: "A claim is already in progress for this address. Try again shortly." },
    });
    return;
  }

  const account = getOAuthAccountBySeller(address);

  if (!account) {
    res.status(404).json({ error: { message: "No account found for this address" } });
    return;
  }

  const claimable = Math.max(0, account.earned_usd - account.claimed_usd);

  if (claimable < MIN_CLAIM_USD) {
    res.json({
      status: "nothing_to_claim",
      earned_usd: account.earned_usd,
      claimed_usd: account.claimed_usd,
      claimable_usd: claimable,
      min_claim_usd: MIN_CLAIM_USD,
      message: `Minimum claim is $${MIN_CLAIM_USD.toFixed(2)}. Current claimable: $${claimable.toFixed(6)}.`,
    });
    return;
  }

  claimLocks.add(address);
  try {
    // Send USDG on-chain (same mechanism as buyer refund)
    const payout = refundBuyer(address, claimable);

    if (!payout.success) {
      console.error(`[seller-claim] payout failed for ${address}: ${payout.error}`);
      res.status(500).json({
        status: "payout_failed",
        claimable_usd: claimable,
        message: `Payout of $${claimable.toFixed(6)} failed. Your earnings are unchanged. Please try again later.`,
      });
      return;
    }

    // Payout succeeded — update claimed amount
    incrementOAuthAccountClaimed(account.account_id, claimable);

    console.log(`[seller-claim] ${account.account_id} claimed $${claimable.toFixed(6)} → ${address}`);

    res.json({
      status: "claimed",
      account_id: account.account_id,
      claimed_amount: `$${claimable.toFixed(6)}`,
      total_earned: `$${account.earned_usd.toFixed(6)}`,
      total_claimed: `$${(account.claimed_usd + claimable).toFixed(6)}`,
      payout_tx: payout.output,
      message: `$${claimable.toFixed(6)} USDG sent to ${address}.`,
    });
  } finally {
    claimLocks.delete(address);
  }
}

/**
 * POST /v1/seller/auth/revoke — stop sharing and remove OAuth account from pool.
 *
 * Auto-claims any unclaimed earnings before revoking.
 * Body: { "seller_address": "0x..." }
 */
export async function handleSellerAuthRevoke(
  req: Request,
  res: Response,
  manager: AccountManager,
): Promise<void> {
  const { seller_address } = req.body;

  if (!seller_address || !/^0x[0-9a-fA-F]{40}$/.test(seller_address)) {
    res.status(400).json({
      error: { message: "Invalid seller_address — must be 0x + 40 hex chars" },
    });
    return;
  }

  const address = seller_address.toLowerCase();

  const account = getOAuthAccountBySeller(address);
  if (!account) {
    res.status(404).json({ error: { message: "No account found for this address" } });
    return;
  }

  if (account.status === "revoked") {
    res.status(409).json({ error: { message: "Account is already revoked" } });
    return;
  }

  // Prevent concurrent revoke + claim race
  if (claimLocks.has(address)) {
    res.status(429).json({
      error: { message: "A claim is already in progress for this address. Try again shortly." },
    });
    return;
  }

  claimLocks.add(address);
  try {
    // Auto-claim unclaimed earnings
    const claimable = Math.max(0, account.earned_usd - account.claimed_usd);
    let payout_tx: string | null = null;

    if (claimable >= MIN_CLAIM_USD) {
      const payout = refundBuyer(address, claimable);
      if (payout.success) {
        incrementOAuthAccountClaimed(account.account_id, claimable);
        payout_tx = payout.output ?? null;
        console.log(`[seller-revoke] auto-claimed $${claimable.toFixed(6)} → ${address}`);
      } else {
        console.error(`[seller-revoke] auto-claim failed for ${address}: ${payout.error}`);
        res.status(500).json({
          status: "claim_failed",
          claimable_usd: claimable,
          message: `Auto-claim of $${claimable.toFixed(6)} failed. Account NOT revoked. Please try again later.`,
        });
        return;
      }
    }

    // Remove from in-memory pool + delete token file
    manager.removeAccount(account.account_id);

    // Mark as revoked in DB (not deleted)
    revokeOAuthAccount(account.account_id);

    console.log(`[seller-revoke] ${account.account_id} revoked by ${address}`);

    res.json({
      status: "revoked",
      account_id: account.account_id,
      seller_address: address,
      earned_usd: account.earned_usd,
      claimed_usd: account.claimed_usd + claimable,
      auto_claimed_usd: claimable,
      payout_tx,
      message: claimable > 0
        ? `Account revoked. $${claimable.toFixed(6)} USDG auto-claimed to ${address}.`
        : "Account revoked. No unclaimed earnings.",
    });
  } finally {
    claimLocks.delete(address);
  }
}
