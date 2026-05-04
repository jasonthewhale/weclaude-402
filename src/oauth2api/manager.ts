/**
 * Account manager — handles multiple OAuth accounts with:
 * - Sticky round-robin rotation (stays on one account for 20-60 min)
 * - Exponential backoff cooldowns per failure type
 * - Automatic token refresh before expiry
 * - Per-account usage tracking
 */

import type {
  TokenData,
  AccountFailureKind,
  UsageData,
  AvailableAccount,
  AccountResult,
  AccountSnapshot,
  CloakingConfig,
} from "./types.js";
import { refreshTokensWithRetry } from "./oauth.js";
import { saveToken, loadAllTokens, getDeviceId, deleteToken } from "./storage.js";
import { buildHeaders } from "./headers.js";

const REFRESH_LEAD_MS = 4 * 60 * 60 * 1000; // 4 hours before expiry
const REFRESH_CHECK_INTERVAL_MS = 60 * 1000; // check every 60s

const VALIDATION_INTERVAL_MS = 5 * 60 * 1000; // re-validate every 5 minutes
const VALIDATION_CACHE_MS = 5 * 60 * 1000;    // skip re-check if validated within 5 min
const VALIDATION_TIMEOUT_MS = 10_000;
const VALIDATION_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_COUNT_TOKENS_URL = "https://api.anthropic.com/v1/messages/count_tokens?beta=true";

const FAILURE_BACKOFF: Record<
  AccountFailureKind,
  { baseMs: number; maxMs: number }
> = {
  rate_limit: { baseMs: 60 * 1000, maxMs: 15 * 60 * 1000 },
  quota_exhausted: { baseMs: 60 * 60 * 1000, maxMs: 6 * 60 * 60 * 1000 }, // 1h → 6h
  auth: { baseMs: 10 * 60 * 1000, maxMs: 60 * 60 * 1000 },
  forbidden: { baseMs: 10 * 60 * 1000, maxMs: 60 * 60 * 1000 },
  server: { baseMs: 5 * 1000, maxMs: 5 * 60 * 1000 },
  network: { baseMs: 5 * 1000, maxMs: 5 * 60 * 1000 },
};

const FAILURE_PRIORITY: Record<AccountFailureKind, number> = {
  rate_limit: 0,
  server: 1,
  network: 2,
  quota_exhausted: 3,
  forbidden: 4,
  auth: 5,
};

// Sticky routing removed — PoolAllocator now routes by composite
// utilization (1m/5h/7d) so it needs freedom to pick the best account.

interface AccountState {
  token: TokenData;
  cooldownUntil: number;
  failureCount: number;
  lastFailureKind: AccountFailureKind | null;
  lastError: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastRefreshAt: string | null;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  refreshing: boolean;
  refreshPromise: Promise<boolean> | null;
  validatedAt: number | null;
  validationFailed: boolean;
}

export function extractUsage(resp: any): UsageData {
  return {
    inputTokens: resp.usage?.input_tokens || 0,
    outputTokens: resp.usage?.output_tokens || 0,
    cacheCreationInputTokens: resp.usage?.cache_creation_input_tokens || 0,
    cacheReadInputTokens: resp.usage?.cache_read_input_tokens || 0,
  };
}

function buildAvailableAccount(
  authDir: string,
  email: string,
  token: TokenData,
): AvailableAccount {
  return {
    token,
    deviceId: getDeviceId(authDir, email),
    accountUuid: token.accountUuid,
  };
}

export class AccountManager {
  private accounts: Map<string, AccountState> = new Map();
  private accountOrder: string[] = [];
  private lastUsedIndex: number = -1;
  private authDir: string;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private validationTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;

  constructor(authDir: string) {
    this.authDir = authDir;
  }

  load(): void {
    const tokens = loadAllTokens(this.authDir);
    for (const token of tokens) {
      this.accounts.set(token.email, this.createAccountState(token));
      this.accountOrder.push(token.email);
    }
    console.log(`[manager] Loaded ${this.accounts.size} account(s)`);
  }

  addAccount(token: TokenData): void {
    const existing = this.accounts.get(token.email);
    if (existing) {
      existing.token = token;
      existing.cooldownUntil = 0;
      existing.failureCount = 0;
      existing.lastFailureKind = null;
      existing.lastError = null;
      existing.lastFailureAt = null;
      existing.lastSuccessAt = new Date().toISOString();
      existing.lastRefreshAt = new Date().toISOString();
    } else {
      const state = this.createAccountState(token);
      state.lastSuccessAt = new Date().toISOString();
      state.lastRefreshAt = new Date().toISOString();
      this.accounts.set(token.email, state);
      this.accountOrder.push(token.email);
    }
    saveToken(this.authDir, token);
  }

