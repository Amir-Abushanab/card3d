import { describe, expect, it, vi } from "vitest";
import { DESIGN_EXAMPLES, FINISH_OUTPUT_SCHEMA, FinishOutputError, finishSystemPrompt } from "@card3d/core/describe";
import { defaultDesign, type CardDesign } from "@card3d/core/model";
import { resolveDescribeFlag, type FlagInputs } from "./flag.ts";
import { FALLBACK_BETA, FINISH_MAX_TOKENS, FINISH_MODEL, answerFromMessage, buildMessageParams, createAnthropicProvider } from "./anthropic.ts";
import { FinishProviderError, createProxyProvider, maskApiKey, looksLikeApiKey, type FinishProvider } from "./providers.ts";
import { FinishValidationError, describeFinish, mergeUploads, skillCommand, validateFinish } from "./flow.ts";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789-wxyz";
const DESIGN = DESIGN_EXAMPLES[0].design;
const ANSWER = JSON.stringify({ summary: "Champagne gold.", design_json: JSON.stringify(DESIGN) });

/** A Messages API response as the API sends it. */
const apiMessage = (over: Record<string, unknown> = {}) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: FINISH_MODEL,
  content: [
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "text", text: ANSWER },
  ],
  stop_reason: "end_turn",
  stop_sequence: null,
  stop_details: null,
  usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 9000 },
  ...over,
});

interface RecordedCall {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** A fetch that records each request and answers with `respond`. No network. */
function mockFetch(respond: () => Response) {
  const calls: RecordedCall[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    // The SDK may hand over a Headers object from another realm: copy it entry by entry.
    const headers = new Headers();
    const h = init?.headers as { forEach?: (cb: (v: string, k: string) => void) => void } | Record<string, string> | undefined;
    if (h && typeof h.forEach === "function") (h.forEach as (cb: (v: string, k: string) => void) => void)((v, k) => headers.set(k, v));
    else if (h) for (const [k, v] of Object.entries(h)) headers.set(k, String(v));
    calls.push({ url: String(input instanceof Request ? input.url : input), headers, body: JSON.parse(String(init?.body ?? "{}")) });
    return respond();
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "request-id": "req_test" } });

describe("feature flag", () => {
  const base: FlagInputs = { env: undefined, search: "", stored: null, dev: false, hostname: "card-studio.pages.dev" };
  it("is off by default, in dev and in builds", () => {
    expect(resolveDescribeFlag(base).enabled).toBe(false);
    expect(resolveDescribeFlag({ ...base, dev: true, hostname: "localhost" }).enabled).toBe(false);
  });
  it("turns on with the build flag", () => {
    expect(resolveDescribeFlag({ ...base, env: "1" }).enabled).toBe(true);
    expect(resolveDescribeFlag({ ...base, env: "true" }).enabled).toBe(true);
    expect(resolveDescribeFlag({ ...base, env: "0" }).enabled).toBe(false);
  });
  it("honours the URL / stored override only locally", () => {
    expect(resolveDescribeFlag({ ...base, search: "?describe-finish=1", stored: "1" }).enabled).toBe(false);
    const local = { ...base, hostname: "localhost" };
    expect(resolveDescribeFlag({ ...local, search: "?describe-finish" })).toEqual({ enabled: true, store: "1" });
    expect(resolveDescribeFlag({ ...local, stored: "1" }).enabled).toBe(true);
    expect(resolveDescribeFlag({ ...local, search: "?describe-finish=0", stored: "1" })).toEqual({ enabled: false, store: null });
    expect(resolveDescribeFlag({ ...base, dev: true, hostname: "192.168.1.5", search: "?describe-finish=1" }).enabled).toBe(true);
  });
});

