// Turn checkpoints (`pause_turns`) at the manager boundary: what a `paused` run
// result does to the record, what a resume inherits and what it may override, the
// cumulative turn ceiling and the budget a tombstone carries, the worktree a
// checkpoint keeps and gives back, a stop that lands mid-resume, and what the
// sweeps leave alone.
//
// The runner is mocked deliberately: this file is about what the manager does
// with a `paused` outcome and what it hands to the runner for the NEXT segment.
// Real checkpoint behaviour end to end — a faux model pausing mid-run, the
// ceiling taking precedence over the interval — is covered by
// test/pause-turns-e2e.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
  // The manager resolves a conversation's cumulative ceiling and the grace window
  // through the runner rather than re-deriving them. 20 stands in for a project
  // default the real resolver would pick up from config; 0 means "no ceiling".
  resolveEffectiveMaxTurns: vi.fn((_type: string, explicit?: number) => (explicit === undefined ? 20 : explicit || undefined)),
  normalizeMaxTurns: vi.fn((n?: number) => (n ? n : undefined)),
  getGraceTurns: vi.fn(() => 5),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(async () => {}),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import type { AgentRecord } from "../src/types.js";
import { cleanupWorktree, createWorktree } from "../src/worktree.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/repo" } as any;
const worktree = { path: "/tmp/pi-agent-a", branch: "pi-agent-a", baseSha: "abc", workPath: "/tmp/pi-agent-a" };

/** Let the manager's own settle handlers (all async) run. */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

interface Outcome {
  text?: string;
  paused?: boolean;
  aborted?: boolean;
  steered?: boolean;
  failure?: string;
  /** Turns to report through `onTurnEnd` before settling. */
  turns?: number;
}

/**
 * `runAgent`, settling only when the test says so — a checkpoint is a decision
 * the runner makes at a turn boundary, so the test has to make it too. Turns are
 * reported through the manager's own callback, exactly as the runner would.
 */
function scriptSpawn() {
  const pending = new Map<string, (outcome: Outcome) => void>();
  vi.mocked(runAgent).mockClear();
  vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, prompt: any, options: any) =>
    new Promise<any>(resolve => {
      // Handed over as soon as the runner has it: the session file the manager
      // reads off it here is the only trace a tombstone can reopen later.
      const session = { dispose: vi.fn(), sessionManager: { getSessionFile: () => "/tmp/pi-session.jsonl" } };
      options.onSessionCreated?.(session);
      pending.set(prompt as string, outcome => {
        if (outcome.turns !== undefined) options.onTurnEnd?.(outcome.turns);
        resolve({
          responseText: outcome.text ?? `${prompt}-result`,
          session,
          aborted: outcome.aborted ?? false,
          steered: outcome.steered ?? false,
          ...(outcome.paused !== undefined ? { paused: outcome.paused } : {}),
          ...(outcome.failure !== undefined ? { failure: outcome.failure } : {}),
        });
      });
    }),
  );
  return pending;
}

/** `resumeAgent`, keeping the options the manager passed for each segment. */
function scriptResume() {
  const calls: { prompt: string; options: any }[] = [];
  const pending = new Map<string, (outcome: Outcome) => void>();
  vi.mocked(resumeAgent).mockClear();
  vi.mocked(resumeAgent).mockImplementation((_session: any, prompt: any, options: any) => {
    calls.push({ prompt: prompt as string, options });
    return new Promise<any>(resolve => {
      pending.set(prompt as string, outcome => {
        if (outcome.turns !== undefined) options.onTurnEnd?.(outcome.turns);
        resolve({
          text: outcome.text ?? `${prompt}-result`,
          ...(outcome.failure !== undefined ? { failure: outcome.failure } : {}),
          ...(outcome.paused !== undefined ? { paused: outcome.paused } : {}),
          ...(outcome.aborted !== undefined ? { aborted: outcome.aborted } : {}),
          ...(outcome.steered !== undefined ? { steered: outcome.steered } : {}),
        });
      });
    });
  });
  return { calls, pending };
}

const lastOptions = (calls: { options: any }[]) => calls[calls.length - 1].options;

