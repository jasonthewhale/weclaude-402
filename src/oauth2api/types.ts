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
