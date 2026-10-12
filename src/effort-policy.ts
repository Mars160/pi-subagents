/**
 * effort-policy.ts — the `defaultEffort` / `forceDefaultEffort` settings and the
 * one place that turns a thinking-level *choice* into the level a spawn runs at.
 *
 * Every path that picks a level — the `Agent` tool, nested delegation, workflow
 * `agent({ effort })` and `runAgent`'s own fallback — resolves through
 * `resolveEffectiveEffort`, so the precedence cannot drift between them:
 *
 *   forceDefaultEffort on → defaultEffort, whatever else was asked for
 *   agent file / caller   → their existing winner (each call site keeps its own
 *                           frontmatter-vs-caller order; that is a surface
 *                           difference, not policy, and the winner arrives here
 *                           as `candidate`)
 *   otherwise             → defaultEffort, if configured
 *   otherwise             → inherit pi's own default
 *
 * Unlike model-policy.ts there is nothing to resolve: a level is a literal, and
 * pi clamps it to what the model supports when the session starts. The one
 * exception is a forced resume, which assigns the level to a live session
 * directly — there `resolveForcedEffort` clamps it itself.
 *
 * State lives here (rather than in an index.ts closure) for the same reason
 * `defaultModel`'s does: every entry point needs it.
 */

import { type Api, clampThinkingLevel, type Model, type ModelThinkingLevel, type ThinkingLevel } from "@earendil-works/pi-ai";

const EFFORT_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** True for a valid `ThinkingLevel` spelling. settings.ts uses it to drop unknown `defaultEffort` values. */
export function isEffortLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * The merged `defaultEffort` setting. `""` is a real value — a project file
 * clearing a globally configured default — so it is stored verbatim and read as
 * "unset" by `configuredDefaultEffort()`. Same convention as `defaultModel`.
 */
let defaultEffort: string | undefined;

/** When true, `defaultEffort` outranks every other level, including a caller's. */
let forceDefaultEffort = false;

export function getDefaultEffort(): string | undefined { return defaultEffort; }
export function setDefaultEffort(value: string | undefined): void {
  // Trimmed, but "" survives: it is how a project clears a global default, and
  // the settings snapshot writes this value back verbatim.
  defaultEffort = value === undefined ? undefined : value.trim();
}
export function isForceDefaultEffort(): boolean { return forceDefaultEffort; }
export function setForceDefaultEffort(enabled: boolean): void { forceDefaultEffort = enabled; }

/** The non-empty, valid configured default, or undefined when unset/cleared/invalid. */
function configuredDefaultEffort(): ThinkingLevel | undefined {
  return defaultEffort !== undefined && isEffortLevel(defaultEffort) ? defaultEffort : undefined;
}

const FORCE_WITHOUT_DEFAULT =
  "forceDefaultEffort is enabled but defaultEffort is not set — configure a default thinking level in " +
  "/agents → Settings (or `defaultEffort` in subagents.json) before spawning a subagent.";

/** Where the level a spawn will use came from, for display. */
export type EffortSource = "forced" | "candidate" | "default";

export interface EffortDecision {
  /** The level to request. Undefined means "inherit pi's own default". */
  level?: ThinkingLevel;
  /** The configured or asked value behind `level`. */
  input?: string;
  source?: EffortSource;
  /** True when `error` must fail the spawn rather than fall back to the parent. */
  fatal: boolean;
  /** A configuration error. */
  error?: string;
}

/**
 * Resolve the thinking level a spawn should run at.
 *
 * `candidate` is the winner of the caller-vs-agent-file precedence, as the call
 * site computes it (the `Agent` tool and nested tools prefer the agent file's
 * frontmatter; a workflow script prefers its own `effort`). Omit it — while
 * force is off — and only the configured default layer applies, which is what
 * `runAgent`'s fallback needs.
 */
export function resolveEffectiveEffort(candidate?: ThinkingLevel): EffortDecision {
  if (forceDefaultEffort) {
    const configured = configuredDefaultEffort();
    if (configured === undefined) return { source: "forced", fatal: true, error: FORCE_WITHOUT_DEFAULT };
    return { level: configured, input: configured, source: "forced", fatal: false };
  }
  if (candidate !== undefined) {
    return { level: candidate, input: candidate, source: "candidate", fatal: false };
  }
  const configured = configuredDefaultEffort();
  if (configured !== undefined) {
    return { level: configured, input: configured, source: "default", fatal: false };
  }
  return { fatal: false };
}

/**
 * The clamped level `forceDefaultEffort` demands for a resumed session.
 * A separate error field distinguishes configuration errors from level strings.
 *
 * Resumes used to be a hole: `resumeAgent` re-prompts a session that already
 * exists, so nothing re-resolved its level and a forced default would only
 * apply to agents started after the setting was turned on. Reopening a persisted
 * conversation in a new pi session has the same shape (it goes through
 * `runAgent`, but the session file's recorded level outranks the spawn option),
 * so it is handled in `agent-runner` for the same reason. The level is clamped
 * here because assigning it to `agent.state.thinkingLevel` bypasses the session
 * constructor that would otherwise clamp it.
 */
export function resolveForcedEffort(model?: Model<Api>): { level?: ModelThinkingLevel; error?: string } {
  if (!forceDefaultEffort) return {};
  const configured = configuredDefaultEffort();
  if (configured === undefined) return { error: FORCE_WITHOUT_DEFAULT };
  return { level: model === undefined ? configured : clampThinkingLevel(model, configured) };
}

/**
 * One sentence describing the configured effort policy, appended to the tool
 * descriptions that can carry it. Empty when nothing is configured and nothing
 * is forced — an unconfigured project pays no tokens for the setting.
 */
export function effortPolicyGuideline(): string {
  const configured = configuredDefaultEffort();
  if (forceDefaultEffort) {
    return configured === undefined
      ? "Reasoning effort is forced (forceDefaultEffort) but no defaultEffort is configured, so subagent spawns fail until one is set."
      : `Reasoning effort is forced to "${configured}" for every subagent (forceDefaultEffort): caller thinking/effort parameters and an agent file's thinking: are ignored.`;
  }
  if (configured !== undefined) {
    return `Subagents use thinking level "${configured}" when neither the call nor an agent file sets one.`;
  }
  return "";
}
