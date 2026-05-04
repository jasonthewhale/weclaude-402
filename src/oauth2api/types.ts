export interface PKCECodes {
  codeVerifier: string;
  codeChallenge: string;
}

export interface TokenData {
  accessToken: string;
  refreshToken: string;
  email: string;
  expiresAt: string; // ISO 8601
  accountUuid: string;
}

export interface TokenStorage {
  access_token: string;
  refresh_token: string;
  last_refresh: string;
  email: string;
  type: "claude";
  expired: string; // ISO 8601
  account_uuid?: string;
}

export type AccountFailureKind =
  | "rate_limit"
  | "quota_exhausted"
  | "auth"
  | "forbidden"
  | "server"
  | "network";

export interface UsageData {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface AvailableAccount {
  token: TokenData;
  deviceId: string;
  accountUuid: string;
}

export type AccountResult =
  | { account: AvailableAccount }
  | {
      account: null;
      failureKind: AccountFailureKind | null;
      retryAfterMs: number | null;
    };

export interface AccountSnapshot {
  email: string;
  available: boolean;
  cooldownUntil: number;
  failureCount: number;
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
  expiresAt: string;
  refreshing: boolean;
  validationFailed: boolean;
  validatedAt: number | null;
}

/**
 * Common interface for account selection — implemented by both
 * AccountManager (direct) and PoolAllocator (rate-limit-aware).
 */
export interface AccountProvider {
  getNextAccount(estimatedTokens?: number): AccountResult;
  recordAttempt(email: string): void;
  recordSuccess(email: string, usage?: UsageData): void;
  recordFailure(email: string, kind: AccountFailureKind, detail?: string, cooldownUntilMs?: number): void;
  refreshAccount(email: string): Promise<boolean>;
  /** Update upstream-reported 5h/7d utilization from response headers. */
  recordUpstreamUtilization(email: string, util5h: number, util7d: number): void;
}

export interface CloakingConfig {
  cliVersion: string;
  entrypoint: string;
}

export interface OAuth2ApiConfig {
  authDir: string;
  cloaking: CloakingConfig;
  timeouts: {
    messagesMs: number;
    streamMessagesMs: number;
    countTokensMs: number;
  };
  debug: "off" | "errors" | "verbose";
}
