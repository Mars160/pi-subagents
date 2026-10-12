// Unit tests for the defaultEffort / forceDefaultEffort policy. These are the
// precedence rules every spawn surface shares, so the table below is pinned
// here once rather than re-derived per caller.

import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  effortPolicyGuideline,
  getDefaultEffort,
  isEffortLevel,
  isForceDefaultEffort,
  resolveEffectiveEffort,
  resolveForcedEffort,
  setDefaultEffort,
  setForceDefaultEffort,
} from "../src/effort-policy.js";
import { resolveAgentInvocationConfig } from "../src/invocation-config.js";

/** A reasoning model that supports every level except xhigh/max. */
const clampedModel = {
  provider: "test", id: "clamped", name: "Clamped", reasoning: true,
  thinkingLevelMap: { max: null },
} as unknown as Model<Api>;

/** A non-reasoning model: pi only offers "off", so any level clamps to it. */
const plainModel = {
  provider: "test", id: "plain", name: "Plain", reasoning: false,
} as unknown as Model<Api>;

afterEach(() => {
  setDefaultEffort(undefined);
  setForceDefaultEffort(false);
});

describe("isEffortLevel", () => {
  it("accepts every ThinkingLevel and rejects everything else", () => {
    for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(isEffortLevel(level)).toBe(true);
    }
    for (const junk of ["off", "HIGH", " tiny", "", 1, null, undefined, {}]) {
      expect(isEffortLevel(junk)).toBe(false);
    }
  });
});

describe("defaultEffort state", () => {
  it("is unset and unforced by default", () => {
    expect(getDefaultEffort()).toBeUndefined();
    expect(isForceDefaultEffort()).toBe(false);
  });

  it("trims a set value but keeps it", () => {
    setDefaultEffort("  high  ");
    expect(getDefaultEffort()).toBe("high");
  });

  it("keeps the empty string as the project-level clear", () => {
    setDefaultEffort("high");
    setDefaultEffort("");
    expect(getDefaultEffort()).toBe("");
    // "" reads as unset to the resolver: no configured default.
    expect(resolveEffectiveEffort(undefined)).toEqual({ fatal: false });
  });
});

describe("resolveEffectiveEffort precedence", () => {
  it("returns nothing when nothing is configured and nothing was asked", () => {
    expect(resolveEffectiveEffort(undefined)).toEqual({ fatal: false });
  });

  it("passes a candidate through unchanged when force is off", () => {
    setDefaultEffort("low");
    expect(resolveEffectiveEffort("high")).toEqual({
      level: "high", input: "high", source: "candidate", fatal: false,
    });
  });

  it("uses the configured default when neither side named a level", () => {
    setDefaultEffort("medium");
    expect(resolveEffectiveEffort(undefined)).toEqual({
      level: "medium", input: "medium", source: "default", fatal: false,
    });
  });

  it("ignores an invalid configured default rather than passing it on", () => {
    setDefaultEffort("turbo");
    expect(resolveEffectiveEffort(undefined)).toEqual({ fatal: false });
  });

  it("force overrides a candidate", () => {
    setDefaultEffort("low");
    setForceDefaultEffort(true);
    expect(resolveEffectiveEffort("max")).toEqual({
      level: "low", input: "low", source: "forced", fatal: false,
    });
  });

  it("force with no default is a fatal configuration error, not a fallback", () => {
    setForceDefaultEffort(true);
    const decision = resolveEffectiveEffort("high");
    expect(decision.fatal).toBe(true);
    expect(decision.error).toContain("forceDefaultEffort is enabled but defaultEffort is not set");
    expect(decision.level).toBeUndefined();
  });

  it("force with an invalid default is the same fatal error", () => {
    setDefaultEffort("turbo");
    setForceDefaultEffort(true);
    expect(resolveEffectiveEffort(undefined).fatal).toBe(true);
  });
});

describe("resolveForcedEffort clamps through the model", () => {
  it("returns {} when force is off", () => {
    setDefaultEffort("high");
    expect(resolveForcedEffort(clampedModel)).toEqual({});
  });

  it("errors when force is on without a default", () => {
    setForceDefaultEffort(true);
    expect(resolveForcedEffort(clampedModel).error).toContain("forceDefaultEffort is enabled");
  });

  it("returns the configured level unclamped when no model is known", () => {
    setDefaultEffort("max");
    setForceDefaultEffort(true);
    expect(resolveForcedEffort()).toEqual({ level: "max" });
  });

  it("clamps down to the highest level the model actually supports", () => {
    setDefaultEffort("max");
    setForceDefaultEffort(true);
    expect(resolveForcedEffort(clampedModel)).toEqual({ level: "high" });
  });

  it("clamps to off on a model with no reasoning at all", () => {
    setDefaultEffort("high");
    setForceDefaultEffort(true);
    expect(resolveForcedEffort(plainModel)).toEqual({ level: "off" });
  });
});

describe("effortPolicyGuideline", () => {
  it("is empty when nothing is configured — no token cost", () => {
    expect(effortPolicyGuideline()).toBe("");
  });

  it("describes the configured default", () => {
    setDefaultEffort("low");
    expect(effortPolicyGuideline()).toBe(
      'Subagents use thinking level "low" when neither the call nor an agent file sets one.',
    );
  });

  it("describes a forced default as ignoring the caller and frontmatter", () => {
    setDefaultEffort("high");
    setForceDefaultEffort(true);
    const text = effortPolicyGuideline();
    expect(text).toContain('forced to "high"');
    expect(text).toContain("caller");
    expect(text).toContain("thinking:");
  });

  it("warns that a forced default with no level fails spawns", () => {
    setForceDefaultEffort(true);
    expect(effortPolicyGuideline()).toBe(
      "Reasoning effort is forced (forceDefaultEffort) but no defaultEffort is configured, so subagent spawns fail until one is set.",
    );
  });
});

describe("resolveAgentInvocationConfig effort layering", () => {
  const agent = (thinking?: string) =>
    ({ name: "a", description: "a", systemPrompt: "s", thinking } as never);

  it("keeps the frontmatter winner when nothing is configured", () => {
    expect(resolveAgentInvocationConfig(agent("high"), { thinking: "low" }).thinking).toBe("high");
  });

  it("keeps a caller's level when the agent file names none", () => {
    expect(resolveAgentInvocationConfig(agent(), { thinking: "low" }).thinking).toBe("low");
  });

  it("applies the configured default only when neither side named one", () => {
    setDefaultEffort("medium");
    expect(resolveAgentInvocationConfig(agent(), {}).thinking).toBe("medium");
    expect(resolveAgentInvocationConfig(agent("high"), {}).thinking).toBe("high");
  });

  it("force replaces the frontmatter winner and records the ask as overridden", () => {
    setDefaultEffort("low");
    setForceDefaultEffort(true);
    const resolved = resolveAgentInvocationConfig(agent("high"), {});
    expect(resolved.thinking).toBe("low");
    expect(resolved.overridden?.thinking).toBe("high");
  });

  it("surfaces the fatal configuration error instead of a level", () => {
    setForceDefaultEffort(true);
    const resolved = resolveAgentInvocationConfig(agent("high"), { thinking: "max" });
    expect(resolved.thinking).toBeUndefined();
    expect(resolved.effortError).toContain("forceDefaultEffort is enabled");
  });
});
