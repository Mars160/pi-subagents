/**
 * turn-checkpoint.ts — stop an agent session at a turn boundary, resumably.
 *
 * The SDK's `shouldStopAfterTurn` hook runs after a turn's tools have executed:
 * a boundary `agent.continue()` can resume from. A checkpoint stops the loop
 * there once the caller's turn count reaches the interval.
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
type ShouldStopAfterTurn = NonNullable<AgentSession["agent"]["shouldStopAfterTurn"]>;

/** The context the SDK hands that hook at the end of a turn. */
type TurnBoundary = Parameters<ShouldStopAfterTurn>[0];

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
   * counter `maxTurns` is enforced against — the runner counts every `turn_end`,
   * including turns this hook never sees because they ended in a provider error,
   * so a pause lands on the turn the caller counts as the interval-th.
   * Defaults to counting this hook's own invocations.
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
  const previousShouldStop = agent.shouldStopAfterTurn;
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

  const hook: ShouldStopAfterTurn = async (context: TurnBoundary, signal) => {
    // Chain, don't override: a run another hook stops keeps stopping, and that
    // is a stop rather than a pause (there is nothing to resume from).
    if (previousShouldStop && (await previousShouldStop(context, signal))) return true;
    if (signal?.aborted) return false;
    hookTurns += 1;
    if (options.shouldPause && !options.shouldPause()) return false;
    if (turnCount() < interval) return false;
    // A turn with no tool results and nothing queued is the end of the run:
    // pausing there would report a finished run as paused.
    if (context.toolResults.length === 0 && !agent.hasQueuedMessages()) return false;
    paused = true;
    suppressCompaction();
    options.onPause?.();
    return true;
  };
  agent.shouldStopAfterTurn = hook;

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
      agent.shouldStopAfterTurn = previousShouldStop;
      if (previousContinue) agent.continue = previousContinue;
      restoreCompaction?.();
    },
  };
}
