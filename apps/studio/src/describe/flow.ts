/**
 * One "describe a finish" run: ask the provider, validate the answer (`lintDesign`, plus the host's
 * WGSL compile check), and on failure ask once more with the problems listed. Pure orchestration:
 * no DOM, no network of its own.
 */
import { FinishOutputError, lintDesign, type FinishContext, type FinishPromptInput } from "@card3d/core/describe";
import type { CardDesign } from "@card3d/core/model";
import type { FinishProvider } from "./providers.ts";

export interface FinishValidation {
  design: CardDesign | null;
  errors: string[];
  warnings: string[];
}

type CompileErrors = { line: number; message: string }[];

/**
 * `lintDesign` as strings, plus `compile(code)` errors for each custom layer (when given: the card
 * engine's WGSL check, `EngineStage.checkShader`; null when it can't check now).
 */
export async function validateFinish(
  raw: unknown,
  compile?: (code: string) => CompileErrors | null | Promise<CompileErrors | null>,
): Promise<FinishValidation> {
  const lint = lintDesign(raw);
  const errors = lint.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message));
  const warnings = lint.warnings.map((e) => `${e.path}: ${e.message}`);
  if (lint.design && compile && !errors.length) {
    const layers = lint.design.shaders ?? [];
    for (let i = 0; i < layers.length; i++) {
      if (layers[i].id !== "custom") continue;
      for (const e of (await compile(layers[i].code ?? "")) ?? []) errors.push(`shaders[${i}].code${e.line ? `:${e.line}` : ""}: ${e.message}`);
    }
  }
  return { design: lint.design, errors, warnings };
}

export interface DescribeRun {
  provider: FinishProvider;
  description: string;
  current?: FinishContext;
  validate(raw: unknown): FinishValidation | Promise<FinishValidation>;
  /** Model calls in all (the first plus retries). Default 2. */
  attempts?: number;
  signal?: AbortSignal;
  onAttempt?(attempt: number, of: number): void;
}

export interface DescribeResult {
  design: CardDesign;
  summary: string;
  warnings: string[];
  attempts: number;
}

/** Validation still failed after the last attempt. */
export class FinishValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`The design still had problems after the retry:\n${errors.map((e) => `• ${e}`).join("\n")}`);
    this.name = "FinishValidationError";
    this.errors = errors;
  }
}

export async function describeFinish(run: DescribeRun): Promise<DescribeResult> {
  const total = Math.max(1, run.attempts ?? 2);
  let retry: FinishPromptInput["retry"];
  let last: string[] = [];
  for (let attempt = 1; attempt <= total; attempt++) {
    run.onAttempt?.(attempt, total);
    let answer;
    try {
      answer = await run.provider.generate(
        { description: run.description, ...(run.current ? { current: run.current } : {}), ...(retry ? { retry } : {}) },
        run.signal,
      );
    } catch (err) {
      if (!(err instanceof FinishOutputError)) throw err;
      last = [err.message];
      retry = { designJson: err.raw.slice(0, 40_000), errors: last };
      continue;
    }
    const v = await run.validate(answer.design);
    if (v.design && !v.errors.length) return { design: v.design, summary: answer.summary, warnings: v.warnings, attempts: attempt };
    last = v.errors;
    retry = { designJson: answer.designJson, errors: v.errors };
  }
  throw new FinishValidationError(last);
}

/**
 * The design to apply: the generated one, keeping what the model can't produce from the current card
 * (uploaded artwork and stickers, and an uploaded logo unless the answer drew its own).
 */
export function mergeUploads(next: CardDesign, current: CardDesign): CardDesign {
  const out: CardDesign = {
    ...next,
    decals: current.decals.map((d) => ({ ...d })),
    surfaceSources: { ...current.surfaceSources },
    surfaceTreatments: { ...current.surfaceTreatments },
  };
  if (!next.logo && current.logo) out.logo = { ...current.logo };
  return out;
}

export const EXAMPLE_DESCRIPTION = "smoked bronze with a fine hairline brush and a faint oil-slick holo";

/** The Claude Code command for a description: the no-key path (.claude/skills/describe-finish). */
export const skillCommand = (description: string): string => `/describe-finish ${description.trim().replace(/\s+/g, " ") || EXAMPLE_DESCRIPTION}`;
