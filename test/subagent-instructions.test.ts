import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSession, loaderOptions, session } = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  loaderOptions: vi.fn(),
  session: {
    messages: [],
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(async () => {}),
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
  },
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession,
  defineTool: (definition: unknown) => definition,
  // agent-types.ts derives BUILTIN_TOOL_NAMES from these factories' `.name`s.
  createCodingTools: () => ["read", "bash", "edit", "write"].map((name) => ({ name })),
  createReadOnlyTools: () => ["read", "grep", "find", "ls"].map((name) => ({ name })),
  getAgentDir: () => process.env.PI_CODING_AGENT_DIR ?? "/mock/agent-dir",
  DefaultResourceLoader: class {
    constructor(options: unknown) { loaderOptions(options); }
    async reload() {}
    getExtensions() { return { extensions: [], errors: [] }; }
  },
  SessionManager: { inMemory: vi.fn(), create: vi.fn(), open: vi.fn() },
  SettingsManager: { create: () => ({}) },
}));

vi.mock("../src/env.js", () => ({
  detectEnv: async () => ({ isGitRepo: false, branch: "", platform: "linux" }),
}));

import {
  getSubagentInstructionsFile,
  type RunOptions,
  readSubagentInstructions,
  runAgent,
  setSubagentInstructionsFile,
} from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { buildAgentPrompt } from "../src/prompts.js";
import { applySettings, loadSettings, type SettingsAppliers, saveSettings } from "../src/settings.js";
import type { AgentConfig } from "../src/types.js";

let dir: string;
let originalAgentDir: string | undefined;
const config: AgentConfig = {
  name: "rules-test",
  description: "Shared rules test",
  builtinToolNames: ["read"],
  extensions: false,
  skills: false,
  systemPrompt: "Keep the agent-specific role.",
  promptMode: "replace",
  inheritContext: false,
  runInBackground: false,
  isolated: false,
};
const env = { isGitRepo: false, branch: "", platform: "linux" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-subagent-rules-"));
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(dir, "global");
  setSubagentInstructionsFile(undefined);
  registerAgents(new Map([[config.name, config]]));
  vi.clearAllMocks();
  createAgentSession.mockResolvedValue({ session });
});

