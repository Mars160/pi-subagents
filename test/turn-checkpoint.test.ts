/**
 * turn-checkpoint.test.ts — the SDK contract `src/turn-checkpoint.ts` rests on.
 *
 * `createFakeSdk` drives the control flow of the installed pi-agent-core rather
 * than a plain object mock, because the ORDER is the whole point:
 *
 *   agent-loop.js      run a turn → ask `finishTurn({message, toolResults, …})`
 *                      → emit `turn_end` → stop when it returns `{action:"end"}`.
 *                      An error/aborted stop calls the hook too, but ignores its
 *                      decision and returns.
 *   agent-session.js   `_runAgentPrompt`: `await agent.prompt()`, then
 *                      `while (await _handlePostAgentRun()) await agent.continue()`,
 *                      where the handler continues on its own for a retryable
 *                      error, a needed compaction, or queued messages.
 *
 * `test/pause-turns-e2e.test.ts` covers the same mechanism against a real
 * session. This file covers what a scripted faux model cannot reach: chaining an
 * installed hook, the restore path, compaction suppression being observable at
 * all, turns the hook never sees, and a session missing these members entirely.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PAUSE_TURNS,
  installTurnCheckpoint,
  normalizePauseTurns,
  type TurnCheckpointOptions,
} from "../src/turn-checkpoint.js";

/** The SDK's turn-boundary hook, keyed off the public session type. */
type FinishTurn = NonNullable<AgentSession["agent"]["finishTurn"]>;

/** The context the SDK hands the turn hook. */
type TurnBoundary = Parameters<FinishTurn>[0];

interface FakeOptions {
  /** Turns a prompt runs when nothing stops it. */
  turns: number;
  /** Tool results each turn produces. 0 = a plain text completion. */
  toolResultsPerTurn?: number;
  /** 1-based turns that end in a provider error: the hook runs, its decision is ignored. */
  errorTurns?: number[];
  /** Let the post-run handler retry an error turn through `agent.continue()`. */
  retryErrors?: boolean;
  /** Queue a follow-up at `agent_end`, the way an extension handler would. */
  queueAtEnd?: boolean;
  /** Make the post-run handler want a compaction. */
  needsCompaction?: boolean;
  compactionEnabled?: boolean;
}

/** A session that runs the SDK's real control flow with a scripted model. */
function createFakeSdk(options: FakeOptions) {
  const state = {
    /** Turns the current prompt has run — the caller's `turn_end` count. */
    segmentTurns: 0,
    /** Turns every prompt has run. */
    totalTurns: 0,
    /** Times the SDK's own continuation ran — a turn started after the loop. */
    continueCalls: 0,
    /** The `enabled` flag the post-run handler saw on each compaction check. */
    compactionChecks: [] as boolean[],
  };
  // Fresh per call, like SettingsManager.getCompactionSettings().
  const compaction = {
    enabled: options.compactionEnabled ?? false,
    reserveTokens: 1_000,
    keepRecentTokens: 100,
  };
  const queued: string[] = [];
  const listeners: Array<(event: unknown) => void> = [];
  const messages: Array<{ role: string }> = [];

  // `continue`/`hasQueuedMessages` are prototype methods and `finishTurn` is an
  // own field on the real Agent — same shape here.
  const agent = Object.create({
    async continue() {
      state.continueCalls += 1;
      queued.splice(0);
      await runTurns();
    },
    hasQueuedMessages: () => queued.length > 0,
  }) as {
    finishTurn?: FinishTurn;
    continue: () => Promise<void>;
    hasQueuedMessages: () => boolean;
  };
  agent.finishTurn = undefined;

  const settingsManager = {
    compaction,
    getCompactionSettings: () => ({ ...compaction }),
  };

  let lastAssistantMessage: { role: string; stopReason?: string } | undefined;

  /** agent-loop.js's runLoop: turns until the turn hook ends them or an error stop returns. */
  async function runTurns() {
    while (state.totalTurns < options.turns) {
      state.totalTurns += 1;
      const isError = (options.errorTurns ?? []).includes(state.totalTurns);
      const message = { role: "assistant", stopReason: isError ? "error" : "toolUse", content: [] };
      const toolResults = isError || (options.toolResultsPerTurn ?? 1) === 0
        ? []
        : Array.from({ length: options.toolResultsPerTurn ?? 1 }, () => ({ role: "toolResult" }));
      messages.push(message, ...toolResults);
      lastAssistantMessage = message;
      // The hook runs before `turn_end`, and an error stop runs it too.
      const decision = await agent.finishTurn?.(
        { message, toolResults, context: {}, newMessages: [] } as unknown as TurnBoundary,
        undefined,
      );
      // The caller's counter is the `turn_end` count, so it advances after the hook.
      state.segmentTurns += 1;
      for (const listener of [...listeners]) listener({ type: "turn_end" });
      // An error stop returns without honoring the decision, exactly as pi does.
      if (isError) return;
      if (decision?.action === "end") return;
    }
  }

  /** `AgentSession._handlePostAgentRun`, reduced to the reasons it continues. */
  async function handlePostAgentRun(): Promise<boolean> {
    const message = lastAssistantMessage;
    lastAssistantMessage = undefined;
    if (!message) return false;
    const enabled = settingsManager.getCompactionSettings().enabled;
    state.compactionChecks.push(enabled);
    if (message.stopReason === "error" && options.retryErrors) return true;
    if (enabled && options.needsCompaction) return true;
    return queued.length > 0;
  }

  const session = {
    agent,
    settingsManager,
    messages,
    subscribe(listener: (event: unknown) => void) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    steerCalls: [] as string[],
    steer(message: string) {
      session.steerCalls.push(message);
    },
    abortCalls: 0,
    abort() {
      session.abortCalls += 1;
    },
    async prompt() {
      state.segmentTurns = 0;
      await runTurns();
      if (options.queueAtEnd) queued.push("nudge");
      for (const listener of [...listeners]) listener({ type: "agent_end" });
      while (await handlePostAgentRun()) await agent.continue();
    },
  };

  return {
    session,
    agent,
    state,
    queued,
    /** Queue a steering/follow-up message the way a running turn would. */
    queue: (text: string) => queued.push(text),
    settingsManager,
    compaction,
  };
}

