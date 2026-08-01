import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export async function showAtelierPhase(ctx: ExtensionContext, message: string): Promise<void> {
  ctx.ui.setWorkingMessage?.(`Atelier: ${message}…`);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export function clearAtelierPhase(ctx: ExtensionContext): void {
  ctx.ui.setWorkingMessage?.();
}
