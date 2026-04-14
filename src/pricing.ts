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
}

/** Pricing per model family (USD per million tokens). */
const MODEL_PRICING: Record<string, TokenPricing> = {
  // Opus 4
  "claude-opus-4-6": { inputPerMTok: 15, outputPerMTok: 75 },
  opus: { inputPerMTok: 15, outputPerMTok: 75 },

  // Sonnet 4
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4-20250514": { inputPerMTok: 3, outputPerMTok: 15 },
  sonnet: { inputPerMTok: 3, outputPerMTok: 15 },

  // Haiku 3.5
  "claude-haiku-4-5-20251001": { inputPerMTok: 0.8, outputPerMTok: 4 },
  "claude-haiku-4-5": { inputPerMTok: 0.8, outputPerMTok: 4 },
  haiku: { inputPerMTok: 0.8, outputPerMTok: 4 },
};

/** Fallback to Sonnet pricing if model is unknown. */
const DEFAULT_PRICING: TokenPricing = { inputPerMTok: 3, outputPerMTok: 15 };

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
  const pricing = getPricing(model);
  const inputTokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  // Cache reads are typically cheaper, but we charge full input price for simplicity
  const cacheReadTokens = usage.cache_read_input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;

  const inputCost = ((inputTokens + cacheReadTokens) / 1_000_000) * pricing.inputPerMTok;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMTok;

  return inputCost + outputCost;
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
