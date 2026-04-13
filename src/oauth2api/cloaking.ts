/**
 * Request cloaking — makes OAuth-proxied requests structurally identical
 * to real Claude Code CLI traffic.
 *
 * Implements:
 * - Fingerprint computation (SHA256 of salt + message chars + version)
 * - Billing header generation (with cch=00000 attestation placeholder)
 * - System prompt injection (billing header + CLI prefix with cache_control)
 * - metadata.user_id construction (device_id + account_uuid + session_id)
 *
 * Fixes applied from CLOAKING_ANALYSIS.md (SAFE for v2.1.88):
 * - Gap B: Added `cch=00000;` to billing header
 * - Gap E: Added `scope: "org"` to prefix block's cache_control
 */

import crypto from "crypto";
import type { Request } from "express";
import type { AvailableAccount, CloakingConfig } from "./types.js";
import { getSessionID } from "./headers.js";

const DEFAULT_CLI_VERSION = "2.1.88";
const DEFAULT_ENTRYPOINT = "cli";

// ── Fingerprint ──

const FINGERPRINT_SALT = "59cf53e54c78";
const FINGERPRINT_INDICES = [4, 7, 20];

function extractFirstUserMessageText(messages: any[]): string {
  if (!Array.isArray(messages)) return "";
  const first = messages.find((m: any) => m.role === "user");
  if (!first) return "";
  if (typeof first.content === "string") return first.content;
  if (Array.isArray(first.content)) {
    const textBlock = first.content.find((b: any) => b.type === "text");
    if (textBlock) return textBlock.text || "";
  }
  return "";
}

function computeFingerprint(messageText: string, version: string): string {
  const chars = FINGERPRINT_INDICES.map((i) => messageText[i] || "0").join("");
  const input = `${FINGERPRINT_SALT}${chars}${version}`;
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 3);
}

// ── Billing header ──

function generateBillingHeader(
  messages: any[],
  version: string,
  entrypoint: string,
): string {
  const msgText = extractFirstUserMessageText(messages);
  const fp = computeFingerprint(msgText, version);
  // Gap B fix: include cch=00000; placeholder (real CLI 2.1.88 includes this)
  return `x-anthropic-billing-header: cc_version=${version}.${fp}; cc_entrypoint=${entrypoint}; cch=00000;`;
}

// ── System prompt detection ──

function isBillingHeaderBlock(block: any): boolean {
  return (
    typeof block.text === "string" &&
    block.text.includes("x-anthropic-billing-header")
  );
}

function isPrefixBlock(block: any): boolean {
  return (
    typeof block.text === "string" && block.text.includes("You are Claude Code")
  );
}

// ── metadata.user_id ──

function buildUserId(
  deviceId: string,
  accountUuid: string,
  sessionId: string,
): string {
  return JSON.stringify({
    device_id: deviceId,
    account_uuid: accountUuid,
    session_id: sessionId,
  });
}

// ── Main cloaking function ──

export interface CloakingOptions {
  body?: any;
  request: Request;
  account: AvailableAccount;
  cloaking: CloakingConfig;
  apiKeyHash: string;
}

/**
 * Apply Claude Code cloaking to the request body.
 *
 * Two modes:
 * 1. External clients (OpenAI-compatible): Injects billing header, prefix, metadata
 * 2. Claude Code CLI clients: Detects existing prefix/billing, avoids duplication
 *
 * Always injects metadata.user_id and ensures thinking config is present (Gap D fix).
 */
export function applyCloaking(options: CloakingOptions): any {
  const { request, account, cloaking, apiKeyHash } = options;
  const body = structuredClone(options.body ?? request.body);
  const cliVersion = cloaking.cliVersion || DEFAULT_CLI_VERSION;
  const entrypoint = cloaking.entrypoint || DEFAULT_ENTRYPOINT;

  // --- System prompt injection ---
  const existingSystem = body.system || [];
  const remaining: any[] = Array.isArray(existingSystem)
    ? [...existingSystem]
    : [{ type: "text", text: existingSystem }];

  // Extract or generate billing header block
  const billingIdx = remaining.findIndex(isBillingHeaderBlock);
  const billingBlock =
    billingIdx >= 0
      ? remaining.splice(billingIdx, 1)[0]
      : {
          type: "text",
          text: generateBillingHeader(
            body.messages || [],
            cliVersion,
            entrypoint,
          ),
        };

  // Extract or generate prefix block
  // Gap E fix: cache_control includes scope: "org" (matches prompt-caching-scope beta)
  const prefixIdx = remaining.findIndex(isPrefixBlock);
  const prefixBlock =
    prefixIdx >= 0
      ? remaining.splice(prefixIdx, 1)[0]
      : {
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
          cache_control: { type: "ephemeral", scope: "org" },
        };

  // Ensure existing prefix blocks also have scope: "org"
  if (
    prefixBlock.cache_control &&
    !prefixBlock.cache_control.scope
  ) {
    prefixBlock.cache_control.scope = "org";
  }

  // Reassemble: billing header (pos 0), prefix (pos 1), then the rest
  body.system = [billingBlock, prefixBlock, ...remaining];

  // --- Metadata injection ---
  let sessionID = request.headers["x-claude-code-session-id"];
  sessionID =
    typeof sessionID === "string" ? sessionID : getSessionID(apiKeyHash);

  if (!body.metadata) body.metadata = {};
  body.metadata.user_id = buildUserId(
    account.deviceId,
    account.accountUuid,
    sessionID,
  );

  // --- Gap D fix: Inject thinking config when absent ---
  // Real CLI always sends thinking config for supported models.
  // Only inject for models that support adaptive thinking (claude-4+ family).
  if (!body.thinking) {
    const model = (body.model || "").toLowerCase();
    const supportsAdaptive =
      model.includes("opus-4") ||
      model.includes("sonnet-4-6") ||
      (model === "opus" || model === "sonnet");
    if (supportsAdaptive) {
      body.thinking = { type: "adaptive" };
    }
  }

  return body;
}
