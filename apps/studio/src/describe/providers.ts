/**
 * "Describe a finish…" providers: where the model call goes. Two implementations, neither configured
 * by default:
 * - `anthropic` (anthropic.ts): the user's own Anthropic API key, called from the browser. The key
 *   lives only in this browser's localStorage (never in the URL, a share link or a design) and is
 *   shown masked.
 * - `proxy` (here): a server-side proxy at `VITE_DESCRIBE_FINISH_PROXY` (e.g. a Cloudflare Worker that
 *   holds the key). Request / response contract: DEPLOY.md "Describe a finish (feature flag)".
 * Both build the same request from `@card3d/core/describe` (`finishSystemPrompt`, …).
 */
import { parseFinishOutput, type FinishAnswer, type FinishPromptInput } from "@card3d/core/describe";

export interface FinishProvider {
  readonly id: "anthropic" | "proxy";
  /** For the dialog, e.g. "your Anthropic API key (sk-ant-…a1b2)". */
  readonly label: string;
  /**
   * One model call. Resolves with the parsed answer (validate it with `lintDesign`); rejects with a
   * `FinishOutputError` (unparseable answer: worth a retry), a `FinishProviderError` (show it) or an
   * AbortError.
   */
  generate(input: FinishPromptInput, signal?: AbortSignal): Promise<FinishAnswer>;
}

export type FinishProviderErrorKind = "auth" | "permission" | "rate-limit" | "network" | "refusal" | "truncated" | "bad-request" | "server";

/** A provider failure with a message fit for the dialog. */
export class FinishProviderError extends Error {
  readonly kind: FinishProviderErrorKind;
  readonly status?: number;
  constructor(kind: FinishProviderErrorKind, message: string, status?: number) {
    super(message);
    this.name = "FinishProviderError";
    this.kind = kind;
    this.status = status;
  }
}

// ── the user's key (bring your own) ─────────────────────────────────────────

const API_KEY_STORAGE = "card-studio.anthropic-api-key";

export function loadApiKey(): string | null {
  try {
    return localStorage.getItem(API_KEY_STORAGE)?.trim() || null;
  } catch {
    return null;
  }
}

/** Saves the key in this browser only. Returns false when storage is unavailable. */
export function saveApiKey(key: string): boolean {
  try {
    localStorage.setItem(API_KEY_STORAGE, key.trim());
    return true;
  } catch {
    return false;
  }
}

export function clearApiKey(): void {
  try {
    localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    /* storage unavailable */
  }
}

/** "sk-ant-api03-…" → "sk-ant-…a1b2": never show the whole key. */
export function maskApiKey(key: string): string {
  const k = key.trim();
  const head = k.startsWith("sk-ant-") ? "sk-ant-" : k.slice(0, 3);
  return k.length <= 8 ? "••••" : `${head}…${k.slice(-4)}`;
}

/** Plausible Anthropic key shape (the API has the final say). */
export const looksLikeApiKey = (k: string): boolean => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k.trim());

// ── the proxy ────────────────────────────────────────────────────────────────

/** Body of a proxy request (DEPLOY.md). */
interface ProxyRequest extends FinishPromptInput {
  version: 1;
}

/**
 * A provider for a server-side proxy. The proxy answers 200 with the model's structured output
 * (`{ summary, design_json }`), or a non-2xx status with `{ error }`.
 */
export function createProxyProvider(url: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): FinishProvider {
  return {
    id: "proxy",
    label: "the studio's model service",
    async generate(input, signal) {
      const body: ProxyRequest = {
        version: 1,
        description: input.description,
        ...(input.current ? { current: input.current } : {}),
        ...(input.retry ? { retry: input.retry } : {}),
      };
      let res: Response;
      try {
        res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
      } catch (err) {
        if ((err as Error).name === "AbortError") throw err;
        throw new FinishProviderError("network", "Couldn't reach the model service. Check your connection and try again.");
      }
      const text = await res.text();
      if (!res.ok) {
        let message = "";
        try {
          message = String((JSON.parse(text) as { error?: unknown }).error ?? "");
        } catch {
          /* not JSON */
        }
        const kind: FinishProviderErrorKind =
          res.status === 429 ? "rate-limit" : res.status === 401 ? "auth" : res.status === 403 ? "permission" : res.status >= 500 ? "server" : "bad-request";
        const fallback = kind === "rate-limit" ? "Too many requests right now. Try again in a minute." : `The model service failed (HTTP ${res.status}).`;
        throw new FinishProviderError(kind, message || fallback, res.status);
      }
      return parseFinishOutput(text);
    },
  };
}

/** The provider this studio can use now: the user's key first, else the build's proxy, else none. */
export async function configuredProvider(proxyUrl = import.meta.env.VITE_DESCRIBE_FINISH_PROXY): Promise<FinishProvider | null> {
  const key = loadApiKey();
  if (key) {
    const { createAnthropicProvider } = await import("./anthropic.ts");
    return createAnthropicProvider({ apiKey: key });
  }
  return proxyUrl ? createProxyProvider(proxyUrl) : null;
}
