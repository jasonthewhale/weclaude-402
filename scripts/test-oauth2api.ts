#!/usr/bin/env bun
/**
 * Test script for the OAuth-to-API converter.
 *
 * Starts an Express server with the oauth2api router mounted, then runs
 * a series of API calls to verify each endpoint works correctly.
 *
 * Usage:
 *   bun run scripts/login.ts          # first: get OAuth tokens
 *   bun run scripts/test-oauth2api.ts  # then: run this test
 *
 * Tests:
 *   1. GET  /v1/models                    — model listing
 *   2. GET  /admin/accounts               — account dashboard
 *   3. POST /v1/messages                  — Anthropic native (non-streaming)
 *   4. POST /v1/messages                  — Anthropic native (streaming)
 *   5. POST /v1/chat/completions          — OpenAI format (non-streaming)
 *   6. POST /v1/chat/completions          — OpenAI format (streaming)
 *   7. POST /v1/messages/count_tokens     — token counting
 */

import path from "path";
import express from "express";
import { AccountManager, createOAuth2ApiRouter } from "../src/oauth2api/index.js";
import type { OAuth2ApiConfig } from "../src/oauth2api/index.js";

const AUTH_DIR = path.join(process.env.HOME || "/root", ".weclaude", "auth");
const TEST_PORT = 19283; // random high port for testing
const BASE = `http://127.0.0.1:${TEST_PORT}`;

// ── Config ──

const config: OAuth2ApiConfig = {
  authDir: AUTH_DIR,
  cloaking: { cliVersion: "2.1.88", entrypoint: "cli" },
  timeouts: {
    messagesMs: 120_000,
    streamMessagesMs: 600_000,
    countTokensMs: 30_000,
  },
  debug: "errors",
};

// ── Helpers ──

let passed = 0;
let failed = 0;

function ok(name: string, detail?: string) {
  passed++;
  console.log(`  \x1b[32mPASS\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name: string, detail: string) {
  failed++;
  console.log(`  \x1b[31mFAIL\x1b[0m ${name} — ${detail}`);
}

async function fetchJSON(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const resp = await fetch(url, init);
  const body = await resp.json();
  return { status: resp.status, body };
}

async function fetchSSE(url: string, init: RequestInit): Promise<{ status: number; events: string[] }> {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    return { status: resp.status, events: [await resp.text()] };
  }
  const text = await resp.text();
  const events = text.split("\n").filter((l) => l.startsWith("data:") || l.startsWith("event:"));
  return { status: resp.status, events };
}

// ── Tests ──

async function testModels() {
  const name = "GET /v1/models";
  try {
    const { status, body } = await fetchJSON(`${BASE}/v1/models`);
    if (status !== 200) return fail(name, `status ${status}`);
    if (body.object !== "list") return fail(name, `expected object=list, got ${body.object}`);
    if (!body.data?.length) return fail(name, "no models returned");
    ok(name, `${body.data.length} models`);
  } catch (err: any) {
    fail(name, err.message);
  }
}

async function testAccounts() {
  const name = "GET /admin/accounts";
  try {
    const { status, body } = await fetchJSON(`${BASE}/admin/accounts`);
    if (status !== 200) return fail(name, `status ${status}`);
    if (typeof body.account_count !== "number") return fail(name, "missing account_count");
    ok(name, `${body.account_count} account(s)`);
  } catch (err: any) {
    fail(name, err.message);
  }
}

async function testMessagesNonStreaming() {
  const name = "POST /v1/messages (non-streaming)";
  try {
    const { status, body } = await fetchJSON(`${BASE}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 100,
        messages: [{ role: "user", content: "Say exactly: test-ok" }],
      }),
    });
    if (status !== 200) return fail(name, `status ${status}: ${JSON.stringify(body)}`);
    if (!body.content) return fail(name, "no content in response");
    const text = body.content.find((b: any) => b.type === "text")?.text || "";
    ok(name, `"${text.slice(0, 60)}..."`);
  } catch (err: any) {
    fail(name, err.message);
  }
}

async function testMessagesStreaming() {
  const name = "POST /v1/messages (streaming)";
  try {
    const { status, events } = await fetchSSE(`${BASE}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "Say exactly: stream-ok" }],
      }),
    });
    if (status !== 200) return fail(name, `status ${status}`);
    if (events.length === 0) return fail(name, "no SSE events received");
    const hasMessageStop = events.some((e) => e.includes("message_stop"));
    if (!hasMessageStop) return fail(name, "missing message_stop event");
    ok(name, `${events.length} SSE lines`);
  } catch (err: any) {
    fail(name, err.message);
  }
}

async function testChatCompletionsNonStreaming() {
  const name = "POST /v1/chat/completions (non-streaming)";
  try {
    const { status, body } = await fetchJSON(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 100,
        messages: [
          { role: "system", content: "You are a test assistant." },
          { role: "user", content: "Say exactly: openai-ok" },
        ],
      }),
    });
    if (status !== 200) return fail(name, `status ${status}: ${JSON.stringify(body)}`);
    if (body.object !== "chat.completion") return fail(name, `wrong object: ${body.object}`);
    const content = body.choices?.[0]?.message?.content || "";
    ok(name, `"${content.slice(0, 60)}..."`);
  } catch (err: any) {
    fail(name, err.message);
  }
}

async function testChatCompletionsStreaming() {
  const name = "POST /v1/chat/completions (streaming)";
  try {
    const { status, events } = await fetchSSE(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "Say exactly: stream-chat-ok" }],
      }),
    });
    if (status !== 200) return fail(name, `status ${status}`);
    if (events.length === 0) return fail(name, "no SSE events received");
    const hasDone = events.some((e) => e.includes("[DONE]"));
    if (!hasDone) return fail(name, "missing [DONE] sentinel");
    ok(name, `${events.length} SSE lines`);
  } catch (err: any) {
    fail(name, err.message);
  }
}

async function testCountTokens() {
  const name = "POST /v1/messages/count_tokens";
  try {
    const { status, body } = await fetchJSON(`${BASE}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: "Hello, how are you?" }],
      }),
    });
    if (status !== 200) return fail(name, `status ${status}: ${JSON.stringify(body)}`);
    if (typeof body.input_tokens !== "number") return fail(name, "missing input_tokens");
    ok(name, `${body.input_tokens} tokens`);
  } catch (err: any) {
    fail(name, err.message);
  }
}

// ── Main ──

async function main() {
  // Load accounts
  const manager = new AccountManager(AUTH_DIR);
  manager.load();

  if (manager.accountCount === 0) {
    console.error("No accounts found. Run first:");
    console.error("  bun run scripts/login.ts");
    process.exit(1);
  }

  manager.startAutoRefresh();

  // Start server
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  const router = createOAuth2ApiRouter(config, manager);
  app.use(router);

  const server = app.listen(TEST_PORT, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));

  console.log(`\nTest server running on ${BASE}\n`);
  console.log("Running tests...\n");

  // Run tests sequentially
  await testModels();
  await testAccounts();
  await testMessagesNonStreaming();
  await testMessagesStreaming();
  await testChatCompletionsNonStreaming();
  await testChatCompletionsStreaming();
  await testCountTokens();

  // Summary
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

  // Cleanup
  manager.stopAutoRefresh();
  server.close();

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner failed:", err.message);
  process.exit(1);
});