describe("Anthropic provider (bring your own key)", () => {
  it("builds the request: model, thinking, effort, structured output, cached system prompt, fallbacks", () => {
    const p = buildMessageParams({ description: "brushed rose gold", current: { cardholderName: "Grace Hopper" } });
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.max_tokens).toBe(FINISH_MAX_TOKENS);
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.output_config).toEqual({ effort: "medium", format: { type: "json_schema", schema: FINISH_OUTPUT_SCHEMA } });
    expect(p.betas).toEqual([FALLBACK_BETA]);
    expect(p.fallbacks).toBe("default");
    expect(p.system).toEqual([{ type: "text", text: finishSystemPrompt(), cache_control: { type: "ephemeral" } }]);
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0].role).toBe("user");
    expect(p.messages[0].content).toMatch(/brushed rose gold[\s\S]*"Grace Hopper"/);
    expect("temperature" in p).toBe(false);
  });

  it("sends the key, version and browser-access headers to the Messages API, and parses the answer", async () => {
    const { fetch, calls } = mockFetch(() => json(200, apiMessage()));
    const provider = createAnthropicProvider({ apiKey: KEY, fetch, maxRetries: 0 });
    const answer = await provider.generate({ description: "champagne gold" });
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages(\?beta=true)?$/);
    // SDK 1.x sends the key as a bearer credential (older releases: x-api-key).
    expect([c.headers.get("x-api-key"), c.headers.get("authorization")]).toContain(c.headers.get("x-api-key") ? KEY : `Bearer ${KEY}`);
    expect(c.headers.get("anthropic-version")).toBeTruthy();
    expect(c.headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(c.headers.get("anthropic-beta")).toContain(FALLBACK_BETA);
    expect(c.body.model).toBe(FINISH_MODEL);
    expect(c.body).not.toHaveProperty("betas");
    expect(c.body.fallbacks).toBe("default");
    expect(answer.summary).toBe("Champagne gold.");
    expect(answer.design).toEqual(DESIGN);
    expect(provider.label).toContain("sk-ant-…wxyz");
    expect(provider.label).not.toContain(KEY);
  });

  it("maps API errors to messages for the dialog", async () => {
    const run = async (res: () => Response) =>
      createAnthropicProvider({ apiKey: KEY, fetch: mockFetch(res).fetch, maxRetries: 0 })
        .generate({ description: "x" })
        .catch((e: unknown) => e);
    const auth = await run(() => json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
    expect(auth).toBeInstanceOf(FinishProviderError);
    expect((auth as FinishProviderError).kind).toBe("auth");
    const rate = await run(() => json(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }));
    expect((rate as FinishProviderError).kind).toBe("rate-limit");
    const bad = await run(() => json(400, { type: "error", error: { type: "invalid_request_error", message: "bad schema" } }));
    expect((bad as FinishProviderError).kind).toBe("bad-request");
    expect((bad as Error).message).toContain("bad schema");
    const down = await run(() => json(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    expect((down as FinishProviderError).kind).toBe("server");
    const net = await createAnthropicProvider({
      apiKey: KEY,
      maxRetries: 0,
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch,
    })
      .generate({ description: "x" })
      .catch((e: unknown) => e);
    expect((net as FinishProviderError).kind).toBe("network");
  });

  it("handles refusals, truncation and unparseable answers", () => {
    const msg = (over: Record<string, unknown>) => apiMessage(over) as never;
    expect(() => answerFromMessage(msg({ stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: "no" } }))).toThrow(
      FinishProviderError,
    );
    expect(() => answerFromMessage(msg({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"summary":"' }] }))).toThrow(FinishOutputError);
    expect(() => answerFromMessage(msg({ content: [{ type: "text", text: "Sure! Here it is" }] }))).toThrow(FinishOutputError);
  });
});

describe("proxy provider", () => {
  it("posts the description and reads the structured answer", async () => {
    const { fetch, calls } = mockFetch(() => new Response(ANSWER, { status: 200 }));
    const p = createProxyProvider("https://describe.example.workers.dev/finish", fetch);
    const a = await p.generate({ description: "rose gold", retry: { designJson: "{}", errors: ["e"] } });
    expect(calls[0].url).toBe("https://describe.example.workers.dev/finish");
    expect(calls[0].body).toEqual({ version: 1, description: "rose gold", retry: { designJson: "{}", errors: ["e"] } });
    expect(a.design).toEqual(DESIGN);
  });
  it("reports the proxy's error message and status", async () => {
    const p = createProxyProvider("https://x.test/", mockFetch(() => json(429, { error: "Slow down" })).fetch);
    await expect(p.generate({ description: "x" })).rejects.toMatchObject({ kind: "rate-limit", status: 429, message: "Slow down" });
    const q = createProxyProvider("https://x.test/", mockFetch(() => new Response("oops", { status: 502 })).fetch);
    await expect(q.generate({ description: "x" })).rejects.toMatchObject({ kind: "server", message: "The model service failed (HTTP 502)." });
  });
});

describe("the describe-a-finish flow", () => {
  const fake = (answers: (string | Error)[]) => {
    const inputs: unknown[] = [];
    const provider: FinishProvider = {
      id: "proxy",
      label: "fake",
      generate: async (input) => {
        inputs.push(input);
        const a = answers.shift()!;
        if (a instanceof Error) throw a;
        const o = JSON.parse(a);
        return { summary: o.summary, design: JSON.parse(o.design_json), designJson: o.design_json };
      },
    };
    return { provider, inputs };
  };
  const bad = JSON.stringify({ summary: "bad", design_json: JSON.stringify({ recipe: { material: "gold" }, cardholderName: "x" }) });

  it("retries once with the validation errors, then applies", async () => {
    const { provider, inputs } = fake([bad, ANSWER]);
    const r = await describeFinish({ provider, description: "gold", validate: (raw) => validateFinish(raw) });
    expect(r.attempts).toBe(2);
    expect(r.design.recipe.holoStyle).toBe("shiny");
    expect(inputs[1]).toMatchObject({ description: "gold", retry: { errors: [expect.stringContaining('recipe.material: "gold" is not one of')] } });
  });

  it("retries an unparseable answer, and gives up after the last attempt", async () => {
    const out = fake([new FinishOutputError("the answer was not JSON", "Sure!"), bad]);
    await expect(describeFinish({ provider: out.provider, description: "x", validate: (raw) => validateFinish(raw) })).rejects.toBeInstanceOf(
      FinishValidationError,
    );
    expect(out.inputs[1]).toMatchObject({ retry: { designJson: "Sure!", errors: ["the answer was not JSON"] } });
  });

  it("does not retry provider errors", async () => {
    const { provider, inputs } = fake([new FinishProviderError("auth", "nope"), ANSWER]);
    await expect(describeFinish({ provider, description: "x", validate: (raw) => validateFinish(raw) })).rejects.toBeInstanceOf(FinishProviderError);
    expect(inputs).toHaveLength(1);
  });

  it("adds WGSL compile errors from the host", async () => {
    const design = {
      recipe: {},
      cardholderName: "x",
      shaders: [{ id: "custom", language: "wgsl", side: "front", target: "skin", code: "fn mainImage(uv: vec2f) -> vec4f { return vec4f(nope); }" }],
    };
    const v = await validateFinish(design, async () => [{ line: 1, message: "unresolved value 'nope'" }]);
    expect(v.errors).toEqual(["shaders[0].code:1: unresolved value 'nope'"]);
  });

  it("keeps the current card's uploads", () => {
    const current: CardDesign = {
      ...defaultDesign(),
      decals: [{ id: "s", side: "front", src: "data:image/png;base64,AA", aspect: 1, x: 1, y: 2, width: 3, rotation: 0, scale: 1 }],
      surfaceSources: { back: "data:image/png;base64,BB" },
      surfaceTreatments: { back: "printed" },
      logo: { src: "data:image/png;base64,CC" },
    };
    const next = mergeUploads(defaultDesign(), current);
    expect(next.decals).toEqual(current.decals);
    expect(next.surfaceSources).toEqual({ back: "data:image/png;base64,BB" });
    expect(next.logo).toEqual({ src: "data:image/png;base64,CC" });
  });
});

describe("helpers", () => {
  it("masks keys and checks their shape", () => {
    expect(maskApiKey(KEY)).toBe("sk-ant-…wxyz");
    expect(maskApiKey("short")).toBe("••••");
    expect(looksLikeApiKey(KEY)).toBe(true);
    expect(looksLikeApiKey("hello")).toBe(false);
  });
  it("writes the Claude Code command", () => {
    expect(skillCommand("  brushed\n rose gold ")).toBe("/describe-finish brushed rose gold");
    expect(skillCommand("")).toMatch(/^\/describe-finish \w/);
  });
});
