/**
 * Rate Limiter + Pool Allocator
 *
 * In-memory sliding-window rate limiting per OAuth account (RPM/TPM).
 * PoolAllocator wraps AccountManager with least-loaded account selection
 * that respects per-account rate limits.
 */

import type {
  AccountFailureKind,
  AccountResult,
  AccountProvider,
  UsageData,
} from "./types.js";
import type { AccountManager } from "./manager.js";
import {
  incrementOAuthAccountUsage,
  incrementOAuthAccountEarnings,
  logOAuthUsage,
  getOAuthAccount,
} from "../x402/db.js";
import { UPSTREAM_UTIL_STALE_MS } from "../config.js";

// ── Sliding-window rate limiter ──

interface SlidingWindow {
  windowStartMs: number;
  requestCount: number;
  tokenCount: number;
}

interface UpstreamUtilization {
  util5h: number;
  util7d: number;
  updatedAt: number;
}

export class RateLimiter {
  private windows = new Map<string, SlidingWindow>();
  private configs = new Map<string, { maxRpm: number; maxTpm: number }>();
  private upstream = new Map<string, UpstreamUtilization>();

  constructor(
    private defaultMaxRpm: number,
    private defaultMaxTpm: number,
  ) {}

  /** Set per-account limits (from DB config). */
  setConfig(accountId: string, maxRpm?: number | null, maxTpm?: number | null): void {
    this.configs.set(accountId, {
      maxRpm: maxRpm ?? this.defaultMaxRpm,
      maxTpm: maxTpm ?? this.defaultMaxTpm,
    });
  }

  /** Check if account has headroom for a request. */
  canAccept(accountId: string, estimatedTokens: number): boolean {
    const w = this.getWindow(accountId);
    const c = this.getConfig(accountId);
    return w.requestCount < c.maxRpm && w.tokenCount + estimatedTokens < c.maxTpm;
  }

  /** Record a new request starting (increments RPM). */
  recordStart(accountId: string): void {
    const w = this.getWindow(accountId);
    w.requestCount++;
  }

  /** Record actual tokens consumed after request completes. */
  recordCompletion(accountId: string, actualTokens: number): void {
    // Window may have reset since the request started — that's fine,
    // the new window just gets a partial count.
    const w = this.getWindow(accountId);
    w.tokenCount += actualTokens;
  }

  /** Utilization ratio (0.0–1.0+), used for sorting. */
  getUtilization(accountId: string): number {
    const w = this.getWindow(accountId);
    const c = this.getConfig(accountId);
    const rpmUtil = w.requestCount / c.maxRpm;
    const tpmUtil = w.tokenCount / c.maxTpm;
    return Math.max(rpmUtil, tpmUtil);
  }

  /** Time until the current window expires (for Retry-After). */
  getRetryAfterMs(accountId: string): number {
    const w = this.windows.get(accountId);
    if (!w) return 0;
    const elapsed = Date.now() - w.windowStartMs;
    return Math.max(0, 60_000 - elapsed);
  }

  /** Update upstream-reported utilization from response headers. */
  recordUpstreamUtilization(accountId: string, util5h: number, util7d: number): void {
    this.upstream.set(accountId, { util5h, util7d, updatedAt: Date.now() });
  }

  /** Get upstream utilization. Returns 0 for stale or missing data. */
  getUpstreamUtilization(accountId: string): { util5h: number; util7d: number } {
    const u = this.upstream.get(accountId);
    if (!u || Date.now() - u.updatedAt > UPSTREAM_UTIL_STALE_MS) {
      return { util5h: 0, util7d: 0 };
    }
    return { util5h: u.util5h, util7d: u.util7d };
  }

  /**
   * Composite utilization: max across 1-min, 5h, and 7d windows.
   * Mirrors Claude's enforcement — hitting any single window triggers a 429.
   */
  getCompositeUtilization(accountId: string): number {
    const minuteUtil = this.getUtilization(accountId);
    const { util5h, util7d } = this.getUpstreamUtilization(accountId);
    return Math.max(minuteUtil, util5h, util7d);
  }

  private getWindow(accountId: string): SlidingWindow {
    const now = Date.now();
    let w = this.windows.get(accountId);
    if (!w || now - w.windowStartMs >= 60_000) {
      w = { windowStartMs: now, requestCount: 0, tokenCount: 0 };
      this.windows.set(accountId, w);
    }
    return w;
  }

  private getConfig(accountId: string) {
    return (
      this.configs.get(accountId) ?? {
        maxRpm: this.defaultMaxRpm,
        maxTpm: this.defaultMaxTpm,
      }
    );
  }
}

// ── Pool allocator ──

export class PoolAllocator implements AccountProvider {
  constructor(
    private manager: AccountManager,
    private rateLimiter: RateLimiter,
  ) {}

