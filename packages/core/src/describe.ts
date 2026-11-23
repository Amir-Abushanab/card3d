/**
 * `@card3d/core/describe`: the model-facing description of the design space and a linter for
 * hand- or model-written designs. A separate entry so
 * the root bundles and the CDN builds never carry it.
 */
export { describeDesignSpace, designSpaceSections, type DesignSpaceSection } from "./describe/text.ts";
export { lintDesign, type DesignLint, type DesignIssue } from "./describe/lint.ts";
export { DESIGN_EXAMPLES, type DesignExample } from "./describe/examples.ts";
export { DESIGN_FIELDS, RECIPE_DOCS, type FieldDoc, type FieldTable } from "./describe/fields.ts";
export {
  FINISH_OUTPUT_SCHEMA,
  MAX_FINISH_DESCRIPTION,
  FinishOutputError,
  finishSystemPrompt,
  finishUserMessage,
  parseFinishOutput,
  type FinishAnswer,
  type FinishContext,
  type FinishPromptInput,
} from "./describe/prompt.ts";
