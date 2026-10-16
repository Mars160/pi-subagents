/**
 * turn-checkpoint.ts — stop an agent session at a turn boundary, resumably.
 *
 * The SDK's `finishTurn` hook runs after a turn's assistant message and tool
 * results, immediately before `turn_end`: a boundary `agent.continue()` can
 * resume from. Returning `{ action: "end" }` ends the loop there once the
 * caller's turn count reaches the interval.
 *
 * Stopping the loop is not enough. `AgentSession._runAgentPrompt` continues the
 * run itself (`while (await this._handlePostAgentRun()) await this.agent.continue()`)
 * for a retryable error, a compaction or queued messages, so a checkpoint also
 * makes `agent.continue` a no-op and reports compaction as disabled while
 * paused. Both are installed when the pause fires and undone by `restore()`,
 * which the caller runs in a `finally`.
 */

import type { AgentSession, CompactionSettings } from "@earendil-works/pi-coding-agent";

/** Turns a segment runs before a checkpoint pauses it, when a caller asks for pausing without a count. */
export const DEFAULT_PAUSE_TURNS = 25;

/**
 * Normalize a caller-supplied pause interval: `undefined`, `0`, negative or
 * non-finite all mean "no checkpoint". Mirrors {@link normalizeMaxTurns} in
 * agent-runner.ts — `0` disables a limit at the runner level.
 */
export function normalizePauseTurns(turns: number | undefined): number | undefined {
  if (turns == null || !Number.isFinite(turns) || turns < 1) return undefined;
  return Math.floor(turns);
}

/** The SDK's turn-boundary hook, keyed off the public session type so a pi bump surfaces here. */
type FinishTurn = NonNullable<AgentSession["agent"]["finishTurn"]>;

/** The subset of `SettingsManager` the checkpoint touches. */
type CompactionSettingsSource = { getCompactionSettings?: () => CompactionSettings };

export interface TurnCheckpointOptions {
  /**
   * Turns this segment may run before the checkpoint stops it. Values below 1
   * are clamped to 1 rather than throwing — the caller resolves the real
   * interval (see {@link normalizePauseTurns}).
   */
  pauseTurns: number;
  /**
   * Turns this segment has completed, as the caller counts them. Pass the same
   * counter `maxTurns` is enforced against — the runner counts every `turn_end`.
   * This hook runs before that event, so the caller's count is one short of the
   * turn being decided and the checkpoint compares `getTurnCount() + 1` to the
   * interval. Defaults to counting this hook's own invocations.
   */
  getTurnCount?: () => number;
  /**
   * Whether pausing is still allowed. The runner answers false once `maxTurns`
   * has steered the agent to wrap up: a run already being wound down must not
   * also be paused, or the wrap-up never finishes.
   */
  shouldPause?: () => boolean;
  /** Called once, at the moment the checkpoint stops the run. */
  onPause?: () => void;
}

export interface TurnCheckpoint {
  /** True once this checkpoint stopped the run. */
  readonly paused: boolean;
  /** Turns completed, by the caller's count when one was given. */
  readonly turns: number;
  /** Undo every hook this checkpoint installed. Idempotent. */
  restore(): void;
}

/**
 * Install a turn checkpoint on `session` and return its handle. Each install
 * counts from zero, so a resume that installs a fresh checkpoint gets a full
 * interval rather than the remains of the last one.
 */
export function installTurnCheckpoint(
  session: AgentSession,
  options: TurnCheckpointOptions,
): TurnCheckpoint {
  const interval = Math.max(1, Math.floor(options.pauseTurns));
  const agent = session.agent;
  const previousFinishTurn = agent.finishTurn;
  const previousContinue = agent.continue;

  let paused = false;
  let hookTurns = 0;
  let restored = false;
  let restoreCompaction: (() => void) | undefined;
  const turnCount = options.getTurnCount ?? (() => hookTurns);

  // Installed lazily, on the first pause: a run that never pauses must not have
  // its compaction settings touched, and the SDK reads them only in the prompt
  // preflight and in the post-run handler right after the loop returns.
  const suppressCompaction = () => {
    const settingsManager = session.settingsManager as unknown as CompactionSettingsSource | undefined;
    const original = settingsManager?.getCompactionSettings;
    if (!settingsManager || !original) return;
    settingsManager.getCompactionSettings = () => ({ ...original.call(settingsManager), enabled: false });
    restoreCompaction = () => {
      settingsManager.getCompactionSettings = original;
    };
  };

  const hook: FinishTurn = async (turn, signal) => {
    // Chain, don't override: the session's own hook still dispatches `turn_end`
    // boundaries, and its decision outranks ours.
    const previousDecision = (await previousFinishTurn?.(turn, signal)) ?? undefined;
    // A run another hook ends keeps ending, and that is a stop rather than a
    // pause (there is nothing to resume from).
    if (previousDecision?.action === "end") return previousDecision;
    // An explicit continue promises one more request, so a tool-less turn is not
    // the end of the run and may still be paused.
    const explicitContinue = previousDecision?.action === "continue";
    // Error and aborted turns are hard exits the loop takes regardless of this
    // decision, and the session retries them itself: leave them alone.
    if (signal?.aborted || turn.message.stopReason === "error" || turn.message.stopReason === "aborted") {
      return previousDecision;
    }
    hookTurns += 1;
    // This hook runs before `turn_end`, so a caller counting those events has
    // not counted the turn being decided yet.
    const counted = options.getTurnCount ? turnCount() + 1 : hookTurns;
    if (options.shouldPause && !options.shouldPause()) return previousDecision;
    if (counted < interval) return previousDecision;
    // A turn with no tool results, nothing queued and no forced continuation is
    // the end of the run: pausing there would report a finished run as paused.
    if (!explicitContinue && turn.toolResults.length === 0 && !agent.hasQueuedMessages()) {
      return previousDecision;
    }
    paused = true;
    suppressCompaction();
    options.onPause?.();
    return { action: "end" };
  };
  agent.finishTurn = hook;

  if (previousContinue) {
    agent.continue = async () => {
      if (paused) return;
      await previousContinue.call(agent);
    };
  }

  return {
    get paused() {
      return paused;
    },
    get turns() {
      return turnCount();
    },
    restore() {
      if (restored) return;
      restored = true;
      agent.finishTurn = previousFinishTurn;
      if (previousContinue) agent.continue = previousContinue;
      restoreCompaction?.();
    },
  };
}
