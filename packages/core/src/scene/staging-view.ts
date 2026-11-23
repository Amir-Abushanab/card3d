/**
 * Product-shot staging (`CardDesign.scene`): the parts every bundle carries. They are small and pure:
 * the resolved defaults and the framing a staged card gets (the environment catalog for pickers is
 * `./environments.ts`). The renderer side (HDRI decoding, backdrops, the reflective floor) is the
 * engine's `scene` chunk (crates/card3d-engine/src/scene.rs), downloaded only when a design has a scene.
 */
import type { CardDesign, CardFloor, CardScene, SceneBackdrop } from "../types.ts";
import { cardFrameSize } from "../geometry/shape-frame.ts";

export const SCENE_BACKDROPS: readonly SceneBackdrop[] = ["none", "sweep", "gradient", "environment"];

/** Clamp ranges of the scene's numbers (`sanitizeScene`, the studio's sliders). */
export const SCENE_RANGES = {
  environmentIntensity: [0.25, 3],
  environmentRotation: [0, 360],
  backdropBlur: [0, 1],
  reflectivity: [0, 1],
  shadow: [0, 1],
  floorBlur: [0, 1],
} as const;

export const SCENE_DEFAULTS = {
  environmentIntensity: 1,
  environmentRotation: 0,
  backdropBlur: 0.45,
  floor: { reflectivity: 0.45, shadow: 0.6, blur: 0.35 } satisfies Required<CardFloor>,
} as const;

/** A scene with every default filled in. */
export interface ResolvedScene {
  /** "studio" or an environment id / URL. */
  environment: string;
  environmentIntensity: number;
  environmentRotation: number;
  backdrop: SceneBackdrop;
  backdropColor: string | null;
  backdropBlur: number;
  floor: Required<CardFloor> | null;
}

/**
 * The scene with defaults, or null when it changes nothing (absent, or the studio environment at its
 * own intensity with no backdrop and no floor): then a host renders exactly as without one.
 */
export function resolveScene(scene: CardScene | null | undefined): ResolvedScene | null {
  if (!scene) return null;
  const r: ResolvedScene = {
    environment: scene.environment && scene.environment !== "studio" ? scene.environment : "studio",
    environmentIntensity: scene.environmentIntensity ?? SCENE_DEFAULTS.environmentIntensity,
    environmentRotation: scene.environmentRotation ?? SCENE_DEFAULTS.environmentRotation,
    backdrop: scene.backdrop ?? "none",
    backdropColor: scene.backdropColor ?? null,
    backdropBlur: scene.backdropBlur ?? SCENE_DEFAULTS.backdropBlur,
    floor: scene.floor ? { ...SCENE_DEFAULTS.floor, ...scene.floor } : null,
  };
  const inert = r.environment === "studio" && r.environmentIntensity === 1 && r.environmentRotation === 0 && r.backdrop === "none" && !r.floor;
  return inert ? null : r;
}

/** Gap between the card's lower edge and the floor (card units: the card floats ~1.5 mm above it). */
export const FLOOR_GAP = 0.06;

/**
 * How a staged card is framed: with a floor or a sweep the camera rises a little and looks slightly
 * down at a point below the card's centre (so the reflection and the contact shadow are in frame),
 * from `distance` × the host's own distance. Null when the scene needs no change of camera.
 */
export interface StagingView {
  /** Camera elevation above the target, radians. */
  elevation: number;
  /** World y the camera looks at. */
  targetY: number;
  /** Multiplier on the host's camera distance. */
  distance: number;
  /** World y of the floor (null: no floor). */
  floorY: number | null;
}

export function stagingView(design: Pick<CardDesign, "scene" | "shape">): StagingView | null {
  const scene = resolveScene(design.scene);
  if (!scene || (!scene.floor && scene.backdrop !== "sweep")) return null;
  const frame = cardFrameSize(design);
  const floorY = -frame.height / 2 - FLOOR_GAP;
  return {
    elevation: (9 * Math.PI) / 180,
    targetY: scene.floor ? -frame.height * 0.16 : 0,
    distance: scene.floor ? 1.12 : 1,
    floorY,
  };
}

/**
 * Name of the staging backdrop's group (hosts orbiting the camera turn it to face the camera).
 * @archive the local three.js archive (.archive/three-engine) imports it
 */
export const STAGING_BACKDROP_NAME = "card3d staging backdrop";
