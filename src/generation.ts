/** Client-observed model request timing, separate from task/tool wall time. */
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface GenerationStats {
  outputTokens: number;
  durationMs: number;
}

/**
 * Measure each successful model request from streamFunction invocation to
 * message_end, including time-to-first-token and hidden reasoning. Excludes
 * tools, queueing, between-request retry backoff and failed/aborted messages.
 * Retries inside the provider's stream function remain part of request time.
 * Token counts come from provider usage, never from character estimates.
 */
export function subscribeGeneration(
  session: Pick<AgentSession, "subscribe"> & { agent: Pick<AgentSession["agent"], "streamFunction"> },
  onGeneration: (stats: GenerationStats) => void,
  now: () => number = () => performance.now(),
): () => void {
  let requestStartedAt: number | undefined;
  const originalStream = session.agent.streamFunction;
  const timedStream: typeof originalStream = (...args) => {
    requestStartedAt = now();
    try {
      return originalStream.apply(session.agent, args);
    } catch (error) {
      requestStartedAt = undefined;
      throw error;
    }
  };
  session.agent.streamFunction = timedStream;
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    const started = requestStartedAt;
    requestStartedAt = undefined;
    if (started === undefined || event.message.stopReason === "error" || event.message.stopReason === "aborted") return;
    const outputTokens = event.message.usage?.output;
    const durationMs = now() - started;
    if (outputTokens > 0 && Number.isFinite(outputTokens) && durationMs > 0 && Number.isFinite(durationMs)) {
      onGeneration({ outputTokens, durationMs });
    }
  });
  return () => {
    unsubscribe();
    if (session.agent.streamFunction === timedStream) session.agent.streamFunction = originalStream;
    requestStartedAt = undefined;
  };
}

/** Only local measured output is accumulated, not nested agents' billed usage. */
export function addGeneration(target: GenerationStats | undefined, delta: GenerationStats): GenerationStats {
  return {
    outputTokens: (target?.outputTokens ?? 0) + delta.outputTokens,
    durationMs: (target?.durationMs ?? 0) + delta.durationMs,
  };
}
