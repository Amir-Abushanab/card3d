import { describe, expect, it } from "vitest";
import { FLOOR_GAP, resolveScene, stagingView } from "./staging-view.ts";
import { SCENE_ENVIRONMENTS } from "./environments.ts";
import { environmentUrl } from "./marketing/environment-files.ts";
import { ensureDesign, defaultDesign, cloneDesign } from "../design/design.ts";
import { sanitizeScene } from "../design/sanitize.ts";
import { cameraPathPose, cameraPathTime, CAMERA_PATHS, ease } from "./camera-paths.ts";

describe("scene staging", () => {
  it("an absent or inert scene resolves to null (the stage renders as before)", () => {
    expect(resolveScene(undefined)).toBeNull();
    expect(resolveScene({})).toBeNull();
    expect(resolveScene({ environment: "studio", environmentIntensity: 1, backdrop: "none" })).toBeNull();
    expect(resolveScene({ floor: {} })?.floor).toEqual({ reflectivity: 0.45, shadow: 0.6, blur: 0.35 });
    expect(resolveScene({ environment: "softbox" })).toMatchObject({ environment: "softbox", backdrop: "none", floor: null });
  });

  it("frames a floor below the card (portrait cards are taller)", () => {
    expect(stagingView({ scene: { environment: "softbox" } })).toBeNull();
    const v = stagingView({ scene: { floor: {} } })!;
    expect(v.floorY).toBeCloseTo(-2.125 / 2 - FLOOR_GAP, 6);
    expect(v.elevation).toBeGreaterThan(0);
    const p = stagingView({ scene: { floor: {} }, shape: { orientation: "portrait" } })!;
    expect(p.floorY).toBeCloseTo(-3.37 / 2 - FLOOR_GAP, 6);
    expect(stagingView({ scene: { backdrop: "sweep" } })?.distance).toBe(1);
  });

  it("sanitizes untrusted scenes: ids, URLs, clamps, defaults dropped", () => {
    expect(sanitizeScene({ environment: "studio" })).toBeUndefined();
    expect(
      sanitizeScene({ environment: "softbox", environmentIntensity: 9, environmentRotation: -30, backdrop: "sweep", backdropColor: "#ABCDEF", floor: true }),
    ).toEqual({
      environment: "softbox",
      environmentIntensity: 3,
      environmentRotation: 330,
      backdrop: "sweep",
      backdropColor: "#abcdef",
      floor: {},
    });
    expect(sanitizeScene({ environment: "https://example.com/hdri/room_1k.hdr" })?.environment).toBe("https://example.com/hdri/room_1k.hdr");
    expect(sanitizeScene({ environment: "javascript:alert(1)" })).toBeUndefined();
    expect(sanitizeScene({ environment: "https://example.com/x.png" })).toBeUndefined();
    expect(sanitizeScene({ backdrop: "disco", floor: { reflectivity: 2, shadow: -1 } })).toEqual({ floor: { reflectivity: 1, shadow: 0 } });
  });

  it("travels through ensureDesign and cloneDesign", () => {
    const d = ensureDesign({ ...defaultDesign(), scene: { environment: "loft", floor: { blur: 0.5 }, backdrop: "environment" } });
    expect(d.scene).toEqual({ environment: "loft", floor: { blur: 0.5 }, backdrop: "environment" });
    const c = cloneDesign(d);
    c.scene!.floor!.blur = 0.1;
    expect(d.scene!.floor!.blur).toBe(0.5);
  });

  it("maps every catalog environment to its file; URLs pass through, unknown ids don't", () => {
    for (const e of SCENE_ENVIRONMENTS) expect(environmentUrl(e.id)).toMatch(new RegExp(`/assets/environments/${e.id}\\.webp$`));
    expect(environmentUrl("studio")).toBeNull();
    expect(environmentUrl("nope")).toBeNull();
    expect(environmentUrl("/hdri/a.hdr", (s) => `https://cdn.test${s}`)).toBe("https://cdn.test/hdri/a.hdr");
  });
});

describe("camera paths", () => {
  it("spin is the original turntable; loops end where they start", () => {
    for (const t of [0, 0.25, 0.6]) {
      const p = cameraPathPose("spin", t, { pitch: -8, yaw: 0 });
      expect(p.card.yaw).toBeCloseTo(360 * t, 9);
      expect(p.card.pitch).toBeCloseTo(-8 + 4 * Math.sin(t * Math.PI * 2), 9);
      expect(p.camera).toEqual({ azimuth: 0, elevation: 0, distance: 1 });
    }
    for (const path of CAMERA_PATHS.filter((p) => p.loop)) {
      const a = cameraPathPose(path.id, 0);
      const b = cameraPathPose(path.id, 1);
      expect(b.card.lift).toBeCloseTo(a.card.lift, 9);
      expect((((b.camera.azimuth - a.camera.azimuth) % 360) + 360) % 360).toBeCloseTo(0, 9);
      expect((((b.card.yaw - a.card.yaw) % 360) + 360) % 360).toBeCloseTo(0, 9);
    }
  });

  it("one-shot paths reach their end pose on the last frame; flip reveal turns back to front", () => {
    expect(cameraPathTime("push-in", 49, 50)).toBe(1);
    expect(cameraPathTime("orbit", 49, 50)).toBeCloseTo(0.98, 9);
    expect(cameraPathPose("flip-reveal", 0).card.yaw).toBe(180);
    expect(cameraPathPose("flip-reveal", 1).card.yaw).toBeCloseTo(360, 9);
    expect(cameraPathPose("push-in", 0).camera.distance).toBeGreaterThan(cameraPathPose("push-in", 1).camera.distance);
  });

  it("easings are monotonic from 0 to 1", () => {
    for (const e of ["linear", "ease-in-out", "ease-out", "ease-in", "sine"] as const) {
      let prev = -1;
      for (let i = 0; i <= 20; i++) {
        const v = ease(e, i / 20);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
      expect(ease(e, 0)).toBeCloseTo(0, 12);
      expect(ease(e, 1)).toBeCloseTo(1, 12);
    }
  });
});
