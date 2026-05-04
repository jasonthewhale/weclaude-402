/**
 * Retry-aware proxy for upstream API calls.
 *
 * Handles:
 * - Account rotation on failure (picks next available account)
 * - Automatic token refresh on 401
 * - Exponential backoff between retries
 * - Classification of failure types for cooldown strategy
 */

import type { Response as ExpressResponse } from "express";
import type { AccountFailureKind, AvailableAccount, AccountResult, AccountProvider } from "./types.js";
import type { OAuth2ApiConfig } from "./types.js";

const MAX_RETRIES = 3;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const OAUTH_ORG_NOT_ALLOWED_MESSAGE =
  "oauth authentication is currently not allowed for this organization";
// Account-level rejections: don't penalise the client — switch to the next
// account immediately with no backoff. The failing account is already put in
// cooldown by recordFailure() so getNextAccount() skips it on the next loop.
const FAST_RETRY_STATUSES = new Set([403]);

function isOAuthOrgNotAllowedTransient(status: number, body?: string): boolean {
  return (
    status === 403 &&
    !!body &&
    body.toLowerCase().includes(OAUTH_ORG_NOT_ALLOWED_MESSAGE)
  );
}

function classifyFailure(status: number, headers?: Headers, body?: string): AccountFailureKind {
  if (status === 429) {
    // Distinguish temporary rate limit from quota exhaustion.
    // Claude returns these headers on every response:
    //   anthropic-ratelimit-unified-status: 'allowed' | 'allowed_warning' | 'rejected'
    //   anthropic-ratelimit-unified-5h-utilization: 0-1 fraction
    const unifiedStatus = headers?.get("anthropic-ratelimit-unified-status");
    const util5h = parseFloat(headers?.get("anthropic-ratelimit-unified-5h-utilization") || "0");
    const util7d = parseFloat(headers?.get("anthropic-ratelimit-unified-7d-utilization") || "0");

    // If unified status is 'rejected' or utilization is >= 100%, this account's quota is exhausted
    if (unifiedStatus === "rejected" || util5h >= 1.0 || util7d >= 1.0) {
      return "quota_exhausted";
    }

    // Also check body for quota-related keywords (fallback)
    if (body) {
      const lower = body.toLowerCase();
      if (lower.includes("usage limit") || lower.includes("quota") || lower.includes("exceeded")) {
        return "quota_exhausted";
      }
    }

    return "rate_limit";
  }
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  return "server";
}

const FAILURE_RESPONSES: Record<
  AccountFailureKind,
  { status: number; message: string }
> = {
  rate_limit: { status: 429, message: "Service is temporarily rate limited. Please retry shortly." },
  quota_exhausted: { status: 429, message: "Service capacity temporarily reached. Please retry later." },
  auth: { status: 503, message: "Service temporarily unavailable. Please retry later." },
  forbidden: { status: 503, message: "Service temporarily unavailable. Please retry later." },
  server: { status: 503, message: "Service temporarily unavailable. Please retry later." },
  network: { status: 503, message: "Service temporarily unavailable. Please retry later." },
};

function accountUnavailable(
  resp: ExpressResponse,
  result: Extract<AccountResult, { account: null }>,
): void {
  const { failureKind, retryAfterMs } = result;

  if (!failureKind) {
    resp.status(503).json({ error: { message: "No available account" } });
    return;
  }

  const { status, message } = FAILURE_RESPONSES[failureKind];
  if (retryAfterMs && retryAfterMs > 0) {
    resp.setHeader(
      "Retry-After",
      Math.max(1, Math.ceil(retryAfterMs / 1000)).toString(),
    );
  }
  resp.status(status).json({ error: { message } });
}

export interface ProxyOptions {
  upstream: (account: AvailableAccount) => Promise<Response>;
  success: (upstream: Response, account: AvailableAccount) => Promise<void>;
  maxRetries?: number;
}