  removeAccount(email: string): boolean {
    const acct = this.accounts.get(email);
    if (!acct) return false;
    this.accounts.delete(email);
    this.accountOrder = this.accountOrder.filter((e) => e !== email);
    if (this.lastUsedIndex >= this.accountOrder.length) {
      this.lastUsedIndex = this.accountOrder.length - 1;
    }
    deleteToken(this.authDir, email);
    console.log(`[manager] Removed account ${email} from pool`);
    return true;
  }

  getNextAccount(): AccountResult {
    const count = this.accountOrder.length;
    if (count === 0) {
      return { account: null, failureKind: null, retryAfterMs: null };
    }

    const now = Date.now();

    // Round-robin: pick the next available account (no stickiness —
    // PoolAllocator handles routing by composite utilization).
    const startIdx = this.lastUsedIndex >= 0 ? this.lastUsedIndex + 1 : 0;
    for (let i = 0; i < count; i++) {
      const idx = (startIdx + i) % count;
      const email = this.accountOrder[idx];
      const acct = this.accounts.get(email)!;
      if (acct.cooldownUntil <= now) {
        this.lastUsedIndex = idx;
        return {
          account: buildAvailableAccount(this.authDir, email, acct.token),
        };
      }
    }

    // All accounts in cooldown
    const firstAcct = this.accounts.get(this.accountOrder[0])!;
    let bestKind: AccountFailureKind = firstAcct.lastFailureKind ?? "network";
    let bestRemainingMs = Math.max(0, firstAcct.cooldownUntil - now);
    for (const email of this.accountOrder.slice(1)) {
      const acct = this.accounts.get(email)!;
      const kind = acct.lastFailureKind ?? "network";
      const remainingMs = Math.max(0, acct.cooldownUntil - now);
      if (
        FAILURE_PRIORITY[kind] < FAILURE_PRIORITY[bestKind] ||
        (FAILURE_PRIORITY[kind] === FAILURE_PRIORITY[bestKind] &&
          remainingMs < bestRemainingMs)
      ) {
        bestKind = kind;
        bestRemainingMs = remainingMs;
      }
    }

    const isRecoverable = bestKind !== "auth" && bestKind !== "forbidden";
    return {
      account: null,
      failureKind: bestKind,
      retryAfterMs: isRecoverable ? bestRemainingMs : null,
    };
  }

  recordAttempt(email: string): void {
    const acct = this.accounts.get(email);
    if (acct) acct.totalRequests++;
  }

  recordSuccess(email: string, usage?: UsageData): void {
    const acct = this.accounts.get(email);
    if (!acct) return;

    acct.cooldownUntil = 0;
    acct.failureCount = 0;
    acct.lastFailureKind = null;
    acct.lastError = null;
    acct.lastFailureAt = null;
    acct.lastSuccessAt = new Date().toISOString();
    acct.totalSuccesses++;

    if (usage) {
      acct.totalInputTokens += usage.inputTokens;
      acct.totalOutputTokens += usage.outputTokens;
      acct.totalCacheCreationInputTokens += usage.cacheCreationInputTokens;
      acct.totalCacheReadInputTokens += usage.cacheReadInputTokens;
    }
  }

  recordFailure(
    email: string,
    kind: AccountFailureKind,
    detail?: string,
    cooldownUntilMs?: number,
  ): void {
    const acct = this.accounts.get(email);
    if (!acct) return;

    acct.failureCount++;
    acct.totalFailures++;
    acct.lastFailureKind = kind;
    acct.lastFailureAt = new Date().toISOString();
    acct.lastError = detail ? `${kind}: ${detail}` : kind;

    // Forbidden means OAuth is not allowed for this account — skip it immediately
    // rather than waiting for a cooldown to expire and burning another real request.
    if (kind === "forbidden") {
      if (!acct.validationFailed) {
        console.warn(`[manager] ${acct.token.email} marked invalid (forbidden) — removed from pool`);
      }
      acct.validationFailed = true;
      acct.cooldownUntil = 0;
      return;
    }

    if (cooldownUntilMs && cooldownUntilMs > Date.now()) {
      // Use exact reset time from upstream headers
      acct.cooldownUntil = cooldownUntilMs;
      const cooldownMs = cooldownUntilMs - Date.now();
      console.log(
        `[manager] ${email} cooled down ${Math.round(cooldownMs / 1000)}s until ${new Date(cooldownUntilMs).toISOString()} (${kind})`,
      );
    } else {
      const { baseMs, maxMs } = FAILURE_BACKOFF[kind];
      const cooldownMs = Math.min(
        baseMs * 2 ** Math.max(0, acct.failureCount - 1),
        maxMs,
      );
      acct.cooldownUntil = Date.now() + cooldownMs;
      console.log(
        `[manager] ${email} cooled down ${Math.round(cooldownMs / 1000)}s (${kind})`,
      );
    }
  }

