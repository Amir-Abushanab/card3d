import { describe, expect, it } from "vitest";
import { loopSeamFrames, loopSeamWeight } from "./exporters.ts";

describe("loop seam", () => {
  it("cross-fades only animated cards on looping paths", () => {
    expect(loopSeamFrames("spin", true, 120, 30)).toBe(15);
    expect(loopSeamFrames("spin", false, 120, 30)).toBe(0);
    expect(loopSeamFrames("push-in", true, 120, 30)).toBe(0);
    expect(loopSeamFrames("hover", true, 120, 30)).toBe(15);
  });

  it("is at most a third of the clip", () => {
    expect(loopSeamFrames("spin", true, 12, 30)).toBe(4);
    expect(loopSeamFrames("spin", true, 3, 30)).toBe(0);
  });

  it("rises evenly towards the frame after the last", () => {
    const m = 4;
    const w = Array.from({ length: m }, (_, j) => loopSeamWeight(j, m));
    expect(w[0]).toBeCloseTo(0.2);
    expect(w[m - 1]).toBeCloseTo(0.8);
    // Even steps, and the same step on to the first frame (weight 1).
    for (let j = 1; j < m; j++) expect(w[j]! - w[j - 1]!).toBeCloseTo(0.2);
    expect(1 - w[m - 1]!).toBeCloseTo(0.2);
  });
});