export async function proxyWithRetry(
  tag: string,
  resp: ExpressResponse,
  config: OAuth2ApiConfig,
  manager: AccountProvider,
  options: ProxyOptions,
): Promise<void> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  let lastStatus = 500;
  let lastErrBody = "";
  const refreshedAccounts = new Set<string>();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = manager.getNextAccount();
    if (!result.account) {
      return accountUnavailable(resp, result);
    }
    const account = result.account;
    manager.recordAttempt(account.token.email);

    let upstream: Response;
    try {
      upstream = await options.upstream(account);
    } catch (err: any) {
      manager.recordFailure(account.token.email, "network", err.message);
      if (config.debug !== "off") {
        console.error(
          `[proxy] ${tag} attempt ${attempt + 1} network failure: ${err.message}`,
        );
      }
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
        continue;
      }
      resp.status(502).json({ error: { message: "Upstream network error" } });
      return;
    }

    // Capture upstream utilization headers (sent on every response, not just 429s).
    // These feed the multi-window routing: accounts with lower 5h/7d utilization
    // are preferred by PoolAllocator.
    const raw5h = upstream.headers.get("anthropic-ratelimit-unified-5h-utilization");
    const raw7d = upstream.headers.get("anthropic-ratelimit-unified-7d-utilization");
    if (raw5h || raw7d) {
      const u5h = parseFloat(raw5h || "0");
      const u7d = parseFloat(raw7d || "0");
      if (!isNaN(u5h) || !isNaN(u7d)) {
        manager.recordUpstreamUtilization(
          account.token.email,
          isNaN(u5h) ? 0 : u5h,
          isNaN(u7d) ? 0 : u7d,
        );
      }
    }

    if (upstream.ok) {
      await options.success(upstream, account);
      return;
    }

    lastStatus = upstream.status;
    try {
      lastErrBody = await upstream.text();
      if (config.debug !== "off") {
        console.error(
          `[proxy] ${tag} attempt ${attempt + 1} failed (${lastStatus}): ${lastErrBody}`,
        );
      }
    } catch {}

    const oauthOrgNotAllowedTransient = isOAuthOrgNotAllowedTransient(
      lastStatus,
      lastErrBody,
    );

    if (lastStatus === 401) {
      const refreshed = await manager.refreshAccount(account.token.email);
      if (refreshed && !refreshedAccounts.has(account.token.email)) {
        refreshedAccounts.add(account.token.email);
        attempt--;
        continue;
      }
    } else if (oauthOrgNotAllowedTransient) {
      if (config.debug !== "off") {
        console.warn(
          `[proxy] ${tag} attempt ${attempt + 1} hit transient OAuth org rejection; retrying`,
        );
      }
    } else {
      const failureKind = classifyFailure(lastStatus, upstream.headers, lastErrBody);

      // Extract reset timestamp from upstream headers for precise cooldown
      let cooldownUntilMs: number | undefined;
      if (failureKind === "quota_exhausted") {
        const reset5h = upstream.headers.get("anthropic-ratelimit-unified-5h-reset");
        const reset7d = upstream.headers.get("anthropic-ratelimit-unified-7d-reset");
        const resetEpoch = reset5h || reset7d;
        if (resetEpoch) {
          const resetMs = parseFloat(resetEpoch) * 1000;
          if (resetMs > Date.now()) cooldownUntilMs = resetMs;
        }
        console.warn(`[proxy] ${tag} account ${account.token.email} quota exhausted, cooldown until ${cooldownUntilMs ? new Date(cooldownUntilMs).toISOString() : "backoff"}`);
      }

      manager.recordFailure(account.token.email, failureKind, undefined, cooldownUntilMs);
    }

    if (
      !RETRYABLE_STATUSES.has(lastStatus) &&
      !FAST_RETRY_STATUSES.has(lastStatus) &&
      !oauthOrgNotAllowedTransient
    ) {
      break;
    }
    if (RETRYABLE_STATUSES.has(lastStatus) && attempt < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
    }
    // FAST_RETRY_STATUSES: fall through immediately to next account
  }

  try {
    const parsed = lastErrBody ? JSON.parse(lastErrBody) : null;
    if (parsed && typeof parsed === "object") {
      resp.status(lastStatus).json(parsed);
    } else {
      resp.status(lastStatus).json({ error: { message: "Upstream request failed" } });
    }
  } catch {
    resp.status(lastStatus).json({ error: { message: "Upstream request failed" } });
  }
}
