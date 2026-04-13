/**
 * Token file persistence.
 *
 * Stores OAuth tokens as JSON files in the auth directory, one per account.
 * File format matches auth2api's TokenStorage for interoperability.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { TokenData, TokenStorage } from "./types.js";

function tokenToStorage(data: TokenData): TokenStorage {
  return {
    access_token: data.accessToken,
    refresh_token: data.refreshToken,
    last_refresh: new Date().toISOString(),
    email: data.email,
    type: "claude",
    expired: data.expiresAt,
    account_uuid: data.accountUuid,
  };
}

function storageToToken(storage: TokenStorage): TokenData {
  return {
    accessToken: storage.access_token,
    refreshToken: storage.refresh_token,
    email: storage.email,
    expiresAt: storage.expired,
    accountUuid: storage.account_uuid || "",
  };
}

export function saveToken(authDir: string, data: TokenData): void {
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const sanitized = data.email
    .replace(/[^a-zA-Z0-9@._-]/g, "_")
    .replace(/\.\./g, "_");
  const filename = `claude-${sanitized}.json`;
  const filePath = path.join(authDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(tokenToStorage(data), null, 2), {
    mode: 0o600,
  });
}

export function loadAllTokens(authDir: string): TokenData[] {
  if (!fs.existsSync(authDir)) return [];
  const files = fs
    .readdirSync(authDir)
    .filter((f) => f.startsWith("claude-") && f.endsWith(".json"));
  const tokens: TokenData[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(authDir, file), "utf-8");
      const storage = JSON.parse(raw) as TokenStorage;
      tokens.push(storageToToken(storage));
    } catch {
      console.error(`[storage] Failed to load token file: ${file}`);
    }
  }
  return tokens;
}

// ── Device ID ──

/**
 * Persistent device_id per account, matching real Claude Code's
 * getOrCreateUserID() format: 64-char hex string from randomBytes(32).
 */
const deviceIdCache = new Map<string, string>();

export function getDeviceId(authDir: string, email: string): string {
  if (deviceIdCache.has(email)) return deviceIdCache.get(email)!;

  const suffix = crypto
    .createHash("sha256")
    .update(email)
    .digest("hex")
    .slice(0, 12);
  const filePath = path.join(authDir, `.device_id_${suffix}`);
  try {
    const stored = fs.readFileSync(filePath, "utf-8").trim();
    if (stored && /^[a-f0-9]{64}$/.test(stored)) {
      deviceIdCache.set(email, stored);
      return stored;
    }
  } catch {}

  const id = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, id, { mode: 0o600 });
  deviceIdCache.set(email, id);
  return id;
}
