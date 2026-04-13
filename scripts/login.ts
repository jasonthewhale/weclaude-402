#!/usr/bin/env bun
/**
 * Login script — obtains Claude OAuth tokens via browser-based PKCE flow.
 *
 * Usage:
 *   bun run scripts/login.ts              # auto mode (starts local callback server)
 *   bun run scripts/login.ts --manual     # manual mode (paste callback URL)
 *
 * Tokens are saved to ~/.weclaude/auth/ and can be loaded by AccountManager.
 */

import crypto from "crypto";
import readline from "readline";
import path from "path";
import { generatePKCECodes } from "../src/oauth2api/pkce.js";
import { generateAuthURL, exchangeCodeForTokens } from "../src/oauth2api/oauth.js";
import { waitForCallback } from "../src/oauth2api/callback.js";
import { AccountManager } from "../src/oauth2api/manager.js";

const AUTH_DIR = path.join(
  process.env.HOME || "/root",
  ".weclaude",
  "auth",
);

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const manual = process.argv.includes("--manual");

  const manager = new AccountManager(AUTH_DIR);
  manager.load();

  const pkce = generatePKCECodes();
  const state = crypto.randomBytes(16).toString("hex");
  const authURL = generateAuthURL(state, pkce);

  console.log("\n=== WeClaude OAuth Login ===\n");
  console.log("Open this URL in your browser:\n");
  console.log(authURL);

  let code: string;
  let returnedState: string;

  if (manual) {
    console.log(
      "\nAfter login, your browser will redirect to a localhost URL that may fail to load.",
    );
    console.log(
      "Copy the FULL URL from your browser address bar and paste it here.\n",
    );
    const callbackURL = await prompt("Paste callback URL: ");
    const url = new URL(callbackURL);
    code = url.searchParams.get("code") || "";
    returnedState = url.searchParams.get("state") || "";

    if (!code) {
      console.error("Error: No authorization code found in URL");
      process.exit(1);
    }
    if (returnedState !== state) {
      console.error("Error: State mismatch");
      process.exit(1);
    }
  } else {
    console.log("\nWaiting for OAuth callback on http://127.0.0.1:54545 ...\n");
    const result = await waitForCallback();
    code = result.code;
    returnedState = result.state;
  }

  console.log("Exchanging code for tokens...");
  const tokenData = await exchangeCodeForTokens(code, returnedState, state, pkce);
  manager.addAccount(tokenData);

  console.log(`\nLogin successful!`);
  console.log(`  Account:  ${tokenData.email}`);
  console.log(`  Expires:  ${tokenData.expiresAt}`);
  console.log(`  Saved to: ${AUTH_DIR}`);
  console.log(`\nYou can now run: bun run scripts/test-oauth2api.ts`);
}

main().catch((err) => {
  console.error("Login failed:", err.message);
  process.exit(1);
});
