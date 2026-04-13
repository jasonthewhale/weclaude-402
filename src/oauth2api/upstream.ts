/**
 * Upstream Anthropic API caller.
 *
 * Makes cloaked requests to the Anthropic Messages API using OAuth tokens.
 * Handles both streaming and non-streaming responses, with model-aware
 * header construction.
 */

import crypto from "crypto";
import type { Request } from "express";
import type { AvailableAccount, OAuth2ApiConfig } from "./types.js";
import { buildHeaders, extractPassthroughHeaders } from "./headers.js";

const BASE_URL = "https://api.anthropic.com";

function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function extractApiKey(headers: Record<string, any>): string {
  const auth = headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const xKey = headers["x-api-key"];
  if (typeof xKey === "string") return xKey;
  return "";
}

export interface CallMessagesOptions {
  body?: any;
  request: Request;
  account: AvailableAccount;
  config: OAuth2ApiConfig;
  structured?: boolean;
}

export async function callAnthropicMessages(
  options: CallMessagesOptions,
): Promise<Response> {
  const { request, account, config, structured } = options;
  const body = options.body ?? request.body;
  const url = `${BASE_URL}/v1/messages?beta=true`;
  const stream = !!body.stream;
  const model = body.model || "claude-sonnet-4-6";
  const apiKeyHash = hashApiKey(extractApiKey(request.headers));
  const timeoutMs = stream
    ? config.timeouts.streamMessagesMs
    : config.timeouts.messagesMs;

  const headers = buildHeaders({
    token: account.token.accessToken,
    stream,
    timeoutMs,
    model,
    cloaking: config.cloaking,
    apiKeyHash,
    structured,
    extraHeaders: extractPassthroughHeaders(request.headers),
  });

  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export interface CallCountTokensOptions {
  request: Request;
  account: AvailableAccount;
  config: OAuth2ApiConfig;
}

export async function callAnthropicCountTokens(
  options: CallCountTokensOptions,
): Promise<Response> {
  const { request, account, config } = options;
  const body = request.body;
  const url = `${BASE_URL}/v1/messages/count_tokens?beta=true`;
  const model = body.model || "claude-sonnet-4-6";
  const apiKeyHash = hashApiKey(extractApiKey(request.headers));
  const timeoutMs = config.timeouts.countTokensMs;

  const headers = buildHeaders({
    token: account.token.accessToken,
    stream: false,
    timeoutMs,
    model,
    cloaking: config.cloaking,
    apiKeyHash,
  });

  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}
