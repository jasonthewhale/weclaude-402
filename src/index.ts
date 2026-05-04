/**
 * WeClaude — x402-gated Claude API proxy.
 *
 * Flow:
 *   1. Buyer pays USDG via x402 → POST /v1/buyer/topup → gets API key
 *   2. API key authorizes requests to Claude via oauth2api proxy
 *   3. Each LLM call deducts real token cost from balance
 *   4. Buyer withdraws → unused balance refunded on-chain
 *
 * Endpoints:
 *   POST /v1/buyer/topup        — x402 payment → API key
 *   POST /v1/chat/completions   — OpenAI format (balance-gated)
 *   POST /v1/messages           — Anthropic format (balance-gated)
 *   POST /v1/messages/count_tokens — token counting (balance-gated, free)
 *   GET  /v1/models             — list supported models
 *   GET  /v1/buyer/balance       — check remaining balance
 *   POST /v1/buyer/withdraw     — refund unused USDG
 *   GET  /health                — service health
 *   GET  /admin/accounts        — OAuth account dashboard
 */

import path from "path";
import fs from "fs";
import express from "express";
import { paymentMiddlewareFromHTTPServer } from "@okxweb3/x402-express";

import { PORT, TOPUP_USD, TOPUP_TIERS, NETWORK, PAY_TO, USDG_ASSET, usdToAtomic, tierPath, DEFAULT_MAX_RPM, DEFAULT_MAX_TPM, LOW_BALANCE_THRESHOLD_USD, SELLER_REVENUE_SHARE, MIN_BALANCE_USD } from "./config.js";
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
  setHealthExtras,
  logTransaction,
  logRequest,
  upsertOAuthAccount,
} from "./x402/index.js";
import {
  AccountManager,
  createOAuth2ApiRouter,
  RateLimiter,
  PoolAllocator,
  handleSellerAuthStart,
  handleSellerAuthComplete,
  handleSellerAuthRevoke,
  handleSellerStatus,
  handleSellerEarn,
  handleSellerClaim,
} from "./oauth2api/index.js";
import type { OAuth2ApiConfig } from "./oauth2api/index.js";
import { estimateCost, calculateCost } from "./pricing.js";
import { canUseGrace, recordGrace, prepareGraceRequest, resetGrace } from "./grace.js";

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
    manager.startAccountValidation(oauthConfig.cloaking);
  }

  // Initialize rate limiter + pool allocator
  const rateLimiter = new RateLimiter(DEFAULT_MAX_RPM, DEFAULT_MAX_TPM);
  const pool = new PoolAllocator(manager, rateLimiter);

  // Sync existing OAuth accounts to DB (so server-owned accounts get tracked).
  // Don't pass source — lets seller-contributed accounts keep source: "seller".
  for (const email of manager.getAllEmails()) {
    const info = manager.getToken(email);
    if (info) {
      upsertOAuthAccount({
        account_id: email,
        account_uuid: info.token.accountUuid || null,
        status: "active",
      });
    }
  }
  pool.syncConfigsFromDb();
  if (manager.accountCount > 0) {
    console.log(`[pool] Synced ${manager.accountCount} account(s) to DB, rate limits loaded`);
  }

  // Inject live stats into /health for the frontend
  const MODELS = [
    "claude-opus-4-7", "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001", "claude-haiku-4-5",
    "opus", "sonnet", "haiku",
  ];
  setHealthExtras({ accounts: manager.accountCount, models: MODELS });

  // Initialize x402 payment infrastructure
  const { resourceServer, httpServer } = createX402Setup();

  const app = express();
  app.use(express.json({ limit: "50mb" }));

  // ── Serve frontend (production build) ──
  const frontendDist = path.join(import.meta.dir, "..", "frontend", "dist");
  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
  }

  // ── LLM request logger (daily rotation, async, slim payloads) ──
  const LOG_DIR = path.join(process.cwd(), "data", "logs");
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const LOG_RETENTION_DAYS = 7;
  const LLM_PATHS = new Set(["/v1/messages", "/v1/chat/completions", "/v1/responses"]);

  /** data/logs/<key-prefix>/YYYY-MM-DD.jsonl — one dir per buyer, daily files. */
  function logFilePath(apiKey: string | undefined): string {
    const day = new Date().toISOString().slice(0, 10);
    const prefix = apiKey ? apiKey.slice(8, 20) : "_anonymous"; // sk-x402-<12chars>
    const dir = path.join(LOG_DIR, prefix);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${day}.jsonl`);
  }

  /** Extract the last user message text (truncated) instead of the full history. */
  function slimRequestBody(body: any): any {
    if (!body || typeof body !== "object") return body;
    const { messages, ...rest } = body;
    if (!Array.isArray(messages) || messages.length === 0) return rest;
    // Find last user message
    let lastUser: any;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") { lastUser = messages[i]; break; }
    }
    let text = "";
    if (lastUser) {
      const content = lastUser.content;
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) text = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
    }
    const MAX_LEN = 2000;
    return {
      ...rest,
      message_count: messages.length,
      last_user_message: text.length > MAX_LEN ? text.slice(0, MAX_LEN) + "...[truncated]" : text,
    };
  }

  /** Extract assistant text + usage from response, drop the bulk. */
  function slimResponseBody(body: any): any {
    if (!body || typeof body !== "object") return body;
    const slim: any = {};
    // Anthropic format
    if (body.type === "message") {
      slim.model = body.model;
      slim.stop_reason = body.stop_reason;
      slim.usage = body.usage;
      const textBlocks = body.content?.filter?.((b: any) => b.type === "text");
      if (textBlocks?.length) {
        const full = textBlocks.map((b: any) => b.text).join("");
        slim.response_length = full.length;
        slim.response_preview = full.slice(0, 500);
      }
      return slim;
    }
    // OpenAI format
    if (body.choices) {
      slim.model = body.model;
      slim.usage = body.usage;
      const msg = body.choices?.[0]?.message;
      if (msg?.content) {
        slim.response_length = msg.content.length;
        slim.response_preview = msg.content.slice(0, 500);
      }
      slim.finish_reason = body.choices?.[0]?.finish_reason;
      return slim;
    }
    return body;
  }

  // Prune logs older than retention period (runs once at startup)
  try {
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 86_400_000;
    for (const sub of fs.readdirSync(LOG_DIR)) {
      const subDir = path.join(LOG_DIR, sub);
      if (!fs.statSync(subDir).isDirectory()) continue;
      for (const file of fs.readdirSync(subDir)) {
        const match = file.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (match && new Date(match[1]).getTime() < cutoff) {
          fs.unlinkSync(path.join(subDir, file));
          console.log(`[log] pruned ${sub}/${file}`);
        }
      }
      // Remove empty buyer dirs
      if (fs.readdirSync(subDir).length === 0) fs.rmdirSync(subDir);
    }
  } catch { /* ignore pruning errors */ }

  // ── Response enrichment + logging middleware ──
  app.use((req, res, next) => {
    const startMs = Date.now();
    const originalJson = res.json.bind(res);
    let captured: any;
    res.json = (body: any) => {
      // Inject low-balance warning into successful LLM responses.
      if (res.statusCode === 200 && body && typeof body === "object" && !Array.isArray(body)) {
        const preBalance = res.locals.weclaudeBalance;
        if (typeof preBalance === "number" && preBalance < LOW_BALANCE_THRESHOLD_USD) {
          body._weclaude = {
            warning: "low_balance",
            balance: `$${preBalance.toFixed(6)}`,
            message: `Balance is low ($${preBalance.toFixed(2)}). Top up to avoid interruption.`,
            topup_tiers: TOPUP_TIERS.map((t) => t === 0.1 ? "/v1/buyer/topup" : `/v1/buyer/topup/${t.toFixed(1)}`),
          };
        }
      }

      // Enrich 402 responses with agent-friendly guidance.
      if (res.statusCode === 402) {
        // Detect failed payment attempt: body had {signature, authorization} but still got 402.
        const paymentAttempted = !!(req.body?.signature && req.body?.authorization);
        const paymentHeader = res.getHeader("payment-required");
        if (paymentHeader) {
          try {
            const decoded = JSON.parse(Buffer.from(String(paymentHeader), "base64").toString());
            const option = decoded.accepts?.[0];
            const amountReadable = option?.amount
              ? `$${(parseInt(option.amount) / 1_000_000).toFixed(2)} USDG`
              : undefined;

            if (paymentAttempted) {
              // Payment was signed and submitted but the facilitator rejected it.
              // Most likely cause: insufficient USDG balance on-chain.
              body = {
                error: "Payment failed",
                reason: "The payment signature was submitted but verification failed on-chain. This usually means the wallet does not have enough USDG on X Layer.",
                amount: amountReadable,
                network: option?.network,
                suggestion: "Check your USDG balance with: onchainos portfolio --chain xlayer. If insufficient, swap or bridge USDG to X Layer first, then retry the topup.",
                retry: false,
              };
            } else {
              // Fresh challenge — no payment attempted yet.
              const headerName = (decoded.x402Version || 0) >= 2 ? "PAYMENT-SIGNATURE" : "X-PAYMENT";
              body = {
                error: "Payment required",
                description: decoded.resource?.description || "x402 payment required",
                x402Version: decoded.x402Version,
                resource: decoded.resource,
                accepted: option,
                amount: option?.amount,
                amount_readable: amountReadable,
                network: option?.network,
                asset: option?.asset,
                payTo: option?.payTo,
                maxTimeoutSeconds: option?.maxTimeoutSeconds,
                payment_header_name: headerName,
                instructions: [
                  "1. Detect your wallet address: onchainos wallet addresses → data.xlayer[0].address",
                  `2. Sign: onchainos payment x402-pay --accepts '${JSON.stringify(decoded.accepts)}' --from <YOUR_WALLET_ADDRESS>`,
                  "3. Extract 'signature' from data.signature and 'authorization' from data.authorization in the sign response",
                  `4. POST ${req.originalUrl} with JSON body: {"signature":"<SIGNATURE>","authorization":<AUTHORIZATION_OBJECT>}`,
                ],
                note: "Just send the raw onchainos sign response back — the server handles header assembly. The server returns 402 for ALL payment failures.",
              };
            }
          } catch {
            body = {
              error: "Payment required",
              hint: "Decode the base64 'payment-required' response header for payment details.",
            };
          }
        }
      }
      captured = body;
      return originalJson(body);
    };

    // Only log LLM endpoints, async, per-buyer files
    res.on("finish", () => {
      if (!LLM_PATHS.has(req.path)) return;
      const key = extractKey(req) ?? undefined;
      const entry = {
        ts: new Date().toISOString(),
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - startMs,
        request: slimRequestBody(req.body),
        response: slimResponseBody(captured),
      };
      fs.appendFile(logFilePath(key), JSON.stringify(entry) + "\n", () => {});
    });
    next();
  });
  // ── Easy-pay: accept raw {signature, authorization} body for topup ──
  // Lets clients skip the manual payload-build + base64-encode step.
  // Converts the raw onchainos sign response into a PAYMENT-SIGNATURE header
  // so the x402 middleware validates it normally.
  app.use((req, _res, next) => {
    if (!req.path.startsWith("/v1/buyer/topup")) return next();
    if (req.headers["payment-signature"] || req.headers["x-payment"]) return next();
    const { signature, authorization } = req.body || {};
    if (!signature || !authorization) return next();

    const pathMatch = req.path.match(/^\/v1\/buyer\/topup\/(.+)$/);
    const paramUsd = pathMatch ? parseFloat(pathMatch[1]) : NaN;
    const tierUsd = !isNaN(paramUsd) && TOPUP_TIERS.includes(paramUsd) ? paramUsd : TOPUP_USD;

    const payload = {
      x402Version: 2,
      resource: {
        url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
        description: `Top up $${tierUsd} USDG — get an API key for Claude API access`,
        mimeType: "",
      },
      accepted: {
        scheme: "exact",
        network: NETWORK,
        amount: usdToAtomic(tierUsd),
        asset: USDG_ASSET,
        payTo: PAY_TO,
        maxTimeoutSeconds: 600,
        extra: {},
      },
      payload: { signature, authorization },
    };

    req.headers["payment-signature"] = Buffer.from(JSON.stringify(payload)).toString("base64");
    next();
  });

  app.use(paymentMiddlewareFromHTTPServer(httpServer));

  // ── Payment routes (no balance check) ──
  // Register explicit routes per tier — no catch-all :amount param.
  // This prevents unregistered amounts from bypassing x402.
  for (const usd of TOPUP_TIERS) {
    app.post(tierPath(usd), handleTopup);
  }
  app.post("/v1/buyer/withdraw", handleClose);
  app.get("/v1/buyer/balance", handleBalance);
  app.get("/health", handleHealth);
  // Root route: serve frontend if built, otherwise 200 OK for health probes
  app.all("/", (_req, res, next) => {
    if (fs.existsSync(path.join(frontendDist, "index.html"))) return next();
    res.sendStatus(200);
  });

  // ── Seller OAuth endpoints ──
  app.post("/v1/seller/auth/start", handleSellerAuthStart);
  app.post("/v1/seller/auth/complete", (req, res) => handleSellerAuthComplete(req, res, manager));
  app.post("/v1/seller/auth/revoke", (req, res) => handleSellerAuthRevoke(req, res, manager));
  app.get("/v1/seller/status", handleSellerStatus);
  app.get("/v1/seller/earn", handleSellerEarn);
  app.post("/v1/seller/claim", handleSellerClaim);

  // ── Admin auth gate ──
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  app.use("/admin", (req, res, next) => {
    if (!ADMIN_SECRET) {
      res.status(503).json({ error: "Admin endpoints are disabled. Set ADMIN_SECRET env var." });
      return;
    }
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ") || auth.slice(7) !== ADMIN_SECRET) {
      res.status(401).json({ error: "Invalid or missing admin token. Use: Authorization: Bearer <ADMIN_SECRET>" });
      return;
    }
    next();
  });

  // ── Admin: upstream utilization ──
  app.get("/admin/utilization", async (_req, res) => {
    const tokens = manager.getAllAccessTokens();
    const results: any[] = [];

    const fetches = [...tokens.entries()].map(async ([email, accessToken]) => {
      try {
        const resp = await fetch("https://api.anthropic.com/api/oauth/usage", {
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": "ClaudeCode/2.1.88",
          },
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) {
          results.push({ email, error: `HTTP ${resp.status}` });
          return;
        }
        const usage = await resp.json() as any;
        results.push({
          email,
          five_hour: usage.five_hour || null,
          seven_day: usage.seven_day || null,
          extra_usage: usage.extra_usage || null,
        });
      } catch (err: any) {
        results.push({ email, error: err.message });
      }
    });

    await Promise.all(fetches);
    // Sort by email for consistent ordering
    results.sort((a, b) => a.email.localeCompare(b.email));
    res.json({ accounts: results, generated_at: new Date().toISOString() });
  });

  // ── Balance-gated LLM proxy ──
  // The oauth2api router handles: /v1/chat/completions, /v1/messages,
  // /v1/messages/count_tokens, /v1/models, /v1/responses, /admin/accounts
  const oauthRouter = createOAuth2ApiRouter(
    oauthConfig,
    pool,
    (req, model, usage, accountEmail) => {
    // Grace requests are free — skip billing entirely
    if ((req as any)._graceMode) {
      console.log(`[grace] free call model=${model} via=${accountEmail}`);
      return;
    }

    // Post-call: deduct real cost based on actual token usage
    const key = extractKey(req);
    if (!key) return;
    const account = getBalance(key);
    if (!account) return;

    const cost = calculateCost(model, usage);
    const earnedUsd = cost * SELLER_REVENUE_SHARE;
    const inputTok = usage.input_tokens || 0;
    const cacheCreateTok = usage.cache_creation_input_tokens || 0;
    const cacheReadTok = usage.cache_read_input_tokens || 0;
    const outputTok = usage.output_tokens || 0;
    const totalInputTok = inputTok + cacheCreateTok + cacheReadTok;

    // Update balance (clamp at zero — actual cost may exceed estimate)
    account.balanceUsd = Math.max(0, account.balanceUsd - cost);
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

    // Log per-request OAuth usage (which account served which buyer)
    if (accountEmail) {
      pool.logUsage({
        accountEmail,
        apiKey: key,
        model,
        usage: {
          inputTokens: inputTok,
          outputTokens: outputTok,
          cacheCreationInputTokens: cacheCreateTok,
          cacheReadInputTokens: cacheReadTok,
        },
        costUsd: cost,
        earnedUsd,
        durationMs: 0, // TODO: track actual duration
      });
    }

    console.log(
      `[usage] model=${model} in=${totalInputTok} out=${outputTok} cost=$${cost.toFixed(6)} earned=$${earnedUsd.toFixed(6)} balance=$${account.balanceUsd.toFixed(6)} via=${accountEmail || "unknown"}`,
    );
  },
  () => ({ snapshots: manager.getSnapshots(), count: manager.accountCount }),
  );

  // ── Topup intent detection ──
  // If the buyer's last message mentions "weclaude" and "topup", route to the
  // free grace model instead of burning Claude tokens on billing questions.
  //
  // When Claude Code expands a /weclaude skill, the full message includes the
  // entire skill documentation (which always contains "topup"). We must check
  // only the user's INTENT — either <command-args> or text before the docs blob.
  function isTopupRequest(req: express.Request): boolean {
    const msgs = req.body?.messages;
    if (!Array.isArray(msgs) || msgs.length === 0) return false;
    // Only check the LAST user message. Extract text blocks only (not tool_result content).
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role !== "user") continue;
      const content = msgs[i].content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join(" ");
      }

      // Extract only the user's intent, not injected skill documentation.
      // Skill-expanded messages have <command-args>...</command-args> — check only that.
      const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
      if (argsMatch) {
        const args = argsMatch[1].toLowerCase();
        return args.includes("topup") || args.includes("top up") || args.includes("top-up");
      }

      // No skill expansion — check the user's raw message (before any docs blob).
      // Truncate at "Base directory for this skill:" to exclude injected docs.
      const docsStart = text.indexOf("Base directory for this skill:");
      const intent = docsStart > 0 ? text.slice(0, docsStart) : text;
      const lower = intent.toLowerCase();
      return lower.includes("weclaude") && (lower.includes("topup") || lower.includes("top up") || lower.includes("top-up"));
    }
    return false;
  }

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
      const key = extractKey(req);
      if (key) {
        const account = getBalance(key);
        if (account) {
          // Check if buyer is asking about topup — route to free grace regardless of balance
          // Balance depleted — grace period (free topup assistance via Haiku)
          const shouldGrace = isTopupRequest(req) || (account.balanceUsd < MIN_BALANCE_USD && canUseGrace(key));
          if (shouldGrace) {
            const { remaining } = account.balanceUsd < MIN_BALANCE_USD
              ? recordGrace(key)
              : { remaining: 99 }; // topup keyword requests are unlimited
            prepareGraceRequest(req, account.payer, remaining, account.balanceUsd);
            console.log(`[grace] key=${key.slice(0, 16)}... payer=${account.payer} remaining=${remaining}`);
            return oauthRouter(req, res, next);
          }
        }
      }

      // Pre-flight: estimate cost from request body and check balance
      const model = req.body?.model || "claude-sonnet-4-6";
      const estimated = estimateCost(model, req.body || {});
      return requireBalanceFor(estimated)(req, res, () => {
        oauthRouter(req, res, next);
      });
    }

    next();
  });

  // ── SPA fallback: serve index.html for unknown GET routes ──
  // Express 5 requires named wildcard params — bare "*" is not valid.
  if (fs.existsSync(frontendDist)) {
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(path.join(frontendDist, "index.html"));
    });
  }

  // ── Start server ──
  app.listen(PORT, "0.0.0.0", async () => {
    try {
      await resourceServer.initialize();
    } catch (err: any) {
      console.error(`Failed to initialize facilitator: ${err.message}`);
      process.exit(1);
    }

    console.log(`\nWeClaude server running on http://0.0.0.0:${PORT}\n`);
    console.log(`  POST /v1/buyer/topup        — pay $${TOPUP_USD} USDG, get API key`);
    console.log(`  POST /v1/chat/completions   — OpenAI format (real token pricing)`);
    console.log(`  POST /v1/messages           — Anthropic format (real token pricing)`);
    console.log(`  POST /v1/responses          — Responses API (real token pricing)`);
    console.log(`  POST /v1/messages/count_tokens — token counting (free)`);
    console.log(`  GET  /v1/models             — list models`);
    console.log(`  GET  /v1/buyer/balance      — check balance`);
    console.log(`  POST /v1/buyer/withdraw     — refund unused USDG`);
    console.log(`  POST /v1/seller/auth/start  — begin seller OAuth flow`);
    console.log(`  POST /v1/seller/auth/complete — complete seller OAuth flow`);
    console.log(`  POST /v1/seller/auth/revoke  — stop sharing, auto-claim earnings`);
    console.log(`  GET  /v1/seller/status      — seller account stats`);
    console.log(`  GET  /v1/seller/earn        — seller earnings breakdown`);
    console.log(`  POST /v1/seller/claim       — claim earnings as USDG`);
    console.log(`  GET  /admin/accounts        — OAuth account status`);
    console.log(`  Network: X Layer (${NETWORK}), Seller: ${PAY_TO}`);
    console.log(`  Rate limits: ${DEFAULT_MAX_RPM} RPM / ${DEFAULT_MAX_TPM} TPM per account`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
