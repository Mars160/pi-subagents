/**
 * Agent tool wiring for `pause_turns` checkpoints: the schema the model reads,
 * the guidance to review before resuming, what is handed to the manager on a
 * spawn (and withheld on a resume), the schedule refusal, and the paused
 * foreground framing. Runner/manager behaviour is covered by the real e2e.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

vi.mock("../src/output-file.js", async () => {
  const actual = await vi.importActual<typeof import("../src/output-file.js")>("../src/output-file.js");
  return {
    ...actual,
    createOutputFilePath: vi.fn(() => "/tmp/fake-subagent.output"),
    writeInitialEntry: vi.fn(),
    ensureOutputFile: vi.fn(),
    streamToOutputFile: vi.fn(() => vi.fn()),
  };
});

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension, { formatPausedForeground } from "../src/index.js";
import { DEFAULT_PAUSE_TURNS } from "../src/turn-checkpoint.js";
import type { AgentRecord } from "../src/types.js";
import { type BootedPi, ctx, flush, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

/** The registry the extension publishes, so a test can read what the manager kept. */
const MANAGER_KEY = Symbol.for("pi-subagents:manager");

/** Pull the agent id out of a tool result — the same line the model parses. */
function agentIdOf(result: any): string {
  const id = /Agent ID:\s*(\S+)/.exec(textOf(result))?.[1];
  if (!id) throw new Error(`no agent id in result: ${textOf(result)}`);
  return id;
}

