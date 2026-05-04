/**
 * OAuth-to-API Converter Module
 *
 * Converts Claude OAuth tokens into a fully functional API proxy that mimics
 * the real Claude Code CLI's request signatures. Supports:
 *
 * - OpenAI Chat Completions format (POST /v1/chat/completions)
 * - OpenAI Responses API format (POST /v1/responses)
 * - Anthropic Messages passthrough (POST /v1/messages)
 * - Token counting (POST /v1/messages/count_tokens)
 * - Multi-account rotation with multi-window utilization routing (1m/5h/7d)
 * - Automatic token refresh
 * - Request cloaking (fingerprint, billing header, system prompt injection)
 * - SSE streaming with format translation
 *
 * Usage:
 *   import { createOAuth2ApiRouter, AccountManager } from "./oauth2api/index.js";
 *
 *   const manager = new AccountManager("~/.weclaude/auth");
 *   manager.load();
 *   manager.startAutoRefresh();
 *
 *   const router = createOAuth2ApiRouter(config, manager);
 *   app.use(router);
 *
 * Login flow (CLI):
 *   import { generatePKCECodes } from "./oauth2api/index.js";
 *   import { generateAuthURL, exchangeCodeForTokens } from "./oauth2api/index.js";
 *   import { waitForCallback } from "./oauth2api/index.js";
 *
 *   const pkce = generatePKCECodes();
 *   const state = crypto.randomBytes(16).toString("hex");
 *   const authURL = generateAuthURL(state, pkce);
 *   // Open authURL in browser...
 *   const { code, state: returnedState } = await waitForCallback();
 *   const token = await exchangeCodeForTokens(code, returnedState, state, pkce);
 *   manager.addAccount(token);
 */

// Types
export type {
  TokenData,
  PKCECodes,
  UsageData,
  AvailableAccount,
  AccountResult,
  AccountSnapshot,
  AccountFailureKind,
  AccountProvider,
  CloakingConfig,
  OAuth2ApiConfig,
} from "./types.js";

// OAuth flow
export { generatePKCECodes } from "./pkce.js";
export {
  generateAuthURL,
  exchangeCodeForTokens,
  refreshTokens,
  refreshTokensWithRetry,
} from "./oauth.js";
export { waitForCallback } from "./callback.js";

// Storage
export { saveToken, loadAllTokens, deleteToken, getDeviceId } from "./storage.js";

// Account management
export { AccountManager, extractUsage } from "./manager.js";

// Cloaking
export { applyCloaking } from "./cloaking.js";

// Headers
export { buildHeaders, getSessionID, extractPassthroughHeaders } from "./headers.js";

// Upstream API
export { callAnthropicMessages, callAnthropicCountTokens } from "./upstream.js";

// Streaming
export { handleStreamingResponse } from "./streaming.js";

// Translator
export {
  resolveModel,
  openaiToAnthropic,
  anthropicToOpenai,
  createStreamState,
  anthropicSSEToChat,
  responsesToAnthropic,
  anthropicToResponses,
  makeResponsesState,
  anthropicSSEToResponses,
} from "./translator.js";

// Proxy
export { proxyWithRetry } from "./proxy.js";

// Pool allocator (rate-limit-aware account selection)
export { RateLimiter, PoolAllocator } from "./pool.js";

// Seller OAuth endpoints
export {
  handleSellerAuthStart,
  handleSellerAuthComplete,
  handleSellerAuthRevoke,
  handleSellerStatus,
  handleSellerEarn,
  handleSellerClaim,
} from "./seller.js";

// Router (main entry point)
export { createOAuth2ApiRouter } from "./router.js";
