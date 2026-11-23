/**
 * Lighting / backdrop presets for the single-card stage and the marquee. A preset retunes the studio
 * rig without replacing it: the environment's Lightformer panels (scaled and tinted by role, the
 * whole environment optionally turned), the punctual lights, the exposure, plus a backdrop for the
 * page / exported images (the canvas itself stays transparent).
 *
 * "studio" is the identity: the stage and the marquee render exactly as without a preset (the
 * comparison renders and every existing design are unchanged).
 */
import type { LightingPresetId } from "../types.ts";
import { STUDIO_LIGHTS, TONE_MAPPING_EXPOSURE } from "./light-values.ts";

/** How a preset reshapes the environment (`createStudioEnvironment`'s `look`). Multipliers default to 1. */
export interface EnvironmentLook {
  /** The key panels: L3 (key softbox) and L4 (hot strip). */
  key?: number;
  /** The fill panels: L2 (left softbox), L7 (top ring), L8 (low bar). */
  fill?: number;
  /** The dim surround: L1 (front backdrop) and L6 (rear fill). */
  base?: number;
  /** Colour multiplied into the key panels. */
  keyTint?: string;
  /** Colour multiplied into the fill and surround panels. */
  fillTint?: string;
  /**
   * Extra narrow, very bright panels outside the cone a flat face reflects (so a face-on card looks the
   * same): strips behind the card (left, right, top) that its bevel and edges catch at grazing angles,
   * and strips about 60° off-axis that the embossed name and mark's edges catch. Black metal reflects
   * only a percent or two, so only panels this bright give a dark card its silhouette and lettering.
   */
  rim?: { intensity: number; color?: string };
}

/**
 * How a preset grades an HDRI scene environment (`CardDesign.scene.environment`), which has no panels
 * to retune (`marketing/grade.ts`). The rig's roles, found in the HDRI: the key (its strongest light
 * source and whatever lies within ~50° of it), the fill (its other light sources: the brightest 0.5 %
 * of the sphere) and the base (the room: the 90 % below), blended smoothly in between. Each gets a gain;
 * the key the look's `keyTint`, fill and base its `fillTint`. The look's rim panels stand in front of
 * the HDRI. The punctual lights and exposure apply as on the rig. Gains default to 1.
 */
export interface EnvironmentGrade {
  key?: number;
  fill?: number;
  base?: number;
  /** Colour multiplied into the key (default: the look's `keyTint`). */
  keyTint?: string;
  /** Colour multiplied into the fill and the base (default: the look's `fillTint`). */
  fillTint?: string;
  /** 1 = unchanged. */
  saturation?: number;
  /** × the look's rim panels (`env.rim`); default 1, 0 = none. */
  rim?: number;
  /** Degrees added to the environment's rotation (as the rig's `envRotationY` turns its panels). */
  turn?: number;
}

export interface LightingBackdrop {
  /** Gradient: `inner` at the glow centre, `outer` at the edges. */
  inner: string;
  outer: string;
  /** Glow centre, 0..1 of the frame (x, y from the top left). */
  at: [number, number];
  /** Text on this backdrop should be light. */
  dark: boolean;
}

export interface LightingPreset {
  id: LightingPresetId;
  label: string;
  description: string;
  env: EnvironmentLook;
  /** The look on an HDRI environment; absent (studio) = the HDRI as it is. */
  hdri?: EnvironmentGrade;
  /** Environment intensity (`scene.environmentIntensity`) and rotation about Y, radians. */
  envIntensity: number;
  envRotationY: number;
  ambient: { color: string; intensity: number };
  key: { color: string; intensity: number; position: [number, number, number] };
  /** Multiplier on the marquee's frontal fill light (the single-card stage has none). */
  frontFill: number;
  exposure: number;
  backdrop: LightingBackdrop;
}

const STUDIO: LightingPreset = {
  id: "studio",
  label: "Studio",
  description: "The neutral softbox studio every card is tuned in",
  env: {},
  envIntensity: 1,
  envRotationY: 0,
  ambient: { ...STUDIO_LIGHTS.ambient },
  key: { ...STUDIO_LIGHTS.key, position: [...STUDIO_LIGHTS.key.position] },
  frontFill: 1,
  exposure: TONE_MAPPING_EXPOSURE,
  backdrop: { inner: "#3a3d4d", outer: "#0b0b10", at: [0.55, 0.42], dark: true },
};

