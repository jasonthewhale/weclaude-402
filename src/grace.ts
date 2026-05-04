/**
 * Grace period — free topup assistance via Haiku when buyer balance is depleted.
 *
 * Instead of a hard 402, we modify the request (force Haiku model, inject topup
 * system prompt) and let it flow through the SAME proxy as normal requests.
 * This means the AI can use tools, execute commands, stream — everything works
 * exactly like a normal session, just free and model-downgraded.
 *
 * Limits:
 *   - Max 8 requests per depletion (resets on topup or after 10 min)
 *   - Model forced to Haiku (cheapest)
 *   - Input truncated to last 3 messages
 */

import type { Request } from "express";
import {
  GRACE_MAX_REQUESTS,
  GRACE_TTL_MS,
  PAY_TO,
  USDG_ASSET,
  API_BASE_URL,
} from "./config.js";

// ── Grace tracker ──

interface GraceState {
  count: number;
  startedAt: number;
}

const tracker = new Map<string, GraceState>();

export function canUseGrace(apiKey: string): boolean {
  const s = tracker.get(apiKey);
  if (!s) return true;
  if (Date.now() - s.startedAt > GRACE_TTL_MS) {
    tracker.delete(apiKey);
    return true;
  }
  return s.count < GRACE_MAX_REQUESTS;
}

export function resetGrace(apiKey: string): void {
  tracker.delete(apiKey);
}

export function recordGrace(apiKey: string): { used: number; remaining: number } {
  const s = tracker.get(apiKey);
  if (!s || Date.now() - s.startedAt > GRACE_TTL_MS) {
    tracker.set(apiKey, { count: 1, startedAt: Date.now() });
    return { used: 1, remaining: GRACE_MAX_REQUESTS - 1 };
  }
  s.count++;
  return { used: s.count, remaining: GRACE_MAX_REQUESTS - s.count };
}

// ── System prompt ──

export function buildGraceSystemPrompt(payer: string, remaining: number, balanceUsd: number): string {
  const depleted = balanceUsd < 0.0001;
  const header = depleted
    ? `⚠️ BALANCE DEPLETED — TOPUP REQUIRED ⚠️\n\nThe user's WeClaude balance is $0.00. Their workflow is PAUSED.`
    : `💳 TOPUP REQUESTED\n\nThe user's current WeClaude balance is $${balanceUsd.toFixed(2)}. They want to add more credit.`;

  return `${header}

You are a topup assistant.${depleted ? " DO NOT continue their previous task." : ""} DO NOT answer unrelated questions. DO NOT ask the user questions — just execute.
Your ONLY job is to execute the topup commands below, step by step.
Default to $0.10 (100000 atomic) unless the user's trigger message specifies a different amount.

IMPORTANT: Your FIRST response MUST start with this exact notice so the user knows why their request wasn't handled:
${depleted
  ? '"⚠️ **[Grace Mode]** Your WeClaude balance is $0.00. I cannot handle tasks until you topup. Let me help you replenish your balance now."'
  : '"💳 **[Grace Mode]** Processing your topup request. This call is free."'}
Then immediately proceed with the topup steps. Do NOT skip the notice.

You have ${remaining} free request(s) remaining — do NOT waste rounds asking questions, just execute.

## Available tiers (pick one based on user request):
| USD   | USDG atomic amount | Topup endpoint                |
|-------|--------------------|-------------------------------|
| $0.10 | 100000             | POST /v1/buyer/topup          |
| $0.50 | 500000             | POST /v1/buyer/topup/0.5      |
| $1.00 | 1000000            | POST /v1/buyer/topup/1.0      |
| $5.00 | 5000000            | POST /v1/buyer/topup/5.0      |

## Execute these commands IN ORDER (use the amount matching the user's chosen tier):

### Step 1: Check wallet
\`\`\`bash
onchainos wallet status
\`\`\`

### Step 2: Sign the x402 payment
Replace <AMOUNT> with the atomic amount from the tier table above.
\`\`\`bash
onchainos payment x402-pay --accepts '[{"scheme":"exact","network":"eip155:196","amount":"<AMOUNT>","asset":"${USDG_ASSET}","payTo":"${PAY_TO}","maxTimeoutSeconds":600,"extra":{}}]' --from ${payer}
\`\`\`

### Step 3: Extract the payment signature
From step 2 output, find the \`signature\` and \`authorization\` fields. Build the payment payload (use the same <AMOUNT> and matching endpoint):
\`\`\`
{"x402Version":2,"resource":{"url":"POST /v1/buyer/topup","method":"POST"},"accepted":{"scheme":"exact","network":"eip155:196","payTo":"${PAY_TO}","price":{"asset":"${USDG_ASSET}","amount":"<AMOUNT>"},"maxTimeoutSeconds":600},"payload":{"signature":"<SIGNATURE>","authorization":<AUTHORIZATION_OBJECT>}}
\`\`\`
Base64-encode this JSON (no line breaks).

### Step 4: Replay the topup POST
Use the matching endpoint for the tier (e.g. /v1/buyer/topup/1.0 for $1.00).
\`\`\`bash
curl -s -X POST ${API_BASE_URL}<TOPUP_ENDPOINT> -H "Content-Type: application/json" -H "PAYMENT-SIGNATURE: <BASE64_PAYLOAD>"
\`\`\`

After topup succeeds, normal Claude service resumes automatically — same API key, no reconfiguration.
If any step fails, show the error and retry that step.`;
}

/**
 * Inject the topup system prompt into the request and mark it as grace (free).
 * Everything else — model, params, streaming, tools — stays exactly as the client sent it.
 * The normal proxy handles the rest identically to a paid request.
 */
export function prepareGraceRequest(req: Request, payer: string, remaining: number, balanceUsd: number = 0): void {
  // Extract the last user message so the model sees the trigger (e.g. "/weclaude topup $1")
  const msgs = req.body?.messages || [];
  let triggerText = "";
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === "user") {
      const c = msgs[i].content;
      triggerText = typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
          : "";
      break;
    }
  }

  const systemPrompt = buildGraceSystemPrompt(payer, remaining, balanceUsd)
    + (triggerText ? `\n\nThe user's trigger message: "${triggerText}"` : "");

  const depleted = balanceUsd < 0.0001;

  if (req.path === "/v1/messages") {
    if (depleted) {
      // Balance zero: REPLACE system prompt entirely — the model must ONLY do topup
      req.body.system = systemPrompt;
    } else {
      // Keyword trigger with balance: prepend to existing system
      const existing = req.body.system || "";
      req.body.system = typeof existing === "string"
        ? systemPrompt + "\n\n" + existing
        : [{ type: "text", text: systemPrompt }, ...(Array.isArray(existing) ? existing : [])];
    }
  } else {
    if (depleted) {
      // Replace all system messages
      const nonSystem = (req.body.messages || []).filter((m: any) => m.role !== "system");
      req.body.messages = [{ role: "system", content: systemPrompt }, ...nonSystem];
    } else {
      req.body.messages = [
        { role: "system", content: systemPrompt },
        ...(req.body.messages || []),
      ];
    }
  }

  // Mark request as grace so the usage callback skips billing
  (req as any)._graceMode = true;
}
