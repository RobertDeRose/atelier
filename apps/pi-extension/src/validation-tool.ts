import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AtelierCore } from "../../../packages/core/src/index.ts";

export const ATELIER_VALIDATION_TOOL = "atlr_validate";
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

type ToolSchema = Record<string | symbol, unknown>;

function stringSchema(description: string, values?: readonly string[]): ToolSchema {
  return {
    [TYPEBOX_KIND]: "String",
    type: "string",
    description,
    ...(values === undefined ? {} : { enum: [...values] }),
  };
}

function objectSchema(properties: Record<string, ToolSchema>, required: string[] = []): ToolSchema {
  return {
    [TYPEBOX_KIND]: "Object",
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validationText(items: Array<{ name: string; status: string; durationMs: number }>): string {
  return items.length === 0
    ? "No focused validations matched the current changed paths."
    : items.map((item) => `${item.name}: ${item.status} (${item.durationMs} ms)`).join("\n");
}

function requirePassingValidation(items: Array<{ name: string; status: string; durationMs: number }>): void {
  const unsuccessful = items.filter((item) => item.status !== "passed" && item.status !== "interrupted");
  if (unsuccessful.length > 0) {
    throw new Error(`Declared validation did not pass:\n${validationText(unsuccessful)}`);
  }
}

export function registerValidationTool(
  pi: ExtensionAPI,
  coreFor: (ctx: ExtensionContext) => AtelierCore,
): void {
  pi.registerTool({
    name: ATELIER_VALIDATION_TOOL,
    label: "Atelier Validation",
    description: "Select or run repository-declared Atelier validations through the typed validation capability. Never use Bash as a substitute. Permission to validate does not override a user's instruction not to run validation.",
    promptSnippet: "Use Atelier's typed validation tool for declared validation; never run declared checks through Bash",
    promptGuidelines: [
      "Use action=plan before action=focused unless the current Working State already records a current focused selection.",
      "Use action=run only when the user or approved task explicitly names one configured validation.",
      "Do not invoke validation when the user has instructed you not to run tests or validation, even though the active task capability permits it.",
    ],
    parameters: objectSchema({
      action: stringSchema("Validation operation.", ["plan", "focused", "run"]),
      name: stringSchema("Configured validation name; required only for action=run."),
    }, ["action"]),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const core = coreFor(ctx);
      const input = params as { action: "plan" | "focused" | "run"; name?: string };
      try {
        if (input.action === "plan") {
          const selection = core.selectFocusedValidation();
          const text = selection.noMatch
            ? `Focused selection ${selection.id}: no configured validations matched the current changed paths.`
            : [
                `Focused selection ${selection.id}:`,
                ...selection.selected.map((item) => `- ${item.name}: ${item.reason}${item.required ? " (required)" : ""}`),
              ].join("\n");
          return { content: [{ type: "text", text }], details: { action: input.action, selection } };
        }

        if (input.action === "focused") {
          const selection = core.selectFocusedValidation();
          const results = [];
          for (const item of selection.selected) {
            results.push(await core.runValidation(item.name, { selectionId: selection.id, ...(signal === undefined ? {} : { ...(signal === undefined ? {} : { signal }) }) }));
          }
          requirePassingValidation(results);
          return {
            content: [{ type: "text", text: validationText(results) }],
            details: { action: input.action, selection, results },
          };
        }

        const name = input.name?.trim();
        if (!name) throw new Error("action=run requires a configured validation name");
        const evidence = await core.runValidation(name, { ...(signal === undefined ? {} : { signal }) });
        requirePassingValidation([evidence]);
        return {
          content: [{ type: "text", text: `${name}: ${evidence.status} (${evidence.durationMs} ms)` }],
          details: { action: input.action, evidence },
        };
      } catch (error) {
        throw new Error(`Atelier validation failed: ${errorMessage(error)}`);
      }
    },
  });
}