export const LIGHTING_PRESETS: readonly LightingPreset[] = [
  STUDIO,
  {
    id: "dramatic",
    label: "Dramatic",
    description: "One hard strip from the side, deep shadows, a spotlit backdrop",
    // The panels turn a little off the camera's reflection line and the fills drop well below the key:
    // a face-on card sits in low light with the key raking along one side, tilting sweeps it across,
    // and the rim panels keep dark finishes' edges, mark and name.
    env: { key: 1.5, fill: 0.4, base: 0.6, rim: { intensity: 12, color: "#e6ecff" } },
    hdri: { key: 1.6, fill: 0.25, base: 0.35, turn: 15 },
    envIntensity: 1,
    envRotationY: 0.15,
    // Enough ambient and fill that matte dark finishes (diffuse) keep their name and mark.
    ambient: { color: "#ffffff", intensity: 0.22 },
    key: { color: "#ffffff", intensity: 0.7, position: [-7, 3, 3] },
    frontFill: 1,
    exposure: 1,
    backdrop: { inner: "#454a62", outer: "#040407", at: [0.6, 0.4], dark: true },
  },
  {
    id: "warm",
    label: "Warm",
    description: "Late-afternoon softboxes: amber key, peach fill",
    env: { key: 1.05, fill: 1.05, keyTint: "#ffe0bd", fillTint: "#ffeedc", rim: { intensity: 8, color: "#ffd9b0" } },
    hdri: { key: 1.1, fill: 1.1, base: 1.05 },
    envIntensity: 1,
    envRotationY: 0.12,
    ambient: { color: "#ffe6cc", intensity: 0.38 },
    key: { color: "#ffd2a0", intensity: 0.45, position: [-5, 4, 6] },
    frontFill: 1,
    exposure: 0.95,
    backdrop: { inner: "#4a3328", outer: "#120b08", at: [0.5, 0.4], dark: true },
  },
  {
    id: "cool",
    label: "Cool",
    description: "Overcast daylight: icy key, steel-blue fill",
    env: { key: 1.05, fill: 1.15, keyTint: "#d4e6ff", fillTint: "#bcd3f2", rim: { intensity: 8, color: "#cfe0ff" } },
    hdri: { key: 1.2, fill: 1.25, base: 1.2 },
    envIntensity: 1,
    envRotationY: -0.12,
    ambient: { color: "#d6e4ff", intensity: 0.38 },
    key: { color: "#c4dcff", intensity: 0.42, position: [-4, 6, 6] },
    frontFill: 1,
    exposure: 0.93,
    backdrop: { inner: "#22324a", outer: "#060a12", at: [0.5, 0.36], dark: true },
  },
  {
    id: "dark",
    label: "Dark",
    description: "Low key: dim panels and a black stage for bright metals",
    env: { key: 0.85, fill: 0.45, base: 0.5, rim: { intensity: 10 } },
    hdri: { key: 0.6, fill: 0.4, base: 0.35 },
    envIntensity: 0.9,
    envRotationY: 0,
    ambient: { color: "#ffffff", intensity: 0.24 },
    key: { color: "#ffffff", intensity: 0.3, position: [-4, 5, 7] },
    frontFill: 0.9,
    exposure: 0.92,
    backdrop: { inner: "#18181d", outer: "#000000", at: [0.5, 0.45], dark: true },
  },
  {
    id: "light",
    label: "Light",
    description: "High key: a bright white sweep and soft, even fill",
    env: { key: 0.9, fill: 1.5, base: 14 },
    hdri: { key: 1.5, fill: 1.9, base: 2.2, saturation: 0.9 },
    envIntensity: 1.05,
    envRotationY: 0,
    ambient: { color: "#ffffff", intensity: 0.55 },
    key: { color: "#ffffff", intensity: 0.4, position: [-3, 6, 7] },
    frontFill: 1.2,
    exposure: 0.95,
    backdrop: { inner: "#ffffff", outer: "#d5d8df", at: [0.5, 0.4], dark: false },
  },
];

export const DEFAULT_LIGHTING: LightingPresetId = "studio";

export function getLightingPreset(id: string | null | undefined): LightingPreset {
  return LIGHTING_PRESETS.find((p) => p.id === id) ?? STUDIO;
}

/** True for the identity preset (nothing to change). */
export const isStudioLighting = (id: string | null | undefined): boolean => getLightingPreset(id).id === "studio";

/** The backdrop as a CSS `background` value. */
export function lightingBackdropCss(id: string | null | undefined): string {
  const b = getLightingPreset(id).backdrop;
  return `radial-gradient(120% 110% at ${b.at[0] * 100}% ${b.at[1] * 100}%, ${b.inner} 0%, ${b.outer} 100%)`;
}

/** Paint the backdrop into a 2D context (exports: images, video and GIF frames). */
export function paintLightingBackdrop(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  w: number,
  h: number,
  id: string | null | undefined,
): void {
  const b = getLightingPreset(id).backdrop;
  const cx = b.at[0] * w;
  const cy = b.at[1] * h;
  // CSS "120% 110%" ellipse to the farthest corner, approximated by a circle scaled to the frame.
  const r = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) * 1.15;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, b.inner);
  g.addColorStop(1, b.outer);
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}
