/**
 * stop-subagent-wiring.test.ts — the top-level stop path: the session's own
 * agent stops a child it spawned.
 *
 * The reply strings are not the interesting part. What matters is that a stop
 * lands for each status `manager.abort` supports (running, queued, paused),
 * that the run's own settle path cannot relabel an externally stopped agent,
 * that an agent the session does not own is refused, and that the caller is not
 * then notified about a completion it just cancelled.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { NOTIFICATION_HOLD_MS } from "../src/completion-outbox.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

type Tools = ReturnType<typeof makePi>["tools"];
type Lifecycle = ReturnType<typeof makePi>["lifecycle"];
type RunResult = Awaited<ReturnType<typeof runAgent>>;
type NestedManager = NonNullable<Parameters<typeof runAgent>[3]["nestedRuntime"]>["manager"];

/** What `index.ts` publishes on this global symbol for cross-extension callers. */
const MANAGER_KEY = Symbol.for("pi-subagents:manager");

interface ManagerRegistry {
  getRecord(id: string): AgentRecord | undefined;
}

/** The live record behind an id. Throws rather than returning a silent undefined. */
function recordOf(id: string): AgentRecord {
  const manager = (globalThis as unknown as Record<symbol, ManagerRegistry>)[MANAGER_KEY];
  const record = manager.getRecord(id);
  if (!record) throw new Error(`no live top-level record for ${id}`);
  return record;
}

let hermetic: Hermetic | undefined;
let lifecycle: Lifecycle | undefined;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
});

