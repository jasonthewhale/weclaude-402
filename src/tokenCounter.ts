import Anthropic from "@anthropic-ai/sdk";

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// --------------- Fallback ---------------

function countCharsFallback(
  messages: Anthropic.MessageParam[],
  system?: string,
): number {
  let chars = system?.length ?? 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") chars += block.text.length;
      }
    }
  }
  return Math.floor(chars / 4);
}

// --------------- Main export ---------------

export interface CountTokensParams {
  model: string;
  messages: Anthropic.MessageParam[];
  system?: string;
  tools?: Anthropic.Tool[];
}

export interface CountTokensResult {
  input_tokens: number;
  method: "api" | "fallback";
}

export async function countTokens(
  params: CountTokensParams,
): Promise<CountTokensResult> {
  try {
    const result = await anthropic.messages.countTokens(params);
    return { input_tokens: result.input_tokens, method: "api" };
  } catch (err: any) {
    console.warn(`[tokenCounter] API failed (${err.message}), using fallback`);
    return {
      input_tokens: countCharsFallback(params.messages, params.system),
      method: "fallback",
    };
  }
}
