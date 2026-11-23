/**
 * AR viewers: which viewer this device has, and how to open one. The models come from the card engine
 * (`EngineStage.exportAr` / `OffscreenStage.exportAr`: USDZ and GLB, its `ar` part loads on first use).
 *
 * - iOS / iPadOS Safari: AR Quick Look, an `<a rel="ar">` link (with an `<img>` child) to a `.usdz`;
 *   a `blob:` URL works, so the model can be made in the page.
 * - Android: Scene Viewer, an `intent://` URL whose `file` is a GLB it downloads itself: it must be
 *   a public https URL (never `blob:`), i.e. a hosted file.
 * - Desktop: no AR; offer the files.
 */

export interface ArSupport {
  /** AR Quick Look (iOS / iPadOS Safari and WebViews that support `rel="ar"`). */
  quickLook: boolean;
  /** An Android device (Scene Viewer via an intent URL; needs a hosted GLB). */
  sceneViewer: boolean;
}

export function arSupport(): ArSupport {
  if (typeof document === "undefined" || typeof navigator === "undefined") return { quickLook: false, sceneViewer: false };
  let quickLook = false;
  try {
    quickLook = document.createElement("a").relList.supports("ar");
  } catch {
    quickLook = false;
  }
  return { quickLook, sceneViewer: !quickLook && /\bAndroid\b/i.test(navigator.userAgent) };
}

export interface SceneViewerOptions {
  /** Shown in Scene Viewer's header. */
  title?: string;
  /** "View more" link (https). */
  link?: string;
  /** Where the browser goes when Scene Viewer isn't installed. Default: the current page. */
  fallbackUrl?: string;
  /** Default "ar_preferred" (3D viewer when the device has no ARCore). */
  mode?: "ar_preferred" | "ar_only" | "3d_only";
}

/**
 * Scene Viewer intent URL for a hosted GLB (`fileUrl` must be https). The model keeps its real-world
 * size (`resizable=false`).
 */
export function sceneViewerUrl(fileUrl: string, o: SceneViewerOptions = {}): string {
  const mode = o.mode ?? "ar_preferred";
  const q = new URLSearchParams({ file: fileUrl, mode, resizable: "false" });
  if (o.title) q.set("title", o.title);
  if (o.link) q.set("link", o.link);
  const fallback = o.fallbackUrl ?? (typeof location !== "undefined" ? location.href : "https://developers.google.com/ar");
  // ar_only needs ARCore; ar_preferred / 3d_only go through the Google app.
  const pkg = mode === "ar_only" ? "com.google.ar.core" : "com.google.android.googlequicksearchbox";
  return `intent://arvr.google.com/scene-viewer/1.0?${q.toString()}#Intent;scheme=https;package=${pkg};action=android.intent.action.VIEW;S.browser_fallback_url=${encodeURIComponent(fallback)};end;`;
}

/**
 * Open AR Quick Look on a `.usdz` (a `blob:` or https URL). Must run in a user gesture. The model
 * keeps its real-world size (`allowsContentScaling=0`).
 */
export function openQuickLook(usdzUrl: string): void {
  const a = document.createElement("a");
  a.rel = "ar";
  a.href = `${usdzUrl}#allowsContentScaling=0`;
  a.style.display = "none";
  // Quick Look only takes over links that wrap an image.
  a.append(document.createElement("img"));
  document.body.append(a);
  a.click();
  a.remove();
}
