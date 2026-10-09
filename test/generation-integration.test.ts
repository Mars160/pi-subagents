/**
 * Integration regression tests for client-observed generation timing: the REAL
 * `runAgent`/`resumeAgent` and `AgentManager` wired to a stubbed pi session.
 * Pure unit tests of `subscribeGeneration`/`addGeneration` live in
 * `generation.test.ts`.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventListener,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

const {
  createAgentSession,
  defaultResourceLoaderCtor,
  getAgentDir,
  sessionManagerInMemory,
  sessionManagerCreate,
  sessionManagerOpen,
  settingsManagerGetSessionDir,
  settingsManagerCreate,
} = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  defaultResourceLoaderCtor: vi.fn(),
  getAgentDir: vi.fn(() => "/mock/agent-dir"),
  sessionManagerInMemory: vi.fn(() => ({ kind: "memory-session-manager" })),
  sessionManagerCreate: vi.fn(() => ({ kind: "persistent-session-manager" })),
  sessionManagerOpen: vi.fn(() => ({ kind: "reopened-session-manager" })),
  settingsManagerGetSessionDir: vi.fn(() => undefined as string | undefined),
  settingsManagerCreate: vi.fn(() => ({ kind: "settings-manager", getSessionDir: settingsManagerGetSessionDir })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession,
  defineTool: (definition: unknown) => definition,
  DefaultResourceLoader: class {
    constructor(options: unknown) {
      defaultResourceLoaderCtor(options);
    }

    async reload() {}

    getExtensions() {
      return { extensions: [], errors: [], runtime: {} };
    }
  },
  getAgentDir,
  SessionManager: { inMemory: sessionManagerInMemory, create: sessionManagerCreate, open: sessionManagerOpen },
  SettingsManager: { create: settingsManagerCreate },
}));

// A minimal "general-purpose"-like agent: no extensions, no skills, no nested
// delegation — enough for the runner to reach its prompt without side paths.
vi.mock("../src/agent-types.js", () => ({
  BUILTIN_TOOL_NAMES: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  getConfig: vi.fn(() => ({
    displayName: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    promptMode: "replace",
  })),
  getAgentConfig: vi.fn(() => ({
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: "You are Explore.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
  })),
  getMemoryToolNames: vi.fn(() => []),
  getReadOnlyMemoryToolNames: vi.fn(() => []),
  getToolNamesForType: vi.fn(() => ["read"]),
}));

vi.mock("../src/env.js", () => ({
  detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })),
}));

vi.mock("../src/prompts.js", () => ({
  buildAgentPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../src/memory.js", () => ({
  buildMemoryBlock: vi.fn(() => ""),
  buildReadOnlyMemoryBlock: vi.fn(() => ""),
}));

vi.mock("../src/skill-loader.js", () => ({
  preloadSkills: vi.fn(() => []),
}));

vi.mock("../src/nested-tools.js", () => ({
  getMaxSubagentDepth: vi.fn(() => 2),
  createNestedSubagentTools: vi.fn(() => []),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => false),
}));

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import type { GenerationStats } from "../src/generation.js";
import { formatGenerationTps } from "../src/ui/agent-widget.js";

/** Prompt behaviour queued for each successive `session.prompt()` call. */
type PromptScript = (session: AgentSession, emit: (event: AgentSessionEvent) => void) => void;

/** Deterministic clocks. `subscribeGeneration` reads `performance.now()`; the
 *  manager timestamps records with `Date.now()`. Both are pinned per test so a
 *  measured duration is an assertion, not a function of test wall time. */
let clock = 0;
let wall = 1_000_000;
let nowSpy: MockInstance;
let dateSpy: MockInstance;
let promptScripts: PromptScript[] = [];

function createSession(): { session: AgentSession; emit: (event: AgentSessionEvent) => void } {
  const listeners: AgentSessionEventListener[] = [];
  const emit = (event: AgentSessionEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  // Faithful-enough stub: `subscribe` returns a REAL unsubscribe, because the
  // runner tears its generation/collector subscriptions down in `finally`, and
  // a stale listener from a previous run would keep firing.
  const session = {
    messages: [],
    subscribe: vi.fn((listener: AgentSessionEventListener) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    }),
    prompt: vi.fn(async () => {
      const script = promptScripts.shift();
      if (script) script(session, emit);
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => ["read"]),
    setActiveToolsByName: vi.fn(),
    getAllTools: vi.fn(() => []),
    agent: {},
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
    sessionManager: { getSessionFile: () => undefined },
  } as unknown as AgentSession;
  return { session, emit };
}

function assistantMessage(stopReason: AssistantMessage["stopReason"], output: number, costTotal = 0): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: {
      input: 10,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10 + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
    },
    stopReason,
    timestamp: 0,
  };
}

/** Emit one assistant stream whose measured generation window is exactly
 *  `durationMs` (first non-empty delta at `from`, `message_end` at `from + durationMs`). */
