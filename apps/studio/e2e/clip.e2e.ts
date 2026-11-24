/**
 * Clip export (Export → Video / GIF): a looping path (Spin) on an animated card ends where it begins
 * (the seam cross-fade), and video is encoded with WebCodecs, so it has exact frame times and a real
 * duration (a MediaRecorder WebM has none).
 */
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, openStudio, settle, smallExport, test } from "./fixtures.ts";

/** A face shader whose brightness ramps with time: without the seam fade, a loop jumps back to dark. */
const GRADIENT_SHADER = `fn mainImage(uv: vec2f) -> vec4f {
  let v = fract(uTime * 0.2);
  return vec4f(vec3f(v), 1.0);
}`;

async function openAnimatedCard(page: Page): Promise<void> {
  await openStudio(page);
  // The studio's own autosave (trusted, unlike a shared link): a default card plus the shader.
  await page.evaluate((code) => {
    const design = { shaders: [{ id: "custom", language: "wgsl", side: "front", target: "skin", code }] };
    localStorage.setItem("card-studio:autosave", JSON.stringify({ savedAt: Date.now(), design }));
  }, GRADIENT_SHADER);
  await openStudio(page);
  await settle(page, 500);
}

async function record(page: Page, format: "gif" | "webm"): Promise<Buffer> {
  // Small frames: a software renderer pays per pixel, and the checks only need the card's face.
  const exp = await smallExport(page, 480, 320);
  // The clip group's format list (beside its Record button).
  await exp
    .locator(".c3-group", { hasText: "VIDEO / GIF" })
    .locator("select")
    .first()
    .selectOption({ label: format === "gif" ? "GIF" : "WebM" });
  const download = page.waitForEvent("download", { timeout: 0 }); // bounded by the test's timeout
  await exp.getByRole("button", { name: /Record spin/ }).click();
  return readFile((await (await download).path())!);
}

test("a GIF of an animated card on the spin path loops without a jump", async ({ page }) => {
  test.slow(); // 3x the timeout: a clip renders a few hundred frames
  await openAnimatedCard(page);
  const gif = await record(page, "gif");
  // Decode every frame; compare the seam (last → first) with the ordinary frame-to-frame change.
  const { steps, seam } = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dec = new ImageDecoder({ data: bytes, type: "image/gif" });
    await dec.tracks.ready;
    const n = dec.tracks.selectedTrack!.frameCount;
    const lumas: number[] = [];
    for (let i = 0; i < n; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      const c = new OffscreenCanvas(image.displayWidth, image.displayHeight);
      const g = c.getContext("2d")!;
      g.drawImage(image, 0, 0);
      image.close();
      // Mean luma of the middle of the frame (the card's face).
      const d = g.getImageData(Math.round(c.width * 0.4), Math.round(c.height * 0.4), Math.round(c.width * 0.2), Math.round(c.height * 0.2)).data;
      let s = 0;
      for (let k = 0; k < d.length; k += 4) s += 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2];
      lumas.push(s / (d.length / 4));
    }
    const steps = lumas.slice(1).map((v, i) => Math.abs(v - lumas[i]));
    return { steps, seam: Math.abs(lumas[0] - lumas[n - 1]) };
  }, gif.toString("base64"));
  const sorted = [...steps].sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length * 0.9)];
  expect(steps.length).toBeGreaterThan(50);
  expect(seam, `seam ${seam.toFixed(2)} vs the 90th-percentile step ${typical.toFixed(2)}`).toBeLessThan(Math.max(3, typical * 2));
});

test("a WebM clip has exact frame times: a real duration", async ({ page }) => {
  test.slow(); // 3x the timeout: a clip renders a few hundred frames
  await openAnimatedCard(page);
  const webm = await record(page, "webm");
  const duration = await page.evaluate(async (b64) => {
    const v = document.createElement("video");
    v.muted = true;
    v.src = `data:video/webm;base64,${b64}`;
    await new Promise<void>((r, j) => {
      v.onloadedmetadata = () => r();
      v.onerror = () => j(new Error("the video didn't load"));
    });
    return v.duration;
  }, webm.toString("base64"));
  expect(duration).toBeGreaterThan(3.9);
  expect(duration).toBeLessThan(4.1);
});
