/**
 * Balance Store — thin wrapper over SQLite (db.ts).
 *
 * Keeps the same exported interface (getBalance, setBalance, etc.)
 * so callers (routes, middleware, index) don't need changes.
 * All data now lives in data/weclaude.db.
 */

import {
  getDb,
  getBuyer,
  createBuyer,
  updateBalance,
  generateApiKey,
} from "./db.js";

export { generateApiKey } from "./db.js";

// Re-export the legacy shape for callers that destructure it.
export interface AccountBalance {
  apiKey: string;
  balanceUsd: number;
  usedUsd: number;
  payer: string;
  createdAt: number;
}

function toAccount(row: {
  api_key: string;
  payer: string;
  balance_usd: number;
  used_usd: number;
  created_at: string;
}): AccountBalance {
  return {
    apiKey: row.api_key,
    balanceUsd: row.balance_usd,
    usedUsd: row.used_usd,
    payer: row.payer,
    createdAt: new Date(row.created_at).getTime(),
  };
}

/** Initialize DB (replaces old loadSessions). */
export function loadSessions(): void {
  getDb(); // ensures schema is created
  const count = (
    getDb().prepare("SELECT COUNT(*) AS cnt FROM buyers").get() as { cnt: number }
  ).cnt;
  if (count > 0) console.log(`[store] ${count} buyer(s) in database`);
}

/** No-op — SQLite writes are immediate. Kept for API compat. */
export function saveSessions(): void {
  // intentionally empty
}

export function getBalance(key: string): AccountBalance | undefined {
  const row = getBuyer(key);
  return row ? toAccount(row) : undefined;
}

export function setBalance(key: string, account: AccountBalance): void {
  const existing = getBuyer(key);
  if (existing) {
    updateBalance(key, account.balanceUsd, account.usedUsd);
  } else {
    createBuyer(key, account.payer, account.balanceUsd);
  }
}
