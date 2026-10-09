/** Client-observed generation timing, separate from task/tool wall time. */
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface GenerationStats {
  outputTokens: number;
  durationMs: number;
}

/**
 * Measure each successful assistant stream from its first non-empty output
 * delta to message_end. Includes streamed thinking and tool-call arguments;
 * excludes time-to-first-token, tools, retries and failed/aborted messages.
 * Token counts come from provider usage, never from character estimates.
 */
export function subscribeGeneration(
  session: Pick<AgentSession, "subscribe">,
  onGeneration: (stats: GenerationStats) => void,
  now: () => number = () => performance.now(),
): () => void {
  let firstDeltaAt: number | undefined;
  return session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start" && event.message.role === "assistant") {
      firstDeltaAt = undefined;
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if ((update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta")
        && update.delta.length > 0) {
        firstDeltaAt ??= now();
      }
    }
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    const started = firstDeltaAt;
    firstDeltaAt = undefined;
    if (started === undefined || event.message.stopReason === "error" || event.message.stopReason === "aborted") return;
    const outputTokens = event.message.usage?.output;
    const durationMs = now() - started;
    if (outputTokens > 0 && Number.isFinite(outputTokens) && durationMs > 0 && Number.isFinite(durationMs)) {
      onGeneration({ outputTokens, durationMs });
    }
  });
}

/** Only local measured output is accumulated, not nested agents' billed usage. */
export function addGeneration(target: GenerationStats | undefined, delta: GenerationStats): GenerationStats {
  return {
    outputTokens: (target?.outputTokens ?? 0) + delta.outputTokens,
    durationMs: (target?.durationMs ?? 0) + delta.durationMs,
  };
}
