/**
 * model-policy.ts — the `defaultModel` / `forceDefaultModel` settings and the
 * one place that turns a model *choice* into the model a spawn actually runs on.
 *
 * Every path that picks a model — the `Agent` tool, nested delegation, workflow
 * `agent()`, cross-extension RPC, the scheduler, and `runAgent`'s own fallback —
 * resolves through `resolveEffectiveModel`, so the precedence cannot drift
 * between them:
 *
 *   forceDefaultModel on  → defaultModel, whatever else was asked for
 *   agent file / caller   → their existing winner (each call site keeps its own
 *                           frontmatter-vs-caller order; that is a surface
 *                           difference, not policy)
 *   otherwise             → defaultModel, if one is configured
 *   otherwise             → inherit the parent model
 *
 * A caller-supplied model that cannot be resolved is the caller's error to see:
 * it is fatal on the tool/RPC paths and was already. A configured defaultModel
 * that cannot be resolved is fatal too — silently inheriting the parent would
 * mean the setting "worked" everywhere except where it mattered. An agent file's
 * own `model:` keeps its historical silent fall back to the parent.
 *
 * State lives here (rather than in an index.ts closure) for the same reason
 * `scopeModels` lives in model-scope.ts: every entry point needs it.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";

/**
 * The merged `defaultModel` setting. `""` is a real value — a project file
 * clearing a globally configured model — so it is stored verbatim and read as
 * "unset" by `configuredDefaultModel()`. Same convention as
 * `subagentInstructionsFile` and `widgetStatusTemplate`.
 */
let defaultModel: string | undefined;

/** When true, `defaultModel` outranks every other model choice, including a caller's. */
let forceDefaultModel = false;

export function getDefaultModel(): string | undefined { return defaultModel; }
export function setDefaultModel(value: string | undefined): void {
  // Trimmed, but "" survives: it is how a project clears a global default, and
  // the settings snapshot writes this value back verbatim.
  defaultModel = value === undefined ? undefined : value.trim();
}
export function isForceDefaultModel(): boolean { return forceDefaultModel; }
export function setForceDefaultModel(enabled: boolean): void { forceDefaultModel = enabled; }

/** The non-empty configured default, or undefined when unset/cleared. */
function configuredDefaultModel(): string | undefined {
  return defaultModel !== undefined && defaultModel !== "" ? defaultModel : undefined;
}

/** Where the model a spawn will use came from, for scope warnings and display. */
export type ModelSource = "forced" | "params" | "frontmatter" | "default";

export interface ModelCandidate {
  input?: string;
  source: "frontmatter" | "params";
}

/**
 * The frontmatter-vs-caller winner for the surfaces that prefer the agent file
 * (the `Agent` tool and nested delegation). Shared so the order is stated once;
 * the RPC and workflow paths read their own caller first and pass a candidate
 * with `source: "params"` instead.
 */
export function preferAgentFileModel(agentModel?: string, paramModel?: string): ModelCandidate {
  return agentModel != null
    ? { input: agentModel, source: "frontmatter" }
    : { input: paramModel, source: "params" };
}

export interface ModelDecision {
  /** The resolved model. Undefined means "inherit the parent model". */
  model?: Model<Api>;
  /** The string behind `model`, or behind a resolution error. */
  input?: string;
  source?: ModelSource;
  /**
   * True when the model came from a caller (tool param, RPC option, workflow
   * request). `scopeModels` refuses such a choice instead of warning.
   */
  callerSupplied: boolean;
  /** True when `error` must fail the spawn rather than fall back to the parent. */
  fatal: boolean;
  /** A configuration error, or an unresolvable model when `fatal`. */
  error?: string;
}

const FORCE_WITHOUT_DEFAULT =
  "forceDefaultModel is enabled but defaultModel is not set — configure a default model in /agents → Settings " +
  "(or `defaultModel` in subagents.json) before spawning a subagent.";

