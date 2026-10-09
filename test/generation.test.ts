import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { addGeneration, type GenerationStats, subscribeGeneration } from "../src/generation.js";

function harness() {
  let listener!: AgentSessionEventListener;
  let clock = 0;
  const cleanup = vi.fn();
  const measured: GenerationStats[] = [];
  const unsubscribe = subscribeGeneration({ subscribe: (cb) => { listener = cb; return cleanup; } },
    stats => measured.push(stats), () => clock);
  const message: AssistantMessage = {
    role: "assistant", content: [], api: "openai-completions", provider: "test", model: "test",
    usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 0,
  };
  return {
    measured, cleanup, unsubscribe, message,
    emit: (event: AgentSessionEvent, at: number) => { clock = at; listener(event); },
    delta: (type: "text_delta" | "thinking_delta" | "toolcall_delta", at: number, delta = "token") => {
      clock = at;
      listener({ type: "message_update", message, assistantMessageEvent: { type, contentIndex: 0, delta, partial: message } });
    },
  };
}

describe("generation timing", () => {
  it.each(["text_delta", "thinking_delta", "toolcall_delta"] as const)("starts at first %s, excluding TTFT and tool gaps", type => {
    const h = harness();
    h.emit({ type: "message_start", message: h.message }, 0);
    h.delta(type, 10_000);
    h.delta("text_delta", 11_000);
    h.emit({ type: "message_end", message: h.message }, 12_000);
    h.emit({ type: "message_start", message: h.message }, 90_000);
    h.delta(type, 100_000);
    h.emit({ type: "message_end", message: { ...h.message, usage: { ...h.message.usage, output: 200 } } }, 104_000);
    expect(h.measured).toEqual([{ outputTokens: 100, durationMs: 2000 }, { outputTokens: 200, durationMs: 4000 }]);
    expect(h.measured.reduce<GenerationStats | undefined>(addGeneration, undefined)).toEqual({ outputTokens: 300, durationMs: 6000 });
    h.unsubscribe();
    expect(h.cleanup).toHaveBeenCalledOnce();
  });

  it("ignores empty deltas and non-assistant message starts", () => {
    const h = harness();
    h.delta("text_delta", 100, "");
    h.delta("thinking_delta", 1000);
    h.emit({ type: "message_start", message: { role: "user", content: "hello", timestamp: 0 } }, 1500);
    h.emit({ type: "message_end", message: h.message }, 2000);
    expect(h.measured).toEqual([{ outputTokens: 100, durationMs: 1000 }]);
  });

  it.each(["error", "aborted"] as const)("discards %s and resets timing for retries", stopReason => {
    const h = harness();
    h.delta("text_delta", 1000);
    h.emit({ type: "message_end", message: { ...h.message, stopReason } }, 2000);
    h.emit({ type: "message_start", message: h.message }, 5000);
    h.delta("text_delta", 10_000);
    h.emit({ type: "message_end", message: h.message }, 11_000);
    expect(h.measured).toEqual([{ outputTokens: 100, durationMs: 1000 }]);
  });

  it("does not fabricate timing for messages without deltas or double-count message_end", () => {
    const h = harness();
    h.emit({ type: "message_end", message: h.message }, 1000);
    expect(h.measured).toEqual([]);
    h.delta("text_delta", 2000);
    h.emit({ type: "message_end", message: h.message }, 3000);
    h.emit({ type: "message_end", message: h.message }, 4000);
    expect(h.measured).toHaveLength(1);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("omits invalid output usage %s", output => {
    const h = harness();
    h.delta("text_delta", 1000);
    h.emit({ type: "message_end", message: { ...h.message, usage: { ...h.message.usage, output } } }, 2000);
    expect(h.measured).toEqual([]);
  });

  it("omits a zero duration", () => {
    const h = harness();
    h.delta("text_delta", 1000);
    h.emit({ type: "message_end", message: h.message }, 1000);
    expect(h.measured).toEqual([]);
  });
});