function emitStream(
  emit: (event: AgentSessionEvent) => void,
  opts: {
    from: number;
    durationMs: number;
    output: number;
    stopReason?: AssistantMessage["stopReason"];
    deltaType?: "text_delta" | "thinking_delta" | "toolcall_delta";
  },
) {
  const message = assistantMessage(opts.stopReason ?? "stop", opts.output);
  clock = opts.from;
  emit({ type: "message_start", message });
  clock = opts.from;
  emit({
    type: "message_update",
    message,
    assistantMessageEvent: {
      type: opts.deltaType ?? "text_delta",
      contentIndex: 0,
      delta: "token",
      partial: message,
    },
  });
  clock = opts.from + opts.durationMs;
  emit({ type: "message_end", message });
}

const ctx = {
  cwd: "/tmp",
  model: undefined,
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: vi.fn(() => "parent prompt"),
  sessionManager: {
    getBranch: vi.fn(() => []),
    getSessionFile: vi.fn(() => "/sessions/parent.jsonl"),
  },
} as unknown as ExtensionContext;

const pi = {} as unknown as ExtensionAPI;

let manager: AgentManager | undefined;

beforeEach(() => {
  clock = 0;
  wall = 1_000_000;
  promptScripts = [];
  nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
  dateSpy = vi.spyOn(Date, "now").mockImplementation(() => wall);
  createAgentSession.mockReset();
  createAgentSession.mockImplementation(async () => ({ session: createSession().session }));
  manager = undefined;
});

afterEach(async () => {
  await manager?.dispose();
  manager = undefined;
  nowSpy.mockRestore();
  dateSpy.mockRestore();
});

// ─── runner wiring ───────────────────────────────────────────────────────

describe("runAgent → onGeneration wiring", () => {
  it("reports one measured generation per successful assistant stream, starting at the first non-empty delta", async () => {
    const measured: GenerationStats[] = [];
    promptScripts.push((_session, emit) => {
      // First non-empty delta is the THINKING delta at t=500, not the text
      // delta at t=1000 — the window must start at 500.
      const message = assistantMessage("stop", 120);
      clock = 100;
      emit({ type: "message_start", message });
      clock = 500;
      emit({ type: "message_update", message, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm", partial: message } });
      clock = 1000;
      emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: message } });
      clock = 1500;
      emit({ type: "message_update", message, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "{}", partial: message } });
      clock = 3000;
      emit({ type: "message_end", message });
    });

    await runAgent(ctx, "Explore", "go", { pi, onGeneration: (stats) => measured.push(stats) });

    expect(measured).toEqual([{ outputTokens: 120, durationMs: 2500 }]);
  });

  it("does not fabricate generation for a message that streamed no deltas", async () => {
    const measured: GenerationStats[] = [];
    const seenUsage: number[] = [];
    promptScripts.push((_session, emit) => {
      const message = assistantMessage("stop", 100);
      clock = 0;
      emit({ type: "message_start", message });
      clock = 1000;
      emit({ type: "message_end", message });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onGeneration: (stats) => measured.push(stats),
      onAssistantUsage: (usage) => seenUsage.push(usage.output),
    });

    expect(measured).toEqual([]);
    // The usage callback is independent of the generation callback: a billed
    // message with no streamed output still reports tokens.
    expect(seenUsage).toEqual([100]);
  });

  it.each(["error", "aborted"] as const)("discards a %s stream while still reporting its usage", async (stopReason) => {
    const measured: GenerationStats[] = [];
    const seenUsage: number[] = [];
    promptScripts.push((_session, emit) => {
      emitStream(emit, { from: 0, durationMs: 2000, output: 100, stopReason });
      emitStream(emit, { from: 10_000, durationMs: 1000, output: 30 });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onGeneration: (stats) => measured.push(stats),
      onAssistantUsage: (usage) => seenUsage.push(usage.output),
    });

    // Only the successful follow-up stream counts; the failed/aborted one
    // contributes nothing to the rate, but its tokens are still billed.
    expect(measured).toEqual([{ outputTokens: 30, durationMs: 1000 }]);
    expect(seenUsage).toEqual([100, 30]);
  });
});

describe("resumeAgent → onGeneration wiring", () => {
  it("measures only the resumed turn's stream", async () => {
    const { session } = createSession();
    session.messages.push(assistantMessage("stop", 0));
    const measured: GenerationStats[] = [];
    promptScripts.push((_session, emit) => {
      emitStream(emit, { from: 0, durationMs: 1500, output: 80 });
    });

    await resumeAgent(session, "continue", { onGeneration: (stats) => measured.push(stats) });

    expect(measured).toEqual([{ outputTokens: 80, durationMs: 1500 }]);
    // The runner tore its subscription down; a later resume must not reach it.
    promptScripts.push((_session, emit) => emitStream(emit, { from: 0, durationMs: 500, output: 10 }));
    await resumeAgent(session, "again");
    expect(measured).toHaveLength(1);
  });
});

// ─── manager accumulation ────────────────────────────────────────────────

function spawnBackground(): string {
  return manager!.spawn(pi, ctx, "general-purpose", "go", { description: "gen", isBackground: true });
}

