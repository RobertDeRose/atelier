import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  rankPresentedHits,
  type AtelierCore,
} from "../../../packages/core/src/index.ts";
import {
  codeStatusMarkdown,
  codeStatusSummary,
} from "./command-reports.ts";
import {
  codeSearchMarkdown,
  codeSymbolsMarkdown,
} from "./code-tool-presentation.ts";
import type { FooterStatusController } from "./footer-status-controller.ts";
import { appendAtelierReport } from "./report-presentation.ts";

interface CodeCommandDependencies {
  getCore(ctx: ExtensionContext): AtelierCore;
  getFooterStatus(ctx: ExtensionContext): FooterStatusController;
}

export function registerCodeCommands(
  pi: ExtensionAPI,
  dependencies: CodeCommandDependencies,
): void {
  pi.registerCommand("code-status", {
    description: "Show Atelier code-provider health, capabilities, and index state",
    handler: async (_args, ctx) => {
      const core = dependencies.getCore(ctx);
      const footer = dependencies.getFooterStatus(ctx);
      try {
        const status = await core.code.status(undefined, core.codeWorkspace());
        footer.recordProvider(core, status);
        const retrieval = core.code.retrievalStatus();
        appendAtelierReport(
          pi,
          ctx,
          "Code intelligence",
          codeStatusMarkdown(status, retrieval),
          codeStatusSummary(status, retrieval),
        );
      } catch (error) {
        footer.markProviderOffline();
        throw error;
      } finally {
        await footer.refresh(ctx, core);
      }
    },
  });

  pi.registerCommand("code-index", {
    description: "Start or join the Atelier background code-index operation",
    handler: async (_args, ctx) => {
      const core = dependencies.getCore(ctx);
      const footer = dependencies.getFooterStatus(ctx);
      try {
        const state = await core.code.ensureIndex(core.codeWorkspace());
        appendAtelierReport(pi, ctx, "Code index", `**state:** ${state}`, state);
        const status = await core.code.status(undefined, core.codeWorkspace());
        footer.recordProvider(core, status);
      } catch (error) {
        footer.markProviderOffline();
        throw error;
      } finally {
        await footer.refresh(ctx, core);
      }
    },
  });

  pi.registerCommand("code-search", {
    description: "Search code across the configured Atelier workspace",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /code-search QUERY", "warning");
        return;
      }
      await runSearchCommand(pi, ctx, query, dependencies, "search");
    },
  });

  pi.registerCommand("code-symbols", {
    description: "Search symbols through the configured Atelier code provider",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /code-symbols QUERY", "warning");
        return;
      }
      await runSearchCommand(pi, ctx, query, dependencies, "symbols");
    },
  });
}

async function runSearchCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  query: string,
  dependencies: CodeCommandDependencies,
  operation: "search" | "symbols",
): Promise<void> {
  const core = dependencies.getCore(ctx);
  const footer = dependencies.getFooterStatus(ctx);
  try {
    const workspace = core.codeWorkspace();
    const results = rankPresentedHits(operation === "search"
      ? await core.code.search({ workspace, text: query, mode: "semantic", limit: 10 })
      : await core.code.symbols({ workspace, text: query, limit: 20, requireUnresolved: false }));
    const status = await core.code.status(undefined, workspace);
    footer.recordProvider(core, status);
    const retrieval = core.code.retrievalStatus();
    appendAtelierReport(
      pi,
      ctx,
      operation === "search" ? "Code search" : "Symbol search",
      operation === "search"
        ? codeSearchMarkdown(query, results, retrieval)
        : codeSymbolsMarkdown(query, results, retrieval),
      `${results.length} ${operation === "search" ? "result" : "match"}(s) · ${retrieval.inventory.freshness}`,
    );
  } catch (error) {
    footer.markProviderOffline();
    throw error;
  } finally {
    await footer.refresh(ctx, core);
  }
}
