/**
 * The loader's crash detection (wasm/loader.js): a "starting" mark left by a load that never finished
 * means WebGPU crashed the tab, but the mark of a start still in flight on this page (a second card
 * starting while the first is unconfirmed) is the page's own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdWebgpuStart, webgpuDistrusted } from "../wasm/loader.js";

const KEY = "card3d:webgpu";
let items: Map<string, string>;
const stored = () => items.get(KEY)?.split(":")[0] ?? null;

beforeEach(() => {
  items = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, String(v)),
    removeItem: (k: string) => void items.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("WebGPU start marks", () => {
  it("treats a mark no start of this page holds as a crash", () => {
    items.set(KEY, `starting:${Date.now()}`);
    expect(webgpuDistrusted()).toBe(true);
    expect(stored()).toBe("failed");
  });

  it("doesn't distrust WebGPU while this page's own start is in flight", () => {
    const first = holdWebgpuStart();
    expect(stored()).toBe("starting");
    expect(webgpuDistrusted()).toBe(false);
    const second = holdWebgpuStart();
    first();
    expect(stored()).toBe("starting"); // the second start isn't confirmed yet
    expect(webgpuDistrusted()).toBe(false);
    second();
    expect(stored()).toBeNull();
    expect(webgpuDistrusted()).toBe(false);
  });

  it("keeps a failure when another start is released later", () => {
    const a = holdWebgpuStart();
    const b = holdWebgpuStart();
    a(true);
    expect(stored()).toBe("failed");
    b();
    expect(stored()).toBe("failed");
    expect(webgpuDistrusted()).toBe(true);
  });

  it("releases once; a later failure (a lost device) still counts", () => {
    const a = holdWebgpuStart();
    a();
    a();
    expect(stored()).toBeNull();
    const b = holdWebgpuStart();
    a(true);
    expect(stored()).toBe("failed");
    b();
    expect(stored()).toBe("failed");
  });
});
