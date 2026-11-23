import { describe, expect, it } from "vitest";
import {
  generateAutomergeUrl,
  parseAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo/slim";

import { compare } from "./changes.ts";

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
