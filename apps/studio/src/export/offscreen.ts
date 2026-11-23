/**
 * Offscreen card stages for exports and thumbnails, sized to the output, with the camera pulled back so
 * the whole card fits whatever the aspect ratio. The card engine draws them (`createOffscreenStage`,
 * `@card3d/core/engine`).
 */
import { cardFrameSize, createOffscreenStage, stagingView, type OffscreenStage } from "@card3d/core/engine";
import type { AssetProvider, CardDesign, Quality } from "@card3d/core/model";

/** A camera orbit around the framing target (camera paths): degrees, and a multiplier on the distance. */
interface CameraOrbit {
  azimuth: number;
  elevation: number;
  distance: number;
}

/** Card layout size in world units. */
const CARD_W = 3.37;
const CARD_H = 2.125;
/** The stage camera's vertical field of view, degrees (`DEFAULT_CAMERA`). */
export const CAMERA_FOV = 34;
/** A card's print area, world units (`cardFrameSize(design)`: portrait shapes stand it up). */
export interface CardSize {
  width: number;
  height: number;
}
const LANDSCAPE: CardSize = { width: CARD_W, height: CARD_H };

/** A unit quaternion (three's `Quaternion` fits). */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** `v` turned by the unit quaternion `q`. */
function rotate(q: Quat, x: number, y: number, z: number): [number, number, number] {
  // t = 2 q.xyz × v; v' = v + w t + q.xyz × t
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  return [x + q.w * tx + (q.y * tz - q.z * ty), y + q.w * ty + (q.z * tx - q.x * tz), z + q.w * tz + (q.x * ty - q.y * tx)];
}

/**
 * Camera distance at which the card (plus `margin`, a multiplier on its half-extents) fits the
 * frame for a vertical fov in degrees.
 */
export function fitDistance(aspect: number, fovDeg: number, margin: number, card: CardSize = LANDSCAPE): number {
  const tv = Math.tan(rad(fovDeg / 2));
  const byHeight = ((card.height / 2) * margin) / tv;
  const byWidth = ((card.width / 2) * margin) / (tv * Math.max(aspect, 1e-3));
  return Math.max(byHeight, byWidth);
}

/**
 * Smallest camera distance at which the card, posed by `q`, projects inside the frame with
 * `margin` (a multiplier on each corner's offset), accounting for perspective.
 */
function exactFitDistance(q: Quat, aspect: number, fovDeg: number, margin: number, card: CardSize = LANDSCAPE): number {
  const tv = Math.tan(rad(fovDeg / 2));
  const th = tv * aspect;
  let z = 0;
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const [px, py, pz] = rotate(q, (sx * card.width) / 2, (sy * card.height) / 2, sz * 0.03);
        z = Math.max(z, pz + (margin * Math.abs(px)) / th, pz + (margin * Math.abs(py)) / tv);
      }
  return z;
}

/** Euler (degrees) → quaternion, the same composition as the card interaction (pitch, yaw): three's XYZ. */
export function rotationQuaternion(pitchDeg: number, yawDeg: number, rollDeg = 0): Quat {
  const [c1, c2, c3] = [Math.cos(rad(pitchDeg) / 2), Math.cos(rad(yawDeg) / 2), Math.cos(rad(rollDeg) / 2)];
  const [s1, s2, s3] = [Math.sin(rad(pitchDeg) / 2), Math.sin(rad(yawDeg) / 2), Math.sin(rad(rollDeg) / 2)];
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  };
}

export interface FrameOptions {
  width: number;
  height: number;
  /** Card orientation (the live stage's root quaternion); identity when omitted. */
  quaternion?: Quat;
  /** Multiplier on the card's half-extents; 1.18 leaves a comfortable border. */
  margin?: number;
  /** "exact": fit this pose tightly (stills); "turntable": one distance that fits every yaw. */
  fit?: "exact" | "turntable";
  /**
   * Seconds the card's animations advance before this frame (video/GIF: 1/fps). Default 0: a
   * capture stage never runs its own clock, so stills and thumbnails are deterministic.
   */
  dt?: number;
  /** Camera orbit around the framing target (camera paths); none: the camera on its axis. */
  orbit?: CameraOrbit | null;
  /** Raise the card (camera paths' hover), card units. */
  lift?: number;
}

