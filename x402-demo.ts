import crypto from "crypto";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import express from "express";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import {
  x402ResourceServer,
  x402HTTPResourceServer,
  paymentMiddlewareFromHTTPServer,
} from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { AggrDeferredEvmScheme } from "@okxweb3/x402-evm/deferred/server";

const NETWORK = "eip155:196" as const; // X Layer
const PAY_TO = process.env.SELLER_ADDRESS || "0x15df42a6ae23a4748c2a06e2bbe1e1bfaa525501";
const PORT = 4021;

// USDG on X Layer (6 decimals)
const USDG_ASSET = "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8";

// Topup: $0.10 USDG = 100_000 atomic units
const TOPUP_AMOUNT = "100000";
const TOPUP_USD = 0.1;

// Cost per simulated LLM call: $0.001
const COST_PER_CALL = 0.001;

// --------------- Balance Store ---------------

interface AccountBalance {
  apiKey: string;
  balanceUsd: number; // authorized amount remaining
  usedUsd: number; // accumulated usage
  payer: string; // buyer's on-chain address
  settled: boolean; // whether session has been closed
  createdAt: number;
}

const SESSIONS_FILE = path.join(process.cwd(), "data", "x402-sessions.json");

const balances = new Map<string, AccountBalance>();

function saveSessions(): void {
  const dir = path.dirname(SESSIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = Object.fromEntries(balances);
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
}

function loadSessions(): void {
  if (!fs.existsSync(SESSIONS_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
    for (const [key, val] of Object.entries(raw)) {
      balances.set(key, val as AccountBalance);
    }
    console.log(`[store] Loaded ${balances.size} sessions from ${SESSIONS_FILE}`);
  } catch (err: any) {
    console.error(`[store] Failed to load sessions: ${err.message}`);
  }
}

function generateApiKey(): string {
  return `sk-x402-${crypto.randomBytes(24).toString("hex")}`;
}

function findByApiKey(key: string): AccountBalance | undefined {
  return balances.get(key);
}

// --------------- Mock LLM ---------------

function createMockLLMResponse(messages: any[]) {
  const lastMsg = messages?.[messages.length - 1];
  const userContent =
    typeof lastMsg?.content === "string" ? lastMsg.content : "hello";
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "claude-sonnet-4-6",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: `[x402-demo] Simulated response to: "${userContent}"`,
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 },
  };
}

// --------------- Refund Helper ---------------

