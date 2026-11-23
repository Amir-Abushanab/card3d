/**
 * Everything the studio keeps in localStorage: the autosaved working design, named drafts, the
 * user's sticker library and a few UI preferences. Every access is wrapped: storage can be missing
 * (private mode, blocked site data) or full (data-URL artwork is large), and the studio must keep
 * working either way.
 */
import type { CardDesign } from "@card3d/core/model";
import { ensureDesign, stripEmbeddedMedia } from "./design.ts";

const KEY = {
  autosave: "card-studio:autosave",
  drafts: "card-studio:drafts",
  stickers: "card-studio:stickers",
  prefs: "card-studio:prefs",
} as const;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Returns false when the write failed (quota, blocked storage). */
function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// ── autosave ────────────────────────────────────────────────────────────────

export type SaveResult = "ok" | "without-media" | "failed";

/** Save the working design; if it doesn't fit, retry without inline uploads. */
export function autosave(design: CardDesign): SaveResult {
  if (write(KEY.autosave, { savedAt: Date.now(), design })) return "ok";
  if (write(KEY.autosave, { savedAt: Date.now(), design: stripEmbeddedMedia(design).design, mediaDropped: true })) return "without-media";
  return "failed";
}

export function loadAutosave(): { design: CardDesign; savedAt: number } | null {
  const v = read<{ savedAt: number; design: unknown }>(KEY.autosave);
  if (!v) return null;
  try {
    return { design: ensureDesign(v.design), savedAt: v.savedAt ?? 0 };
  } catch {
    return null;
  }
}

// ── drafts ──────────────────────────────────────────────────────────────────

export interface Draft {
  id: string;
  name: string;
  savedAt: number;
  /** Small JPEG data URL of the card at save time. */
  thumb?: string;
  design: CardDesign;
}

export function listDrafts(): Draft[] {
  const list = read<Draft[]>(KEY.drafts);
  return Array.isArray(list) ? list.filter((d) => d && typeof d.id === "string" && d.design) : [];
}

export function saveDraft(draft: Draft): SaveResult {
  const others = listDrafts().filter((d) => d.id !== draft.id);
  if (write(KEY.drafts, [draft, ...others])) return "ok";
  const lean = { ...draft, design: stripEmbeddedMedia(draft.design).design };
  if (write(KEY.drafts, [lean, ...others])) return "without-media";
  return "failed";
}

export function deleteDraft(id: string): void {
  write(
    KEY.drafts,
    listDrafts().filter((d) => d.id !== id),
  );
}

// ── sticker library (user uploads) ───────────────────────────────────────────

export interface LibrarySticker {
  id: string;
  name: string;
  src: string;
  aspect: number;
  builtin?: boolean;
}

export function loadStickerLibrary(): LibrarySticker[] {
  const list = read<LibrarySticker[]>(KEY.stickers);
  return Array.isArray(list) ? list.filter((s) => s && typeof s.src === "string") : [];
}

export function saveStickerLibrary(list: LibrarySticker[]): boolean {
  return write(
    KEY.stickers,
    list.filter((s) => !s.builtin),
  );
}

// ── prefs ───────────────────────────────────────────────────────────────────

export interface Prefs {
  quality?: "full" | "performance";
  /** "scene" follows the design's lighting preset (older "dark" / "light" values read as "scene"). */
  backdrop?: "scene" | "checker" | "dark" | "light";
  folds?: Record<string, boolean>;
  presetCategory?: string;
  assets?: "reference" | "public";
  /** Width of the shader code drawer (px). */
  editorWidth?: number;
}

export const loadPrefs = (): Prefs => read<Prefs>(KEY.prefs) ?? {};
export function savePrefs(patch: Partial<Prefs>): void {
  write(KEY.prefs, { ...loadPrefs(), ...patch });
}