function resolutionError(source: ModelSource, input: string, detail: string): string {
  const why = source === "forced" ? " (required by forceDefaultModel)" : "";
  return `Configured defaultModel "${input}"${why} could not be resolved.\n\n${detail}`;
}

/**
 * Resolve the model a spawn should run on.
 *
 * `candidate` is the winner of the caller-vs-agent-file precedence, as the call
 * site computes it (the `Agent` tool and nested tools prefer the agent file's
 * frontmatter; a workflow script prefers its own `model:`). Omit it — while
 * force is off — and only the configured default/parent layers apply, which is
 * what `runAgent`'s fallback needs.
 */
export function resolveEffectiveModel(args: {
  candidate?: ModelCandidate;
  registry: ModelRegistry;
}): ModelDecision {
  const configured = configuredDefaultModel();

  if (forceDefaultModel) {
    if (configured === undefined) {
      return { source: "forced", callerSupplied: false, fatal: true, error: FORCE_WITHOUT_DEFAULT };
    }
    const resolved = resolveModel(configured, args.registry);
    if (typeof resolved === "string") {
      return { input: configured, source: "forced", callerSupplied: false, fatal: true, error: resolutionError("forced", configured, resolved) };
    }
    return { model: resolved, input: configured, source: "forced", callerSupplied: false, fatal: true };
  }

  if (args.candidate?.input) {
    const { input, source } = args.candidate;
    const resolved = resolveModel(input, args.registry);
    if (typeof resolved === "string") {
      return {
        input,
        source,
        callerSupplied: source === "params",
        // Only a caller-supplied model fails the spawn. An agent file's typo has
        // always fallen back to the parent silently, and shrinking that is a
        // separate change.
        fatal: source === "params",
        error: resolved,
      };
    }
    return { model: resolved, input, source, callerSupplied: source === "params", fatal: source === "params" };
  }

  if (configured !== undefined) {
    const resolved = resolveModel(configured, args.registry);
    if (typeof resolved === "string") {
      return { input: configured, source: "default", callerSupplied: false, fatal: true, error: resolutionError("default", configured, resolved) };
    }
    return { model: resolved, input: configured, source: "default", callerSupplied: false, fatal: true };
  }

  return { callerSupplied: false, fatal: false };
}

/**
 * The model `forceDefaultModel` demands for a live session being resumed, or an
 * error string, or undefined when force is off.
 *
 * Resumes used to be a hole: `AgentManager.resume` re-prompts a session that
 * already exists, so nothing re-resolved its model and a forced default would
 * only apply to agents started after the setting was turned on. Reopening a
 * persisted conversation in a new pi session has the same shape (it goes through
 * `runAgent`, but the session file's recorded model outranks the spawn option),
 * so it is handled in `agent-runner` for the same reason.
 */
export function resolveForcedModel(registry: ModelRegistry): Model<Api> | string | undefined {
  if (!forceDefaultModel) return undefined;
  const configured = configuredDefaultModel();
  if (configured === undefined) return FORCE_WITHOUT_DEFAULT;
  const resolved = resolveModel(configured, registry);
  return typeof resolved === "string" ? resolutionError("forced", configured, resolved) : resolved;
}

/** Structural view of pi's `ModelRuntime`, which a live session exposes. */
export interface ModelRuntimeLike {
  getModel(provider: string, modelId: string): Model<Api> | undefined;
  getModels(): readonly Model<Api>[];
  getAvailableSnapshot?(): readonly Model<Api>[];
}

/**
 * Adapt a session's `ModelRuntime` to the `ModelRegistry` facade `resolveModel`
 * reads. Used where a live session is the only handle on the model catalog —
 * `resumeAgent`, which gets no `ExtensionContext`.
 */
export function modelRegistryFromRuntime(runtime: ModelRuntimeLike): ModelRegistry {
  return {
    find: (provider, modelId) => runtime.getModel(provider, modelId),
    getAll: () => [...runtime.getModels()],
    getAvailable: () => [...(runtime.getAvailableSnapshot?.() ?? runtime.getModels())],
  };
}