  /**
   * Pick the least-loaded account that has rate limit headroom.
   * Falls back to AccountManager's built-in logic if no rate-limit-aware
   * candidates are available.
   */
  getNextAccount(estimatedTokens: number = 1000): AccountResult {
    const accounts = this.manager.getAvailableAccounts();

    if (accounts.length === 0) {
      // All accounts in cooldown — delegate to manager's error reporting
      return this.manager.getNextAccount();
    }

    // Filter by rate limit headroom
    const candidates = accounts.filter((a) =>
      this.rateLimiter.canAccept(a.token.email, estimatedTokens),
    );

    if (candidates.length === 0) {
      // Accounts are healthy but all rate-limited this window
      const minRetry = Math.min(
        ...accounts.map((a) => this.rateLimiter.getRetryAfterMs(a.token.email)),
      );
      return {
        account: null,
        failureKind: "rate_limit" as AccountFailureKind,
        retryAfterMs: minRetry > 0 ? minRetry : 60_000,
      };
    }

    // Sort by composite utilization (max of 1m, 5h, 7d) — least loaded first
    candidates.sort(
      (a, b) =>
        this.rateLimiter.getCompositeUtilization(a.token.email) -
        this.rateLimiter.getCompositeUtilization(b.token.email),
    );

    const chosen = candidates[0];
    const util = this.rateLimiter.getCompositeUtilization(chosen.token.email);
    const { util5h, util7d } = this.rateLimiter.getUpstreamUtilization(chosen.token.email);
    if (util5h > 0 || util7d > 0) {
      console.log(
        `[pool] Routed to ${chosen.token.email} (composite=${(util * 100).toFixed(1)}% 5h=${(util5h * 100).toFixed(1)}% 7d=${(util7d * 100).toFixed(1)}%)`,
      );
    }
    this.rateLimiter.recordStart(chosen.token.email);
    return { account: chosen };
  }

  recordAttempt(email: string): void {
    this.manager.recordAttempt(email);
  }

  recordSuccess(email: string, usage?: UsageData): void {
    this.manager.recordSuccess(email, usage);
    if (usage) {
      const totalTokens =
        usage.inputTokens +
        usage.outputTokens +
        usage.cacheCreationInputTokens +
        usage.cacheReadInputTokens;
      this.rateLimiter.recordCompletion(email, totalTokens);

      // Persist to DB (non-blocking — ignore errors)
      try {
        incrementOAuthAccountUsage(email, {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheCreationTokens: usage.cacheCreationInputTokens,
          cacheReadTokens: usage.cacheReadInputTokens,
        });
      } catch (err: any) {
        console.error(`[pool] Failed to persist usage for ${email}: ${err.message}`);
      }
    }
  }

  recordFailure(email: string, kind: AccountFailureKind, detail?: string, cooldownUntilMs?: number): void {
    this.manager.recordFailure(email, kind, detail, cooldownUntilMs);
  }

  refreshAccount(email: string): Promise<boolean> {
    return this.manager.refreshAccount(email);
  }

  recordUpstreamUtilization(email: string, util5h: number, util7d: number): void {
    this.rateLimiter.recordUpstreamUtilization(email, util5h, util7d);
  }

  /** Log detailed per-request usage to oauth_usage table. */
  logUsage(opts: {
    accountEmail: string;
    apiKey: string;
    model: string;
    usage: UsageData;
    costUsd: number;
    earnedUsd: number;
    durationMs: number;
  }): void {
    try {
      // Only log if the account exists in oauth_accounts table
      const acct = getOAuthAccount(opts.accountEmail);
      if (!acct) return;

      logOAuthUsage({
        accountId: opts.accountEmail,
        apiKey: opts.apiKey,
        model: opts.model,
        inputTokens: opts.usage.inputTokens,
        outputTokens: opts.usage.outputTokens,
        cacheCreationTokens: opts.usage.cacheCreationInputTokens,
        cacheReadTokens: opts.usage.cacheReadInputTokens,
        costUsd: opts.costUsd,
        earnedUsd: opts.earnedUsd,
        durationMs: opts.durationMs,
      });

      // Accumulate earnings on the account's running total
      if (opts.earnedUsd > 0) {
        incrementOAuthAccountEarnings(opts.accountEmail, opts.earnedUsd);
      }
    } catch (err: any) {
      console.error(`[pool] Failed to log oauth_usage: ${err.message}`);
    }
  }

  /** Load per-account rate limit configs from DB. */
  syncConfigsFromDb(): void {
    try {
      const accounts = this.manager.getAllEmails();
      for (const email of accounts) {
        const dbAcct = getOAuthAccount(email);
        if (dbAcct) {
          this.rateLimiter.setConfig(email, dbAcct.max_rpm, dbAcct.max_tpm);
        }
      }
    } catch (err: any) {
      console.error(`[pool] Failed to sync rate limit configs: ${err.message}`);
    }
  }
}
