/**
 * Tweakpane controls generated from parameter specs: the effects' `EffectParamSpec`s and the face
 * shaders' `ShaderParamSpec`s (built-ins and annotated custom WGSL) share one builder.
 *
 * Each control binds a small proxy object (not the design itself, whose nested objects are replaced
 * on undo/load), reads its value through `get` and writes through `set`; `refresh()` re-reads.
 */
import type { FolderApi } from "tweakpane";

/** A Tweakpane binding as `addBinding` returns it. */
export type BindingApi = ReturnType<FolderApi["addBinding"]>;
import type { ShaderParamValue } from "@card3d/core/model";
import { parseShaderColor, type EffectParamSpec, type ShaderParamSpec } from "@card3d/core/editor";

type AnySpec = (EffectParamSpec | ShaderParamSpec) & { optional?: boolean };

export interface ParamControls {
  /** Every blade, in order (to hide/show or dispose together). */
  blades: { hidden: boolean; dispose(): void }[];
  refresh(): void;
  setHidden(hidden: boolean): void;
  dispose(): void;
}

export interface ParamControlOptions {
  /** True while the panel is refreshing from the model (change events are ignored then). */
  syncing(): boolean;
  /** Called after a value was written (`set`). */
  onChange(spec: AnySpec): void;
  /** Insert at this blade index of the folder (default: append). */
  index?: number;
}

const toHex = (v: unknown): string => {
  const c = parseShaderColor(v) ?? [1, 1, 1];
  return `#${c
    .map((x) =>
      Math.round(Math.min(1, Math.max(0, x)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
};

const decimals = (step: number | undefined) => {
  if (!step || step >= 1) return 0;
  return Math.min(4, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
};

/**
 * Builds one control per spec into `folder`. `get(key)` returns the stored value (undefined = unset:
 * the default is shown, or for `optional` params the control is off); `set(key, value)` stores one
 * (undefined = clear an optional param).
 */
export function buildParamControls(
  folder: FolderApi,
  specs: readonly AnySpec[],
  get: (key: string) => ShaderParamValue | undefined,
  set: (key: string, value: ShaderParamValue | undefined) => void,
  o: ParamControlOptions,
): ParamControls {
  const blades: (BindingApi & { hidden: boolean })[] = [];
  const refreshers: (() => void)[] = [];
  let index = o.index;
  const at = () => (index === undefined ? {} : { index: index++ });
  let local = false;
  const quiet = () => local || o.syncing();

  for (const spec of specs) {
    const describe = (b: BindingApi) => {
      if (spec.description) b.element.title = spec.description;
      return b;
    };
    const valueOf = (): ShaderParamValue => {
      const v = get(spec.key);
      return v === undefined ? (spec.default as ShaderParamValue) : v;
    };

    // Optional params: an enable checkbox, then the value control (shown while on).
    let enable: { on: boolean } | null = null;
    let enableBlade: (BindingApi & { hidden: boolean }) | null = null;
    if (spec.optional) {
      enable = { on: get(spec.key) !== undefined };
      enableBlade = describe(folder.addBinding(enable, "on", { label: spec.label, ...at() })) as BindingApi & { hidden: boolean };
      blades.push(enableBlade);
    }
    const label = spec.optional ? "" : spec.label;

    let binding: BindingApi;
    let read: () => void;
    const proxy: { v: unknown } = { v: null };

    const write = (v: ShaderParamValue | undefined) => {
      set(spec.key, v);
      o.onChange(spec);
    };

    const options = (spec as { options?: readonly { label: string; value: string | number }[] }).options;
    if (options?.length) {
      proxy.v = valueOf();
      binding = folder.addBinding(proxy, "v", { label, options: options.map((x) => ({ text: x.label, value: x.value })), ...at() });
      read = () => (proxy.v = valueOf());
    } else if (spec.type === "bool") {
      proxy.v = Boolean(valueOf());
      binding = folder.addBinding(proxy, "v", { label, ...at() });
      read = () => (proxy.v = Boolean(valueOf()));
    } else if (spec.type === "color") {
      proxy.v = toHex(valueOf());
      binding = folder.addBinding(proxy, "v", { label, view: "color", ...at() });
      read = () => (proxy.v = toHex(valueOf()));
    } else if (spec.type === "vec2" || spec.type === "vec3") {
      const n = spec.type === "vec2" ? 2 : 3;
      const dim = { min: spec.min, max: spec.max, step: spec.step };
      const vec = () => {
        const v = valueOf();
        const a = Array.isArray(v) ? v : [0, 0, 0];
        return n === 2 ? { x: a[0] ?? 0, y: a[1] ?? 0 } : { x: a[0] ?? 0, y: a[1] ?? 0, z: (a as number[])[2] ?? 0 };
      };
      proxy.v = vec();
      binding = folder.addBinding(
        proxy,
        "v",
        n === 2 ? { label, x: dim, y: { ...dim, inverted: true }, picker: "popup", ...at() } : { label, x: dim, y: dim, z: dim, ...at() },
      );
      read = () => (proxy.v = vec());
    } else {
      // float / int
      const isInt = spec.type === "int";
      const step = spec.step ?? (isInt ? 1 : undefined);
      const fmtDigits = isInt ? 0 : decimals(step ?? 0.01);
      proxy.v = Number(valueOf()) || 0;
      binding = folder.addBinding(proxy, "v", {
        label,
        ...(spec.min !== undefined ? { min: spec.min } : {}),
        ...(spec.max !== undefined ? { max: spec.max } : {}),
        ...(step !== undefined ? { step } : {}),
        format: (v: number) => v.toFixed(fmtDigits),
        ...at(),
      });
      read = () => (proxy.v = Number(valueOf()) || 0);
    }
    describe(binding);
    blades.push(binding as BindingApi & { hidden: boolean });

    const current = (): ShaderParamValue => {
      const v = proxy.v as unknown;
      if (spec.type === "vec2") {
        const p = v as { x: number; y: number };
        return [p.x, p.y];
      }
      if (spec.type === "vec3") {
        const p = v as { x: number; y: number; z: number };
        return [p.x, p.y, p.z];
      }
      if (spec.type === "int" && typeof v === "number") return Math.round(v);
      // Slider steps accumulate float error (0.49999999999999994): keep the step's precision.
      if (spec.type === "float" && typeof v === "number" && spec.step) return Number(v.toFixed(decimals(spec.step) + 1));
      return v as ShaderParamValue;
    };

    binding.on("change", () => {
      if (quiet()) return;
      if (enable && !enable.on) return;
      write(current());
    });
    if (enable && enableBlade) {
      const valueBlade = binding as BindingApi & { hidden: boolean };
      valueBlade.hidden = !enable.on;
      enableBlade.on("change", () => {
        valueBlade.hidden = !enable!.on;
        if (quiet()) return;
        write(enable!.on ? current() : undefined);
      });
      refreshers.push(() => {
        enable!.on = get(spec.key) !== undefined;
        enableBlade!.refresh();
        valueBlade.hidden = !enable!.on || hiddenAll;
      });
    }
    refreshers.push(() => {
      read();
      binding.refresh();
    });
  }

  let hiddenAll = false;
  return {
    blades,
    refresh() {
      local = true;
      try {
        for (const r of refreshers) r();
      } finally {
        local = false;
      }
    },
    setHidden(hidden: boolean) {
      hiddenAll = hidden;
      for (const b of blades) b.hidden = hidden;
      if (!hidden) this.refresh();
    },
    dispose() {
      for (const b of blades) b.dispose();
      blades.length = 0;
    },
  };
}
