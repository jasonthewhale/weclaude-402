export const NETWORK = "eip155:196" as const; // X Layer
export const PAY_TO = process.env.SELLER_ADDRESS || "0x15df42a6ae23a4748c2a06e2bbe1e1bfaa525501";
export const PORT = Number(process.env.PORT) || 42069;

// USDG on X Layer (6 decimals)
export const USDG_ASSET = "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8";

// Default topup: $0.10 USDG = 100_000 atomic units
export const TOPUP_AMOUNT = "100000";
export const TOPUP_USD = 0.1;

// Supported topup tiers (USD). Each gets its own x402 route.
export const TOPUP_TIERS: number[] = [0.1, 0.5, 1.0, 5.0];

/** Convert USD amount to USDG atomic units (6 decimals). */
export function usdToAtomic(usd: number): string {
  return Math.round(usd * 1_000_000).toString();
}

/** URL path for a topup tier. Preserves decimal (1.0 → "1.0", not "1"). */
export function tierPath(usd: number): string {
  return usd === TOPUP_USD ? "/v1/buyer/topup" : `/v1/buyer/topup/${usd.toFixed(1)}`;
}

// Minimum balance required to attempt an API call (pre-flight sanity check).
// Actual cost is deducted after the call based on real token usage.
export const MIN_BALANCE_USD = 0.0001;

// When balance drops below this, inject a low-balance warning in API responses.
export const LOW_BALANCE_THRESHOLD_USD = 1.0;

// ── Rate limiting defaults (per OAuth account) ──
// Conservative — adapts from upstream 429 headers at runtime.
export const DEFAULT_MAX_RPM = 40;       // requests per minute
export const DEFAULT_MAX_TPM = 200_000;  // tokens per minute

// ── Upstream utilization tracking ──
// How long before upstream-reported utilization data is considered stale.
// After this, we assume 0 (the account hasn't been used recently).
export const UPSTREAM_UTIL_STALE_MS = 60 * 60 * 1000; // 1 hour

// ── Revenue split ──
// Fraction of buyer cost that goes to the OAuth account owner (seller).
// Platform keeps the remainder (1 - SELLER_REVENUE_SHARE).
export const SELLER_REVENUE_SHARE = 0.8; // 80% seller, 20% platform

// ── Seller OAuth flow ──
export const SELLER_AUTH_TTL_MS = 5 * 60_000; // 5 min for OAuth flow

// ── Public-facing base URL (used in grace prompt, frontend proxy, etc.) ──
export const API_BASE_URL = process.env.API_BASE_URL || "https://weclaude.cc";

// ── Grace period (free topup assistance via OpenAI when balance depleted) ──
export const GRACE_MAX_REQUESTS = 8;           // enough for a full topup flow (~5 rounds + retries)
export const GRACE_TTL_MS = 10 * 60_000;       // grace window resets after 10 min
