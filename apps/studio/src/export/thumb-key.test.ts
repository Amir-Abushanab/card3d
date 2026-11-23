import { describe, expect, it } from "vitest";
import { hashString, stableStringify, thumbCacheKey, thumbVersion } from "./thumb-key.ts";

describe("stableStringify", () => {
  it("sorts keys at every level and matches JSON otherwise", () => {
    expect(stableStringify({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: "s" } })).toBe('{"a":{"c":"s","d":[3,{"x":2,"y":1}]},"b":1}');
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    const v = { s: 'q"uote', n: 1.5, t: true, z: null, arr: [1, "2", null] };
    expect(JSON.parse(stableStringify(v))).toEqual(v);
  });

  it("drops undefined/function members like JSON, keeps array slots as null", () => {
    expect(stableStringify({ a: undefined, b: () => 1, c: 1 })).toBe('{"c":1}');
    expect(stableStringify([undefined, 1])).toBe("[null,1]");
    expect(stableStringify(Number.NaN)).toBe("null");
  });

  it("rejects cycles but allows repeated (non-circular) references", () => {
    const shared = { x: 1 };
    expect(stableStringify({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
    const c: Record<string, unknown> = {};
    c.self = c;
    expect(() => stableStringify(c)).toThrow(/circular/);
  });
});

describe("hashString", () => {
  it("is deterministic, 14 hex digits, and sensitive to every character", () => {
    expect(hashString("card")).toBe(hashString("card"));
    expect(hashString("card")).toMatch(/^[0-9a-f]{14}$/);
    expect(hashString("card")).not.toBe(hashString("cars"));
    expect(hashString("")).toMatch(/^[0-9a-f]{14}$/);
    expect(hashString("a", 1)).not.toBe(hashString("a", 2));
  });

  it("does not collide on a few thousand similar inputs", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(hashString(`{"recipe":{"color":"#${i.toString(16).padStart(6, "0")}"}}`));
    expect(seen.size).toBe(5000);
  });
});

describe("thumbCacheKey", () => {
  const design = { recipe: { material: "silver", color: "#d9d6cc" }, decals: [] };
  const version = thumbVersion({ renderer: 180, build: "abc", assets: "reference" });
  const key = thumbCacheKey({ design, width: 240, height: 150, version });

  it("ignores key order but not values", () => {
    expect(thumbCacheKey({ design: { decals: [], recipe: { color: "#d9d6cc", material: "silver" } }, width: 240, height: 150, version })).toBe(key);
    expect(thumbCacheKey({ design: { ...design, recipe: { ...design.recipe, color: "#d9d6cd" } }, width: 240, height: 150, version })).not.toBe(key);
  });

  it("changes with size, renderer, build, assets and format", () => {
    expect(thumbCacheKey({ design, width: 200, height: 150, version })).not.toBe(key);
    for (const v of [
      thumbVersion({ renderer: 181, build: "abc", assets: "reference" }),
      thumbVersion({ renderer: 180, build: "abd", assets: "reference" }),
      thumbVersion({ renderer: 180, build: "abc", assets: "public" }),
      thumbVersion({ renderer: 180, build: "abc", assets: "reference", format: 2 }),
    ]) {
      expect(thumbCacheKey({ design, width: 240, height: 150, version: v })).not.toBe(key);
    }
    expect(key).toMatch(/^t1-[0-9a-f]{14}$/);
  });
});
