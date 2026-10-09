// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the `${...}` placeholder text is the literal subject under test, not a missing interpolation.

/**
 * widgetStatusTemplate — the settings-file seam. The rendering itself (literal
 * substitution, unknown placeholders, single-line collapsing) lives in
 * test/widget-status-template.test.ts and test/settings.test.ts; what only an
 * index-level boot can show is that the field is loaded into the widget state
 * and survives the whole-object snapshot an unrelated menu save writes back.
 *
 * Mirrors test/subagent-instructions-wiring.test.ts — same observed property,
 * different field.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionUIContext, initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import type { SubagentsSettings } from "../src/settings.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

describe("widgetStatusTemplate wiring", () => {
  let hermetic: Hermetic | undefined;

  afterEach(() => {
    hermetic?.restore();
    hermetic = undefined;
  });

  const globalSettingsPath = () => join(process.env.PI_CODING_AGENT_DIR as string, "subagents.json");
  const projectSettingsPath = (dir: string) => join(dir, ".pi", "subagents.json");

  function boot(settings: SubagentsSettings) {
    // Spread into a fresh literal: the helper takes a JSON payload, and an
    // interface has no implicit index signature to satisfy that parameter.
    hermetic = hermeticDir({ settings: { ...settings } });
    const booted = makePi();
    subagentsExtension(booted.pi);
    return { booted, dir: hermetic.dir };
  }

  function bootWithGlobal(projectSettings: SubagentsSettings, globalSettings: SubagentsSettings) {
    hermetic = hermeticDir({ settings: { ...projectSettings } });
    writeFileSync(globalSettingsPath(), JSON.stringify(globalSettings));
    const booted = makePi();
    subagentsExtension(booted.pi);
    return { booted, dir: hermetic.dir };
  }

  /**
   * Drive `/agents → Settings` far enough to write the settings file. Any
   * change writes the WHOLE snapshot, so which row is toggled does not matter.
   */
  async function changeAnUnrelatedSetting(booted: ReturnType<typeof makePi>, dir: string) {
    initTheme(undefined, false);
    type CustomFactory = Parameters<ExtensionUIContext["custom"]>[0];
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

  it("does not erase a hand-written template when an unrelated setting is saved", async () => {
    const { booted, dir } = boot({ widgetStatusTemplate: "${task_title} ${round}", schedulingEnabled: false });

    await changeAnUnrelatedSetting(booted, dir);

    const saved = JSON.parse(readFileSync(projectSettingsPath(dir), "utf-8")) as SubagentsSettings;
    expect(saved.widgetStatusTemplate).toBe("${task_title} ${round}");
  });

  it("does not erase the project's empty-string clear either", async () => {
    const { booted, dir } = bootWithGlobal(
      { widgetStatusTemplate: "", schedulingEnabled: false },
      { widgetStatusTemplate: "${model}" },
    );

    await changeAnUnrelatedSetting(booted, dir);

    const saved = JSON.parse(readFileSync(projectSettingsPath(dir), "utf-8")) as SubagentsSettings;
    expect(saved.widgetStatusTemplate).toBe("");
  });

  it("keeps the field absent when it was never configured", async () => {
    const { booted, dir } = boot({ schedulingEnabled: false });

    await changeAnUnrelatedSetting(booted, dir);

    const saved = JSON.parse(readFileSync(projectSettingsPath(dir), "utf-8")) as SubagentsSettings;
    expect(saved).not.toHaveProperty("widgetStatusTemplate");
  });
});
