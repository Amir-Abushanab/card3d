/**
 * Material preset tables. Every recipe supplies `color`, so the preset never sets the
 * hue in practice; it contributes three scalar modifiers to the polish curves in `scalar.ts`.
 */
import type { MaterialPreset } from "../types.ts";

export interface PresetModifiers {
  /** Added to the polish → roughness curve. */
  roughnessBias: number;
  /** Multiplier on clearcoat (metal presets only; glass clearcoat is fixed at 1). */
  clearcoat: number;
  metalness: number;
}

/** Base colour used only when neither the override nor the config supplies one (`n4`). */
export const PRESET_FALLBACK_COLORS: Readonly<Record<MaterialPreset, string>> = {
  silver: "#bcbcb9",
  nickel: "#303431",
  titanium: "#555b57",
  brass: "#62594f",
  oxide: "#34464a",
  carbon: "#30332f",
  glass: "#c5dde4",
};

/** Scalar modifiers per preset (`n9`). */
export const PRESET_MODIFIERS: Readonly<Record<MaterialPreset, PresetModifiers>> = {
  silver: { roughnessBias: 0, clearcoat: 1, metalness: 1 },
  nickel: { roughnessBias: -0.04, clearcoat: 1.25, metalness: 1 },
  titanium: { roughnessBias: 0.05, clearcoat: 0.72, metalness: 1 },
  brass: { roughnessBias: -0.015, clearcoat: 1.12, metalness: 1 },
  oxide: { roughnessBias: 0.09, clearcoat: 0.54, metalness: 1 },
  carbon: { roughnessBias: 0.15, clearcoat: 0.3, metalness: 1 },
  glass: { roughnessBias: -0.12, clearcoat: 1, metalness: 0 },
};

export function isMaterialPreset(value: unknown): value is MaterialPreset {
  return typeof value === "string" && Object.hasOwn(PRESET_MODIFIERS, value);
}
