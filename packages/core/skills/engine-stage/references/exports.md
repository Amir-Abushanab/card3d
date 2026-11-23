# Exports: images, video frames, AR models, print rasters

All of these run in the browser on the card engine (they need a GPU context). Card Studio's own
encoders (WebM / MP4 / GIF, the print PDF and plate package) are not in the package: the package gives
you frames, models and rasters.

## Images and thumbnails

```ts
import { createOffscreenStage, ensureDesign } from "@card3d/core";

const off = createOffscreenStage({ quality: "full" });
try {
  await off.setDesign(ensureDesign({ recipe: { material: "nickel", color: "#151715" }, cardholderName: "Ada Lovelace" }));
  const png = await off.frameBlob({ width: 1600, height: 1000 }); // PNG, transparent around the card
  const webp = await off.frameBlob({ width: 480, height: 300 }, "image/webp", 0.9);
  console.log(png.size, webp.size);
} finally {
  off.dispose();
}
```

- One offscreen stage can draw many designs in turn: `setDesign`, then frames.
- `quaternion` turns the card, `orbit` moves the camera, `lift` raises the card, `cameraDistance`
  frames it yourself. Without them the card faces the camera at the stage's own framing.
- Clocks stand still unless a frame asks for `dt` (seconds): the same calls give the same pixels.
  `advance(seconds)` runs them without drawing (e.g. let vines grow before a still).

## Video frames along a camera path

`CAMERA_PATHS`: `spin`, `orbit`, `push-in`, `flip-reveal`, `glint`, `hover` (each with a suggested
length and easing). Pose each frame and step the clocks by 1/fps; encode the frames yourself
(WebCodecs `VideoEncoder`, or `MediaRecorder` on a canvas).

```ts
import { cameraPathPose, cameraPathTime, getCameraPath, type CameraPathId, type CardQuaternion, type OffscreenStage } from "@card3d/core";

/** Euler XYZ (degrees, as the camera paths give them) → the quaternion `frame` takes. */
function rotationQuaternion(pitchDeg: number, yawDeg: number, rollDeg = 0): CardQuaternion {
  const r = (d: number) => (d * Math.PI) / 360; // half-angle, radians
  const [c1, c2, c3] = [Math.cos(r(pitchDeg)), Math.cos(r(yawDeg)), Math.cos(r(rollDeg))];
  const [s1, s2, s3] = [Math.sin(r(pitchDeg)), Math.sin(r(yawDeg)), Math.sin(r(rollDeg))];
  return { x: s1 * c2 * c3 + c1 * s2 * s3, y: c1 * s2 * c3 - s1 * c2 * s3, z: c1 * c2 * s3 + s1 * s2 * c3, w: c1 * c2 * c3 - s1 * s2 * s3 };
}

async function renderClip(off: OffscreenStage, path: CameraPathId, fps = 30): Promise<Blob[]> {
  const frames = Math.round(getCameraPath(path).seconds * fps);
  const out: Blob[] = [];
  for (let i = 0; i < frames; i++) {
    const pose = cameraPathPose(path, cameraPathTime(path, i, frames));
    out.push(
      await off.frameBlob({
        width: 1280,
        height: 800,
        quaternion: rotationQuaternion(pose.card.pitch, pose.card.yaw, pose.card.roll),
        orbit: pose.camera,
        lift: pose.card.lift,
        dt: i === 0 ? 0 : 1 / fps,
      }),
    );
  }
  return out;
}
```

On a live stage the same pose is `stage.setRotation([pitch, yaw, roll] in radians)`,
`stage.setLift(lift)`, `stage.setCameraOrbit(pose.camera)` (null to stop).

## AR models

`stage.exportAr({ format: "usdz" | "glb", size?, upright? })` (or `offscreen.exportAr(design, …)`)
bakes the card into a real-size model: ISO ID-1, 85.60 × 53.98 × 0.76 mm, metres, Y up, lying face up
(`upright: true` stands it up), with colour, roughness / metalness and normal maps per face (`size`:
longest side of each map, default 2048). Holo foils and face shaders become a static texture, and an
animated card exports the frame on screen. The AR part of the engine loads on first use.

```ts
import { arSupport, openQuickLook, sceneViewerUrl, type EngineStage } from "@card3d/core";

/** Call from a click: Quick Look must open within the tap's user activation. */
async function viewInAr(stage: EngineStage, hostedGlbUrl?: string): Promise<boolean> {
  const ar = arSupport();
  if (ar.quickLook) {
    const bytes = new Uint8Array(await stage.exportAr({ format: "usdz" }));
    openQuickLook(URL.createObjectURL(new Blob([bytes], { type: "model/vnd.usdz+zip" })));
    return true;
  }
  if (ar.sceneViewer && hostedGlbUrl) {
    location.href = sceneViewerUrl(hostedGlbUrl, { title: "Card" });
    return true;
  }
  return false; // desktop: offer a download of the GLB instead
}
```

- iPhone / iPad (AR Quick Look) take a USDZ made in the page. A big design can take a moment: start
  `exportAr` on `pointerdown` and open on `click`, or the tap's activation may expire.
- Android's Scene Viewer downloads the model itself: it needs a GLB at a public https URL. Export a
  GLB, upload it, and pass that URL.

## Print production rasters

```ts
import { createOffscreenStage, ensureDesign } from "@card3d/core";
import { bakePrint, cardDieline, dielineSvg } from "@card3d/core/print";

const design = ensureDesign({ recipe: { material: "silver" }, cardholderName: "Ada Lovelace" });
const off = createOffscreenStage();
try {
  const sides = await bakePrint(off, design, { dpi: 600, bleedMm: 2 }); // one entry per side
  for (const s of sides) console.log(s.side, s.layout.width, s.layout.height, Object.keys(s.masks), s.features);
  const front = dielineSvg(cardDieline(design, { bleedMm: 2, safeMm: 3 }), "front");
  console.log(front.length);
} finally {
  off.dispose();
}
```

- Each side has `color` (RGBA raster, sRGB), `masks` (grey separations by `PRINT_MASKS` id: `engrave`, `fill`, `etch`, `emboss`, `foil`, `spot-gloss`, `relief`, `white`;
  only those that apply), `elements` (where each mark sits) and `features` (what a printer can't reproduce as
  rendered: foil, shader layers, add-ons, effects, a clear card).
- `artwork: { front: img }` gives the bake full-resolution artwork (the engine itself keeps a copy of
  at most 1280 px); `showChip: true` keeps the chip in the colour raster for a preview.
- `cardDieline` (trim, bleed, safe zone, cutouts, ISO keep-outs) and `dielineSvg` draw the cutting
  guide. Turning these into a PDF or a vendor package is up to the host (Card Studio's
  **Export → Print files…** does it in the studio).