describe("Agent tool — pause_turns checkpoints", () => {
  let hermetic: ReturnType<typeof hermeticDir>;
  let booted: BootedPi;
  /** The session a spawned agent ends up holding, so it can be resumed. */
  let session: any;

  beforeEach(() => {
    // Only the manager's GC interval is faked: the eviction sweep is what turns a
    // record into a tombstone, and a test cannot wait ten minutes for it. Every
    // other timer (the nudge hold, the batch debounce) stays real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    hermetic = hermeticDir();
    booted = makePi();
    subagentsExtension(booted.pi);

    session = {
      messages: [{ role: "user", content: "first task" }],
      subscribe: vi.fn(() => vi.fn()),
      steer: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      await Promise.resolve();
      options.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed answer" } as any);
  });

  afterEach(async () => {
    // Releases the registry slot, so the next test's activation claims it.
    await booted.lifecycle.get("session_shutdown")?.({}, ctx());
    hermetic.restore();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function manager(): any {
    return (globalThis as any)[MANAGER_KEY];
  }

  function agentTool(): any {
    return booted.tools.get("Agent");
  }

  /** Spawn a background agent and let it settle, so the record is resumable. */
  async function spawnSettled(params: Record<string, unknown> = {}): Promise<string> {
    const res = await agentTool().execute(
      "spawn-call",
      { prompt: "first task", description: "First task", subagent_type: "general-purpose", run_in_background: true, ...params },
      undefined,
      undefined,
      ctx(),
    );
    const id = agentIdOf(res);
    await flush();
    return id;
  }

  async function resume(id: string, params: Record<string, unknown> = {}): Promise<any> {
    return agentTool().execute(
      "resume-call",
      { prompt: "keep going", description: "Keep going", subagent_type: "general-purpose", resume: id, run_in_background: true, ...params },
      undefined,
      undefined,
      ctx(),
    );
  }

  // The shape is the contract: `0` must be representable, the default stated.
  it("declares pause_turns as a non-negative integer stating its default", () => {
    const param = (agentTool().parameters.properties as Record<string, any>).pause_turns;
    expect(param.type).toBe("integer");
    expect(param.minimum).toBe(0);
    expect(param.description).toContain(String(DEFAULT_PAUSE_TURNS));
    expect(param.description).toMatch(/0 to disable checkpoints/i);
  });

  it("tells the model to review a checkpoint instead of resuming it blindly", () => {
    const description = agentTool().description as string;
    expect(description).toContain(`after ${DEFAULT_PAUSE_TURNS} turns`);
    expect(description).toMatch(/never resume it blindly/i);
    expect(description).toContain("pause_turns: 0");
  });

  // A scheduled job fires unattended, so a checkpoint could never be acted on.
  it("refuses to schedule a job when pause_turns is set", async () => {
    const res = await agentTool().execute(
      "schedule-call",
      { prompt: "nightly", description: "Nightly check", subagent_type: "general-purpose", schedule: "+10m", pause_turns: 5 },
      undefined,
      undefined,
      ctx(),
    );
    const text = textOf(res);
    expect(text).toContain("pause_turns");
    expect(text).toContain("schedule");
    // The refusal is the actionable error, not "the scheduler is not up yet".
    expect(text).not.toContain("Scheduler is not active");
  });

  it("hands the manager the default interval on a fresh spawn", async () => {
    const id = await spawnSettled();
    expect(manager().getRecord(id).pauseTurns).toBe(DEFAULT_PAUSE_TURNS);
  });

  it("passes an explicit interval through and keeps 0 as 'no checkpoints'", async () => {
    const seven = await spawnSettled({ pause_turns: 7 });
    expect(manager().getRecord(seven).pauseTurns).toBe(7);

    const off = await spawnSettled({ pause_turns: 0 });
    // 0 must mean "off", not collapse into "unset" and back to the default.
    // Whether the record spells that as 0 or as nothing is the manager's.
    expect(manager().getRecord(off).pauseTurns ?? 0).toBe(0);
  });

  // Inheritance is the hand-off's job: the tool must send nothing, or a
  // materialized default would re-enable checkpoints on a resume.
  it("inherits the interval on resume unless the caller names one", async () => {
    const id = await spawnSettled({ pause_turns: 0 });
    const intervalOf = () => manager().getRecord(id).pauseTurns ?? 0;

    await resume(id);
    await flush();
    expect(intervalOf()).toBe(0);

    await resume(id, { pause_turns: 3 });
    await flush();
    expect(manager().getRecord(id).pauseTurns).toBe(3);
  });

  it("inherits a live conversation's budget when resumed by mention", async () => {
    const id = await spawnSettled({ max_turns: 50 });
    const record = manager().getRecord(id);
    record.totalTurns = 12;

    await booted.lifecycle.get("input")!({ text: `@${record.handle} keep going`, source: "user" }, ctx());
    await flush();

    expect(vi.mocked(resumeAgent).mock.calls.at(-1)?.[2]).toMatchObject({ maxTurns: 50, turnOffset: 12 });
    expect(record.maxTurns).toBe(50);
  });

  // The pause notice is held ~200ms, and the record it captures is mutated by
  // the next segment: without cancelling it, a resume inside that window would
  // announce the paused segment off the resumed record.
  it("drops a checkpoint notice a resume has superseded", async () => {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      return { responseText: "partial", session, aborted: false, steered: false, paused: true };
    });
    const id = await spawnSettled();
    expect(manager().getRecord(id).status).toBe("paused");

    // Never settles, so nothing re-schedules over the held notice's window.
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));
    await resume(id);
    await new Promise((r) => setTimeout(r, 300));

    expect(booted.pi.sendMessage).not.toHaveBeenCalled();
  });

  /**
   * Archive a settled agent the way the sweep does: a session file on disk, the
   * budget it had reached, and a completedAt old enough to be evicted.
   */
  async function archive(id: string, budget: { pauseTurns?: number; maxTurns?: number; totalTurns?: number }): Promise<string> {
    const sessionFile = join(hermetic.dir, `${id}.session.jsonl`);
    writeFileSync(sessionFile, "{}");
    const record = manager().getRecord(id);
    record.sessionFile = sessionFile;
    Object.assign(record, budget);
    record.completedAt = Date.now() - 11 * 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager().getRecord(id)).toBeUndefined();
    return sessionFile;
  }

  // An archived conversation must be reopened on its OWN budget: a fresh
  // allowance (or a config-resolved ceiling) would be the max_turns bypass a
  // resume must never become.
  it("reopens an archived conversation on its own budget, not a fresh one", async () => {
    const id = await spawnSettled({ pause_turns: 3, max_turns: 50 });
    const sessionFile = await archive(id, { pauseTurns: 3, maxTurns: 50, totalTurns: 12 });

    const res = await resume(id);
    expect(textOf(res)).toContain("archived");
    const reopened = manager().getRecord(agentIdOf(res))!;
    expect(reopened.pauseTurns).toBe(3);
    expect(reopened.maxTurns).toBe(50);
    expect(reopened.totalTurns).toBe(12);

    // Reopening the conversation, not starting a new one.
    const options = vi.mocked(runAgent).mock.calls.at(-1)![3] as any;
    expect(options.resumeSessionFile).toBe(sessionFile);
    expect(options.turnOffset).toBe(12);
  });

  it("reopens an archived conversation from a mention on the same budget", async () => {
    const id = await spawnSettled({ pause_turns: 3, max_turns: 50 });
    const handle = manager().getRecord(id).handle as string;
    await archive(id, { pauseTurns: 3, maxTurns: 50, totalTurns: 12 });

    const result = await booted.lifecycle.get("input")!({ text: `@${handle} keep going`, source: "user" }, ctx());
    expect(result?.action).toBe("handled");
    await flush();

    // Reopened on the archived budget: the mention path hands the tombstone's
    // interval, ceiling and spent turns to the new segment.
    const options = vi.mocked(runAgent).mock.calls.at(-1)![3] as any;
    expect(options.resumeSessionFile).toBeDefined();
    expect(options.pauseTurns).toBe(3);
    expect(options.maxTurns).toBe(50);
    expect(options.turnOffset).toBe(12);
  });

  // The parent acts on this framing: tellable from a result, with id and progress.
  it("frames a paused result as partial, with the id to resume", () => {
    const record = {
      id: "agent-7",
      type: "general-purpose",
      description: "Checkpoint validation",
      status: "paused",
      result: "half-finished analysis",
      toolUses: 3,
      startedAt: 1_000,
      completedAt: 5_500,
      segmentTurns: 25,
      totalTurns: 50,
      pauseTurns: 25,
      maxTurns: 100,
    } as unknown as AgentRecord;

    const text = formatPausedForeground(record, "");
    expect(text).toContain("Agent ID: agent-7");
    expect(text).toContain('resume: "agent-7"');
    expect(text).toMatch(/paused/i);
    expect(text).toMatch(/partial/i);
    expect(text).toMatch(/unfinished/i);
    expect(text).toContain("half-finished analysis");
    expect(text).toContain("25 turns in this run");
    expect(text).toContain("50 turns in total");
    expect(text).toContain("3 tool uses");
    expect(text).not.toMatch(/completed/i);
  });

  it("omits counters it does not have instead of printing zeros", () => {
    const record = {
      id: "agent-8",
      type: "general-purpose",
      description: "Bare",
      status: "paused",
      result: "",
      toolUses: 0,
      startedAt: Date.now(),
    } as unknown as AgentRecord;

    const text = formatPausedForeground(record, "");
    expect(text).toContain("(nothing yet)");
    expect(text).not.toContain("turns in this run");
    expect(text).not.toContain("tool use");
  });
});

/**
 * A checkpoint is held open, so stopping it is the one way a caller declines to
 * resume — and the only path that gives back a worktree the checkpoint retained.
 * Driven against a real manager with the runner mocked, since what is under test
 * is the manager's own eligibility rule.
 */
describe("AgentManager — stopping a paused checkpoint", () => {
  it("stops a paused record without reporting the segment a second time", async () => {
    const reported: string[] = [];
    const manager = new AgentManager((r) => reported.push(r.status));
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "partial",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
      paused: true,
    });

    const id = manager.spawn(
      {} as any,
      { cwd: process.cwd(), sessionManager: { getSessionId: () => "s1" } } as any,
      "general-purpose",
      "task",
      { description: "task", isBackground: true },
    );
    const record = manager.getRecord(id)!;
    await record.promise;
    expect(record.status).toBe("paused");
    expect(reported).toEqual(["paused"]);

    expect(manager.abort(id)).toBe(true);
    expect(record.status).toBe("stopped");
    // The pause notification already covered this segment; a stop must not
    // re-announce it as a second settlement.
    expect(reported).toEqual(["paused"]);

    await manager.dispose();
  });
});
