/**
 * A deploy replaces the build's hashed chunks: a page opened before it can't load a lazily imported
 * one (Vite's `vite:preloadError`). The page reloads once to get the new build; not again within a
 * minute, so a real network failure surfaces as an error instead of a reload loop.
 */
const KEY = "card-studio:stale-build-reload";
const AGAIN_AFTER_MS = 60_000;

/** `beforeReload`: save what the reload would lose. */
export function reloadOnStaleBuild(beforeReload?: () => void): void {
  window.addEventListener("vite:preloadError", (e) => {
    try {
      if (Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) < AGAIN_AFTER_MS) return;
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch {
      return; // no storage to guard the loop with: let the error surface
    }
    e.preventDefault();
    beforeReload?.();
    location.reload();
  });
}