describe("turn checkpoints — lifecycle", () => {
  let manager: AgentManager;
  let completed: AgentRecord[];

  beforeEach(() => {
    completed = [];
    manager = new AgentManager(record => { completed.push(record); });
    vi.mocked(createWorktree).mockReset();
    vi.mocked(cleanupWorktree).mockClear();
    vi.mocked(cleanupWorktree).mockImplementation(async () => ({ hasChanges: false }));
  });

  afterEach(async () => {
    await manager?.dispose();
  });

  /** Spawn `a`, pause it after `turns`, and hand back its id. */
  async function pausedAgent(turns: number, options: Record<string, unknown> = {}) {
    const spawn = scriptSpawn();
    const waiting = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "a", {
      description: "a",
      pauseTurns: 3,
      ...options,
    });
    if (options.isolation === "worktree") await flush();
    spawn.get("a")!({ paused: true, turns, text: "partial" });
    const { id, record } = await waiting;
    expect(record.status).toBe("paused");
    return id;
  }

  it("settles a foreground run as paused, with the counters the notification reads", async () => {
    const spawn = scriptSpawn();
    const waiting = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "a", {
      description: "a",
      pauseTurns: 3,
    });
    spawn.get("a")!({ paused: true, turns: 3, text: "partial" });
    const { record } = await waiting;

    expect(record.status).toBe("paused");
    // The partial output is kept, and framed as partial by the callers that read
    // the status — it is not a result.
    expect(record.result).toBe("partial");
    expect(record.pauseTurns).toBe(3);
    expect(record.segmentTurns).toBe(3);
    expect(record.totalTurns).toBe(3);
    // The ceiling is the runner's own resolved value, kept on the record so later
    // segments inherit it.
    expect(record.maxTurns).toBe(20);
    // `completedAt` marks the end of the SEGMENT, checkpoint or not — the status
    // is what says the run is unfinished. The session stays for the next segment.
    expect(record.completedAt).toBeGreaterThan(0);
    expect(record.session).toBeDefined();

    const options = vi.mocked(runAgent).mock.calls[0][3] as any;
    expect(options.pauseTurns).toBe(3);
    expect(options.maxTurns).toBe(20);
    expect(options.turnOffset).toBe(0);
  });

  it("notifies a background checkpoint through onComplete and frees its slot", async () => {
    manager.setMaxConcurrent(1);
    const spawn = scriptSpawn();
    manager.spawn(mockPi, mockCtx, "general-purpose", "bg1", { description: "bg1", isBackground: true, pauseTurns: 3 });
    manager.spawn(mockPi, mockCtx, "general-purpose", "bg2", { description: "bg2", isBackground: true });
    const recordOf = (description: string) => manager.listAgents().find(a => a.description === description)!;
    expect(recordOf("bg2").status).toBe("queued");

    spawn.get("bg1")!({ paused: true, turns: 3 });
    await flush();

    // Through the ordinary completion callback, with the paused status the UI
    // frames as a checkpoint rather than a finish — and the counters it needs.
    expect(completed.map(r => r.status)).toEqual(["paused"]);
    expect(completed[0].totalTurns).toBe(3);
    expect(completed[0].segmentTurns).toBe(3);
    // A checkpoint is not burning tokens, so the slot it held is back.
    expect(recordOf("bg1").status).toBe("paused");
    expect(recordOf("bg2").status).toBe("running");
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it("stops the nested children a checkpointed segment spawned", async () => {
    const spawn = scriptSpawn();
    const waiting = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "a", {
      description: "a",
      pauseTurns: 3,
    });
    const parentId = manager.listAgents().find(a => a.description === "a")!.id;
    manager.spawn(mockPi, mockCtx, "general-purpose", "child", {
      description: "child",
      isBackground: true,
      parentAgentId: parentId,
    });
    const child = manager.listAgents().find(a => a.description === "child")!;
    expect(child.status).toBe("running");

    spawn.get("a")!({ paused: true, turns: 3 });
    await waiting;

    // A checkpoint is not permission for hidden work to keep burning tokens: the
    // segment's children stop with it, and a resumed segment can start them again.
    expect(child.status).toBe("stopped");
  });

  it("resumes with the inherited interval, ceiling and turn offset", async () => {
    const id = await pausedAgent(3);
    const resume = scriptResume();

    const waiting = manager.resume(id, "b");
    resume.pending.get("b")!({ paused: true, turns: 2 });
    const record = (await waiting)!;

    const options = lastOptions(resume.calls);
    expect(options.pauseTurns).toBe(3);
    expect(options.maxTurns).toBe(20);
    // The conversation's count continues; the segment starts at 0.
    expect(options.turnOffset).toBe(3);
    expect(record.status).toBe("paused");
    expect(record.segmentTurns).toBe(2);
    expect(record.totalTurns).toBe(5);
    expect(record.pauseTurns).toBe(3);
  });

  it("lets a resume change the interval, including turning checkpoints off with 0", async () => {
    const id = await pausedAgent(3);
    const resume = scriptResume();

    const changed = manager.resume(id, "b", undefined, { pauseTurns: 7 });
    resume.pending.get("b")!({ paused: true, turns: 7 });
    expect(lastOptions(resume.calls).pauseTurns).toBe(7);
    expect((await changed)!.pauseTurns).toBe(7);

    // 0 is the runner's spelling for "off", and it clears the inherited interval
    // for this and every later segment.
    const off = manager.resume(id, "c", undefined, { pauseTurns: 0 });
    resume.pending.get("c")!({ turns: 1 });
    expect(lastOptions(resume.calls).pauseTurns).toBeUndefined();
    const record = (await off)!;
    expect(record.status).toBe("completed");
    expect(record.pauseTurns).toBeUndefined();
    // 3 turns, then a 7-turn segment, then 1 — the total never resets.
    expect(record.totalTurns).toBe(11);
    expect(record.segmentTurns).toBe(1);
  });

  it("applies a maxTurns override and inherits the stored ceiling otherwise", async () => {
    // The spawn's invocation snapshot carries a ceiling of its own: a resume that
    // fell back to it instead of the record would resurrect 20 after `d` clears it.
    const id = await pausedAgent(3, { invocation: { maxTurns: 20 } });
    const resume = scriptResume();

    const raised = manager.resume(id, "b", undefined, { maxTurns: 50 });
    resume.pending.get("b")!({ paused: true, turns: 1 });
    expect(lastOptions(resume.calls).maxTurns).toBe(50);
    expect((await raised)!.maxTurns).toBe(50);

    const inherited = manager.resume(id, "c");
    resume.pending.get("c")!({ turns: 1 });
    expect(lastOptions(resume.calls).maxTurns).toBe(50);
    expect((await inherited)!.maxTurns).toBe(50);

    // 0 is the runner's spelling for "no ceiling", so an explicit one clears it.
    const cleared = manager.resume(id, "d", undefined, { maxTurns: 0 });
    resume.pending.get("d")!({ turns: 1 });
    // The runner gets the sentinel, not `undefined`: re-resolving that would
    // re-apply the agent's config and the current project default.
    expect(lastOptions(resume.calls).maxTurns).toBe(0);
    expect((await cleared)!.maxTurns).toBeUndefined();

    // ...and it stays cleared for the next segment: the spawn's immutable
    // invocation snapshot must not hand the old ceiling back.
    const afterClear = manager.resume(id, "e");
    resume.pending.get("e")!({ turns: 1 });
    expect(lastOptions(resume.calls).maxTurns).toBe(0);
    expect((await afterClear)!.maxTurns).toBeUndefined();
  });

  it("keeps a ceiling that was resolved as unlimited at spawn", async () => {
    const spawn = scriptSpawn();
    const waiting = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "a", {
      description: "a",
      pauseTurns: 3,
      maxTurns: 0,
    });
    spawn.get("a")!({ paused: true, turns: 3 });
    const { id, record } = await waiting;
    expect(record.maxTurns).toBeUndefined();
    // The runner re-resolves `undefined` against the agent's config and the project
    // default, so the manager has to pass 0 — the runner's spelling for "no ceiling" —
    // or the cap it was asked to drop comes back on the first run.
    expect((vi.mocked(runAgent).mock.calls[0][3] as any).maxTurns).toBe(0);

    // No override: the record keeps the ceiling it was created with, and the
    // runner gets 0 — `undefined` would re-resolve the project default against a
    // record that has no ceiling.
    const resume = scriptResume();
    const resumed = manager.resume(id, "b");
    resume.pending.get("b")!({ paused: true, turns: 1 });
    await resumed;
    expect(lastOptions(resume.calls).maxTurns).toBe(0);
  });

  it("refuses a second resume while a foreground resume is in flight", async () => {
    const id = await pausedAgent(3);
    const resume = scriptResume();
    const waiting = manager.resume(id, "b");

    await expect(manager.resume(id, "again")).resolves.toBeUndefined();
    expect(resume.calls).toHaveLength(1);

    // The first run is untouched and still the one that settles the record.
    resume.pending.get("b")!({ paused: true, turns: 1 });
    expect((await waiting)!.status).toBe("paused");
  });

  it("lets a stop end a foreground resume, and keeps the stopped status", async () => {
    vi.mocked(createWorktree).mockResolvedValue(worktree as any);
    const id = await pausedAgent(3, { isolation: "worktree" });

    const resume = scriptResume();
    const waiting = manager.resume(id, "b");
    const signal = lastOptions(resume.calls).signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    // The viewer's stop reaches THIS run: the record holds a fresh controller, not
    // the settled one from the segment that paused.
    expect(manager.abort(id)).toBe(true);
    expect(signal.aborted).toBe(true);

    // Even a checkpoint outcome must not resurrect the paused status or keep the
    // worktree the stop gave up.
    resume.pending.get("b")!({ paused: true, turns: 1 });
    const record = await waiting;
    expect(record.status).toBe("stopped");
    await flush();
    expect(cleanupWorktree).toHaveBeenCalledTimes(1);
  });

  it("does not report a stopped foreground resume as finished", async () => {
    const id = await pausedAgent(3);
    const resume = scriptResume();
    const waiting = manager.resume(id, "b");

    manager.abort(id);
    resume.pending.get("b")!({ turns: 1 });

    // The runner finished its turn; the stop still wins.
    expect((await waiting)!.status).toBe("stopped");
  });

  it("refuses a resume once the ceiling and its grace turns are spent", async () => {
    // 20 turns + 5 grace is exactly where the runner's own hard stop sits.
    const id = await pausedAgent(25);
    expect(manager.getRecord(id)!.totalTurns).toBe(25);

    const resume = scriptResume();
    await expect(manager.resume(id, "b")).rejects.toThrow(/whole turn budget/);
    expect(resumeAgent).not.toHaveBeenCalled();
    // Left untouched, so the caller can still decide to spend more.
    expect(manager.getRecord(id)!.status).toBe("paused");

    // Raising the ceiling is how the same conversation continues.
    const raised = manager.resume(id, "c", undefined, { maxTurns: 40 });
    resume.pending.get("c")!({ turns: 1 });
    expect((await raised)!.status).toBe("completed");
  });

  it("reopens a conversation with the turns it already spent counted against it", async () => {
    const spawn = scriptSpawn();
    const waiting = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "again", {
      description: "again",
      pauseTurns: 3,
      turnOffset: 15,
    });
    spawn.get("again")!({ turns: 2 });
    const { record } = await waiting;

    const options = vi.mocked(runAgent).mock.calls[0][3] as any;
    expect(options.turnOffset).toBe(15);
    expect(options.maxTurns).toBe(20);
    // 15 spent before it was archived, plus this segment's 2.
    expect(record.totalTurns).toBe(17);
    expect(record.segmentTurns).toBe(2);
  });

  it("refuses to reopen a conversation with nothing left to spend", () => {
    scriptSpawn();

    // 20 turns + 5 grace is where the runner's own hard stop sits, so a reopened
    // conversation that already reached it would only be aborted on its first turn.
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "again", {
      description: "again",
      pauseTurns: 3,
      turnOffset: 25,
    })).toThrow(/whole turn budget/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("keeps the worktree across a checkpoint and gives it back when the conversation ends", async () => {
    vi.mocked(createWorktree).mockResolvedValue(worktree as any);
    const id = await pausedAgent(3, { isolation: "worktree" });

    // Nothing was cleaned up at the checkpoint: the resumed segment has to keep
    // working in the same directory.
    expect(cleanupWorktree).not.toHaveBeenCalled();
    expect(manager.getRecord(id)!.worktree).toEqual(worktree);

    const resume = scriptResume();
    const waiting = manager.resume(id, "b");
    resume.pending.get("b")!({ turns: 1 });
    const record = (await waiting)!;

    expect(record.status).toBe("completed");
    expect(cleanupWorktree).toHaveBeenCalledTimes(1);
    const [, baseCwd, cleaned, description] = vi.mocked(cleanupWorktree).mock.calls[0];
    expect(baseCwd).toBe("/repo");
    expect(cleaned).toEqual(worktree);
    expect(description).toBe("a");
  });

  it("stops a paused agent on abort and gives its worktree back", async () => {
    vi.mocked(createWorktree).mockResolvedValue(worktree as any);
    const id = await pausedAgent(3, { isolation: "worktree" });
    expect(cleanupWorktree).not.toHaveBeenCalled();

    expect(manager.abort(id)).toBe(true);
    await flush();

    const record = manager.getRecord(id)!;
    expect(record.status).toBe("stopped");
    expect(record.completedAt).toBeGreaterThan(0);
    expect(cleanupWorktree).toHaveBeenCalledTimes(1);

    // Idempotent: nothing left to stop, and nothing left to clean up.
    expect(manager.abort(id)).toBe(false);
    await flush();
    expect(cleanupWorktree).toHaveBeenCalledTimes(1);
  });
});

