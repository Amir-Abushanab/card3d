/**
 * Camera paths for product videos: pure functions of normalised time t ∈ [0, 1] → a pose of the card
 * (rotation and lift) and of the camera (on a sphere around the card's framing target). Exporters
 * evaluate them per frame at fixed steps, so a clip is a function of its frame index alone.
 *
 * - spin: the card turns once on a turntable (with a gentle pitch bob): the classic export, unchanged.
 * - orbit: the camera circles the still card once, a little above it (a backdrop turns with it).
 * - push-in: a hero shot: the camera glides in and down while the card turns towards it.
 * - flip-reveal: the card starts on its back and flips over to its front, then settles.
 * - glint: a slow tilt that sweeps the light across the face.
 * - hover: the card floats, bobbing and swaying, in a seamless loop.
 */
export type CameraPathId = "spin" | "orbit" | "push-in" | "flip-reveal" | "glint" | "hover";
export type CameraEasing = "linear" | "ease-in-out" | "ease-out" | "ease-in" | "sine";

export interface CameraPath {
  id: CameraPathId;
  label: string;
  description: string;
  /** Ends where it starts (a seamless loop): sampled at i / n instead of i / (n − 1). */
  loop: boolean;
  /** The easing it reads best with. */
  easing: CameraEasing;
  /** A good clip length, seconds. */
  seconds: number;
}

export const CAMERA_PATHS: readonly CameraPath[] = [
  { id: "spin", label: "Spin", description: "The card turns once on a turntable", loop: true, easing: "linear", seconds: 4 },
  { id: "orbit", label: "Orbit", description: "The camera circles the card once, slightly above it", loop: true, easing: "linear", seconds: 6 },
  { id: "push-in", label: "Hero push-in", description: "The camera glides in while the card turns to face it", loop: false, easing: "ease-in-out", seconds: 4 },
  {
    id: "flip-reveal",
    label: "Flip reveal",
    description: "From the back, the card flips over to its front and settles",
    loop: false,
    easing: "ease-in-out",
    seconds: 3.5,
  },
  { id: "glint", label: "Glint pass", description: "A slow tilt sweeps the light across the face", loop: false, easing: "sine", seconds: 5 },
  { id: "hover", label: "Floating hover", description: "The card floats, bobbing and swaying, in a seamless loop", loop: true, easing: "linear", seconds: 4 },
];

export const CAMERA_EASINGS: readonly { id: CameraEasing; label: string }[] = [
  { id: "linear", label: "Linear" },
  { id: "ease-in-out", label: "Ease in-out" },
  { id: "ease-out", label: "Ease out" },
  { id: "ease-in", label: "Ease in" },
  { id: "sine", label: "Sine" },
];

export const getCameraPath = (id: string | null | undefined): CameraPath => CAMERA_PATHS.find((p) => p.id === id) ?? CAMERA_PATHS[0]!;

/** Easing curves on [0, 1] (cubic in / out / in-out, sine in-out). */
export function ease(e: CameraEasing, t: number): number {
  const x = Math.min(1, Math.max(0, t));
  switch (e) {
    case "ease-in":
      return x * x * x;
    case "ease-out":
      return 1 - Math.pow(1 - x, 3);
    case "ease-in-out":
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    case "sine":
      return -(Math.cos(Math.PI * x) - 1) / 2;
    default:
      return x;
  }
}

export interface CameraPathPose {
  /** Card rotation, degrees (Euler XYZ: pitch, yaw, roll, as the card interaction composes them), and lift (card units, up). */
  card: { pitch: number; yaw: number; roll: number; lift: number };
  /** Camera around the framing target: azimuth (degrees, about the vertical), extra elevation (degrees), distance multiplier. */
  camera: { azimuth: number; elevation: number; distance: number };
}

export interface CameraPathOptions {
  easing?: CameraEasing;
  /** The pose the clip starts from (the spin's base pitch / yaw), degrees. Default −8 / 0. */
  pitch?: number;
  yaw?: number;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const TAU = Math.PI * 2;

/** The pose at normalised time t (0 = first frame; 1 = the end, or the start again for loops). */
export function cameraPathPose(id: CameraPathId, t: number, o: CameraPathOptions = {}): CameraPathPose {
  const path = getCameraPath(id);
  const k = ease(o.easing ?? path.easing, t);
  const pitch0 = o.pitch ?? -8;
  const yaw0 = o.yaw ?? 0;
  const pose: CameraPathPose = { card: { pitch: pitch0, yaw: yaw0, roll: 0, lift: 0 }, camera: { azimuth: 0, elevation: 0, distance: 1 } };
  switch (path.id) {
    case "spin":
      // Exactly the original turntable: a full yaw turn with a gentle pitch bob.
      pose.card.yaw = yaw0 + 360 * k;
      pose.card.pitch = pitch0 + 4 * Math.sin(t * TAU);
      break;
    case "orbit":
      pose.card.pitch = 0;
      pose.camera.azimuth = 360 * k;
      pose.camera.elevation = 10 + 4 * Math.sin(t * TAU);
      break;
    case "push-in":
      pose.card.yaw = lerp(-32, -9, k);
      pose.card.pitch = lerp(-10, -4, k);
      pose.camera.azimuth = lerp(16, 3, k);
      pose.camera.elevation = lerp(12, 3, k);
      pose.camera.distance = lerp(1.5, 0.95, k);
      break;
    case "flip-reveal": {
      // Hold on the back, flip (with a dip of the pitch at the edge-on moment), settle.
      const f = Math.min(1, Math.max(0, (k - 0.12) / 0.7));
      const s = ease("ease-in-out", f);
      pose.card.yaw = 180 + 180 * s;
      pose.card.pitch = -6 - 10 * Math.sin(Math.PI * s);
      pose.card.lift = 0.12 * Math.sin(Math.PI * s);
      pose.camera.elevation = 4;
      pose.camera.distance = lerp(1.06, 0.98, k);
      break;
    }
    case "glint":
      pose.card.yaw = lerp(-24, 24, k);
      pose.card.pitch = lerp(10, -10, k);
      pose.card.roll = lerp(-2, 2, k);
      pose.camera.elevation = 3;
      pose.camera.distance = 0.96;
      break;
    case "hover": {
      const a = k * TAU;
      pose.card.lift = 0.07 * Math.sin(a);
      pose.card.yaw = 11 * Math.sin(a);
      pose.card.pitch = -5 + 3 * Math.sin(2 * a);
      pose.card.roll = 2.5 * Math.cos(a);
      pose.camera.elevation = 4;
      break;
    }
  }
  return pose;
}

/** Normalised time of frame `i` of `frames` (loops never repeat their first frame at the end). */
export function cameraPathTime(id: CameraPathId, i: number, frames: number): number {
  if (frames <= 1) return 0;
  return getCameraPath(id).loop ? i / frames : i / (frames - 1);
}
