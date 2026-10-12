// Boundary tests for `defaultEffort` / `forceDefaultEffort` at the real
// `runAgent` / `resumeAgent` entry points. The pure precedence table lives in
// effort-policy.test.ts; this file pins the two behaviors only the runner can
// show: which level reaches `createAgentSession`, and that a forced resume
// rewrites the live session's own level without touching the session API that
// persists a new global default (`setThinkingLevel`).
//
// The mock scaffold is the lightweight one from model-policy-boundaries.test.ts
// (a bare `createAgentSession` stub), not the full agent-runner harness.

import type { Api, Model } from "@earendil-works/pi-ai";
import type * as CodingAgent from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSession } = vi.hoisted(() => ({ createAgentSession: vi.fn() }));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof CodingAgent>("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    createAgentSession,
    DefaultResourceLoader: class {
      async reload() {}
    },
    SettingsManager: { create: () => ({}) },
    SessionManager: { inMemory: () => ({}), open: () => ({}), create: () => ({}) },
  };
});
vi.mock("../src/env.js", () => ({ detectEnv: async () => ({ isGitRepo: false, branch: "", platform: "linux" }) }));

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { setDefaultEffort, setForceDefaultEffort } from "../src/effort-policy.js";
import { setDefaultModel, setForceDefaultModel } from "../src/model-policy.js";
import type { AgentConfig } from "../src/types.js";

/** Supports every level except xhigh/max, so a forced "max" clamps to "high". */
const clampedModel = {
  provider: "test", id: "clamped", name: "Clamped", reasoning: true,
  thinkingLevelMap: { max: null },
} as unknown as Model<Api>;
const modelRegistry = {
  find: () => clampedModel,
  getAvailable: () => [clampedModel],
  getAll: () => [clampedModel],
};
const ctx = { cwd: "/tmp", model: clampedModel, modelRegistry, getSystemPrompt: () => "Parent" } as unknown as ExtensionContext;

const plainAgent: AgentConfig = {
  name: "plain", description: "No level of its own", systemPrompt: "Work.",
  extensions: false, skills: false, promptMode: "replace", persistSession: false,
};
const pinnedAgent: AgentConfig = {
  ...plainAgent, name: "pinned", description: "Frontmatter level", thinking: "high",
};

/** A session stub rich enough for the resume hooks; records what the runner did. */
function makeSession() {
  const state: { thinkingLevel?: string } = {};
  const session = {
    messages: [],
    model: clampedModel,
    agent: { state },
    sessionManager: { appendThinkingLevelChange: vi.fn(), appendModelChange: vi.fn() },
    subscribe: () => () => {},
    prompt: async () => {},
    // Present so a test can prove the runner does NOT use it: this is the API
    // that would record the level as a new global default in the user's pi
    // settings.
    setThinkingLevel: vi.fn(),
    setSessionName: () => {},
    bindExtensions: async () => {},
  } as unknown as AgentSession & { setThinkingLevel: ReturnType<typeof vi.fn> };
  return session;
}

let session: ReturnType<typeof makeSession>;

beforeEach(() => {
  vi.clearAllMocks();
  registerAgents(new Map([[plainAgent.name, plainAgent], [pinnedAgent.name, pinnedAgent]]));
  setDefaultModel(undefined);
  setForceDefaultModel(false);
  session = makeSession();
  createAgentSession.mockResolvedValue({ session });
});
afterEach(() => {
  setDefaultEffort(undefined);
  setForceDefaultEffort(false);
  registerAgents(new Map());
});

const sessionOpts = () => createAgentSession.mock.calls[0][0] as { thinkingLevel?: string };

describe("runAgent effort resolution", () => {
  it("applies the configured default when nothing named a level", async () => {
    setDefaultEffort("medium");
    await runAgent(ctx, "plain", "go", { pi: {} as ExtensionAPI });
    expect(sessionOpts().thinkingLevel).toBe("medium");
  });

  it("does not let the default override the agent file's frontmatter", async () => {
    setDefaultEffort("medium");
    await runAgent(ctx, "pinned", "go", { pi: {} as ExtensionAPI });
    expect(sessionOpts().thinkingLevel).toBe("high");
  });

  it("does not let the default override an explicit caller level", async () => {
    setDefaultEffort("medium");
    await runAgent(ctx, "plain", "go", { pi: {} as ExtensionAPI, thinkingLevel: "max" });
    expect(sessionOpts().thinkingLevel).toBe("max");
  });

  it("force overrides both the caller and the frontmatter", async () => {
    setDefaultEffort("low");
    setForceDefaultEffort(true);
    await runAgent(ctx, "pinned", "go", { pi: {} as ExtensionAPI, thinkingLevel: "max" });
    expect(sessionOpts().thinkingLevel).toBe("low");
  });

  it("refuses a forced spawn with no default, before creating a session", async () => {
    setForceDefaultEffort(true);
    await expect(runAgent(ctx, "pinned", "go", { pi: {} as ExtensionAPI }))
      .rejects.toThrow("forceDefaultEffort is enabled but defaultEffort is not set");
    expect(createAgentSession).not.toHaveBeenCalled();
  });
});

describe("forced effort reaches a reopened session", () => {
  it("re-asserts the clamped forced level after the session file's own", async () => {
    setDefaultEffort("max");
    setForceDefaultEffort(true);
    await runAgent(ctx, "plain", "go", { pi: {} as ExtensionAPI, resumeSessionFile: "/tmp/s.jsonl" });
    // Clamped to what the model supports, bypassing the session constructor.
    expect(session.agent.state.thinkingLevel).toBe("high");
    expect(session.sessionManager.appendThinkingLevelChange).toHaveBeenCalledWith("high");
    // Never via the API that would persist a new global default.
    expect(session.setThinkingLevel).not.toHaveBeenCalled();
  });
});

describe("resumeAgent forced effort", () => {
  it("switches a live session onto the clamped forced level", async () => {
    setDefaultEffort("max");
    setForceDefaultEffort(true);
    await resumeAgent(session, "again");
    expect(session.agent.state.thinkingLevel).toBe("high");
    expect(session.sessionManager.appendThinkingLevelChange).toHaveBeenCalledWith("high");
    expect(session.setThinkingLevel).not.toHaveBeenCalled();
  });

  it("leaves a live session's level alone when force is off", async () => {
    setDefaultEffort("low");
    session.agent.state.thinkingLevel = "high";
    await resumeAgent(session, "again");
    expect(session.agent.state.thinkingLevel).toBe("high");
    expect(session.sessionManager.appendThinkingLevelChange).not.toHaveBeenCalled();
  });

  it("fails a resume when force is on with no default", async () => {
    setForceDefaultEffort(true);
    await expect(resumeAgent(session, "again")).rejects.toThrow("forceDefaultEffort is enabled");
  });
});