function refundBuyer(
  buyerAddress: string,
  refundUsd: number,
): { success: boolean; output?: string; error?: string } {
  if (refundUsd <= 0) return { success: true, output: "no-refund-needed" };

  // Convert to human-readable amount (USDG has 6 decimals, onchainos handles conversion)
  const readableAmount = refundUsd.toFixed(6);

  const cmd = [
    "onchainos wallet send",
    `--chain 196`,
    `--from ${PAY_TO}`,
    `--receipt ${buyerAddress}`,
    `--contract-token ${USDG_ASSET}`,
    `--readable-amount ${readableAmount}`,
    `--force`,
  ].join(" ");

  console.log(`[refund] ${cmd}`);

  try {
    const output = execSync(cmd, { encoding: "utf-8", timeout: 30_000 });
    console.log(`[refund] success: ${output.trim()}`);
    return { success: true, output: output.trim() };
  } catch (err: any) {
    console.error(`[refund] failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// --------------- Middleware ---------------

function extractKey(req: express.Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const xKey = req.headers["x-api-key"];
  if (typeof xKey === "string") return xKey;
  return null;
}

const requireBalance: express.RequestHandler = (req, res, next) => {
  const key = extractKey(req);
  if (!key) {
    res.status(401).json({ error: { message: "Missing API key. Top up first: POST /v1/topup" } });
    return;
  }
  const account = findByApiKey(key);
  if (!account) {
    res.status(403).json({ error: { message: "Invalid API key. Top up first: POST /v1/topup" } });
    return;
  }
  if (account.settled) {
    res.status(403).json({ error: { message: "Session closed. Top up again: POST /v1/topup" } });
    return;
  }
  if (account.balanceUsd < COST_PER_CALL) {
    res.status(402).json({
      error: {
        message: "Insufficient balance. Close session or top up again.",
        balance: `$${account.balanceUsd.toFixed(6)}`,
        close_url: "/v1/close",
        topup_url: "/v1/topup",
      },
    });
    return;
  }
  next();
};

// --------------- Main ---------------

async function main() {
  loadSessions();

  const apiKey = process.env.OKX_API_KEY;
  const secretKey = process.env.OKX_SECRET_KEY;
  const passphrase = process.env.OKX_PASSPHRASE;

  if (!apiKey || !secretKey || !passphrase) {
    console.error("Missing OKX API credentials. Set OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE.");
    process.exit(1);
  }

  // --- x402 setup (only for /v1/topup) ---

  const facilitatorClient = new OKXFacilitatorClient({
    apiKey,
    secretKey,
    passphrase,
    baseUrl: "https://web3.okx.com",
    syncSettle: true,
  });

  const resourceServer = new x402ResourceServer(facilitatorClient);
  resourceServer.register(NETWORK, new ExactEvmScheme());
  resourceServer.register(NETWORK, new AggrDeferredEvmScheme());

  const topupRoutes = {
    "POST /v1/topup": {
      accepts: [
        {
          scheme: "exact",
          network: NETWORK,
          payTo: PAY_TO,
          price: { asset: USDG_ASSET, amount: TOPUP_AMOUNT },
          maxTimeoutSeconds: 600,
        },
        {
          scheme: "aggr_deferred",
          network: NETWORK,
          payTo: PAY_TO,
          price: { asset: USDG_ASSET, amount: TOPUP_AMOUNT },
          maxTimeoutSeconds: 600,
        },
      ],
      description: `Top up $${TOPUP_USD} USDG — get an API key for Claude API access`,
    },
  };

  const httpServer = new x402HTTPResourceServer(resourceServer, topupRoutes);

  // --- Express app ---

  const app = express();
  app.use(express.json());

  // x402 middleware — only matches /v1/topup, passes through everything else
  app.use(paymentMiddlewareFromHTTPServer(httpServer));

  // Top-up endpoint: x402 payment settled by middleware, then issue API key
  app.post("/v1/topup", (req, res) => {
    // Payment already verified + settled by x402 middleware.
    // Extract payer address from the payment header.
    let payer = "unknown";
    const paymentSig = req.headers["payment-signature"] as string;
    if (paymentSig) {
      try {
        const decoded = JSON.parse(Buffer.from(paymentSig, "base64").toString());
        payer = decoded?.payload?.authorization?.from || "unknown";
      } catch {
        /* ignore */
      }
    }

    const newKey = generateApiKey();
    const account: AccountBalance = {
      apiKey: newKey,
      balanceUsd: TOPUP_USD,
      usedUsd: 0,
      payer,
      settled: false,
      createdAt: Date.now(),
    };
    balances.set(newKey, account);
    saveSessions();

    console.log(`[topup] key=${newKey.slice(0, 16)}... balance=$${TOPUP_USD} payer=${payer}`);

    res.json({
      api_key: newKey,
      balance: `$${TOPUP_USD.toFixed(2)}`,
      cost_per_call: `$${COST_PER_CALL}`,
      estimated_calls: Math.floor(TOPUP_USD / COST_PER_CALL),
      close_url: "/v1/close",
      usage: `Authorization: Bearer ${newKey}`,
    });
  });

  // Chat completions: normal API key + balance check, no x402
  app.post("/v1/chat/completions", requireBalance, (req, res) => {
    const key = extractKey(req)!;
    const account = findByApiKey(key)!;

    // Deduct cost
    account.balanceUsd -= COST_PER_CALL;
    account.usedUsd += COST_PER_CALL;
    saveSessions();

    const response = createMockLLMResponse(req.body?.messages || []);
    res.json(response);
  });

  // Close session: refund unused portion, invalidate key
  app.post("/v1/close", async (req, res) => {
    const key = extractKey(req);
    if (!key) {
      res.status(401).json({ error: { message: "Missing API key" } });
      return;
    }
    const account = findByApiKey(key);
    if (!account) {
      res.status(403).json({ error: { message: "Invalid API key" } });
      return;
    }
    if (account.settled) {
      res.json({
        status: "already_closed",
        used: `$${account.usedUsd.toFixed(6)}`,
        refunded: `$${(TOPUP_USD - account.usedUsd).toFixed(6)}`,
      });
      return;
    }

    // Refund unused portion via onchainos wallet send (seller → buyer)
    const refundUsd = TOPUP_USD - account.usedUsd;
    let refund: { success: boolean; output?: string; error?: string } = {
      success: true,
      output: "no-refund-needed",
    };

    if (refundUsd > 0 && account.payer !== "unknown") {
      refund = refundBuyer(account.payer, refundUsd);
    }

    account.settled = true;
    saveSessions();

    console.log(
      `[close] key=${account.apiKey.slice(0, 16)}... used=$${account.usedUsd.toFixed(6)} refunded=$${refundUsd.toFixed(6)}`,
    );

    res.json({
      status: "closed",
      used: `$${account.usedUsd.toFixed(6)}`,
      refunded: `$${refundUsd.toFixed(6)}`,
      refund_result: refund.success ? refund.output : null,
      refund_error: refund.success ? undefined : refund.error,
      message: refund.success
        ? `Used $${account.usedUsd.toFixed(6)} of $${TOPUP_USD.toFixed(2)}. Refunded $${refundUsd.toFixed(6)} to ${account.payer}.`
        : `Used $${account.usedUsd.toFixed(6)}. Refund of $${refundUsd.toFixed(6)} failed: ${refund.error}`,
    });
  });

  // Balance check
  app.get("/v1/balance", (req, res) => {
    const key = extractKey(req);
    if (!key) {
      res.status(401).json({ error: { message: "Missing API key" } });
      return;
    }
    const account = findByApiKey(key);
    if (!account) {
      res.status(403).json({ error: { message: "Invalid API key" } });
      return;
    }
    res.json({
      balance: `$${account.balanceUsd.toFixed(6)}`,
      used: `$${account.usedUsd.toFixed(6)}`,
      topup: `$${TOPUP_USD.toFixed(2)}`,
      remaining_calls: account.settled ? 0 : Math.floor(account.balanceUsd / COST_PER_CALL),
      closed: account.settled,
    });
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      model: "topup + refund-on-close",
      network: NETWORK,
      topup_price: `$${TOPUP_USD} USDG`,
      cost_per_call: `$${COST_PER_CALL} USDG`,
    });
  });

  app.listen(PORT, "127.0.0.1", async () => {
    try {
      await resourceServer.initialize();
    } catch (err: any) {
      console.error(`Failed to initialize facilitator: ${err.message}`);
      process.exit(1);
    }
    console.log(`x402 demo server running on http://127.0.0.1:${PORT}`);
    console.log();
    console.log(`  Step 1 — Top up (one-time x402 payment, settled immediately):`);
    console.log(`    POST /v1/topup — pay $${TOPUP_USD} USDG, get an API key`);
    console.log();
    console.log(`  Step 2 — Use API key (no x402, until balance runs out):`);
    console.log(`    POST /v1/chat/completions — $${COST_PER_CALL}/call (~${Math.floor(TOPUP_USD / COST_PER_CALL)} calls per topup)`);
    console.log(`    GET  /v1/balance — check remaining balance`);
    console.log();
    console.log(`  Step 3 — Close (refund unused portion via onchainos):`);
    console.log(`    POST /v1/close — refunds unused USDG back to buyer`);
    console.log();
    console.log(`  Network: X Layer (${NETWORK})`);
    console.log(`  Seller:  ${PAY_TO}`);
    console.log(`  Token:   USDG (${USDG_ASSET})`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
