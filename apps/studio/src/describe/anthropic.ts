/**
 * Bring-your-own-key provider: the Messages API called from the browser with the user's own key
 * (the official SDK, `dangerouslyAllowBrowser`, which sends `anthropic-dangerous-direct-browser-access`).
 * Loaded lazily, only when a key is set and the user asks for a design.
 *
 * Request: Claude Opus 5.5, adaptive thinking at medium effort, the design-space description as a
 * cached system prompt, the answer as structured output (`FINISH_OUTPUT_SCHEMA`), and server-side
 * refusal fallbacks (`fallbacks: "default"`).
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  FINISH_OUTPUT_SCHEMA,
  FinishOutputError,
  finishSystemPrompt,
  finishUserMessage,
  parseFinishOutput,
  type FinishAnswer,
  type FinishPromptInput,
} from "@card3d/core/describe";
import { FinishProviderError, maskApiKey, type FinishProvider } from "./providers.ts";

export const FINISH_MODEL = "claude-opus-5-5";
/** Non-streaming: room for adaptive thinking plus a design with a custom shader. */
export const FINISH_MAX_TOKENS = 16000;
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;

/** The Messages API request for one "describe a finish" call. Pure. */
export function buildMessageParams(input: FinishPromptInput, system: string = finishSystemPrompt()): Params {
  return {
    model: FINISH_MODEL,
    max_tokens: FINISH_MAX_TOKENS,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: { type: "json_schema", schema: FINISH_OUTPUT_SCHEMA as unknown as Record<string, unknown> } },
    // The description is identical on every call: cache it (the user message follows the breakpoint).
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: finishUserMessage(input) }],
  };
}

/** The answer in a response, or a `FinishProviderError` / `FinishOutputError` saying why not. */
export function answerFromMessage(message: Message): FinishAnswer {
  if (message.stop_reason === "refusal") {
    const why = message.stop_details?.explanation;
    throw new FinishProviderError("refusal", `The model declined this request${why ? `: ${why}` : ""}. Try describing the finish differently.`);
  }
  const text = message.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (message.stop_reason === "max_tokens") {
    throw new FinishOutputError("the answer was cut off (max_tokens); keep the design, and any custom shader, shorter", text);
  }
  return parseFinishOutput(text);
}

/** Maps SDK errors to messages for the dialog (most specific first). Aborts pass through. */
function providerError(err: unknown): unknown {
  if (err instanceof Anthropic.APIUserAbortError) return Object.assign(new Error("Aborted"), { name: "AbortError" });
  if (err instanceof Anthropic.AuthenticationError)
    return new FinishProviderError("auth", "Your API key was rejected. Check it, or replace it in the key settings.", 401);
  if (err instanceof Anthropic.PermissionDeniedError) return new FinishProviderError("permission", `This API key can't use ${FINISH_MODEL}.`, 403);
  if (err instanceof Anthropic.RateLimitError) return new FinishProviderError("rate-limit", "Rate limited by the Anthropic API. Try again in a minute.", 429);
  if (err instanceof Anthropic.BadRequestError) return new FinishProviderError("bad-request", `The Anthropic API rejected the request: ${err.message}`, 400);
  if (err instanceof Anthropic.InternalServerError)
    return new FinishProviderError("server", `The Anthropic API had a problem (HTTP ${err.status}). Try again.`, err.status);
  if (err instanceof Anthropic.APIConnectionError)
    return new FinishProviderError("network", "Couldn't reach the Anthropic API. Check your connection and try again.");
  if (err instanceof Anthropic.APIError)
    return new FinishProviderError("server", `Anthropic API error${err.status ? ` (HTTP ${err.status})` : ""}: ${err.message}`, err.status);
  return err;
}

export interface AnthropicProviderOptions {
  apiKey: string;
  /** For tests: a fetch to send requests through. */
  fetch?: typeof fetch;
  /** SDK retries on 408/409/429/5xx and connection errors (default 2). */
  maxRetries?: number;
}

export function createAnthropicProvider(opts: AnthropicProviderOptions): FinishProvider {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    dangerouslyAllowBrowser: true,
    maxRetries: opts.maxRetries ?? 2,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  let system: string | null = null;
  return {
    id: "anthropic",
    label: `your Anthropic API key (${maskApiKey(opts.apiKey)})`,
    async generate(input, signal) {
      system ??= finishSystemPrompt();
      let message: Message;
      try {
        message = await client.beta.messages.create(buildMessageParams(input, system), { signal });
      } catch (err) {
        throw providerError(err);
      }
      return answerFromMessage(message);
    },
  };
}
