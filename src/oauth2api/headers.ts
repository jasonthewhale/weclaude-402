/**
 * HTTP header construction for Anthropic API requests.
 *
 * Builds headers that match the real Claude Code CLI's request signature:
 * - Stainless SDK headers (package version, runtime, arch, OS)
 * - Anthropic beta headers (model-dependent)
 * - User-Agent matching CLI format
 * - Per-API-key session IDs with TTL-based rotation
 *
 * Fixes applied from CLOAKING_ANALYSIS.md (SAFE for v2.1.88):
 * - Gap C: Added `context-1m-2025-08-07` beta for Opus models
 */

import crypto from "crypto";
import { IncomingHttpHeaders } from "http";
import type { CloakingConfig } from "./types.js";

const DEFAULT_CLI_VERSION = "2.1.88";
const DEFAULT_ENTRYPOINT = "cli";

// ── Session ID management ──

const SESSION_TTL_MIN = 30 * 60 * 1000;
const SESSION_TTL_MAX = 300 * 60 * 1000;
const sessionMap = new Map<
  string,
  { id: string; lastUsed: number; ttl: number }
>();

function randomTTL(): number {
  return SESSION_TTL_MIN + Math.random() * (SESSION_TTL_MAX - SESSION_TTL_MIN);
}

export function getSessionID(apiKeyHash: string): string {
  const now = Date.now();
  const entry = sessionMap.get(apiKeyHash);
  if (entry && now - entry.lastUsed < entry.ttl) {
    entry.lastUsed = now;
    return entry.id;
  }
  for (const [key, val] of sessionMap) {
    if (now - val.lastUsed >= val.ttl) sessionMap.delete(key);
  }
  const id = crypto.randomUUID();
  sessionMap.set(apiKeyHash, { id, lastUsed: now, ttl: randomTTL() });
  return id;
}

// ── Beta headers ──

/**
 * Build model-dependent Anthropic-Beta header.
 *
 * Real CLI (utils/betas.ts) sends different beta sets:
 * - Haiku: reduced set (no claude-code, no advanced-tool-use, no effort)
 * - Opus/Sonnet: full set including context-1m for Opus (Gap C fix)
 */
function buildBetaHeader(model: string, structured: boolean): string {
  const isHaiku = model.includes("haiku");
  const isOpus = model.includes("opus");

  if (isHaiku) {
    const betas = [
      "oauth-2025-04-20",
      "interleaved-thinking-2025-05-14",
      "redact-thinking-2026-02-12",
      "context-management-2025-06-27",
      "prompt-caching-scope-2026-01-05",
    ];
    if (structured) betas.push("structured-outputs-2025-12-15");
    else betas.push("claude-code-20250219");
    return betas.join(",");
  }

  const betas = [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "redact-thinking-2026-02-12",
    "context-management-2025-06-27",
    "prompt-caching-scope-2026-01-05",
    "advanced-tool-use-2025-11-20",
    "effort-2025-11-24",
  ];

  // Gap C fix: Opus models get the 1M context beta
  if (isOpus) {
    betas.push("context-1m-2025-08-07");
  }

  if (structured) betas.push("structured-outputs-2025-12-15");

  return betas.join(",");
}

// ── Stainless headers ──

function getStainlessArch(): string {
  const arch = process.arch;
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x64";
  return "x86";
}

function getStainlessOs(): string {
  const platform = process.platform;
  if (platform === "darwin") return "MacOS";
  if (platform === "win32") return "Windows";
  if (platform === "freebsd") return "FreeBSD";
  return "Linux";
}

// ── Passthrough detection ──

/**
 * Extract anthropic-* headers from Claude CLI clients for passthrough.
 * Only triggers when User-Agent indicates a real Claude CLI client.
 */
export function extractPassthroughHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string> | undefined {
  const userAgent = headers["user-agent"] || "";
  if (
    typeof userAgent !== "string" ||
    !userAgent.toLowerCase().startsWith("claude-cli")
  ) {
    return undefined;
  }
  const passthrough: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.startsWith("anthropic") && typeof value === "string") {
      passthrough[key] = value;
    }
  }
  const sessionID = headers["x-claude-code-session-id"];
  if (typeof sessionID === "string") {
    passthrough["X-Claude-Code-Session-Id"] = sessionID;
  }
  return passthrough;
}

// ── Main header builder ──

export interface BuildHeadersOptions {
  token: string;
  stream: boolean;
  timeoutMs: number;
  model: string;
  cloaking: CloakingConfig;
  apiKeyHash?: string;
  structured?: boolean;
  extraHeaders?: Record<string, string>;
}

export function buildHeaders(options: BuildHeadersOptions): Record<string, string> {
  const {
    token,
    stream,
    timeoutMs,
    model,
    cloaking,
    apiKeyHash,
    structured,
    extraHeaders,
  } = options;

  const cliVersion = cloaking.cliVersion || DEFAULT_CLI_VERSION;
  const entrypoint = cloaking.entrypoint || DEFAULT_ENTRYPOINT;
  const sessionID = getSessionID(apiKeyHash || "default");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": `claude-cli/${cliVersion} (external, ${entrypoint})`,
    "X-Claude-Code-Session-Id": sessionID,
    "X-Stainless-Lang": "js",
    "X-Stainless-Package-Version": "0.74.0",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Runtime-Version": "v22.13.0",
    "X-Stainless-Arch": getStainlessArch(),
    "X-Stainless-Os": getStainlessOs(),
    "X-Stainless-Timeout": String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    "X-Stainless-Retry-Count": "0",
    Accept: stream ? "text/event-stream" : "application/json",
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": "2023-06-01",
    "x-app": "cli",
    "x-client-request-id": crypto.randomUUID(),
  };

  // Override with passthrough headers from CLI clients
  if (extraHeaders) {
    Object.assign(headers, extraHeaders);
  }

  // Build or merge beta header
  const existingBeta = headers["anthropic-beta"];
  if (typeof existingBeta === "string") {
    headers["anthropic-beta"] = `oauth-2025-04-20,${existingBeta}`;
  } else {
    headers["anthropic-beta"] = buildBetaHeader(model, !!structured);
  }

  return headers;
}
