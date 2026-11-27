import { describe, expect, it } from "vitest";
import { initSubduction } from "@automerge/automerge-repo";
import { Automerge } from "@automerge/automerge-repo/slim";

import { autoOf, conflictState, valueAt } from "./conflicts.js";
import type { Conflict } from "./overlay-types.js";

type Doc = Automerge.Doc<any>;

initSubduction();

// A copy of `doc` with an actor of its own, as another device would have.
const fork = (doc: Doc): Doc => Automerge.load(Automerge.save(doc));
const edit = (doc: Doc, change: (d: any) => void): Doc => Automerge.change(doc, change);

describe("a key both sides wrote", () => {
  const base = Automerge.from<any>({ "@patchwork": { type: "settings" }, model: { threshold: 0.5 } });
  const source = edit(fork(base), (d) => (d.model.threshold = 0.8));
  const target = edit(fork(base), (d) => (d.model.threshold = 0.75));
  const auto = autoOf(source, target);
  const conflict: Conflict = { at: { path: ["model", "threshold"] }, source: 0.8, target: 0.75 };

  it("is open until the merge writes the key", () => {
    expect(conflictState(conflict, { source, target, merged: auto })).toBe("open");
  });

  it("reads which side was taken, even the one auto already showed", () => {
    const shown = valueAt(auto, conflict.at);
    const taken = shown === 0.8 ? "source" : "target";
    const merged = edit(fork(auto), (d) => (d.model.threshold = shown));
    expect(conflictState(conflict, { source, target, merged })).toBe(taken);
  });

  it("reads an edit that's neither side", () => {
    const merged = edit(fork(auto), (d) => (d.model.threshold = 0.9));
    expect(conflictState(conflict, { source, target, merged })).toBe("edited");
  });

  it("opens again when a side writes the key after it was resolved", () => {
    const resolved = edit(fork(auto), (d) => (d.model.threshold = 0.8));
    const later = edit(source, (d) => (d.model.threshold = 0.85));
    const merged = Automerge.merge(fork(resolved), later);
    expect(conflictState(conflict, { source: later, target, merged })).toBe("open");
  });
});

describe("a text place", () => {
  const base = Automerge.from<any>({ "@patchwork": { type: "file" }, content: "a\nb\nc\n" });
  const replaceLine = (doc: Doc, text: string) =>
    edit(fork(doc), (d) => Automerge.splice(d, ["content"], 2, 1, text));
  const source = replaceLine(base, "source");
  const target = replaceLine(base, "target");
  const auto = autoOf(source, target);
  // The middle line: between the newline after "a" and the one after "b".
  const conflict: Conflict = {
    at: {
      path: ["content"],
      from: Automerge.getCursor(base, ["content"], 1),
      to: Automerge.getCursor(base, ["content"], 3),
    },
    source: "source",
    target: "target",
    both: "target\nsource",
  };
  const take = (value: string) =>
    edit(fork(auto), (d) => {
      const length = (valueAt(d, conflict.at) as string).length;
      Automerge.splice(d, ["content"], 2, length, value);
    });

  it("reads both insertions between its ends in auto", () => {
    expect([...(valueAt(auto, conflict.at) as string)].sort().join("")).toBe(
      [..."sourcetarget"].sort().join("")
    );
  });

  it("is open in auto, and taken once the merge writes a side", () => {
    expect(conflictState(conflict, { source, target, merged: auto })).toBe("open");
    expect(conflictState(conflict, { source, target, merged: take("source") })).toBe("source");
    expect(conflictState(conflict, { source, target, merged: take("target") })).toBe("target");
    expect(conflictState(conflict, { source, target, merged: take("target\nsource") })).toBe("both");
    expect(conflictState(conflict, { source, target, merged: take("neither") })).toBe("edited");
  });

  it("isn't resolved by an edit elsewhere in the text", () => {
    const merged = edit(fork(auto), (d) => Automerge.splice(d, ["content"], 0, 1, "A"));
    expect(conflictState(conflict, { source, target, merged })).toBe("open");
  });
});
