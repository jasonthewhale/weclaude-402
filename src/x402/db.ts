/**
 * SQLite storage for buyer accounts, transactions, and request logs.
 *
 * Uses bun:sqlite (built-in, synchronous) — drop-in replacement for the old
 * JSON-file persistence.  Data lives in data/weclaude.db.
 */

import { Database } from "bun:sqlite";
import crypto from "crypto";
import path from "path";
import fs from "fs";

// ── Types ──

export interface Buyer {
  api_key: string;
  payer: string;
  balance_usd: number;
  used_usd: number;
  created_at: string;
  updated_at: string;
}

export type TransactionType = "topup" | "usage" | "withdraw";

export interface Transaction {
  id: number;
  api_key: string;
  type: TransactionType;
  amount_usd: number;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  tx_hash: string | null;
  created_at: string;
}

export interface RequestLog {
  id: number;
  api_key: string;
  transaction_id: number | null;
  model: string;
  endpoint: string;
  status_code: number;
  duration_ms: number;
  stream: boolean;
  created_at: string;
}

// ── Database singleton ──

const DB_PATH = path.join(process.cwd(), "data", "weclaude.db");
let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(DB_PATH, { create: true });
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS buyers (
      api_key     TEXT PRIMARY KEY,
      payer       TEXT NOT NULL,
      balance_usd REAL NOT NULL DEFAULT 0,
      used_usd    REAL NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key      TEXT NOT NULL REFERENCES buyers(api_key),
      type         TEXT NOT NULL CHECK(type IN ('topup', 'usage', 'withdraw')),
      amount_usd   REAL NOT NULL,
      model        TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      tx_hash      TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS requests (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key         TEXT NOT NULL REFERENCES buyers(api_key),
      transaction_id  INTEGER REFERENCES transactions(id),
      model           TEXT NOT NULL,
      endpoint        TEXT NOT NULL,
      status_code     INTEGER NOT NULL DEFAULT 0,
      duration_ms     INTEGER NOT NULL DEFAULT 0,
      stream          INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_buyers_payer
      ON buyers(payer) WHERE payer != 'unknown';
    CREATE INDEX IF NOT EXISTS idx_transactions_api_key ON transactions(api_key);
    CREATE INDEX IF NOT EXISTS idx_requests_api_key     ON requests(api_key);

    -- ── OAuth account pool ──
    CREATE TABLE IF NOT EXISTS oauth_accounts (
      account_id                  TEXT PRIMARY KEY,
      account_uuid                TEXT,
      seller_address              TEXT UNIQUE,
      source                      TEXT NOT NULL DEFAULT 'server'
        CHECK(source IN ('server', 'seller')),
      status                      TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'suspended', 'revoked')),
      total_requests              INTEGER NOT NULL DEFAULT 0,
      total_input_tokens          INTEGER NOT NULL DEFAULT 0,
      total_output_tokens         INTEGER NOT NULL DEFAULT 0,
      total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      max_rpm                     INTEGER,
      max_tpm                     INTEGER,
      created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_seller
      ON oauth_accounts(seller_address) WHERE seller_address IS NOT NULL;

    -- ── Per-request OAuth routing log ──
    CREATE TABLE IF NOT EXISTS oauth_usage (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id              TEXT NOT NULL REFERENCES oauth_accounts(account_id),
      api_key                 TEXT NOT NULL REFERENCES buyers(api_key),
      model                   TEXT NOT NULL,
      input_tokens            INTEGER NOT NULL DEFAULT 0,
      output_tokens           INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens   INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
      cost_usd                REAL NOT NULL DEFAULT 0,
      duration_ms             INTEGER NOT NULL DEFAULT 0,
      status                  TEXT NOT NULL DEFAULT 'success'
        CHECK(status IN ('success', 'error', 'rate_limited')),
      created_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_oauth_usage_account  ON oauth_usage(account_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_usage_api_key  ON oauth_usage(api_key);
    CREATE INDEX IF NOT EXISTS idx_oauth_usage_created  ON oauth_usage(created_at);

    -- ── Seller OAuth pending flows ──
    CREATE TABLE IF NOT EXISTS seller_auth_sessions (
      state             TEXT PRIMARY KEY,
      seller_address    TEXT NOT NULL,
      pkce_verifier     TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'completed', 'expired')),
      expires_at        TEXT NOT NULL,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migration: add oauth_account_id to requests (idempotent)
  try { _db.exec("ALTER TABLE requests ADD COLUMN oauth_account_id TEXT"); } catch { /* already exists */ }
  // Migration: add earned_usd to oauth_accounts (idempotent)
  try { _db.exec("ALTER TABLE oauth_accounts ADD COLUMN earned_usd REAL NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  // Migration: add earned_usd to oauth_usage (idempotent)
  try { _db.exec("ALTER TABLE oauth_usage ADD COLUMN earned_usd REAL NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  // Migration: add claimed_usd to oauth_accounts (idempotent)
  try { _db.exec("ALTER TABLE oauth_accounts ADD COLUMN claimed_usd REAL NOT NULL DEFAULT 0"); } catch { /* already exists */ }

  console.log(`[db] Opened ${DB_PATH}`);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ── Buyer helpers ──

export function generateApiKey(): string {
  return `sk-x402-${crypto.randomBytes(24).toString("hex")}`;
}

export function getBuyer(apiKey: string): Buyer | undefined {
  return getDb()
    .prepare("SELECT * FROM buyers WHERE api_key = ?")
    .get(apiKey) as Buyer | undefined;
}

export function getBuyerByPayer(payer: string): Buyer | undefined {
  return getDb()
    .prepare("SELECT * FROM buyers WHERE payer = ? ORDER BY created_at DESC LIMIT 1")
    .get(payer) as Buyer | undefined;
}

export function createBuyer(apiKey: string, payer: string, balanceUsd: number): Buyer {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      "INSERT INTO buyers (api_key, payer, balance_usd, used_usd, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
    )
    .run(apiKey, payer, balanceUsd, now, now);
  return { api_key: apiKey, payer, balance_usd: balanceUsd, used_usd: 0, created_at: now, updated_at: now };
}

export function updateBalance(apiKey: string, balanceUsd: number, usedUsd: number): void {
  getDb()
    .prepare("UPDATE buyers SET balance_usd = ?, used_usd = ?, updated_at = datetime('now') WHERE api_key = ?")
    .run(balanceUsd, usedUsd, apiKey);
}

// ── Transaction helpers ──

export function logTransaction(
  apiKey: string,
  type: TransactionType,
  amountUsd: number,
  extra?: { model?: string; input_tokens?: number; output_tokens?: number; tx_hash?: string },
): number {
  const result = getDb()
    .prepare(
      "INSERT INTO transactions (api_key, type, amount_usd, model, input_tokens, output_tokens, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      apiKey,
      type,
      amountUsd,
      extra?.model ?? null,
      extra?.input_tokens ?? null,
      extra?.output_tokens ?? null,
      extra?.tx_hash ?? null,
    );
  return Number(result.lastInsertRowid);
}

// ── OAuth account helpers ──

export interface OAuthAccount {
  account_id: string;
  account_uuid: string | null;
  seller_address: string | null;
  source: "server" | "seller";
  status: "active" | "suspended" | "revoked";
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  earned_usd: number;
  claimed_usd: number;
  max_rpm: number | null;
  max_tpm: number | null;
  created_at: string;
  updated_at: string;
}

export function upsertOAuthAccount(opts: {
  account_id: string;
  account_uuid?: string | null;
  seller_address?: string | null;
  source?: "server" | "seller";
  status?: "active" | "suspended" | "revoked";
  max_rpm?: number | null;
  max_tpm?: number | null;
}): void {
  const db = getDb();
  const existing = db
    .prepare("SELECT account_id FROM oauth_accounts WHERE account_id = ?")
    .get(opts.account_id) as { account_id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE oauth_accounts SET
        account_uuid = COALESCE(?, account_uuid),
        seller_address = COALESCE(?, seller_address),
        source = COALESCE(?, source),
        status = COALESCE(?, status),
        max_rpm = COALESCE(?, max_rpm),
        max_tpm = COALESCE(?, max_tpm),
        updated_at = datetime('now')
      WHERE account_id = ?`,
    ).run(
      opts.account_uuid ?? null,
      opts.seller_address ?? null,
      opts.source ?? null,
      opts.status ?? null,
      opts.max_rpm ?? null,
      opts.max_tpm ?? null,
      opts.account_id,
    );
  } else {
    db.prepare(
      `INSERT INTO oauth_accounts (account_id, account_uuid, seller_address, source, status, max_rpm, max_tpm)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.account_id,
      opts.account_uuid ?? null,
      opts.seller_address ?? null,
      opts.source ?? "server",
      opts.status ?? "active",
      opts.max_rpm ?? null,
      opts.max_tpm ?? null,
    );
  }
}

export function getOAuthAccount(accountId: string): OAuthAccount | undefined {
  return getDb()
    .prepare("SELECT * FROM oauth_accounts WHERE account_id = ?")
    .get(accountId) as OAuthAccount | undefined;
}

export function getOAuthAccountBySeller(sellerAddress: string): OAuthAccount | undefined {
  return getDb()
    .prepare("SELECT * FROM oauth_accounts WHERE seller_address = ?")
    .get(sellerAddress) as OAuthAccount | undefined;
}

export function getAllActiveOAuthAccounts(): OAuthAccount[] {
  return getDb()
    .prepare("SELECT * FROM oauth_accounts WHERE status = 'active'")
    .all() as OAuthAccount[];
}

export function revokeOAuthAccount(accountId: string): void {
  getDb()
    .prepare("UPDATE oauth_accounts SET status = 'revoked', updated_at = datetime('now') WHERE account_id = ?")
    .run(accountId);
}

export function incrementOAuthAccountUsage(
  accountId: string,
  usage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number },
): void {
  getDb()
    .prepare(
      `UPDATE oauth_accounts SET
        total_requests = total_requests + 1,
        total_input_tokens = total_input_tokens + ?,
        total_output_tokens = total_output_tokens + ?,
        total_cache_creation_tokens = total_cache_creation_tokens + ?,
        total_cache_read_tokens = total_cache_read_tokens + ?,
        updated_at = datetime('now')
      WHERE account_id = ?`,
    )
    .run(
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheCreationTokens,
      usage.cacheReadTokens,
      accountId,
    );
}

export function incrementOAuthAccountEarnings(accountId: string, earnedUsd: number): void {
  getDb()
    .prepare("UPDATE oauth_accounts SET earned_usd = earned_usd + ?, updated_at = datetime('now') WHERE account_id = ?")
    .run(earnedUsd, accountId);
}

export function incrementOAuthAccountClaimed(accountId: string, claimedUsd: number): void {
  getDb()
    .prepare("UPDATE oauth_accounts SET claimed_usd = claimed_usd + ?, updated_at = datetime('now') WHERE account_id = ?")
    .run(claimedUsd, accountId);
}

// ── OAuth usage log helpers ──

export function logOAuthUsage(opts: {
  accountId: string;
  apiKey: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  earnedUsd: number;
  durationMs: number;
  status?: "success" | "error" | "rate_limited";
}): number {
  const result = getDb()
    .prepare(
      `INSERT INTO oauth_usage (account_id, api_key, model, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, cost_usd, earned_usd, duration_ms, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.accountId,
      opts.apiKey,
      opts.model,
      opts.inputTokens,
      opts.outputTokens,
      opts.cacheCreationTokens,
      opts.cacheReadTokens,
      opts.costUsd,
      opts.earnedUsd,
      opts.durationMs,
      opts.status ?? "success",
    );
  return Number(result.lastInsertRowid);
}

// ── Aggregate stats ──

export function getTotalTokensConsumed(): number {
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(total_input_tokens + total_output_tokens + total_cache_creation_tokens + total_cache_read_tokens), 0) AS total FROM oauth_accounts")
    .get() as { total: number };
  return row.total;
}

export function getBuyerCount(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS cnt FROM buyers")
    .get() as { cnt: number };
  return row.cnt;
}

// ── Seller auth session helpers ──

export interface SellerAuthSession {
  state: string;
  seller_address: string;
  pkce_verifier: string;
  status: "pending" | "completed" | "expired";
  expires_at: string;
  created_at: string;
}

export function createSellerAuthSession(
  state: string,
  sellerAddress: string,
  pkceVerifier: string,
  expiresAt: string,
): void {
  getDb()
    .prepare(
      "INSERT INTO seller_auth_sessions (state, seller_address, pkce_verifier, expires_at) VALUES (?, ?, ?, ?)",
    )
    .run(state, sellerAddress, pkceVerifier, expiresAt);
}

export function getSellerAuthSession(state: string): SellerAuthSession | undefined {
  return getDb()
    .prepare("SELECT * FROM seller_auth_sessions WHERE state = ?")
    .get(state) as SellerAuthSession | undefined;
}

export function completeSellerAuthSession(state: string): void {
  getDb()
    .prepare("UPDATE seller_auth_sessions SET status = 'completed' WHERE state = ?")
    .run(state);
}

export function cleanupExpiredSessions(): void {
  getDb()
    .prepare("DELETE FROM seller_auth_sessions WHERE expires_at < datetime('now') AND status = 'pending'")
    .run();
}

// ── Request log helpers ──

export function logRequest(
  apiKey: string,
  opts: {
    transactionId?: number;
    model: string;
    endpoint: string;
    statusCode: number;
    durationMs: number;
    stream: boolean;
  },
): number {
  const result = getDb()
    .prepare(
      "INSERT INTO requests (api_key, transaction_id, model, endpoint, status_code, duration_ms, stream) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      apiKey,
      opts.transactionId ?? null,
      opts.model,
      opts.endpoint,
      opts.statusCode,
      opts.durationMs,
      opts.stream ? 1 : 0,
    );
  return Number(result.lastInsertRowid);
}
