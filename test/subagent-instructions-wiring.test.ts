/**
 * subagentInstructionsFile — the seams between the settings file, the in-memory
 * value the runner reads, and the whole-object snapshot a menu save writes back.
 *
 * The read itself (BOM, blank file, unreadable file, re-read per session) and
 * the prompt rendering are covered by agent-runner.test.ts and prompts.test.ts.
 * What only an index-level boot can show is load-on-startup, project-over-global
 * precedence, and that an unrelated settings toggle does not erase the field.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionUIContext, initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSubagentInstructionsFile, setSubagentInstructionsFile } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

describe("subagentInstructionsFile wiring", () => {
  let hermetic: Hermetic | undefined;

  afterEach(() => {
    setSubagentInstructionsFile(undefined);
    hermetic?.restore();
    hermetic = undefined;
  });

  const globalSettingsPath = () => join(process.env.PI_CODING_AGENT_DIR as string, "subagents.json");
  const projectSettingsPath = (dir: string) => join(dir, ".pi", "subagents.json");

  /** Redirect into a temp project and boot the real extension against it. */
  function boot(settings: Record<string, unknown>) {
    hermetic = hermeticDir({ settings });
    const booted = makePi();
    subagentsExtension(booted.pi);
    return { booted, dir: hermetic.dir };
  }

  /** Boot with a global file that the project's own settings may override. */
  function bootWithGlobal(projectSettings: Record<string, unknown>, globalSettings: Record<string, unknown>) {
    hermetic = hermeticDir({ settings: projectSettings });
    writeFileSync(globalSettingsPath(), JSON.stringify(globalSettings));
    const booted = makePi();
    subagentsExtension(booted.pi);
    return { booted, dir: hermetic.dir };
  }

  it("loads the project value into the runner's state", () => {
    boot({ subagentInstructionsFile: "rules.md", schedulingEnabled: false });

    expect(getSubagentInstructionsFile()).toBe("rules.md");
  });

  it("defaults to off when nothing sets it", () => {
    boot({ schedulingEnabled: false });

    expect(getSubagentInstructionsFile()).toBeUndefined();
  });

  it("inherits a global path the project does not mention", () => {
    bootWithGlobal(
      { schedulingEnabled: false },
      { subagentInstructionsFile: "~/house-rules.md" },
    );

    expect(getSubagentInstructionsFile()).toBe("~/house-rules.md");
  });

  it("lets the project disable a global path with an empty string", () => {
    bootWithGlobal(
      { subagentInstructionsFile: "", schedulingEnabled: false },
      { subagentInstructionsFile: "~/house-rules.md" },
    );

    expect(getSubagentInstructionsFile()).toBe("");
  });

  /**
   * Drive `/agents → Settings` far enough to write the settings file.
   *
   * Any change writes the WHOLE snapshot, so which row is toggled does not
   * matter — row 0 is `Max concurrency`, whose single-value list re-applies the
   * value it already had. What matters is that the file gets written.
   */
  async function changeAnUnrelatedSetting(booted: ReturnType<typeof makePi>, dir: string) {
    // The settings list asks for a real theme, which only the TUI normally sets up.
    initTheme(undefined, false);
    type CustomFactory = Parameters<ExtensionUIContext["custom"]>[0];
    // Take the Settings entry exactly once: the agents menu re-opens after a
    // submenu closes, so answering it every time never terminates.
    let taken = false;
    const context = ctx({
      cwd: dir,
      ui: {
        notify: vi.fn(),
        select: vi.fn(async (title: string, options: string[]) => {
          if (title !== "Agents" || taken) return undefined;
          taken = true;
          return options.find((o) => o === "Settings");
        }),
        custom: vi.fn(async (factory: CustomFactory) => {
          const built = await factory(
            { requestRender: () => {} } as Parameters<CustomFactory>[0],
            {} as Parameters<CustomFactory>[1],
            {} as Parameters<CustomFactory>[2],
            () => {},
          );
          built.handleInput?.(" ");
          return undefined;
        }),
        input: vi.fn(async () => undefined),
      },
    });
    await booted.commands.get("agents").handler("", context);
  }

  it("does not erase a hand-written value when an unrelated setting is saved", async () => {
    const { booted, dir } = boot({ subagentInstructionsFile: ".pi/house-rules.md", schedulingEnabled: false });

    await changeAnUnrelatedSetting(booted, dir);

    const saved = JSON.parse(readFileSync(projectSettingsPath(dir), "utf-8"));
    expect(saved.subagentInstructionsFile).toBe(".pi/house-rules.md");
  });

  it("does not erase the project's empty-string opt-out either", async () => {
    const { booted, dir } = bootWithGlobal(
      { subagentInstructionsFile: "", schedulingEnabled: false },
      { subagentInstructionsFile: "~/house-rules.md" },
    );

    await changeAnUnrelatedSetting(booted, dir);

    const saved = JSON.parse(readFileSync(projectSettingsPath(dir), "utf-8"));
    expect(saved.subagentInstructionsFile).toBe("");
  });

  it("keeps the field absent when it was never configured", async () => {
    const { booted, dir } = boot({ schedulingEnabled: false });

    await changeAnUnrelatedSetting(booted, dir);

    const saved = JSON.parse(readFileSync(projectSettingsPath(dir), "utf-8"));
    expect(saved).not.toHaveProperty("subagentInstructionsFile");
  });
});
