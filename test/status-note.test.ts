/**
 * status-note.test.ts — the parent-facing note for a run that did not simply
 * complete. A paused checkpoint is the one status here that has NOT settled:
 * its output is a partial answer, and the run is waiting on a decision from the
 * very reader the note is written for. The note has to say both, because the
 * text alone cannot be told apart from a finished answer.
 */
import { describe, expect, it } from "vitest";
import { getForegroundOutcomeNote, getStatusNote } from "../src/status-note.js";

describe("getStatusNote", () => {
  it("frames a paused checkpoint as held, partial and awaiting the parent", () => {
    const note = getStatusNote("paused");

    expect(note).toContain("PAUSED");
    expect(note).toContain("awaiting the parent's decision");
    expect(note).toContain("partial");
  });

  it("never reads as an outcome", () => {
    // The distinction the note exists to draw: finished vs failed. A paused run
    // is neither, so it may not look like either.
    expect(getStatusNote("paused")).not.toContain("completed");
    expect(getStatusNote("paused")).not.toBe(getStatusNote("completed"));
    expect(getStatusNote("paused")).not.toBe(getStatusNote("error"));
  });

  it("keeps the settled wording unchanged", () => {
    expect(getStatusNote("stopped")).toContain("STOPPED BY THE USER");
    expect(getStatusNote("aborted")).toContain("hit the turn limit");
    expect(getStatusNote("steered")).toContain("wrapped up at the turn limit");
    expect(getStatusNote("completed")).toBe("");
    expect(getStatusNote("running")).toBe("");
  });
});

describe("getForegroundOutcomeNote", () => {
  it("frames a paused checkpoint as held, partial and awaiting the caller", () => {
    const note = getForegroundOutcomeNote("paused");

    expect(note).toContain("awaiting your decision");
    expect(note).toContain("partial");
    // A foreground caller holds the whole output inline, so the note points at
    // it rather than implying there is more to fetch (see the id-less caller
    // problem in the function's doc comment).
    expect(note).toContain("above");
  });

  it("does not tell the caller a paused run finished", () => {
    expect(getForegroundOutcomeNote("paused")).not.toContain("completed");
    expect(getForegroundOutcomeNote("paused")).not.toBe(getForegroundOutcomeNote("completed"));
  });

  it("keeps the settled wording unchanged", () => {
    expect(getForegroundOutcomeNote("stopped")).toContain("STOPPED BY THE USER");
    expect(getForegroundOutcomeNote("aborted")).toContain("aborted at the turn limit");
    expect(getForegroundOutcomeNote("steered")).toContain("wrapped up at the turn limit");
    expect(getForegroundOutcomeNote("completed")).toBe("");
  });
});
