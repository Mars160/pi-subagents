// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the `${...}` placeholder text is the literal subject under test, not a missing interpolation.

/**
 * widgetStatusTemplate — the literal substitution helper and its effect on the
 * widget's running/finished rows. Row prefix (icon/name/mode), the activity
 * line, queued summary, overflow footer and the finished status suffix are all
 * assembled by the widget and must survive a template unchanged.
 */

import { describe, expect, it } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import { type AgentActivity, AgentWidget, type Theme, type UICtx } from "../src/ui/agent-widget.js";
import {
  hasStatusTemplate,
  renderWidgetStatusTemplate,
  type WidgetStatusVars,
} from "../src/ui/status-template.js";

const theme: Theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

/** The render callback `UICtx.setWidget` takes — what the widget registers. */
type WidgetRender = NonNullable<Parameters<UICtx["setWidget"]>[1]>;

const ALL_VARS: WidgetStatusVars = {
  task_title: "do the thing",
  model: "sonnet 4.6",
  model_id: "anthropic/claude-sonnet-4-6",
  effort: "high",
  round: "↻3",
  tool_uses_count: "2",
  total_token: "1.2k token",
  tps: "42.1",
  time: "12.3s",
  cost: "~$0.0042",
  status: "running",
};

describe("renderWidgetStatusTemplate", () => {
  it("substitutes every known placeholder", () => {
    const template = "${task_title}|${model}|${model_id}|${effort}|${round}|${tool_uses_count}|${total_token}|${tps}|${time}|${cost}|${status}";
    expect(renderWidgetStatusTemplate(template, ALL_VARS)).toBe(
      "do the thing|sonnet 4.6|anthropic/claude-sonnet-4-6|high|↻3|2|1.2k token|42.1|12.3s|~$0.0042|running",
    );
  });

  it("keeps unknown placeholders literal instead of blanking the field", () => {
    expect(renderWidgetStatusTemplate("${nope} ${task_title} ${}", ALL_VARS)).toBe(
      "${nope} do the thing ${}",
    );
  });

  it("does not re-scan a substituted value for placeholders", () => {
    // A description that itself contains `${model}` must print as written — the
    // replacement happens in one pass, so values are data, not source.
    const vars = { ...ALL_VARS, task_title: "${model}" };
    expect(renderWidgetStatusTemplate("<${task_title}>", vars)).toBe("<${model}>");
  });

  it("collapses newlines and tabs to stay on one line", () => {
    expect(renderWidgetStatusTemplate("a\nb\tc\r\nd", ALL_VARS)).toBe("a b c d");
  });

  it("collapses newlines and tabs that come from a substituted value", () => {
    // A task title or error string can carry its own line breaks, so
    // normalization has to cover the substituted value and not just the
    // template text — otherwise the row silently becomes two lines.
    const vars = { ...ALL_VARS, task_title: "line one\nline\ttwo", effort: "high\r\nmax" };
    expect(renderWidgetStatusTemplate("<${task_title}>[${effort}]", vars)).toBe(
      "<line one line two>[high max]",
    );
  });

  it("does not touch a lone `$` or unbraced name", () => {
    expect(renderWidgetStatusTemplate("$model ${task_title}", ALL_VARS)).toBe("$model do the thing");
  });

  it("treats unset, empty and whitespace-only templates as no template", () => {
    expect(hasStatusTemplate(undefined)).toBe(false);
    expect(hasStatusTemplate("")).toBe(false);
    expect(hasStatusTemplate("  \n\t ")).toBe(false);
    expect(hasStatusTemplate("${time}")).toBe(true);
  });
});

