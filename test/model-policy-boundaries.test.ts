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
    SessionManager: { inMemory: () => ({}) },
  };
});
vi.mock("../src/env.js", () => ({ detectEnv: async () => ({ isGitRepo: false, branch: "", platform: "linux" }) }));

import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { type EventBus, type RpcReply, registerRpcHandlers } from "../src/cross-extension-rpc.js";
import { setDefaultModel, setForceDefaultModel } from "../src/model-policy.js";
import type { AgentConfig } from "../src/types.js";

const defaultModel = { provider: "test", id: "default", name: "Default" } as Model<Api>;
const pinnedModel = { provider: "test", id: "pinned", name: "Pinned" } as Model<Api>;
const models = [defaultModel, pinnedModel];
const modelRegistry = {
  find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
  getAvailable: () => models,
  getAll: () => models,
};
const config: AgentConfig = {
  name: "pinned", description: "Pinned model agent", systemPrompt: "Review code.",
  extensions: false, skills: false, promptMode: "replace", persistSession: false,
  model: "test/pinned",
};
const ctx = { cwd: "/tmp", model: pinnedModel, modelRegistry, getSystemPrompt: () => "Parent" } as unknown as ExtensionContext;

beforeEach(() => {
  vi.clearAllMocks();
  registerAgents(new Map([[config.name, config]]));
  setDefaultModel("test/default");
  setForceDefaultModel(false);
  createAgentSession.mockResolvedValue({
    session: {
      messages: [], subscribe: () => () => {}, prompt: async () => {},
      setSessionName: () => {}, bindExtensions: async () => {},
    } as unknown as AgentSession,
  });
});
afterEach(() => {
  setDefaultModel(undefined);
  setForceDefaultModel(false);
  registerAgents(new Map());
});

describe("forced model at the real runner boundary", () => {
  it("ignores a resolvable frontmatter pin even after a tool supplied the forced model", async () => {
    setForceDefaultModel(true);
    await runAgent(ctx, "pinned", "go", { pi: {} as ExtensionAPI, model: defaultModel });
    expect(createAgentSession.mock.calls[0][0].model).toBe(defaultModel);
  });

  it("refuses a missing default even when the frontmatter model is available", async () => {
    setDefaultModel(undefined);
    setForceDefaultModel(true);
    await expect(runAgent(ctx, "pinned", "go", { pi: {} as ExtensionAPI }))
      .rejects.toThrow("forceDefaultModel is enabled but defaultModel is not set");
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("refuses an unavailable forced default rather than using the frontmatter model", async () => {
    setDefaultModel("test/unavailable");
    setForceDefaultModel(true);
    await expect(runAgent(ctx, "pinned", "go", { pi: {} as ExtensionAPI }))
      .rejects.toThrow('Configured defaultModel "test/unavailable"');
    expect(createAgentSession).not.toHaveBeenCalled();
  });
});

describe("non-forced default at the RPC boundary", () => {
  it("does not inject the default over an agent file's model when the payload omits model", async () => {
    const handlers = new Map<string, (data: unknown) => void>();
    const events: EventBus = {
      on: (event, handler) => { handlers.set(event, handler); return () => { handlers.delete(event); }; },
      emit: (event, data) => { handlers.get(event)?.(data); },
    };
    const spawn = vi.fn(() => "child-id");
    registerRpcHandlers({ events, pi: {}, getCtx: () => ctx, manager: {
      spawn, awaitStartup: async () => {}, abort: () => false, getRecord: () => undefined, consumeResult: () => false,
    } });
    const reply = new Promise<RpcReply<{ id: string }>>(resolve => {
      events.on("subagents:rpc:spawn:reply:req", data => resolve(data as RpcReply<{ id: string }>));
    });
    events.emit("subagents:rpc:spawn", { requestId: "req", type: "pinned", prompt: "go", options: {} });
    expect(await reply).toEqual({ success: true, data: { id: "child-id" } });
    const options = spawn.mock.calls[0] as unknown as [unknown, unknown, unknown, unknown, { model?: Model<Api> }];
    expect(options[4].model ?? pinnedModel).toBe(pinnedModel);
  });
});