// Fake timers have to be installed before `new AgentManager()` — the constructor
// starts the sweep interval — so the GC half lives in its own describe block.
describe("turn checkpoints — sweep", () => {
  let manager: AgentManager | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await manager?.dispose();
    manager = undefined;
    vi.useRealTimers();
  });

  it("keeps a paused record, and its worktree, out of the ten-minute sweep", async () => {
    vi.mocked(cleanupWorktree).mockClear();
    vi.mocked(cleanupWorktree).mockImplementation(async () => ({ hasChanges: false }));
    vi.mocked(createWorktree).mockResolvedValue(worktree as any);
    manager = new AgentManager();

    const spawn = scriptSpawn();
    const paused = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "paused", {
      description: "paused",
      pauseTurns: 3,
      isolation: "worktree",
    });
    await vi.advanceTimersByTimeAsync(0);
    spawn.get("paused")!({ paused: true, turns: 3 });
    await vi.advanceTimersByTimeAsync(0);
    const { id } = await paused;

    // A finished agent in the same window, to prove the sweep really ran.
    const done = scriptSpawn();
    const finished = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "done", { description: "done" });
    await vi.advanceTimersByTimeAsync(0);
    done.get("done")!({ turns: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await finished;

    await vi.advanceTimersByTimeAsync(11 * 60_000);

    expect(manager.listAgents().map(a => a.description)).toEqual(["paused"]);
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("paused");
    // The copy is still there for the segment that resumes it.
    expect(record.worktree).toEqual(worktree);
    expect(cleanupWorktree).not.toHaveBeenCalled();
  });

  it("carries a finished conversation's budget into its tombstone", async () => {
    manager = new AgentManager();

    const spawn = scriptSpawn();
    const waiting = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "done", {
      description: "done",
      pauseTurns: 3,
    });
    await vi.advanceTimersByTimeAsync(0);
    spawn.get("done")!({ turns: 4 });
    await vi.advanceTimersByTimeAsync(0);
    expect((await waiting).record.status).toBe("completed");

    await vi.advanceTimersByTimeAsync(11 * 60_000);

    expect(manager.listAgents()).toEqual([]);
    const [entry] = manager.listTombstones();
    expect(entry.description).toBe("done");
    // The counters outlive the record: `@handle` reopens this conversation from
    // disk, and it must continue against what it already spent.
    expect(entry.pauseTurns).toBe(3);
    expect(entry.totalTurns).toBe(4);
    expect(entry.maxTurns).toBe(20);
  });
});