/**
 * The box a design's framing fits: its print area, or with a staged floor (the stage looks at a point
 * below the card: the reflection and shadow are in frame) a box from the card's top down past its
 * target, symmetrically.
 */
function framedSize(design: CardDesign): CardSize {
  const frame = cardFrameSize(design);
  const view = stagingView(design);
  return view ? { width: frame.width, height: 2 * (frame.height / 2 - view.targetY) } : frame;
}

/** The camera distance a frame asks for. */
function frameDistance(o: FrameOptions, size: CardSize, fov: number): number {
  const aspect = o.width / o.height;
  const margin = o.margin ?? 1.18;
  // A turntable sweeps every yaw: fit the card's diagonal-ish worst case (face-on width, plus the
  // near edge's perspective growth at ~35°) so the zoom stays constant through the spin.
  return o.fit === "turntable"
    ? Math.max(fitDistance(aspect, fov, margin * 1.08, size), exactFitDistance(rotationQuaternion(-12, 35), aspect, fov, margin, size))
    : exactFitDistance(o.quaternion ?? { x: 0, y: 0, z: 0, w: 1 }, aspect, fov, margin, size);
}

/** An offscreen stage that draws frames of one design at a time. */
export interface CaptureStage {
  /** Load a design (skipped when `key` matches the last call's key, e.g. the same design object). */
  setDesign(design: CardDesign, key?: unknown): Promise<void>;
  /** Size the output, orient the card, frame it and render synchronously: a canvas to copy at once. */
  frame(o: FrameOptions): HTMLCanvasElement;
  /**
   * Run the card's clocks forward by `seconds` without rendering (e.g. so a turntable video of a
   * growing-vines card starts where the live preview is). Call after `frame()` has posed the card.
   */
  prime(seconds: number): void;
  /** The card animates by itself (its frames depend on the clock). */
  readonly animated: boolean;
  /** Face shader layers of the current card that couldn't be built (custom code that doesn't compile). */
  shaderErrors(): ShaderLayerError[];
  dispose(): void;
}

/** A face shader layer that couldn't be built: its index in `CardDesign.shaders`, and its errors' lines in its own code. */
interface ShaderLayerError {
  index: number;
  side: string;
  errors: Array<{ line: number; message: string }>;
}

/** The card engine's offscreen stage. */
class EngineOffscreenStage implements CaptureStage {
  readonly stage: OffscreenStage;
  private designKey: unknown = null;
  private size: CardSize = LANDSCAPE;

  constructor(assets: AssetProvider, quality: Quality) {
    this.stage = createOffscreenStage({ quality, assets, resolveUrl: (s) => assets.resolveUrl(s) });
  }

  get animated(): boolean {
    return this.stage.animated;
  }

  async setDesign(design: CardDesign, key: unknown = design): Promise<void> {
    if (key !== null && key === this.designKey) return;
    this.designKey = key;
    this.size = framedSize(design);
    await this.stage.setDesign(design);
  }

  frame(o: FrameOptions): HTMLCanvasElement {
    return this.stage.frame({
      width: o.width,
      height: o.height,
      quaternion: o.quaternion,
      cameraDistance: frameDistance(o, this.size, CAMERA_FOV),
      orbit: o.orbit,
      lift: o.lift,
      dt: o.dt,
    });
  }

  prime(seconds: number): void {
    if (seconds > 0) this.stage.advance(seconds);
  }

  shaderErrors(): ShaderLayerError[] {
    return this.stage.shaderErrors();
  }

  dispose(): void {
    this.stage.dispose();
  }
}

/** Exports' and thumbnails' stage (print bakes and AR models build on its GPU too). */
export class ExportStage extends EngineOffscreenStage {}
