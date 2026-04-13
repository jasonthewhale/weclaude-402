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

    CREATE INDEX IF NOT EXISTS idx_transactions_api_key ON transactions(api_key);
    CREATE INDEX IF NOT EXISTS idx_requests_api_key     ON requests(api_key);
  `);

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