  /** No-op — upstream utilization is tracked by PoolAllocator's RateLimiter. */
  recordUpstreamUtilization(_email: string, _util5h: number, _util7d: number): void {}

  async refreshAccount(email: string): Promise<boolean> {
    const acct = this.accounts.get(email);
    if (!acct) return false;
    if (acct.refreshPromise) return acct.refreshPromise;
    acct.refreshPromise = this.performRefresh(acct);
    return acct.refreshPromise;
  }

  getSnapshots(): AccountSnapshot[] {
    const now = Date.now();
    const snapshots: AccountSnapshot[] = [];
    for (const acct of this.accounts.values()) {
      snapshots.push({
        email: acct.token.email,
        available: acct.cooldownUntil <= now && !acct.validationFailed,
        cooldownUntil: acct.cooldownUntil,
        failureCount: acct.failureCount,
        lastError: acct.lastError,
        lastFailureAt: acct.lastFailureAt,
        lastSuccessAt: acct.lastSuccessAt,
        lastRefreshAt: acct.lastRefreshAt,
        totalRequests: acct.totalRequests,
        totalSuccesses: acct.totalSuccesses,
        totalFailures: acct.totalFailures,
        totalInputTokens: acct.totalInputTokens,
        totalOutputTokens: acct.totalOutputTokens,
        totalCacheCreationInputTokens: acct.totalCacheCreationInputTokens,
        totalCacheReadInputTokens: acct.totalCacheReadInputTokens,
        expiresAt: acct.token.expiresAt,
        refreshing: acct.refreshing,
        validationFailed: acct.validationFailed,
        validatedAt: acct.validatedAt,
      });
    }
    return snapshots;
  }

