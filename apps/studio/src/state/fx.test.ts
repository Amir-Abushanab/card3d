import { describe, expect, it } from "vitest";
import { defaultDesign } from "./design.ts";
import { stillDesign } from "./fx.ts";

describe("stills", () => {
  it("freezes live face shader layers, the shine sweep and the vines cycle, never over an explicit time", () => {
    const d = {
      ...defaultDesign(),
      shaders: [
        { id: "oil-slick", side: "front" as const, target: "overlay" as const },
        { id: "thermal", side: "front" as const, target: "skin" as const, time: 3 },
      ],
      addons: { shine: {}, vines: {} },
    };
    const s = stillDesign(d, 8.5, { vinesTime: 4 });
    expect(s.shaders?.map((l) => l.time)).toEqual([8.5, 3]);
    expect(s.addons?.vines?.time).toBe(4);
    expect(s.addons?.shine?.time).toBe(8.5);
    expect(stillDesign({ ...d, addons: { shine: { time: 2 } } }, 8.5).addons?.shine?.time).toBe(2);
    expect(stillDesign(d, 8.5, { vinesGrown: true }).addons?.vines).toEqual({ cycle: false });
    expect(d.shaders[0]).not.toHaveProperty("time");
  });
});