describe("AgentWidget with widgetStatusTemplate", () => {
  function makeActivity(overrides: Partial<AgentActivity> = {}): AgentActivity {
    return { activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 1, ...overrides };
  }

  function runningRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
    return {
      id: "a1",
      type: "general-purpose",
      description: "r1 description",
      status: "running",
      toolUses: 0,
      startedAt: Date.now() - 12_300,
      lifetimeUsage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.0042 },
      compactionCount: 0,
      generation: { outputTokens: 421, durationMs: 10_000 },
      invocation: {
        modelName: "sonnet 4.6",
        modelId: "anthropic/claude-sonnet-4-6",
        thinking: "high",
      },
      isBackground: true,
      ...overrides,
    };
  }

  function finishedRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
    return runningRecord({ status: "completed", completedAt: Date.now(), ...overrides });
  }

  /** Render the widget and return its lines. */
  function render(
    records: AgentRecord[],
    opts: { activity?: Map<string, AgentActivity>; template?: string; showModel?: boolean; showCost?: boolean } = {},
  ): string {
    // The widget only reads listAgents(); the assertion supplies the class seam.
    const manager: Partial<AgentManager> = { listAgents: () => records };
    const widget = new AgentWidget(
      manager as AgentManager,
      opts.activity ?? new Map<string, AgentActivity>(),
      () => "all",
      () => opts.showCost ?? false,
      () => opts.showModel ?? false,
      () => opts.template,
    );
    let draw: WidgetRender | undefined;
    const uiCtx: UICtx = {
      setStatus: () => {},
      setWidget: (_key, content) => { draw = content; },
    };
    widget.setUICtx(uiCtx);
    widget.update();
    if (!draw) return "";
    // The widget only reads `terminal.columns` from the TUI it renders against.
    const tui = { terminal: { columns: 240 }, requestRender: () => {} };
    return draw(tui, theme).render().join("\n");
  }

  it("leaves the default body untouched when no template is configured", () => {
    const out = render([runningRecord()], { activity: new Map([["a1", makeActivity({ turnCount: 3 })]]) });
    // showCost/showModel are off, so cost and the model name stay gated out of
    // the default body — exactly as before this setting existed.
    expect(out).toContain("r1 description · thinking: high · ↻3 · 1.2k token · 42.1 tok/s");
    expect(out).not.toContain("~$0.0042");
    expect(out).not.toContain("sonnet 4.6");
  });

  it("falls back to the default body for an empty or whitespace-only template", () => {
    const activity = new Map([["a1", makeActivity({ turnCount: 3 })]]);
    for (const template of ["", "   "]) {
      const out = render([runningRecord()], { activity, template });
      expect(out).toContain("r1 description · thinking: high");
      expect(out).not.toContain("${");
    }
  });

  it("renders the running row from the template instead of the default body", () => {
    const activity = new Map([["a1", makeActivity({ turnCount: 3, toolUses: 2 })]]);
    const out = render([runningRecord()], { activity, template: "${task_title}|${round}|${tool_uses_count}|${total_token}|${tps}" });

    expect(out).toContain("r1 description|↻3|2|1.2k token|42.1");
    expect(out).not.toContain(" · ");
    // The activity line is not part of the template.
    expect(out).toContain("⎿  thinking…");
  });

  it("renders the finished row from the template and keeps the status suffix", () => {
    const out = render([finishedRecord({ status: "steered" })], { template: "${task_title}|${status}|${total_token}" });

    expect(out).toContain("r1 description|steered|1.2k token");
    expect(out).toContain("(turn limit)"); // suffix the widget owns, not the template
  });

  it("leaves `${round}` empty on a finished row rather than fabricating a turn count", () => {
    // Finished records carry no turn count of their own, and the activity entry
    // is deleted on completion.
    const out = render([finishedRecord()], { template: "[${round}]" });

    expect(out).toContain("[]");
  });

  it("shows the model and cost even when showModel/showCost are off", () => {
    const out = render([finishedRecord()], {
      template: "${model} ${model_id} ${cost}",
      showModel: false,
      showCost: false,
    });

    expect(out).toContain("sonnet 4.6 anthropic/claude-sonnet-4-6 ~$0.0042");
  });

  it("keeps the asked annotation on the real model and thinking values", () => {
    const record = finishedRecord();
    record.invocation = {
      modelName: "haiku 4.5",
      modelId: "anthropic/claude-haiku-4-5",
      thinking: "high",
      requestedThinking: "max",
      requestedModel: "opus 4.6",
    };
    const out = render([record], { template: "${model}|${model_id}|${effort}" });

    expect(out).toContain("haiku 4.5 (asked opus 4.6)|anthropic/claude-haiku-4-5 (asked opus 4.6)|high (asked max)");
  });

  it("renders 0 tokens as `0 token` and a missing rate as empty", () => {
    const record = finishedRecord({
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      generation: undefined,
    });
    const out = render([record], { template: "[${total_token}][${tps}]" });

    expect(out).toContain("[0 token][]");
    expect(out).not.toContain("tok/s");
  });

  it("keeps unknown placeholders and does not expand a value containing one", () => {
    const record = finishedRecord({ description: "${model}" });
    const out = render([record], { template: "${nope}:${task_title}" });

    expect(out).toContain("${nope}:${model}");
  });

  it("keeps a multi-line template on a single row line", () => {
    const out = render([finishedRecord()], { template: "${task_title}\n\t${status}" });
    const row = out.split("\n").find(l => l.includes("r1 description")) as string;

    expect(row).toContain("r1 description completed");
    expect(row).not.toContain("\t");
  });
});
