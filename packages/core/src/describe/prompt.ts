/**
 * The "describe a finish" request, provider-neutral: the system prompt (the design-space description
 * plus the answer format), the user message, the structured-output schema and the parser for the
 * answer. Card Studio's providers and a future server-side proxy build the same request from these,
 * so every path asks the model the same question. No network code here.
 */
import { describeDesignSpace } from "./text.ts";

/** At most this much of the user's description is sent. */
export const MAX_FINISH_DESCRIPTION = 2000;

/**
 * Structured output for the answer (JSON outputs: every object closed, no numeric constraints). The
 * design travels as JSON text: the design model has open records (shader params) a closed schema
 * can't express, and `lintDesign` validates it fully anyway.
 */
export const FINISH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One or two sentences: the look and the main choices (preset started from, key values)." },
    design_json: { type: "string", description: "The complete CardDesign as JSON text (one object)." },
  },
  required: ["summary", "design_json"],
  additionalProperties: false,
} as const;

/** What the model is told about the card being edited (identity only; uploads never leave the browser). */
export interface FinishContext {
  cardholderName?: string;
  cardholderBio?: string;
}

export interface FinishPromptInput {
  description: string;
  current?: FinishContext;
  /** A previous answer that failed validation, and why: the model fixes it. */
  retry?: { designJson: string; errors: string[] };
}

export interface FinishAnswer {
  summary: string;
  /** Parsed but not yet validated: run it through `lintDesign`. */
  design: unknown;
  /** The design JSON text as the model wrote it (for a retry). */
  designJson: string;
}

const ANSWER_RULES = `
## Your answer

Answer with one JSON object: \`summary\` (one or two sentences) and \`design_json\` (the complete
CardDesign as JSON text). Rules:
- Every field and value must come from this document; leave out optional fields you don't need.
- Uploads (artwork, stickers, raster logos) are not yours to set: \`decals: []\`, \`surfaceSources: {}\`, \`surfaceTreatments: {}\`.
- Keep the cardholder name and bio you are given unless the description asks for new ones.
- Custom WGSL must follow "Custom shaders" exactly (with language: "wgsl"); keep it short and cheap per pixel.
- If the request isn't about a card's look, return the closest sensible finish and say so in the summary.`;

/** The system prompt: stable across requests (cache it). */
export function finishSystemPrompt(): string {
  return `${describeDesignSpace().trim()}\n${ANSWER_RULES}\n`;
}

/** The user message for one request. */
export function finishUserMessage(input: FinishPromptInput): string {
  const description = input.description.trim().slice(0, MAX_FINISH_DESCRIPTION);
  const parts = [`Design this finish:\n\n${description}`];
  const c = input.current;
  if (c && (c.cardholderName || c.cardholderBio)) {
    parts.push(`Current card: cardholderName ${JSON.stringify(c.cardholderName ?? "")}, cardholderBio ${JSON.stringify(c.cardholderBio ?? "")}.`);
  }
  if (input.retry) {
    parts.push(
      `Your previous design failed validation. Fix every problem and answer again with the whole design.\n\nProblems:\n${input.retry.errors.map((e) => `- ${e}`).join("\n")}\n\nPrevious design_json:\n${input.retry.designJson}`,
    );
  }
  return parts.join("\n\n");
}

export class FinishOutputError extends Error {
  /** Text the model returned, for a retry. */
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = "FinishOutputError";
    this.raw = raw;
  }
}

/** Parses the model's answer text (the structured output). Throws `FinishOutputError` when it can't. */
export function parseFinishOutput(text: string): FinishAnswer {
  let outer: unknown;
  try {
    outer = JSON.parse(text);
  } catch {
    throw new FinishOutputError("the answer was not JSON", text);
  }
  const o = outer as Record<string, unknown>;
  if (!o || typeof o !== "object" || typeof o.design_json !== "string") throw new FinishOutputError("the answer has no design_json", text);
  let design: unknown;
  try {
    design = JSON.parse(o.design_json);
  } catch (e) {
    throw new FinishOutputError(`design_json is not valid JSON: ${(e as Error).message}`, o.design_json);
  }
  return { summary: typeof o.summary === "string" ? o.summary : "", design, designJson: o.design_json };
}
