/**
 * WeClaude — x402-gated Claude API proxy.
 *
 * Flow:
 *   1. Buyer pays USDG via x402 → POST /v1/topup → gets API key
 *   2. API key authorizes requests to Claude via oauth2api proxy
 *   3. Each LLM call deducts real token cost from balance
 *   4. Buyer closes session → unused balance refunded on-chain
 *
 * Endpoints:
 *   POST /v1/topup              — x402 payment → API key
 *   POST /v1/chat/completions   — OpenAI format (balance-gated)
 *   POST /v1/messages           — Anthropic format (balance-gated)
 *   POST /v1/messages/count_tokens — token counting (balance-gated, free)
 *   GET  /v1/models             — list supported models
 *   GET  /v1/balance            — check remaining balance
 *   POST /v1/close              — refund unused USDG
 *   GET  /health                — service health
 *   GET  /admin/accounts        — OAuth account dashboard
 */

import path from "path";
import express from "express";
import { paymentMiddlewareFromHTTPServer } from "@okxweb3/x402-express";

import { PORT, TOPUP_USD, NETWORK, PAY_TO } from "./config.js";
import {
  loadSessions,
  getBalance,
  setBalance,
  requireBalance,
  requireBalanceFor,
  extractKey,
  createX402Setup,
  handleTopup,
  handleClose,
  handleBalance,
  handleHealth,
  logTransaction,
  logRequest,
} from "./x402/index.js";
import { AccountManager, createOAuth2ApiRouter } from "./oauth2api/index.js";
import type { OAuth2ApiConfig } from "./oauth2api/index.js";
import { estimateCost, calculateCost } from "./pricing.js";

// ── OAuth2API config ──

const AUTH_DIR = path.join(process.env.HOME || "/root", ".weclaude", "auth");

const oauthConfig: OAuth2ApiConfig = {
  authDir: AUTH_DIR,
  cloaking: { cliVersion: "2.1.88", entrypoint: "cli" },
  timeouts: {
    messagesMs: 120_000,
    streamMessagesMs: 600_000,
    countTokensMs: 30_000,
  },
  debug: process.env.DEBUG === "verbose" ? "verbose" : "errors",
};

// ── Main ──

async function main() {
  // Load persisted x402 sessions
  loadSessions();

  // Initialize OAuth account manager
  const manager = new AccountManager(AUTH_DIR);
  manager.load();

  if (manager.accountCount === 0) {
    console.warn("[oauth2api] No OAuth accounts found. Run: bun run login");
    console.warn("[oauth2api] LLM endpoints will fail until accounts are added.");
  } else {
    console.log(`[oauth2api] Loaded ${manager.accountCount} account(s)`);
    manager.startAutoRefresh();
  }

  // Initialize x402 payment infrastructure
  const { resourceServer, httpServer } = createX402Setup();

  const app = express();
  app.use(express.json({ limit: "50mb" }));

  // x402 payment middleware (handles 402 challenge/response for /v1/topup)
  app.use(paymentMiddlewareFromHTTPServer(httpServer));

  // ── Payment routes (no balance check) ──
  app.post("/v1/topup", handleTopup);
  app.post("/v1/close", handleClose);
  app.get("/v1/balance", handleBalance);
  app.get("/health", handleHealth);

  // ── Balance-gated LLM proxy ──
  // The oauth2api router handles: /v1/chat/completions, /v1/messages,
  // /v1/messages/count_tokens, /v1/models, /v1/responses, /admin/accounts
  const oauthRouter = createOAuth2ApiRouter(oauthConfig, manager, (req, model, usage) => {
    // Post-call: deduct real cost based on actual token usage
    const key = extractKey(req);
    if (!key) return;
    const account = getBalance(key);
    if (!account) return;

    const cost = calculateCost(model, usage);
    const inputTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
    const outputTok = usage.output_tokens || 0;

    // Update balance
    account.balanceUsd -= cost;
    account.usedUsd += cost;
    setBalance(key, account);

    // Log usage transaction
    const txId = logTransaction(key, "usage", cost, {
      model,
      input_tokens: inputTok,
      output_tokens: outputTok,
    });

    // Log the request
    const endpoint = req.path;
    const stream = !!(req.body?.stream);
    logRequest(key, {
      transactionId: txId,
      model,
      endpoint,
      statusCode: 200,
      durationMs: 0, // TODO: track actual duration
      stream,
    });

    console.log(
      `[usage] model=${model} in=${inputTok} out=${outputTok} cost=$${cost.toFixed(6)} balance=$${account.balanceUsd.toFixed(6)}`,
    );
  });

  // Wrap oauth2api routes with balance checking + usage-based deduction
  app.use((req, res, next) => {
    // These paths go through balance gating with cost estimation
    const gatedPaths = [
      "/v1/chat/completions",
      "/v1/messages",
      "/v1/responses",
    ];
    // Token counting is gated but free (no deduction)
    const freePaths = ["/v1/messages/count_tokens"];
    // These are open (no balance needed)
    const openPaths = ["/v1/models", "/admin/accounts"];

    const isGated = gatedPaths.some((p) => req.path === p);
    const isFree = freePaths.some((p) => req.path === p);
    const isOpen = openPaths.some((p) => req.path === p);

    if (isOpen) {
      return oauthRouter(req, res, next);
    }

    if (isFree) {
      return requireBalance(req, res, () => oauthRouter(req, res, next));
    }

    if (isGated) {
      // Pre-flight: estimate cost from request body and check balance
      const model = req.body?.model || "claude-sonnet-4-6";
      const estimated = estimateCost(model, req.body || {});
      return requireBalanceFor(estimated)(req, res, () => {
        oauthRouter(req, res, next);
      });
    }

    next();
  });

  // ── Start server ──
  app.listen(PORT, "127.0.0.1", async () => {
    try {
      await resourceServer.initialize();
    } catch (err: any) {
      console.error(`Failed to initialize facilitator: ${err.message}`);
      process.exit(1);
    }

    console.log(`\nWeClaude server running on http://127.0.0.1:${PORT}\n`);
    console.log(`  POST /v1/topup              — pay $${TOPUP_USD} USDG, get API key`);
    console.log(`  POST /v1/chat/completions   — OpenAI format (real token pricing)`);
    console.log(`  POST /v1/messages           — Anthropic format (real token pricing)`);
    console.log(`  POST /v1/responses          — Responses API (real token pricing)`);
    console.log(`  POST /v1/messages/count_tokens — token counting (free)`);
    console.log(`  GET  /v1/models             — list models`);
    console.log(`  GET  /v1/balance            — check balance`);
    console.log(`  POST /v1/close              — refund unused USDG`);
    console.log(`  GET  /admin/accounts        — OAuth account status`);
    console.log(`  Network: X Layer (${NETWORK}), Seller: ${PAY_TO}`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
