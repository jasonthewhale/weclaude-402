/**
 * OAuth-to-API Router
 *
 * Express router that converts Claude OAuth tokens into a full API proxy.
 * Exposes endpoints compatible with both OpenAI and Anthropic formats:
 *
 *   POST /v1/chat/completions   — OpenAI Chat Completions format
 *   POST /v1/responses          — OpenAI Responses API format
 *   POST /v1/messages           — Anthropic Messages passthrough
 *   POST /v1/messages/count_tokens — Token counting passthrough
 *   GET  /v1/models             — List supported models
 *   GET  /admin/accounts        — Account status dashboard
 *
 * All requests are cloaked to match real Claude Code CLI traffic signatures.
 * See CLOAKING_ANALYSIS.md for the full gap analysis.
 */

import crypto from "crypto";
import { Router, Request, Response as ExpressResponse } from "express";
import type { OAuth2ApiConfig, AvailableAccount, AccountProvider } from "./types.js";
import { extractUsage } from "./manager.js";
import { applyCloaking } from "./cloaking.js";
import { callAnthropicMessages, callAnthropicCountTokens } from "./upstream.js";
import { handleStreamingResponse } from "./streaming.js";
import {
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
import { proxyWithRetry } from "./proxy.js";

const SUPPORTED_MODELS = [
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-haiku-4-5",
  "opus",
  "sonnet",
  "haiku",
] as const;

function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function extractApiKey(req: Request): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const xKey = req.headers["x-api-key"];
  if (typeof xKey === "string") return xKey;
  return "";
}

/**
 * Callback invoked after each API call with the model, token usage,
 * and which OAuth account served the request.
 */
export type UsageCallback = (
  req: Request,
  model: string,
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number },
  accountEmail?: string,
) => void;

/**
 * Create the OAuth-to-API router.
 *
 * @param config - OAuth2API configuration (auth dir, cloaking params, timeouts)
 * @param provider - Account provider (AccountManager or PoolAllocator)
 * @param onUsage - Optional callback fired after each successful API call with real usage data
 * @param snapshotFn - Optional function to get account snapshots (for /admin/accounts)
 * @returns Express Router with all API endpoints
 */
