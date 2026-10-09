/**
 * model-policy.test.ts — the defaultModel / forceDefaultModel precedence and
 * failure modes, and the resume-side model switch.
 *
 * The per-surface integration tests live with their surfaces
 * (agent-model-display, nested-tools, workflow-effective-config,
 * cross-extension-rpc); this file pins the shared policy they all call, so a
 * regression here is diagnosed here rather than four times over.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumeAgent } from "../src/agent-runner.js";
import {
  getDefaultModel,
  isForceDefaultModel,
  modelRegistryFromRuntime,
  resolveEffectiveModel,
  resolveForcedModel,
  setDefaultModel,
  setForceDefaultModel,
} from "../src/model-policy.js";

const haiku = { provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku 4.5" };
const opus = { provider: "anthropic", id: "claude-opus-4-6", name: "Opus 4.6" };

const registry = (models: any[] = [haiku, opus]) => ({
  find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id),
  getAll: () => models,
  getAvailable: () => models,
});

beforeEach(() => {
  setDefaultModel(undefined);
  setForceDefaultModel(false);
});

afterEach(() => {
  setDefaultModel(undefined);
  setForceDefaultModel(false);
});

describe("defaultModel / forceDefaultModel state", () => {
  it("defaults to no default model and no forcing", () => {
    expect(getDefaultModel()).toBeUndefined();
    expect(isForceDefaultModel()).toBe(false);
  });

  it("keeps the empty string as a real value (project clears a global default)", () => {
    setDefaultModel("anthropic/claude-haiku-4-5");
    setDefaultModel("");
    // Stored verbatim so the settings snapshot can write the clear back to disk...
    expect(getDefaultModel()).toBe("");
    // ...but it does not act as a default.
    const decision = resolveEffectiveModel({ registry: registry() });
    expect(decision.model).toBeUndefined();
    expect(decision.error).toBeUndefined();
  });

  it("trims a configured model", () => {
    setDefaultModel("  anthropic/claude-haiku-4-5  ");
    expect(getDefaultModel()).toBe("anthropic/claude-haiku-4-5");
  });
});

describe("resolveEffectiveModel", () => {
  it("inherits the parent when nothing is configured and nothing was asked for", () => {
    const decision = resolveEffectiveModel({ registry: registry() });
    expect(decision.model).toBeUndefined();
    expect(decision.input).toBeUndefined();
    expect(decision.error).toBeUndefined();
    expect(decision.fatal).toBe(false);
  });

  it("applies the configured default when no candidate exists", () => {
    setDefaultModel("claude-haiku-4-5");
    const decision = resolveEffectiveModel({ registry: registry() });
    expect(decision.model).toBe(haiku);
    expect(decision.input).toBe("claude-haiku-4-5");
    expect(decision.source).toBe("default");
    // User config, never a caller's hard error.
    expect(decision.callerSupplied).toBe(false);
  });

  it("fails fatally when the configured default cannot be resolved", () => {
    setDefaultModel("gpt-9");
    const decision = resolveEffectiveModel({ registry: registry() });
    expect(decision.model).toBeUndefined();
    expect(decision.fatal).toBe(true);
    expect(decision.error).toContain('Configured defaultModel "gpt-9"');
    expect(decision.error).toContain("Model not found");
  });

  it("lets an agent file's model outrank the configured default", () => {
    setDefaultModel("claude-haiku-4-5");
    const decision = resolveEffectiveModel({
      candidate: { input: "anthropic/claude-opus-4-6", source: "frontmatter" },
      registry: registry(),
    });
    expect(decision.model).toBe(opus);
    expect(decision.source).toBe("frontmatter");
  });

  it("keeps an agent file's typo a silent fall back to the parent", () => {
    const decision = resolveEffectiveModel({
      candidate: { input: "gpt-9", source: "frontmatter" },
      registry: registry(),
    });
    expect(decision.model).toBeUndefined();
    expect(decision.fatal).toBe(false);
    expect(decision.error).toContain("Model not found");
  });

  it("makes a caller-supplied model's typo fatal", () => {
    const decision = resolveEffectiveModel({
      candidate: { input: "gpt-9", source: "params" },
      registry: registry(),
    });
    expect(decision.fatal).toBe(true);
    expect(decision.callerSupplied).toBe(true);
    expect(decision.error).toContain("Model not found");
  });

  it("reports a resolved caller-supplied model as caller-supplied", () => {
    const decision = resolveEffectiveModel({
      candidate: { input: "haiku", source: "params" },
      registry: registry(),
    });
    expect(decision.model).toBe(haiku);
    expect(decision.callerSupplied).toBe(true);
    expect(decision.fatal).toBe(true);
  });

  it("fails fatally when forceDefaultModel is on and no default is configured", () => {
    setForceDefaultModel(true);
    const decision = resolveEffectiveModel({
      candidate: { input: "anthropic/claude-opus-4-6", source: "params" },
      registry: registry(),
    });
    expect(decision.model).toBeUndefined();
    expect(decision.source).toBe("forced");
    expect(decision.fatal).toBe(true);
    expect(decision.error).toContain("forceDefaultModel is enabled but defaultModel is not set");
  });

  it("forces the configured default over both frontmatter and a caller's model", () => {
    setDefaultModel("anthropic/claude-haiku-4-5");
    setForceDefaultModel(true);
    for (const candidate of [
      { input: "anthropic/claude-opus-4-6", source: "frontmatter" as const },
      { input: "anthropic/claude-opus-4-6", source: "params" as const },
    ]) {
      const decision = resolveEffectiveModel({ candidate, registry: registry() });
      expect(decision.model).toBe(haiku);
      expect(decision.source).toBe("forced");
      expect(decision.callerSupplied).toBe(false);
    }
  });

  it("never resolves the model it is about to ignore", () => {
    // The ignored model is unresolvable; with force on that must not fail the
    // call — only the configured default is resolved.
    setDefaultModel("anthropic/claude-haiku-4-5");
    setForceDefaultModel(true);
    const decision = resolveEffectiveModel({
      candidate: { input: "no-such-model", source: "params" },
      registry: registry(),
    });
    expect(decision.model).toBe(haiku);
    expect(decision.error).toBeUndefined();
  });

  it("fails fatally when the forced default cannot be resolved", () => {
    setDefaultModel("gpt-9");
    setForceDefaultModel(true);
    const decision = resolveEffectiveModel({ registry: registry() });
    expect(decision.fatal).toBe(true);
    expect(decision.error).toContain("required by forceDefaultModel");
  });
});

describe("resolveForcedModel", () => {
  it("returns undefined when force is off, without resolving anything", () => {
    setDefaultModel("gpt-9");
    expect(resolveForcedModel(registry())).toBeUndefined();
  });

  it("returns the configured default under force", () => {
    setDefaultModel("anthropic/claude-haiku-4-5");
    setForceDefaultModel(true);
    expect(resolveForcedModel(registry())).toBe(haiku);
  });

  it("returns an error string for a missing or unresolvable default", () => {
    setForceDefaultModel(true);
    expect(resolveForcedModel(registry())).toContain("forceDefaultModel is enabled but defaultModel is not set");

    setDefaultModel("gpt-9");
    expect(resolveForcedModel(registry())).toContain("could not be resolved");
  });
});

describe("modelRegistryFromRuntime", () => {
  it("adapts a session's ModelRuntime to the ModelRegistry resolveModel reads", () => {
    const runtime = {
      getModel: vi.fn((provider: string, id: string) => [haiku, opus].find(m => m.provider === provider && m.id === id)),
      getModels: vi.fn(() => [haiku, opus]),
      getAvailableSnapshot: vi.fn(() => [haiku]),
    };
    const adapted = modelRegistryFromRuntime(runtime as any);

    expect(adapted.find("anthropic", "claude-haiku-4-5")).toBe(haiku);
    expect(adapted.getAll()).toEqual([haiku, opus]);
    // Availability, not the full catalog — auth-less models must not match.
    expect(adapted.getAvailable?.()).toEqual([haiku]);
    expect(runtime.getAvailableSnapshot).toHaveBeenCalled();
  });

  it("falls back to the full catalog when the runtime exposes no availability snapshot", () => {
    const adapted = modelRegistryFromRuntime({ getModel: () => undefined, getModels: () => [haiku] } as any);
    expect(adapted.getAvailable?.()).toEqual([haiku]);
  });
});

describe("resumeAgent — forceDefaultModel on a live session", () => {
  function session(model: any) {
    return {
      messages: [] as any[],
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn(async () => {}),
      abort: vi.fn(),
      agent: { state: { model } },
      modelRuntime: {
        getModel: (provider: string, id: string) => [haiku, opus].find(m => m.provider === provider && m.id === id),
        getModels: () => [haiku, opus],
        getAvailableSnapshot: () => [haiku, opus],
      },
      sessionManager: { appendModelChange: vi.fn() },
    };
  }

  it("leaves the session's model alone when force is off", async () => {
    const s = session(opus);
    setDefaultModel("anthropic/claude-haiku-4-5");

    await resumeAgent(s as any, "continue");

    expect(s.agent.state.model).toBe(opus);
    expect(s.sessionManager.appendModelChange).not.toHaveBeenCalled();
  });

  it("switches the session onto the forced default and records it in its own file", async () => {
    const s = session(opus);
    setDefaultModel("anthropic/claude-haiku-4-5");
    setForceDefaultModel(true);

    await resumeAgent(s as any, "continue");

    expect(s.agent.state.model).toBe(haiku);
    expect(s.sessionManager.appendModelChange).toHaveBeenCalledWith("anthropic", "claude-haiku-4-5");
  });

  it("refuses the resume when the forced default cannot be resolved", async () => {
    const s = session(opus);
    setDefaultModel("gpt-9");
    setForceDefaultModel(true);

    await expect(resumeAgent(s as any, "continue")).rejects.toThrow(/could not be resolved/);
    expect(s.agent.state.model).toBe(opus);
    expect(s.prompt).not.toHaveBeenCalled();
  });
});
