import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { addGeneration, type GenerationStats, subscribeGeneration } from "../src/generation.js";

type StreamFn = AgentSession["agent"]["streamFunction"];
type GenerationSession = Parameters<typeof subscribeGeneration>[0];

/** `subscribeGeneration` measures the request itself, so the model and context
 *  are never inspected by the stub — only their types have to line up. */
const TEST_MODEL = {} as Parameters<StreamFn>[0];
const TEST_CONTEXT = { messages: [] } as Parameters<StreamFn>[1];

function harness() {
  let listener!: AgentSessionEventListener;
  let clock = 0;
  const cleanup = vi.fn();
  const measured: GenerationStats[] = [];
  // The real stream function is stubbed; `subscribeGeneration` swaps in a
  // wrapper around it and puts the stub back on cleanup.
  const original = vi.fn<StreamFn>(() => ({}) as ReturnType<StreamFn>);
  const agent: GenerationSession["agent"] = { streamFunction: original };
  const session: GenerationSession = {
    subscribe: (cb) => {
      listener = cb;
      return cleanup;
    },
    agent,
  };
  const start = () => subscribeGeneration(session, stats => measured.push(stats), () => clock);
  let unsubscribe = start();
  const message: AssistantMessage = {
    role: "assistant", content: [], api: "openai-completions", provider: "test", model: "test",
    usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 0,
  };
  const emit = (event: AgentSessionEvent, at: number) => { clock = at; listener(event); };
  return {
    measured, cleanup, original, agent, message, emit,
    unsubscribe: () => unsubscribe(),
    resubscribe: () => { unsubscribe = start(); },
    /** Calling the wrapped stream function — not `message_start` — opens the measured window. */
    request: (at: number) => { clock = at; agent.streamFunction(TEST_MODEL, TEST_CONTEXT); },
    update: (at: number, delta = "token", type: "text_delta" | "thinking_delta" | "toolcall_delta" = "text_delta") => {
      clock = at;
      listener({ type: "message_update", message, assistantMessageEvent: { type, contentIndex: 0, delta, partial: message } });
    },
    end: (at: number, stopReason: AssistantMessage["stopReason"] = "stop", output = 100) => {
      clock = at;
      listener({ type: "message_end", message: { ...message, stopReason, usage: { ...message.usage, output } } });
    },
  };
}

describe("generation timing", () => {
  it("measures from the stream request through message_end, including TTFT, and excludes the tool gap", () => {
    const h = harness();
    h.request(0);
    h.emit({ type: "message_start", message: h.message }, 30_000);
    h.update(40_000);
    h.end(45_000);
    // Tool execution happens between the two requests; only request time counts.
    h.request(90_000);
    h.update(91_000);
    h.end(95_000, "stop", 200);
    expect(h.measured).toEqual([{ outputTokens: 100, durationMs: 45_000 }, { outputTokens: 200, durationMs: 5_000 }]);
    expect(h.measured.reduce<GenerationStats | undefined>(addGeneration, undefined)).toEqual({ outputTokens: 300, durationMs: 50_000 });
    expect(h.original).toHaveBeenCalledTimes(2);
    expect(h.original).toHaveBeenCalledWith(TEST_MODEL, TEST_CONTEXT);
    h.unsubscribe();
    expect(h.cleanup).toHaveBeenCalledOnce();
  });

  it("measures a successful message even when it streamed no deltas", () => {
    const h = harness();
    h.request(1_000);
    h.emit({ type: "message_start", message: h.message }, 2_000);
    h.end(3_000);
    expect(h.measured).toEqual([{ outputTokens: 100, durationMs: 2_000 }]);
  });

  it.each(["error", "aborted"] as const)("discards a %s request and resets the window for the next one", stopReason => {
    const h = harness();
    h.request(0);
    h.update(1_000);
    h.end(2_000, stopReason);
    h.request(5_000);
    h.end(6_000);
    expect(h.measured).toEqual([{ outputTokens: 100, durationMs: 1_000 }]);
  });

  it("clears timing when the stream function throws and preserves the error", () => {
    const h = harness();
    const error = new Error("request failed");
    h.original.mockImplementationOnce(() => { throw error; });
    expect(() => h.request(0)).toThrow(error);
    h.end(1_000);
    expect(h.measured).toEqual([]);
    h.request(2_000);
    h.end(3_000);
    expect(h.measured).toEqual([{ outputTokens: 100, durationMs: 1_000 }]);
  });

  it("does not measure events without a stream request", () => {
    const h = harness();
    h.emit({ type: "message_start", message: h.message }, 0);
    h.update(1_000);
    h.end(2_000);
    expect(h.measured).toEqual([]);
    expect(h.original).not.toHaveBeenCalled();
  });

  it("restores the original stream function on cleanup and stops measuring", () => {
    const h = harness();
    h.request(0);
    h.end(1_000);
    expect(h.measured).toHaveLength(1);
    h.unsubscribe();
    expect(h.agent.streamFunction).toBe(h.original);
    h.request(2_000);
    h.end(3_000);
    expect(h.measured).toHaveLength(1);
    expect(h.original).toHaveBeenCalledTimes(2);
  });

  it("leaves a stream function replaced after subscription untouched", () => {
    const h = harness();
    const replacement = vi.fn<StreamFn>(() => ({}) as ReturnType<StreamFn>);
    h.agent.streamFunction = replacement;
    h.unsubscribe();
    expect(h.agent.streamFunction).toBe(replacement);
  });

  it("rewraps cleanly on resubscribe so a resumed turn keeps accumulating", () => {
    const h = harness();
    h.request(0);
    h.end(1_000);
    h.unsubscribe();
    expect(h.agent.streamFunction).toBe(h.original);
    h.resubscribe();
    expect(h.agent.streamFunction).not.toBe(h.original);
    h.request(5_000);
    h.end(6_000, "stop", 300);
    expect(h.measured).toEqual([{ outputTokens: 100, durationMs: 1_000 }, { outputTokens: 300, durationMs: 1_000 }]);
    expect(h.original).toHaveBeenCalledTimes(2);
  });

  it("does not double-count a repeated message_end", () => {
    const h = harness();
    h.request(0);
    h.end(1_000);
    h.end(2_000);
    expect(h.measured).toEqual([{ outputTokens: 100, durationMs: 1_000 }]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("omits invalid output usage %s", output => {
    const h = harness();
    h.request(0);
    h.end(1_000, "stop", output);
    expect(h.measured).toEqual([]);
  });

  it("omits a zero duration", () => {
    const h = harness();
    h.request(1_000);
    h.end(1_000);
    expect(h.measured).toEqual([]);
  });
});
