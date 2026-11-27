import { describe, expect, it } from "vitest";
import {
  generateAutomergeUrl,
  parseAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo/slim";

import { accept, type SubscribeEvent } from "@inkandswitch/patchwork-providers";
import { createRoot } from "solid-js";

import { compare, useChangeMarks } from "./changes.ts";

const [ROOT, DIR, SAME, EDITED, MINE, YOURS] = Array.from({ length: 6 }, generateAutomergeUrl);
const id = (at: AutomergeUrl) => parseAutomergeUrl(at).documentId as string;

const member = (at: AutomergeUrl, heads: string, parent: AutomergeUrl | null) => ({
  url: at,
  heads: [heads],
  parent,
});

describe("comparing two versions' members", () => {
  const ours = [
    member(ROOT, "r1", null),
    member(DIR, "d1", ROOT),
    member(SAME, "s", DIR),
    member(EDITED, "e1", DIR),
    member(MINE, "m", ROOT),
  ];
  const theirs = [
    member(ROOT, "r2", null),
    member(DIR, "d2", ROOT),
    member(SAME, "s", DIR),
    member(EDITED, "e2", DIR),
    member(YOURS, "y", DIR),
  ];
  const { marks, folders, onlyTheirs } = compare(ours, theirs);
  const mark = (at: AutomergeUrl) => marks.get(id(at));

  it("marks members by their heads, and by which version has them", () => {
    expect(mark(SAME)).toBeUndefined();
    expect(mark(EDITED)).toBe("differs");
    expect(mark(MINE)).toBe("ours");
    expect(mark(YOURS)).toBe("theirs");
    expect(onlyTheirs.map((m) => m.url)).toEqual([YOURS]);
  });

  it("marks a folder for what's beneath it, not for itself", () => {
    expect(folders.has(id(DIR))).toBe(true);
    expect(mark(DIR)).toBe("differs");
    expect(mark(ROOT)).toBe("differs");
  });

  it("leaves a folder unmarked when only it changed", () => {
    const quiet = compare(
      [member(ROOT, "r1", null), member(SAME, "s", ROOT)],
      [member(ROOT, "r2", null), member(SAME, "s", ROOT)]
    );
    expect(quiet.marks.size).toBe(0);
  });
});

describe("the marks, while a merge is shown against its target", () => {
  const MERGE = generateAutomergeUrl();
  const ours = [
    member(ROOT, "r1", null),
    member(DIR, "d1", ROOT),
    member(SAME, "s", DIR),
    member(EDITED, "e1", DIR),
    member(MINE, "m", ROOT),
  ];
  const theirs = [
    member(ROOT, "r2", null),
    member(DIR, "d2", ROOT),
    member(SAME, "s", DIR),
    member(EDITED, "e2", DIR),
    member(YOURS, "y", DIR),
  ];

  // A provider answering what the marks ask for, with `merging` deciding
  // whether A is a merge of B.
  function mount(merging: boolean) {
    const host = document.createElement("div");
    const element = document.createElement("div");
    host.append(element);
    const answers: Record<string, (selector: any) => unknown> = {
      compare: () =>
        merging
          ? { kind: "merge", a: MERGE, b: null, source: MINE, target: null, published: false }
          : { kind: "compare", a: MERGE, b: null },
      "overlay:members": (selector) => (selector.overlay === MERGE ? ours : theirs),
      "merge:conflicts": () => ({ [EDITED]: [{ state: "open" }] }),
    };
    host.addEventListener("patchwork:subscribe", ((event: SubscribeEvent) => {
      const answer = answers[event.detail.selector.type];
      if (answer) accept(event, (respond) => void respond(answer(event.detail.selector) as never));
    }) as EventListener);
    return element;
  }

  it("reads as what merging does to the target, with conflicts up to the root", () =>
    createRoot(async (dispose) => {
      const marks = useChangeMarks(mount(true));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(marks.merge()).toEqual({ published: false });
      expect(marks.mark(EDITED)).toBe("conflict");
      expect(marks.mark(DIR)).toBe("conflict");
      expect(marks.mark(MINE)).toBe("added");
      expect(marks.mark(YOURS)).toBe("removed");
      expect(marks.mark(SAME)).toBeUndefined();
      dispose();
    }));

  it("keeps the versions' marks while two drafts are only compared", () =>
    createRoot(async (dispose) => {
      const marks = useChangeMarks(mount(false));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(marks.merge()).toBeUndefined();
      expect(marks.mark(EDITED)).toBe("differs");
      expect(marks.mark(MINE)).toBe("ours");
      dispose();
    }));
});