/** Install as the runner does: with the caller's own turn counter. */
function install(
  fake: ReturnType<typeof createFakeSdk>,
  pauseTurns: number,
  extra: Partial<TurnCheckpointOptions> = {},
) {
  return installTurnCheckpoint(fake.session as unknown as AgentSession, {
    pauseTurns,
    getTurnCount: () => fake.state.segmentTurns,
    ...extra,
  });
}

describe("normalizePauseTurns", () => {
  it("treats 0, negatives, NaN and Infinity as 'no checkpoints'", () => {
    for (const n of [undefined, 0, -1, -2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalizePauseTurns(n as number | undefined)).toBeUndefined();
    }
  });

  it("keeps a positive interval and floors it", () => {
    expect(normalizePauseTurns(1)).toBe(1);
    expect(normalizePauseTurns(25)).toBe(25);
    expect(normalizePauseTurns(2.7)).toBe(2);
  });

  it("defaults to 25 turns", () => {
    expect(DEFAULT_PAUSE_TURNS).toBe(25);
  });
});

describe("installTurnCheckpoint", () => {
  it("does not stop a run that finishes inside the interval", async () => {
    const fake = createFakeSdk({ turns: 3 });
    const onPause = vi.fn();
    const checkpoint = install(fake, 5, { onPause });

    await fake.session.prompt();

    expect(checkpoint.paused).toBe(false);
    expect(checkpoint.turns).toBe(3);
    expect(onPause).not.toHaveBeenCalled();
    expect(fake.state.totalTurns).toBe(3);
    checkpoint.restore();
  });

  it("stops at the turn boundary once the interval is reached", async () => {
    const fake = createFakeSdk({ turns: 9 });
    const onPause = vi.fn();
    const checkpoint = install(fake, 2, { onPause });

    await fake.session.prompt();

    expect(checkpoint.paused).toBe(true);
    expect(checkpoint.turns).toBe(2);
    expect(onPause).toHaveBeenCalledTimes(1);
    // Turns 3..9 never ran: the session is left at a tool-results boundary, not
    // mid-turn.
    expect(fake.state.totalTurns).toBe(2);
    expect(fake.session.messages.at(-1)?.role).toBe("toolResult");
    checkpoint.restore();
  });

  it("never pauses on a plain text completion, however long the run", async () => {
    // Nothing more would happen after such a turn: the loop polls for follow-ups,
    // finds none and exits.
    const fake = createFakeSdk({ turns: 4, toolResultsPerTurn: 0 });
    const checkpoint = install(fake, 1);

    await fake.session.prompt();

    expect(checkpoint.paused).toBe(false);
    expect(fake.state.totalTurns).toBe(4);
    checkpoint.restore();
  });

  it("pauses on a tool-less turn the session itself is continuing", async () => {
    // A `turn_end` handler that asked for a continue means another request
    // follows, so the run is not over and the checkpoint may still pause.
    const fake = createFakeSdk({ turns: 3, toolResultsPerTurn: 0 });
    fake.agent.finishTurn = vi.fn(async () => ({ action: "continue" as const }));
    const checkpoint = install(fake, 1);

    await fake.session.prompt();

    expect(checkpoint.paused).toBe(true);
    expect(fake.state.totalTurns).toBe(1);
    checkpoint.restore();
  });

  it("pauses on a text-only turn while the SDK still has queued work", async () => {
    // A steering message queued mid-stream means the loop was going to run again,
    // so the run is not over and the checkpoint still applies.
    const fake = createFakeSdk({ turns: 3, toolResultsPerTurn: 0 });
    fake.queue("steering message queued mid-stream");
    const checkpoint = install(fake, 1);

    await fake.session.prompt();

    expect(checkpoint.paused).toBe(true);
    expect(fake.state.totalTurns).toBe(1);
    expect(fake.state.continueCalls).toBe(0);

    // Left resumable through the SDK's own path: continue() drains the queue.
    checkpoint.restore();
    await fake.agent.continue();
    expect(fake.state.continueCalls).toBe(1);
    expect(fake.queued).toHaveLength(0);
  });

  it("counts the caller's turns, not its own hook calls", async () => {
    // Two turns die on a provider error: `turn_end` fires (the runner counts
    // them) but the hook skips them. The third counted turn is the interval, so
    // the pause lands there — with a hook-only count it would land a turn late.
    const fake = createFakeSdk({ turns: 4, errorTurns: [1, 2], retryErrors: true });
    const checkpoint = install(fake, 3);

    await fake.session.prompt();

    expect(fake.state.totalTurns).toBe(3);
    expect(fake.state.continueCalls).toBe(2); // the two retries, not a pause
    expect(checkpoint.paused).toBe(true);
    expect(checkpoint.turns).toBe(3);
    checkpoint.restore();
  });

  it("counts its own hook calls when the caller supplies no counter", async () => {
    // The default, and why the runner passes its own: with an error turn the
    // hook count lags the runner's count by one.
    const fake = createFakeSdk({ turns: 4, errorTurns: [1], retryErrors: true });
    const checkpoint = installTurnCheckpoint(fake.session as unknown as AgentSession, { pauseTurns: 2 });

    await fake.session.prompt();

    expect(fake.state.totalTurns).toBe(3);
    expect(checkpoint.turns).toBe(2);
    expect(checkpoint.paused).toBe(true);
    checkpoint.restore();
  });

  it("does not suppress the SDK's retry for a turn that failed before the pause", async () => {
    const fake = createFakeSdk({ turns: 3, errorTurns: [1], retryErrors: true });
    const checkpoint = install(fake, 3);

    await fake.session.prompt();

    expect(fake.state.continueCalls).toBe(1);
    expect(checkpoint.paused).toBe(true);
    checkpoint.restore();
  });

  it("does not label an already aborted turn as paused", async () => {
    const fake = createFakeSdk({ turns: 3 });
    fake.state.segmentTurns = 1;
    const onPause = vi.fn();
    const checkpoint = install(fake, 1, { onPause });
    const controller = new AbortController();
    controller.abort();

    const stopped = await fake.agent.finishTurn?.(
      { toolResults: [{}] } as unknown as TurnBoundary, controller.signal,
    );

    expect(stopped).toBeUndefined();
    expect(checkpoint.paused).toBe(false);
    expect(onPause).not.toHaveBeenCalled();
    checkpoint.restore();
  });

  it("leaves the pause to the caller's precedence", async () => {
    // The runner answers false once max_turns has taken over.
    const fake = createFakeSdk({ turns: 3 });
    const checkpoint = install(fake, 1, { shouldPause: () => false });

    await fake.session.prompt();

    expect(checkpoint.paused).toBe(false);
    expect(fake.state.totalTurns).toBe(3);
    checkpoint.restore();
  });

  it("lets an already-installed hook stop the run without calling it a pause", async () => {
    const fake = createFakeSdk({ turns: 6 });
    const external = vi.fn(async () => ({ action: "end" as const }));
    fake.agent.finishTurn = external;
    const onPause = vi.fn();
    const checkpoint = install(fake, 2, { onPause });

    await fake.session.prompt();

    expect(external).toHaveBeenCalledTimes(1);
    expect(fake.state.totalTurns).toBe(1);
    expect(checkpoint.paused).toBe(false);
    expect(onPause).not.toHaveBeenCalled();
    checkpoint.restore();
  });

  it("keeps chaining to a hook that declines", async () => {
    const fake = createFakeSdk({ turns: 5 });
    const external = vi.fn(async () => undefined);
    fake.agent.finishTurn = external;
    const checkpoint = install(fake, 2);

    await fake.session.prompt();

    expect(external).toHaveBeenCalledTimes(2);
    expect(checkpoint.paused).toBe(true);
    expect(fake.state.totalTurns).toBe(2);
    checkpoint.restore();
  });

  it("gives each install its own interval, so a resume starts fresh", async () => {
    const fake = createFakeSdk({ turns: 6 });
    const first = install(fake, 3);
    await fake.session.prompt();
    expect(first.paused).toBe(true);
    expect(first.turns).toBe(3);
    expect(fake.state.totalTurns).toBe(3);
    first.restore();

    const resumed = install(fake, 3);
    await fake.session.prompt();
    expect(resumed.paused).toBe(true);
    expect(resumed.turns).toBe(3);
    expect(fake.state.totalTurns).toBe(6);
    resumed.restore();
  });

  it("makes the SDK's own post-run continuation a no-op while paused", async () => {
    const fake = createFakeSdk({ turns: 4 });
    const checkpoint = install(fake, 1);

    await fake.session.prompt();

    expect(fake.state.continueCalls).toBe(0);
    // ...and it still works for a session that never paused.
    const running = createFakeSdk({ turns: 1 });
    const runningCheckpoint = install(running, 5);
    await running.session.prompt();
    await running.agent.continue();
    expect(running.state.continueCalls).toBe(1);
    runningCheckpoint.restore();
    checkpoint.restore();
  });

  it("keeps a queued follow-up message for the resume instead of running it", async () => {
    // An extension that queues a nudge at agent_end would otherwise start another
    // turn — on a session the caller believes is stopped.
    const unpaused = createFakeSdk({ turns: 1, queueAtEnd: true });
    const unpausedCheckpoint = install(unpaused, 5);
    await unpaused.session.prompt();
    expect(unpaused.state.continueCalls).toBe(1);
    expect(unpaused.queued).toHaveLength(0);
    unpausedCheckpoint.restore();

    const paused = createFakeSdk({ turns: 4, queueAtEnd: true });
    const checkpoint = install(paused, 1);
    await paused.session.prompt();
    expect(checkpoint.paused).toBe(true);
    expect(paused.state.continueCalls).toBe(0);
    // Still queued: the resumed segment is the one that gets to act on it.
    expect(paused.queued).toHaveLength(1);
    checkpoint.restore();
  });

  it("reports compaction as disabled while paused, without touching the settings", async () => {
    const fake = createFakeSdk({ turns: 4, needsCompaction: true, compactionEnabled: true });
    const checkpoint = install(fake, 1);

    await fake.session.prompt();

    expect(checkpoint.paused).toBe(true);
    expect(fake.state.compactionChecks).toEqual([false]);
    expect(fake.state.continueCalls).toBe(0);

    checkpoint.restore();

    // Restored, and never persisted: the caller's own settings object is intact.
    expect(fake.settingsManager.getCompactionSettings().enabled).toBe(true);
    expect(fake.compaction.enabled).toBe(true);
  });

  it("leaves compaction alone for a run that does not pause", async () => {
    const fake = createFakeSdk({ turns: 1, needsCompaction: true, compactionEnabled: true });
    const checkpoint = install(fake, 5);

    await fake.session.prompt();

    expect(checkpoint.paused).toBe(false);
    expect(fake.state.compactionChecks).toEqual([true]);
    expect(fake.state.continueCalls).toBe(1);
    checkpoint.restore();
  });

  it("restores every member it wrapped, idempotently", async () => {
    const fake = createFakeSdk({ turns: 4, needsCompaction: true, compactionEnabled: true });
    const originalContinue = fake.agent.continue;
    const originalSettings = fake.settingsManager.getCompactionSettings;
    const checkpoint = install(fake, 1);
    await fake.session.prompt();

    checkpoint.restore();
    checkpoint.restore();

    expect(fake.agent.finishTurn).toBeUndefined();
    expect(fake.agent.continue).toBe(originalContinue);
    expect(fake.settingsManager.getCompactionSettings).toBe(originalSettings);

    // ...and the session runs normally afterwards.
    await fake.agent.continue();
    expect(fake.state.continueCalls).toBe(1);
    expect(fake.settingsManager.getCompactionSettings().enabled).toBe(true);
  });

  it("tolerates a session with neither a continue nor a settings manager", async () => {
    const bare: { agent: Record<string, unknown>; messages: unknown[] } = { agent: {}, messages: [] };
    const checkpoint = installTurnCheckpoint(bare as unknown as AgentSession, { pauseTurns: 1 });

    const stop = await (bare.agent.finishTurn as FinishTurn)({
      message: { stopReason: "toolUse" },
      toolResults: [{}],
    } as unknown as TurnBoundary);

    expect(stop).toEqual({ action: "end" });
    expect(checkpoint.paused).toBe(true);
    expect(() => checkpoint.restore()).not.toThrow();
    expect(bare.agent.finishTurn).toBeUndefined();
    expect(bare.agent.continue).toBeUndefined();
  });

  it("clamps a nonsensical interval to 1 instead of never pausing", async () => {
    const fake = createFakeSdk({ turns: 3 });
    const checkpoint = install(fake, 0);
    await fake.session.prompt();
    expect(checkpoint.paused).toBe(true);
    expect(fake.state.totalTurns).toBe(1);
    checkpoint.restore();
  });
});