export function createOAuth2ApiRouter(
  config: OAuth2ApiConfig,
  provider: AccountProvider,
  onUsage?: UsageCallback,
  snapshotFn?: () => { snapshots: any[]; count: number },
): Router {
  const router = Router();

  // ── Models listing ──
  router.get("/v1/models", (_req, res) => {
    res.json({
      object: "list",
      data: SUPPORTED_MODELS.map((id) => ({
        id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "anthropic",
      })),
    });
  });

  // ── OpenAI Chat Completions ──
  router.post("/v1/chat/completions", async (req: Request, resp: ExpressResponse) => {
    try {
      const body = req.body;
      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        resp.status(400).json({
          error: { message: "messages is required and must be a non-empty array" },
        });
        return;
      }

      const stream = !!body.stream;
      const model = resolveModel(body.model || "claude-sonnet-4-6");
      const structured =
        body.response_format?.type === "json_object" ||
        body.response_format?.type === "json_schema";
      const translatedBody = openaiToAnthropic(body);

      if (config.debug === "verbose") {
        console.log("[oauth2api] Translated OpenAI->Anthropic body (before cloaking):");
        console.log(JSON.stringify(translatedBody, null, 2));
      }

      await proxyWithRetry("ChatCompletions", resp, config, provider, {
        upstream: (account: AvailableAccount) => {
          const apiKeyHash = hashApiKey(extractApiKey(req));
          const anthropicBody = applyCloaking({
            body: translatedBody,
            request: req,
            account,
            cloaking: config.cloaking,
            apiKeyHash,
          });
          return callAnthropicMessages({
            body: anthropicBody,
            request: req,
            account,
            config,
            structured,
          });
        },
        success: async (upstream: Response, account: AvailableAccount) => {
          if (stream) {
            const includeUsage = body.stream_options?.include_usage !== false;
            const state = createStreamState(model, includeUsage);
            const result = await handleStreamingResponse(upstream, resp, {
              onEvent: (event, data, usage) =>
                anthropicSSEToChat(event, data, state, usage).map(
                  (c) => `data: ${c}\n\n`,
                ),
            });
            if (result.completed) {
              provider.recordSuccess(account.token.email, result.usage);
              onUsage?.(req, model, {
                input_tokens: result.usage.inputTokens,
                output_tokens: result.usage.outputTokens,
                cache_creation_input_tokens: result.usage.cacheCreationInputTokens,
                cache_read_input_tokens: result.usage.cacheReadInputTokens,
              }, account.token.email);
            } else if (!result.clientDisconnected) {
              provider.recordFailure(
                account.token.email,
                "network",
                "stream terminated before completion",
              );
            }
          } else {
            const anthropicResp = await upstream.json();
            provider.recordSuccess(account.token.email, extractUsage(anthropicResp));
            onUsage?.(req, model, anthropicResp.usage || {}, account.token.email);
            resp.json(anthropicToOpenai(anthropicResp, model));
          }
        },
      });
    } catch (err: any) {
      console.error("[oauth2api] ChatCompletions error:", err.message);
      resp.status(500).json({ error: { message: "Internal server error" } });
    }
  });

  // ── OpenAI Responses API ──
  router.post("/v1/responses", async (req: Request, resp: ExpressResponse) => {
    try {
      const body = req.body;
      if (!body.input && !body.messages) {
        resp.status(400).json({ error: { message: "input is required" } });
        return;
      }

      const stream = !!body.stream;
      const model = resolveModel(body.model || "claude-sonnet-4-6");
      const structured =
        body.text?.format?.type === "json_object" ||
        body.text?.format?.type === "json_schema";
      const translatedBody = responsesToAnthropic(body);

      await proxyWithRetry("Responses", resp, config, provider, {
        upstream: (account: AvailableAccount) => {
          const apiKeyHash = hashApiKey(extractApiKey(req));
          const anthropicBody = applyCloaking({
            body: translatedBody,
            request: req,
            account,
            cloaking: config.cloaking,
            apiKeyHash,
          });
          return callAnthropicMessages({
            body: anthropicBody,
            request: req,
            account,
            config,
            structured,
          });
        },
        success: async (upstream: Response, account: AvailableAccount) => {
          if (stream) {
            const state = makeResponsesState();
            const streamResp = await handleStreamingResponse(upstream, resp, {
              onEvent: (event, data, usage) =>
                anthropicSSEToResponses(event, data, state, model, usage),
            });
            if (streamResp.completed) {
              provider.recordSuccess(account.token.email, streamResp.usage);
              onUsage?.(req, model, {
                input_tokens: streamResp.usage.inputTokens,
                output_tokens: streamResp.usage.outputTokens,
                cache_creation_input_tokens: streamResp.usage.cacheCreationInputTokens,
                cache_read_input_tokens: streamResp.usage.cacheReadInputTokens,
              }, account.token.email);
            } else if (!streamResp.clientDisconnected) {
              provider.recordFailure(
                account.token.email,
                "network",
                "stream terminated before completion",
              );
            }
          } else {
            const anthropicResp = await upstream.json();
            provider.recordSuccess(account.token.email, extractUsage(anthropicResp));
            onUsage?.(req, model, anthropicResp.usage || {}, account.token.email);
            resp.json(anthropicToResponses(anthropicResp, model));
          }
        },
      });
    } catch (err: any) {
      console.error("[oauth2api] Responses error:", err.message);
      resp.status(500).json({ error: { message: "Internal server error" } });
    }
  });

  // ── Anthropic Messages (passthrough) ──
  router.post("/v1/messages", async (req: Request, resp: ExpressResponse) => {
    try {
      const body = req.body;
      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        resp.status(400).json({
          error: { message: "messages is required and must be a non-empty array" },
        });
        return;
      }

      const stream = !!body.stream;

      if (config.debug === "verbose") {
        console.log("[oauth2api] Incoming /v1/messages body:");
        console.log(JSON.stringify(body, null, 2));
      }

      await proxyWithRetry("Messages", resp, config, provider, {
        upstream: (account: AvailableAccount) => {
          const apiKeyHash = hashApiKey(extractApiKey(req));
          const anthropicBody = applyCloaking({
            request: req,
            account,
            cloaking: config.cloaking,
            apiKeyHash,
          });
          return callAnthropicMessages({
            body: anthropicBody,
            request: req,
            account,
            config,
          });
        },
        success: async (upstream: Response, account: AvailableAccount) => {
          if (stream) {
            const result = await handleStreamingResponse(upstream, resp);
            if (result.completed) {
              provider.recordSuccess(account.token.email, result.usage);
              onUsage?.(req, body.model || "claude-sonnet-4-6", {
                input_tokens: result.usage.inputTokens,
                output_tokens: result.usage.outputTokens,
                cache_creation_input_tokens: result.usage.cacheCreationInputTokens,
                cache_read_input_tokens: result.usage.cacheReadInputTokens,
              }, account.token.email);
            } else if (!result.clientDisconnected) {
              provider.recordFailure(
                account.token.email,
                "network",
                "stream terminated before completion",
              );
            }
          } else {
            const anthropicResp = await upstream.json();
            provider.recordSuccess(account.token.email, extractUsage(anthropicResp));
            onUsage?.(req, body.model || "claude-sonnet-4-6", anthropicResp.usage || {}, account.token.email);
            resp.json(anthropicResp);
          }
        },
      });
    } catch (err: any) {
      console.error("[oauth2api] Messages error:", err.message);
      resp.status(500).json({ error: { message: "Internal server error" } });
    }
  });

  // ── Token counting (passthrough) ──
  router.post(
    "/v1/messages/count_tokens",
    async (req: Request, resp: ExpressResponse) => {
      try {
        await proxyWithRetry("CountTokens", resp, config, provider, {
          upstream: (account: AvailableAccount) =>
            callAnthropicCountTokens({ request: req, account, config }),
          success: async (upstream: Response, account: AvailableAccount) => {
            provider.recordSuccess(account.token.email);
            const data = await upstream.json();
            resp.json(data);
          },
        });
      } catch (err: any) {
        console.error("[oauth2api] CountTokens error:", err.message);
        resp.status(500).json({ error: { message: "Internal server error" } });
      }
    },
  );

  // ── Admin: account status ──
  router.get("/admin/accounts", (_req, res) => {
    if (snapshotFn) {
      const { snapshots, count } = snapshotFn();
      res.json({ accounts: snapshots, account_count: count, generated_at: new Date().toISOString() });
    } else {
      res.json({ accounts: [], account_count: 0, generated_at: new Date().toISOString() });
    }
  });

  return router;
}