  startAutoRefresh(): void {
    const timer = setInterval(
      () =>
        this.refreshAll().catch((err) =>
          console.error("[manager] Refresh cycle failed:", err.message),
        ),
      REFRESH_CHECK_INTERVAL_MS,
    );
    timer.unref();
    this.refreshTimer = timer;
    this.refreshAll().catch((err) =>
      console.error("[manager] Initial refresh failed:", err.message),
    );
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  startStatsLogger(): void {
    const timer = setInterval(() => this.logStats(), 5 * 60 * 1000);
    timer.unref();
    this.statsTimer = timer;
  }

  stopStatsLogger(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  startAccountValidation(cloaking: CloakingConfig): void {
    const timer = setInterval(
      () => this.validateAllAccounts(cloaking).catch((err) =>
        console.error("[manager] Validation cycle failed:", err.message),
      ),
      VALIDATION_INTERVAL_MS,
    );
    timer.unref();
    this.validationTimer = timer;
    // Run immediately so invalid accounts are caught before first request
    this.validateAllAccounts(cloaking).catch((err) =>
      console.error("[manager] Initial validation failed:", err.message),
    );
  }

  stopAccountValidation(): void {
    if (this.validationTimer) {
      clearInterval(this.validationTimer);
      this.validationTimer = null;
    }
  }

  /** Return all accounts not currently in cooldown and not validation-failed. */
  getAvailableAccounts(): AvailableAccount[] {
    const now = Date.now();
    const result: AvailableAccount[] = [];
    for (const email of this.accountOrder) {
      const acct = this.accounts.get(email)!;
      if (acct.cooldownUntil <= now && !acct.validationFailed) {
        result.push(buildAvailableAccount(this.authDir, email, acct.token));
      }
    }
    return result;
  }

  /** Return all account emails (for DB sync on startup). */
  getAllEmails(): string[] {
    return [...this.accountOrder];
  }

  /** Return all account access tokens keyed by email (for utilization checks). */
  getAllAccessTokens(): Map<string, string> {
    const result = new Map<string, string>();
    for (const [email, acct] of this.accounts) {
      result.set(email, acct.token.accessToken);
    }
    return result;
  }

  /** Get a specific account's token data (for DB sync). */
  getToken(email: string): { token: TokenData; totalRequests: number; totalInputTokens: number; totalOutputTokens: number; totalCacheCreationInputTokens: number; totalCacheReadInputTokens: number } | undefined {
    const acct = this.accounts.get(email);
    if (!acct) return undefined;
    return {
      token: acct.token,
      totalRequests: acct.totalRequests,
      totalInputTokens: acct.totalInputTokens,
      totalOutputTokens: acct.totalOutputTokens,
      totalCacheCreationInputTokens: acct.totalCacheCreationInputTokens,
      totalCacheReadInputTokens: acct.totalCacheReadInputTokens,
    };
  }

  get accountCount(): number {
    return this.accounts.size;
  }

  private logStats(): void {
    if (this.accounts.size === 0) return;
    console.log(`\n===== Account Stats (${new Date().toISOString()}) =====`);
    for (const acct of this.accounts.values()) {
      const available = acct.cooldownUntil <= Date.now();
      console.log(
        `  ${acct.token.email}: ` +
          `available=${available}, requests=${acct.totalRequests}, ` +
          `successes=${acct.totalSuccesses}, failures=${acct.totalFailures}, ` +
          `tokens=${acct.totalInputTokens + acct.totalOutputTokens}`,
      );
    }
    console.log(`====================================================\n`);
  }

  private async refreshAll(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const now = Date.now();
      for (const acct of this.accounts.values()) {
        const expiresAt = new Date(acct.token.expiresAt).getTime();
        if (expiresAt - now <= REFRESH_LEAD_MS) {
          await this.refreshAccount(acct.token.email);
        }
      }
    } finally {
      this.refreshing = false;
    }
  }

  private async performRefresh(acct: AccountState): Promise<boolean> {
    if (acct.refreshing) return false;
    acct.refreshing = true;
    try {
      console.log(`[manager] Refreshing token for ${acct.token.email}...`);
      const newToken = await refreshTokensWithRetry(acct.token.refreshToken);
      newToken.email = newToken.email || acct.token.email;
      acct.token = newToken;
      acct.cooldownUntil = 0;
      acct.failureCount = 0;
      acct.lastFailureKind = null;
      acct.lastError = null;
      acct.lastFailureAt = null;
      acct.lastSuccessAt = new Date().toISOString();
      acct.lastRefreshAt = new Date().toISOString();
      saveToken(this.authDir, newToken);
      console.log(
        `[manager] Token refreshed, expires ${newToken.expiresAt}`,
      );
      return true;
    } catch (err: any) {
      this.recordFailure(acct.token.email, "auth", err.message);
      console.error(
        `[manager] Refresh failed for ${acct.token.email}: ${err.message}`,
      );
      return false;
    } finally {
      acct.refreshing = false;
      acct.refreshPromise = null;
    }
  }

  private async validateAllAccounts(cloaking: CloakingConfig): Promise<void> {
    const now = Date.now();
    for (const acct of this.accounts.values()) {
      const recentlyValidated =
        acct.validatedAt !== null &&
        now - acct.validatedAt < VALIDATION_CACHE_MS &&
        !acct.validationFailed;
      if (recentlyValidated) continue;
      await this.validateAccount(acct, cloaking);
    }
  }

  private async validateAccount(acct: AccountState, cloaking: CloakingConfig): Promise<void> {
    const headers = buildHeaders({
      token: acct.token.accessToken,
      stream: false,
      timeoutMs: VALIDATION_TIMEOUT_MS,
      model: VALIDATION_MODEL,
      cloaking,
    });

    let res: Response;
    try {
      res = await fetch(ANTHROPIC_COUNT_TOKENS_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: VALIDATION_MODEL,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
      });
    } catch {
      // Network error — don't change validation state
      return;
    }

    acct.validatedAt = Date.now();

    if (res.ok) {
      if (acct.validationFailed) {
        console.log(`[manager] ${acct.token.email} validation recovered — added back to pool`);
        acct.validationFailed = false;
        acct.cooldownUntil = 0;
        acct.failureCount = 0;
      }
    } else if (res.status === 403) {
      if (!acct.validationFailed) {
        console.warn(`[manager] ${acct.token.email} validation failed (403) — removed from pool`);
      }
      acct.validationFailed = true;
    } else if (res.status === 401) {
      // Token expired — trigger refresh; next validation cycle will re-check
      await this.refreshAccount(acct.token.email);
    }
    // 429 / 5xx: account is reachable, don't invalidate
  }

  private createAccountState(token: TokenData): AccountState {
    return {
      token,
      cooldownUntil: 0,
      failureCount: 0,
      lastFailureKind: null,
      lastError: null,
      lastFailureAt: null,
      lastSuccessAt: null,
      lastRefreshAt: null,
      totalRequests: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationInputTokens: 0,
      totalCacheReadInputTokens: 0,
      refreshing: false,
      refreshPromise: null,
      validatedAt: null,
      validationFailed: false,
    };
  }
}
