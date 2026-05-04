/**
 * Token-based pricing — real cost from API usage data.
 *
 * Prices are per million tokens (MTok), matching Anthropic's published rates.
 * Pre-flight estimation uses character count ÷ 4 for input tokens and
 * max_tokens from the request body for output tokens.
 */

export interface TokenPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheCreationPerMTok: number;  // 1.25x input
  cacheReadPerMTok: number;      // 0.1x input
}

/** Discount multiplier applied to all pricing. Set to 1 for production rates. */
const DISCOUNT = 0.1;

/** Build pricing with correct cache multipliers (1.25x create, 0.1x read). */
function pricing(inputPerMTok: number, outputPerMTok: number): TokenPricing {
  return {
    inputPerMTok: inputPerMTok * DISCOUNT,
    outputPerMTok: outputPerMTok * DISCOUNT,
    cacheCreationPerMTok: inputPerMTok * 1.25 * DISCOUNT,
    cacheReadPerMTok: inputPerMTok * 0.1 * DISCOUNT,
  };
}

/** Pricing per model family (USD per million tokens). */
const MODEL_PRICING: Record<string, TokenPricing> = {
  // Opus 4.7 / 4.6 / 4.5 — $5 input, $25 output
  "claude-opus-4-7": pricing(5, 25),
  "claude-opus-4-6": pricing(5, 25),
  opus: pricing(5, 25),

  // Sonnet 4.6 — $3 input, $15 output
  "claude-sonnet-4-6": pricing(3, 15),
  "claude-sonnet-4-20250514": pricing(3, 15),
  sonnet: pricing(3, 15),

  // Haiku 4.5 — $1 input, $5 output
  "claude-haiku-4-5-20251001": pricing(1, 5),
  "claude-haiku-4-5": pricing(1, 5),
  haiku: pricing(1, 5),
};

/** Fallback to Sonnet pricing if model is unknown. */
const DEFAULT_PRICING: TokenPricing = pricing(3, 15);

export function getPricing(model: string): TokenPricing {
  return MODEL_PRICING[model] || DEFAULT_PRICING;
}

/**
 * Calculate actual cost from API response usage.
 *
 * @param model - Model ID used for the request
 * @param usage - Token counts from the API response
 * @returns Cost in USD
 */
export function calculateCost(
  model: string,
  usage: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number },
): number {
  const p = getPricing(model);
  const inputTokens = usage.input_tokens || 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
  const cacheReadTokens = usage.cache_read_input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;

  const inputCost = (inputTokens / 1_000_000) * p.inputPerMTok;
  const cacheCreateCost = (cacheCreationTokens / 1_000_000) * p.cacheCreationPerMTok;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * p.cacheReadPerMTok;
  const outputCost = (outputTokens / 1_000_000) * p.outputPerMTok;

  return inputCost + cacheCreateCost + cacheReadCost + outputCost;
}

/**
 * Estimate cost before making the API call (pre-flight check).
 *
 * Uses rough heuristic: ~4 characters per token for input estimation,
 * and max_tokens from the request body for output estimation.
 * If max_tokens is not set, defaults to 1024.
 *
 * @param model - Model ID
 * @param body - Request body (OpenAI or Anthropic format)
 * @returns Estimated cost in USD
 */
export function estimateCost(model: string, body: any): number {
  const pricing = getPricing(model);

  // Estimate input tokens from message content
  let inputChars = 0;
  const messages = body.messages || [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      inputChars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && typeof part.text === "string") {
          inputChars += part.text.length;
        }
      }
    }
  }
  if (typeof body.system === "string") {
    inputChars += body.system.length;
  }
  // Responses API uses `input` field
  if (typeof body.input === "string") {
    inputChars += body.input.length;
  }

  const estimatedInputTokens = Math.max(Math.ceil(inputChars / 4), 100);
  // Cap at 1024: max_tokens is the theoretical maximum, not the expected output.
  // Using it raw causes false 402s for short requests with large max_tokens (e.g. Claude Code sends 32000).
  const estimatedOutputTokens = Math.min(body.max_tokens || 1024, 1024);

  const inputCost = (estimatedInputTokens / 1_000_000) * pricing.inputPerMTok;
  const outputCost = (estimatedOutputTokens / 1_000_000) * pricing.outputPerMTok;

  return inputCost + outputCost;
}
