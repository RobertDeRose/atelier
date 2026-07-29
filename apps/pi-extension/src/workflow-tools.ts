import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AtelierCore } from "../../../packages/core/src/index.ts";

export const ATELIER_STATE_TOOL = "atlr_state";
export const ATELIER_COMMIT_TOOL = "atlr_commit";
export const ATELIER_TASK_CLOSE_TOOL = "atlr_task_close";
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

type ToolSchema = Record<string | symbol, unknown>;

function stringSchema(description: string): ToolSchema {
  return { [TYPEBOX_KIND]: "String", type: "string", description };
}

function objectSchema(properties: Record<string, ToolSchema>, required: string[] = []): ToolSchema {
  return { [TYPEBOX_KIND]: "Object", type: "object", properties, required, additionalProperties: false };
}

export function registerWorkflowTools(
  pi: ExtensionAPI,
  coreFor: (ctx: ExtensionContext) => AtelierCore,
): void {
  pi.registerTool({
    name: ATELIER_STATE_TOOL,
    label: "Atelier Working State",
    description: "Read authoritative Atelier Working State for the current plan, task, execution, evidence, and next action.",
    promptSnippet: "Read Atelier Working State instead of inferring workflow authority from conversation history",
    parameters: objectSchema({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const core = coreFor(ctx);
      const state = await core.buildWorkingState();
      return { content: [{ type: "text", text: core.workingStateBuilder.toMarkdown(state) }], details: state };
    },
  });

  pi.registerTool({
    name: ATELIER_COMMIT_TOOL,
    label: "Atelier Local Change",
    description: "Create the one task-scoped local Git commit or Jujutsu change using only source paths approved by the exact plan transaction.",
    promptSnippet: "Use Atelier's typed local-change tool; never use Bash or raw VCS commands for the approved task commit",
    parameters: objectSchema({ message: stringSchema("Local commit or change description.") }, ["message"]),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const message = String((params as { message?: unknown }).message ?? "").trim();
      if (!message) throw new Error("Atelier local change requires a non-empty message.");
      const result = coreFor(ctx).commitActiveTask(message, "agent");
      return {
        content: [{ type: "text", text: `Created local ${result.snapshot.vcs === "jj" ? "change" : "commit"}: ${result.message}\nPaths: ${result.changedPaths.join(", ")}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: ATELIER_TASK_CLOSE_TOOL,
    label: "Atelier Task Closure",
    description: "Close the active task only when current validation, exact diff review, local change, and repository-state evidence satisfy the authoritative predicate.",
    promptSnippet: "Use Atelier's typed task-close tool after the completion predicate passes",
    parameters: objectSchema({ reason: stringSchema("Evidence-backed task closure reason.") }, ["reason"]),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const reason = String((params as { reason?: unknown }).reason ?? "").trim();
      if (!reason) throw new Error("Atelier task closure requires a reason.");
      const result = await coreFor(ctx).closeActiveTask(reason, "agent");
      return {
        content: [{ type: "text", text: `Closed task ${result.task.id}. Next approved-plan ready tasks: ${result.nextReady.map((item) => item.id).join(", ") || "none"}.` }],
        details: result,
      };
    },
  });
}
