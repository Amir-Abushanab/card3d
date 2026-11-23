/**
 * The self-hosted scene environments (`CardDesign.scene.environment` ids): metadata for pickers. The
 * files are `assets/environments/<id>.webp` (CC0 HDRIs from Poly Haven, re-encoded by
 * scripts/build-environments.mjs) and load only when a design uses one (the engine's `scene` chunk;
 * the URLs are in `./marketing/environment-files.ts`).
 */
/** One of the self-hosted HDRI environments (`assets/environments/<id>.webp`, CC0, from Poly Haven). */
export interface SceneEnvironment {
  id: string;
  label: string;
  description: string;
  /** Brightness so every environment exposes a card about like the studio rig (× `environmentIntensity`). */
  intensity: number;
  /** Default turn about the vertical axis, degrees (puts the light sources where a card catches them). */
  rotation: number;
  /** A CSS background suggesting the environment's light, for pickers (the image itself loads only when chosen). */
  swatch: string;
  /** The source on Poly Haven (CC0 1.0). */
  source: { title: string; url: string; author: string };
}

export const SCENE_ENVIRONMENTS: readonly SceneEnvironment[] = [
  {
    id: "softbox",
    label: "Softbox",
    description: "A small photo studio: two octabox softboxes and a white cyclorama under a black ceiling",
    intensity: 0.65,
    rotation: 330,
    swatch: "linear-gradient(180deg, #1d1d20 0%, #2b2b2e 38%, #f2f2f0 62%, #e8e8e6 100%)",
    source: { title: "Studio Small 09", url: "https://polyhaven.com/a/studio_small_09", author: "Sergej Majboroda" },
  },
  {
    id: "cyclorama",
    label: "Cyclorama",
    description: "Hard strobe light in a white cyclorama: crisp, bright highlights",
    intensity: 0.45,
    rotation: 180,
    swatch: "radial-gradient(circle at 60% 40%, #ffffff 0%, #d9d9d6 35%, #9a9a98 100%)",
    source: { title: "Cyclorama Hard Light", url: "https://polyhaven.com/a/cyclorama_hard_light", author: "Sergej Majboroda" },
  },
  {
    id: "loft",
    label: "Loft",
    description: "A bright white loft with a tall window and curved light strips",
    intensity: 0.5,
    rotation: 60,
    swatch: "linear-gradient(180deg, #f4f4f2 0%, #c9c6c0 45%, #ecebe8 100%)",
    source: { title: "Brown Photostudio 02", url: "https://polyhaven.com/a/brown_photostudio_02", author: "Sergej Majboroda" },
  },
  {
    id: "warm-hall",
    label: "Warm hall",
    description: "Late sun through tall windows, green and brick walls, a wooden floor",
    intensity: 0.6,
    rotation: 60,
    swatch: "linear-gradient(180deg, #e8dcc0 0%, #44604c 45%, #7a4a30 100%)",
    source: { title: "Photo Studio Loft Hall", url: "https://polyhaven.com/a/photo_studio_loft_hall", author: "Sergej Majboroda" },
  },
  {
    id: "sunset",
    label: "Sunset",
    description: "Golden hour on a waterfront: a low sun and a blue sky",
    intensity: 0.7,
    rotation: 120,
    swatch: "linear-gradient(180deg, #6f9fd8 0%, #b9c9dc 42%, #f3b46a 52%, #8a7d74 100%)",
    source: { title: "Venice Sunset", url: "https://polyhaven.com/a/venice_sunset", author: "Greg Zaal" },
  },
];

export const getSceneEnvironment = (id: string | null | undefined): SceneEnvironment | undefined => SCENE_ENVIRONMENTS.find((e) => e.id === id);
