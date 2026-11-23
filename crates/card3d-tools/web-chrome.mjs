// The browser the web builds run in (compare.mjs, ar-compare.mjs, crates/card3d-web/web/fallback.test.mjs).
//
// By default, Google Chrome in a window, on the machine's GPU (WebGPU behind --enable-unsafe-webgpu).
// With CARD3D_SWIFTSHADER=1 (CI: no GPU), Playwright's Chromium in new headless mode with WebGPU on
// SwiftShader's Vulkan (Dawn) and WebGL on SwiftShader through ANGLE, so both web builds run without a GPU.
// Pages must be a secure context for WebGPU (localhost is). On Linux the GPU process's own Vulkan has to
// be SwiftShader too (--use-vulkan=swiftshader): without it vkCreateInstance fails there, the WebGPU
// canvas gets no shared image to present into, and the device is lost right after the first frame.
export const SWIFTSHADER = !!process.env.CARD3D_SWIFTSHADER;

/** Launches the browser for the web builds; `chromium` is Playwright's browser type. */
export function launchWebChrome(chromium) {
  if (SWIFTSHADER)
    return chromium.launch({
      // Full Chromium in new headless mode (not the headless shell).
      channel: "chromium",
      args: [
        "--enable-unsafe-webgpu",
        "--use-webgpu-adapter=swiftshader",
        "--enable-features=Vulkan",
        "--use-vulkan=swiftshader",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
      ],
    });
  return chromium.launch({ channel: "chrome", headless: false, args: ["--enable-unsafe-webgpu"] });
}
