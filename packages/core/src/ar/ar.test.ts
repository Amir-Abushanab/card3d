import { describe, expect, it } from "vitest";
import { sceneViewerUrl } from "./support.ts";

describe("AR viewers", () => {
  it("builds a Scene Viewer intent for a hosted GLB at real size", () => {
    const url = sceneViewerUrl("https://example.com/card.glb", { title: "Ada", fallbackUrl: "https://example.com/" });
    expect(url).toMatch(
      /^intent:\/\/arvr\.google\.com\/scene-viewer\/1\.0\?file=https%3A%2F%2Fexample\.com%2Fcard\.glb&mode=ar_preferred&resizable=false&title=Ada#Intent;scheme=https;package=com\.google\.android\.googlequicksearchbox;action=android\.intent\.action\.VIEW;S\.browser_fallback_url=https%3A%2F%2Fexample\.com%2F;end;$/,
    );
    expect(sceneViewerUrl("https://x/y.glb", { mode: "ar_only" })).toContain("package=com.google.ar.core");
  });
});
