/**
 * SSE stream handler for Anthropic API responses.
 *
 * Reads the upstream SSE stream, extracts usage data from message_delta events,
 * and optionally transforms events (e.g., Anthropic SSE -> OpenAI SSE format).
 */

import type { Response as ExpressResponse } from "express";
import type { UsageData } from "./types.js";

export type SSEEventHandler = (
  event: string,
  data: any,
  usage: UsageData,
) => string[];

export interface StreamOptions {
  onEvent?: SSEEventHandler;
}

export interface StreamResult {
  completed: boolean;
  clientDisconnected: boolean;
  usage: UsageData;
}

function extractUsageFromSSE(event: string, data: any, usage: UsageData): void {
  // message_start carries input tokens + cache breakdown
  if (event === "message_start") {
    const u = data?.message?.usage;
    if (!u) return;
    usage.inputTokens = u.input_tokens || 0;
    usage.cacheCreationInputTokens = u.cache_creation_input_tokens || 0;
    usage.cacheReadInputTokens = u.cache_read_input_tokens || 0;
    return;
  }

  // message_delta carries final output tokens (and may override input tokens)
  if (event !== "message_delta") return;
  const u = data.usage;
  if (!u) return;
  if (u.input_tokens) usage.inputTokens = u.input_tokens;
  usage.outputTokens = u.output_tokens || 0;
  if (u.cache_creation_input_tokens) usage.cacheCreationInputTokens = u.cache_creation_input_tokens;
  if (u.cache_read_input_tokens) usage.cacheReadInputTokens = u.cache_read_input_tokens;
}

export async function handleStreamingResponse(
  upstream: Response,
  resp: ExpressResponse,
  options?: StreamOptions,
): Promise<StreamResult> {
  const usage: UsageData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  resp.setHeader("Content-Type", "text/event-stream");
  resp.setHeader("Cache-Control", "no-cache");
  resp.setHeader("Connection", "keep-alive");
  resp.setHeader("X-Accel-Buffering", "no");
  resp.flushHeaders();

  const reader = upstream.body?.getReader();
  if (!reader) {
    resp.end();
    return { completed: true, clientDisconnected: false, usage };
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let clientDisconnected = false;
  let completed = false;

  resp.on("close", () => {
    clientDisconnected = true;
    reader.cancel().catch(() => {});
  });

  try {
    while (!clientDisconnected) {
      const { done, value } = await reader.read();
      if (done) break;

      // Raw passthrough when no event transformer
      if (!options?.onEvent) {
        resp.write(value);
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (clientDisconnected) break;

        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const raw = line.slice(5).trim();
          if (!raw) continue;
          try {
            const data = JSON.parse(raw);
            extractUsageFromSSE(currentEvent, data, usage);
            if (options?.onEvent) {
              const chunks = options.onEvent(currentEvent, data, usage);
              for (const c of chunks) {
                if (!clientDisconnected) resp.write(c);
              }
            }
          } catch {
            /* ignore parse errors in SSE data */
          }
        }
      }
    }
    completed = true;
  } catch (err) {
    if (!clientDisconnected) console.error("[stream] Error:", err);
  } finally {
    if (!clientDisconnected) resp.end();
  }

  return { completed, clientDisconnected, usage };
}