afterEach(() => {
  setSubagentInstructionsFile(undefined);
  registerAgents(new Map());
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("shared instruction settings and files", () => {
  it("defaults off and round-trips the configured path", () => {
    expect(getSubagentInstructionsFile()).toBeUndefined();
    saveSettings({ subagentInstructionsFile: "~/AGENTS.md" }, dir);
    expect(loadSettings(dir)).toEqual({ subagentInstructionsFile: "~/AGENTS.md" });
    const appliers = { setSubagentInstructionsFile } as SettingsAppliers;
    applySettings(loadSettings(dir), appliers);
    expect(getSubagentInstructionsFile()).toBe("~/AGENTS.md");
    applySettings({ subagentInstructionsFile: "" }, appliers);
    expect(getSubagentInstructionsFile()).toBe("");
  });

  it("allows a project to disable a global file and rejects invalid values", () => {
    mkdirSync(join(dir, "global"));
    writeFileSync(join(dir, "global", "subagents.json"), JSON.stringify({ subagentInstructionsFile: "~/AGENTS.md" }));
    expect(loadSettings(dir).subagentInstructionsFile).toBe("~/AGENTS.md");
    saveSettings({ subagentInstructionsFile: "" }, dir);
    expect(loadSettings(dir).subagentInstructionsFile).toBe("");
    for (const invalid of [true, 42, null, []]) {
      writeFileSync(join(dir, ".pi", "subagents.json"), JSON.stringify({ subagentInstructionsFile: invalid }));
      expect(loadSettings(dir).subagentInstructionsFile).toBe("~/AGENTS.md");
    }
    saveSettings({ subagentInstructionsFile: "  rules.md  " }, dir);
    expect(loadSettings(dir).subagentInstructionsFile).toBe("rules.md");
  });

  it("reads absolute and config-relative paths without rewriting Markdown", () => {
    const file = join(dir, "rules.md");
    writeFileSync(file, "\uFEFF\n# Rules\n\n  indented code\n");
    expect(readSubagentInstructions(file, "/unrelated")).toBe("# Rules\n\n  indented code");
    expect(readSubagentInstructions("rules.md", dir)).toBe("# Rules\n\n  indented code");
    expect(readSubagentInstructions("", dir)).toBeUndefined();
    writeFileSync(file, "\n \t");
    expect(readSubagentInstructions(file, dir)).toBeUndefined();
  });

  it("expands ~/ without modifying the user's home directory", () => {
    const configured = "~/pi-subagents-nonexistent-rules-test.md";
    expect(() => readSubagentInstructions(configured, dir)).toThrow(join(homedir(), configured.slice(2)));
  });

  it("reports a configured file that cannot be read", () => {
    expect(() => readSubagentInstructions("missing.md", dir)).toThrow(/subagentInstructionsFile.*missing\.md.*could not be read/);
    expect(() => readSubagentInstructions(dir, dir)).toThrow(/could not be read/);
  });
});

describe("shared instruction prompt composition", () => {
  it.each(["append", "replace"] as const)("preserves the %s identity and other extras", (promptMode) => {
    const prompt = buildAgentPrompt({ ...config, promptMode }, dir, env, "Parent identity.", {
      instructionsBlock: "Follow common rules.",
      memoryBlock: "Memory contents.",
      skillBlocks: [{ name: "test", content: "Skill contents." }],
      workflowChild: true,
      worktreeBase: "/main-tree",
    });
    expect(prompt).toContain("<subagent_instructions>\nFollow common rules.\n</subagent_instructions>");
    expect(prompt).toContain(config.systemPrompt);
    expect(prompt).toContain(`<active_agent name="${config.name}"/>`);
    expect(prompt).toContain("Memory contents.");
    expect(prompt).toContain("Skill contents.");
    expect(prompt).toContain("<workflow_child>");
    expect(prompt).toContain("<worktree_isolation>");
    if (promptMode === "append") expect(prompt.startsWith("Parent identity.")).toBe(true);
    else expect(prompt).not.toContain("Parent identity.");
  });

  it("does not repeat rules already inherited by a nested append-mode agent", () => {
    const extras = { instructionsBlock: "Shared rules." };
    const parent = buildAgentPrompt(config, dir, env, undefined, extras);
    const child = buildAgentPrompt({ ...config, promptMode: "append" }, dir, env, parent, extras);
    expect(child.startsWith(parent)).toBe(true);
    expect(child.match(/<subagent_instructions>/g)).toHaveLength(1);
    const replaced = buildAgentPrompt(config, dir, env, parent, extras);
    expect(replaced.match(/<subagent_instructions>/g)).toHaveLength(1);
  });

  it("omits the rules section when there are no instructions", () => {
    expect(buildAgentPrompt(config, dir, env)).not.toContain("<subagent_instructions>");
    expect(buildAgentPrompt(config, dir, env, undefined, { instructionsBlock: "" })).not.toContain("<subagent_instructions>");
  });
});

describe("runner shared instruction injection", () => {
  function context(): ExtensionContext {
    return {
      cwd: dir,
      modelRegistry: { find: () => undefined, getAvailable: () => [] },
      getSystemPrompt: () => "Parent identity.",
    } as unknown as ExtensionContext;
  }

  const pi = {} as ExtensionAPI;

  function systemPrompt(): string {
    const options = loaderOptions.mock.lastCall?.[0] as { systemPromptOverride: () => string };
    return options.systemPromptOverride();
  }

  it.each([
    ["normal", {}],
    ["nested", { nested: true }],
    ["workflow", { workflow: true }],
    ["isolated", { isolated: true }],
    ["custom cwd", { cwd: "/other-working-dir" }],
    ["worktree", { cwd: "/worktree-copy", worktreeBase: "/main-tree" }],
  ] as const)("injects rules for a %s session using configCwd", async (_name, overrides) => {
    writeFileSync(join(dir, "rules.md"), "Shared runner rules.");
    setSubagentInstructionsFile("rules.md");
    const options: RunOptions = { pi, configCwd: dir, ...overrides };
    await runAgent(context(), config.name, "task", options);
    expect(systemPrompt()).toContain("<subagent_instructions>\nShared runner rules.\n</subagent_instructions>");
    expect(createAgentSession.mock.lastCall?.[0].tools).toEqual(["read"]);
    expect(session.prompt).toHaveBeenCalledWith("task");
  });

  it("rereads edits for the next session and leaves the default off", async () => {
    await runAgent(context(), config.name, "task", { pi });
    expect(systemPrompt()).not.toContain("<subagent_instructions>");
    setSubagentInstructionsFile("rules.md");
    writeFileSync(join(dir, "rules.md"), "First rules.");
    await runAgent(context(), config.name, "task", { pi });
    expect(systemPrompt()).toContain("First rules.");
    writeFileSync(join(dir, "rules.md"), "Updated rules.");
    await runAgent(context(), config.name, "task", { pi });
    expect(systemPrompt()).toContain("Updated rules.");
    expect(systemPrompt()).not.toContain("First rules.");
  });

  it("fails before creating a session or prompting when configured rules are unreadable", async () => {
    setSubagentInstructionsFile("missing.md");
    await expect(runAgent(context(), config.name, "task", { pi })).rejects.toThrow(/subagentInstructionsFile/);
    expect(createAgentSession).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
  });
});