describe("AgentManager generation accumulation", () => {
  it("accumulates across spawn and foreground resume, using generation duration — not the reset task clock — as the denominator", async () => {
    manager = new AgentManager();

    // Run 1: 100 tokens over 2 s.
    promptScripts.push((_session, emit) => emitStream(emit, { from: 0, durationMs: 2000, output: 100 }));
    const id = spawnBackground();
    const record = manager.getRecord(id)!;
    await record.promise;
    expect(record.status).toBe("completed");
    expect(record.generation).toEqual({ outputTokens: 100, durationMs: 2000 });
    const startedAtRun1 = record.startedAt;
    expect(startedAtRun1).toBe(1_000_000);

    // Run 2 (foreground resume), 100 s of wall time after the spawn: 300 tokens
    // over 1 s of generation. The resume itself takes another 100 s of wall
    // time, so completedAt - startedAt is a genuinely different denominator.
    // `startedAt` is reset to the resume start; generation duration is NOT.
    wall = 1_100_000;
    promptScripts.push((_session, emit) => {
      wall += 100_000;
      emitStream(emit, { from: 0, durationMs: 1000, output: 300 });
    });
    await manager.resume(id, "again");

    expect(record.generation).toEqual({ outputTokens: 400, durationMs: 3000 });
    // The task clock did reset (this is the trap the generation counter avoids).
    expect(record.startedAt).toBe(1_100_000);
    expect(record.startedAt).not.toBe(startedAtRun1);
    expect(record.completedAt! - record.startedAt).toBe(100_000);
    // Rate is 400 / 3 s = 133.3 tok/s. A task-wall denominator
    // (completedAt - startedAt = 100 s) would have claimed 4.0 tok/s.
    expect(formatGenerationTps(record.generation)).toBe("133.3 tok/s");
    expect(formatGenerationTps(record.generation)).not.toBe("4.0 tok/s");
  });

  it("accumulates a detached background resume on top of the earlier runs", async () => {
    manager = new AgentManager();

    promptScripts.push((_session, emit) => emitStream(emit, { from: 0, durationMs: 2000, output: 100 }));
    const id = spawnBackground();
    const record = manager.getRecord(id)!;
    await record.promise;

    promptScripts.push((_session, emit) => emitStream(emit, { from: 0, durationMs: 1000, output: 300 }));
    await manager.resume(id, "again");
    expect(record.generation).toEqual({ outputTokens: 400, durationMs: 3000 });

    promptScripts.push((_session, emit) => emitStream(emit, { from: 0, durationMs: 500, output: 50 }));
    const detached = await manager.resume(id, "background", undefined, { isBackground: true });
    expect(detached).toBe(record);
    await record.promise;

    expect(record.status).toBe("completed");
    expect(record.generation).toEqual({ outputTokens: 450, durationMs: 3500 });
    expect(formatGenerationTps(record.generation)).toBe("128.6 tok/s");
  });

  it.each(["error", "aborted"] as const)("leaves generation undefined for a %s run, even though usage was billed", async (stopReason) => {
    manager = new AgentManager();

    promptScripts.push((_session, emit) => emitStream(emit, { from: 0, durationMs: 2000, output: 100, stopReason }));
    const id = spawnBackground();
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.generation).toBeUndefined();
    expect(formatGenerationTps(record.generation)).toBe("");
    // Billed tokens, as reported through the separate lifetime accumulator: the
    // absence of a rate is not the absence of usage.
    expect(record.lifetimeUsage.output).toBe(100);
  });

  it("does not fold a nested child's spend into the ancestor's generation", async () => {
    manager = new AgentManager();

    promptScripts.push((_session, emit) => emitStream(emit, { from: 0, durationMs: 2000, output: 100 }));
    const parentId = spawnBackground();
    const parent = manager.getRecord(parentId)!;
    await parent.promise;
    expect(parent.generation).toEqual({ outputTokens: 100, durationMs: 2000 });
    expect(parent.lifetimeUsage.output).toBe(100);

    // A nested child. `nested-tools.ts` books its spend onto every ancestor's
    // `lifetimeUsage` through exactly this option — reproduced here without
    // reaching through the nested tool surface.
    promptScripts.push((_session, emit) => emitStream(emit, { from: 0, durationMs: 4000, output: 500 }));
    const childId = manager.spawn(pi, ctx, "general-purpose", "child", {
      description: "child",
      isBackground: true,
      parentAgentId: parentId,
      depth: 2,
      onAssistantUsage: (usage) => {
        parent.lifetimeUsage.output += usage.output;
      },
    });
    const child = manager.getRecord(childId)!;
    await child.promise;

    // Usage is booked onto the ancestor (600 total) but its generation is the
    // child's own, never the ancestor's.
    expect(parent.lifetimeUsage.output).toBe(600);
    expect(parent.generation).toEqual({ outputTokens: 100, durationMs: 2000 });
    expect(child.generation).toEqual({ outputTokens: 500, durationMs: 4000 });
  });
});