afterEach(async () => {
  await lifecycle?.get("session_shutdown")?.();
  // Released only on shutdown; a test that threw first would leave the next one
  // reading a dead manager through the global symbol.
  delete (globalThis as unknown as Record<symbol, unknown>)[MANAGER_KEY];
  lifecycle = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

function boot(settings: Record<string, unknown> = {}) {
  // Hermetic: the developer's real subagents.json must not decide concurrency.
  hermetic = hermeticDir({ settings: { outputTranscript: false, ...settings } });
  const b = makePi();
  subagentsExtension(b.pi);
  lifecycle = b.lifecycle;
  return b;
}

/** Enough of an AgentSession for the manager's and index's creation hooks. */
function fakeSession(): AgentSession {
  return {
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
  } as unknown as AgentSession;
}

/**
 * Runs that stay in flight until their abort signal fires, then report the
 * partial output a stopped run yields — the shape a real interrupt has.
 */
function interruptibleRuns() {
  vi.mocked(runAgent).mockImplementation(
    (_ctx, _type, _prompt, options) =>
      new Promise<RunResult>((resolve) => {
        const session = fakeSession();
        options.onSessionCreated?.(session);
        options.signal?.addEventListener("abort", () =>
          resolve({ responseText: "partial", session, aborted: true, steered: false }));
      }),
  );
}

/** Runs that never settle on their own, and record the prompt that started them. */
function pendingRuns() {
  const started: string[] = [];
  vi.mocked(runAgent).mockImplementation((_ctx, _type, prompt, options) => {
    started.push(prompt);
    options.onSessionCreated?.(fakeSession());
    return new Promise<RunResult>(() => {});
  });
  return started;
}

/** Runs that settle only when the returned map's resolver is called. */
function resolvableRuns() {
  const resolvers = new Map<string, () => void>();
  vi.mocked(runAgent).mockImplementation(
    (_ctx, _type, prompt, options) =>
      new Promise<RunResult>((resolve) => {
        const session = fakeSession();
        options.onSessionCreated?.(session);
        resolvers.set(prompt, () =>
          resolve({ responseText: "done", session, aborted: false, steered: false }));
      }),
  );
  return resolvers;
}

async function spawnBackground(
  tools: Tools,
  description: string,
  prompt = "go",
  name?: string,
): Promise<string> {
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt, description, subagent_type: "general-purpose", run_in_background: true, ...(name ? { name } : {}) },
    undefined,
    undefined,
    ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

const stop = (tools: Tools, agent_id: string) =>
  tools.get("stop_subagent").execute("tc-stop", { agent_id }, undefined, undefined, ctx());

describe("stop_subagent", () => {
  it("stops a running agent and reports the status it came from", async () => {
    const { tools } = boot();
    interruptibleRuns();

    const id = await spawnBackground(tools, "stop target");
    await flush();
    expect(recordOf(id).status).toBe("running");

    const result = await stop(tools, id);
    expect(textOf(result)).toContain(`Stopped agent ${id}`);
    expect(textOf(result)).toContain("running → stopped");
    expect(recordOf(id).status).toBe("stopped");
  });

  it("stops an agent addressed by the name it was given", async () => {
    const { tools } = boot();
    interruptibleRuns();

    const id = await spawnBackground(tools, "named agent", "go", "audit-auth");
    await flush();

    const result = await stop(tools, "audit-auth");
    expect(textOf(result)).toContain(`Stopped agent ${id}`);
    expect(recordOf(id).status).toBe("stopped");
  });

  it("keeps the external stop as the final status and does not notify the caller", async () => {
    // The run settles AFTER the stop (its abort listener resolves it), so the
    // manager's settle path runs on an already-stopped record: it must not
    // relabel it "aborted", and the completion it would otherwise announce is
    // a completion the caller asked to cancel.
    const { pi, tools } = boot();
    interruptibleRuns();

    const id = await spawnBackground(tools, "cancelled agent");
    await flush();
    pi.sendMessage.mockClear();

    await stop(tools, id);
    await flush();
    expect(recordOf(id).status).toBe("stopped");
    expect(recordOf(id).resultConsumed).toBe(true);

    // An idle parent's notification is held briefly before it is sent.
    await new Promise((r) => setTimeout(r, NOTIFICATION_HOLD_MS + 50));
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("removes a queued agent from the queue instead of starting it", async () => {
    const { tools } = boot({ maxConcurrent: 1 });
    const started = pendingRuns();

    await spawnBackground(tools, "running agent", "one");
    await flush();
    const queuedId = await spawnBackground(tools, "queued agent", "two");
    await flush();
    expect(recordOf(queuedId).status).toBe("queued");
    expect(started).toEqual(["one"]);

    const result = await stop(tools, queuedId);
    expect(textOf(result)).toContain("queued → stopped");
    expect(textOf(result)).toContain("never start");
    expect(recordOf(queuedId).status).toBe("stopped");
  });

  it("reports a finished agent instead of pretending to stop it", async () => {
    const { tools } = boot();
    const resolvers = resolvableRuns();

    const id = await spawnBackground(tools, "finished agent");
    await flush();
    resolvers.get("go")!();
    await flush();
    expect(recordOf(id).status).toBe("completed");

    const result = await stop(tools, id);
    expect(textOf(result)).toContain("Nothing to stop");
    expect(textOf(result)).toContain("completed");
    expect(recordOf(id).status).toBe("completed");
  });

  it("stops a paused agent and says its retained resources are released", async () => {
    const { tools } = boot();
    pendingRuns();

    const id = await spawnBackground(tools, "paused agent");
    await flush();
    // No real checkpoint exists in this harness — the runner is mocked — and
    // the record's status is what `abort()` branches on, so set the status the
    // turn-checkpoint would have left behind.
    const record = recordOf(id);
    record.status = "paused";

    const result = await stop(tools, id);
    expect(textOf(result)).toContain("paused → stopped");
    expect(textOf(result)).toContain("released");
    expect(record.status).toBe("stopped");
  });

  it("reports an unknown id as not found", async () => {
    const { tools } = boot();
    const result = await stop(tools, "no-such-agent");
    expect(textOf(result)).toContain("Agent not found");
  });

  it("refuses an agent owned by another agent", async () => {
    const { pi, tools } = boot();
    let nestedManager: NestedManager | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      nestedManager = options.nestedRuntime?.manager;
      options.onSessionCreated?.(fakeSession());
      return new Promise<RunResult>(() => {});
    });

    const topId = await spawnBackground(tools, "parent agent");
    await flush();
    if (!nestedManager) throw new Error("the spawn should have handed over the owning manager");
    const nestedId = nestedManager.spawn(pi, ctx(), "general-purpose", "nested", {
      description: "nested child",
      isBackground: true,
      parentAgentId: topId,
      depth: 2,
      maxSubagentDepth: 2,
    });
    await flush();

    const result = await stop(tools, nestedId);
    expect(textOf(result)).toContain("Agent not found");
    // The owner's child is untouched: its parent is the one that stops it.
    expect(nestedManager.getRecord(nestedId)?.status).toBe("running");
  });

  it("refuses an agent owned by a workflow", async () => {
    const { tools } = boot();
    pendingRuns();

    const id = await spawnBackground(tools, "workflow child");
    await flush();
    // `isTopLevelAgent` reads exactly this field, and a workflow's runner owns
    // its agents through it — setting it here is the record shape the guard has
    // to refuse. Kept off the registry lookup, which filters owned records out.
    const record = recordOf(id);
    record.workflowId = "wf-1";

    const result = await stop(tools, id);
    expect(textOf(result)).toContain("Agent not found");
    expect(record.status).toBe("running");
  });
});
