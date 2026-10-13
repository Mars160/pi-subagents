import { fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import {
  agentCall,
  agentToolResults,
  type PrintModeRun,
  routeBySession,
  runPrintMode,
} from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

let run: PrintModeRun | undefined;
afterEach(async () => {
  await run?.dispose();
  run = undefined;
});

describe("turn checkpoints through real pi sessions", () => {
  it("pauses foreground execution, resumes the same session with fresh intervals, then finishes", async () => {
    let childCalls = 0;
    let childCallsAtFirstCheckpoint = 0;
    let childCallsAtSecondCheckpoint = 0;
    let id = "";
    run = await runPrintMode({
      prompt: "Delegate and review each checkpoint.",
      live: false,
      respond: routeBySession({
        parentInitial: agentCall({
          prompt: "Run two checks, then report.", description: "Checkpoint validation",
          run_in_background: false, pause_turns: 1,
        }),
        parentFinal: ctx => {
          const results = ctx.messages.filter(m => m.role === "toolResult" && m.toolName === "Agent");
          if (results.length === 1) {
            childCallsAtFirstCheckpoint = childCalls;
            const text = results[0].content.filter(b => b.type === "text").map(b => b.text).join("");
            id = /Agent ID:\s*([^\s]+)/.exec(text)?.[1] ?? "";
            return agentCall({
              resume: id, prompt: "Continue only the remaining work.", description: "Continue checkpoint",
              run_in_background: false,
            });
          }
          if (results.length === 2) {
            childCallsAtSecondCheckpoint = childCalls;
            return agentCall({
              resume: id, prompt: "Report the result.", description: "Finish checkpoint",
              run_in_background: false, pause_turns: 0,
            });
          }
          return "Parent reviewed all checkpoints.";
        },
        subagent: () => {
          childCalls++;
          return childCalls <= 2
            ? [fauxText(`Check ${childCalls} in progress.`), fauxToolCall("bash", { command: "printf checked" })]
            : "CHILD-FINISHED";
        },
      }),
    });

    const results = agentToolResults(run.parentSession);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatch(/paused/i);
    expect(results[1]).toMatch(/paused/i);
    expect(results[2]).toContain("CHILD-FINISHED");
    expect(id).not.toBe("");
    expect(childCallsAtFirstCheckpoint).toBe(1);
    expect(childCallsAtSecondCheckpoint).toBe(2);
    expect(childCalls).toBe(3);
    const record = run.manager?.getRecord(id) as AgentRecord | undefined;
    expect(record?.status).toBe("completed");
    expect(record?.totalTurns).toBe(3);
    expect(record?.pauseTurns ?? 0).toBe(0);
  });

  it("completes a final text answer naturally even exactly at the checkpoint", async () => {
    let childCalls = 0;
    run = await runPrintMode({
      prompt: "Delegate.", live: false,
      respond: routeBySession({
        parentInitial: agentCall({
          prompt: "Answer directly.", description: "Natural completion",
          run_in_background: false, pause_turns: 1,
        }),
        parentFinal: "Reviewed.",
        subagent: () => { childCalls++; return "FINAL-ANSWER"; },
      }),
    });
    expect(childCalls).toBe(1);
    expect(agentToolResults(run.parentSession)[0]).toContain("FINAL-ANSWER");
    expect(agentToolResults(run.parentSession)[0]).not.toMatch(/paused/i);
  });

  it("preserves the cumulative ceiling and grace across resume, then refuses more requests", async () => {
    let childCalls = 0;
    let id = "";
    run = await runPrintMode({
      prompt: "Review progress without granting a larger budget.", live: false, maxModelCalls: 15,
      respond: routeBySession({
        parentInitial: agentCall({
          prompt: "Keep checking.", description: "Bounded checkpoint",
          run_in_background: false, pause_turns: 1, max_turns: 2,
        }),
        parentFinal: ctx => {
          const results = ctx.messages.filter(m => m.role === "toolResult" && m.toolName === "Agent");
          if (results.length === 1) {
            const text = results[0].content.filter(b => b.type === "text").map(b => b.text).join("");
            id = /Agent ID:\s*([^\s]+)/.exec(text)?.[1] ?? "";
          }
          return results.length < 3
            ? agentCall({
              resume: id, prompt: "Continue within the existing budget.", description: "Resume bounded work",
              run_in_background: false,
            })
            : "No further budget granted.";
        },
        subagent: () => {
          childCalls++;
          return fauxToolCall("bash", { command: "printf checked" });
        },
      }),
    });
    const results = agentToolResults(run.parentSession);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatch(/paused/i);
    expect(results[1]).toMatch(/aborted/i);
    expect(results[2]).toMatch(/whole turn budget/i);
    expect(childCalls).toBe(8);
    expect(run.manager?.getRecord(id)?.totalTurns).toBe(8);
    expect(run.manager?.getRecord(id)?.status).toBe("aborted");
  });

  it("uses a default interval of 25 and does not issue a 26th child request", async () => {
    let childCalls = 0;
    run = await runPrintMode({
      prompt: "Delegate.", live: false, maxModelCalls: 35,
      respond: routeBySession({
        parentInitial: agentCall({
          prompt: "Continue checking.", description: "Default checkpoint",
          run_in_background: false,
        }),
        parentFinal: "Review partial progress without resuming.",
        subagent: () => {
          childCalls++;
          return fauxToolCall("bash", { command: "printf checked" });
        },
      }),
    });
    expect(childCalls).toBe(25);
    const result = agentToolResults(run.parentSession)[0];
    expect(result).toMatch(/paused/i);
    const id = /Agent ID:\s*([^\s]+)/.exec(result)?.[1] ?? "";
    const record = run.manager?.getRecord(id) as AgentRecord | undefined;
    expect(record?.status).toBe("paused");
    expect(record?.segmentTurns).toBe(25);
    expect(record?.totalTurns).toBe(25);
    expect(run.manager?.hasRunning()).toBe(false);
  });
});
