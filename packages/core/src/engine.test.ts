/**
 * The page side of the engine's offscreen stage: the card's pose reaches the engine as Euler XYZ angles
 * (the slot's rotation), so `quaternionToEuler` must give back the angles three composes a quaternion from.
 */
import { describe, expect, it } from "vitest";
import { cleanShaderMessage, engineDraws, quaternionToEuler } from "./engine.ts";
import { ensureDesign } from "./design/design.ts";

/** three's `Quaternion.setFromEuler(new Euler(x, y, z, "XYZ"))`. */
function fromEuler(x: number, y: number, z: number) {
  const [c1, c2, c3] = [Math.cos(x / 2), Math.cos(y / 2), Math.cos(z / 2)];
  const [s1, s2, s3] = [Math.sin(x / 2), Math.sin(y / 2), Math.sin(z / 2)];
  return { x: s1 * c2 * c3 + c1 * s2 * s3, y: c1 * s2 * c3 - s1 * c2 * s3, z: c1 * c2 * s3 + s1 * s2 * c3, w: c1 * c2 * c3 - s1 * s2 * s3 };
}

describe("quaternionToEuler", () => {
  it("inverts three's XYZ composition", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let k = 0; k < 500; k++) {
      const e = [rnd() * Math.PI, rnd() * 1.5, rnd() * Math.PI] as const;
      const got = quaternionToEuler(fromEuler(...e));
      for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(e[i], 9);
    }
    for (const v of quaternionToEuler({ x: 0, y: 0, z: 0, w: 1 })) expect(Math.abs(v)).toBe(0);
  });

  it("keeps the rotation at gimbal lock (yaw ±90°)", () => {
    const q = fromEuler(0.3, Math.PI / 2, 0);
    const [x, y, z] = quaternionToEuler(q);
    const back = fromEuler(x, y, z);
    // Same rotation (up to the quaternion's sign).
    const dot = Math.abs(q.x * back.x + q.y * back.y + q.z * back.z + q.w * back.w);
    expect(dot).toBeCloseTo(1, 6);
  });
});

describe("engineDraws", () => {
  const recipe = { material: "silver", texture: "brushed", color: "#d9d6cc" };
  it("draws a legacy design's keys it no longer knows as the standard card", () => {
    const legacy = { recipe, frontEffect: "glow", objectStyle: "widget", bespoke: "gadget", bespokeParams: { a: 1 }, effectParams: { b: 2 } };
    const design = ensureDesign(legacy);
    for (const k of ["frontEffect", "objectStyle", "bespoke", "bespokeParams", "effectParams"]) expect(k in design, k).toBe(false);
    expect(engineDraws(design)).toBe(true);
  });
  it("still leaves custom GLSL face layers to three.js", () => {
    const design = ensureDesign({ recipe, shaders: [{ id: "custom", code: "vec4 mainImage(vec2 uv) { return vec4(1.0); }" }] });
    expect(engineDraws(design)).toBe(false);
  });
  it("takes face shader overlays on glass cards", () => {
    const design = ensureDesign({
      recipe: { material: "glass", color: "#c5dde4" },
      shaders: [{ id: "oil-slick", side: "front", target: "overlay", blend: "screen" }],
    });
    expect(engineDraws(design)).toBe(true);
  });
});

describe("cleanShaderMessage", () => {
  it("keeps naga's message without the module's name and source diagram", () => {
    const naga =
      "\nShader 'face shader check' parsing error: no definition in scope for identifier: `undefinedThing`\n   ┌─ wgsl:90:16\n   │\n90 │   let broken = undefinedThing * 2.0;\n   │                ^^^^^^^^^^^^^^ unknown identifier\n\n";
    expect(cleanShaderMessage(naga)).toBe("no definition in scope for identifier: `undefinedThing`");
    expect(cleanShaderMessage("unresolved value 'undefinedThing'")).toBe("unresolved value 'undefinedThing'");
  });
});
