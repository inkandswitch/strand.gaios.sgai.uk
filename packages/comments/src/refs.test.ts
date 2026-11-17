import { describe, expect, it } from "vitest";
import type { DocHandle } from "@automerge/automerge-repo/slim";
import { docUrlOf, firstLine, isWholeDocument, type CommentThread } from "./comments";
import { locationUrl } from "./context";
import { fallback, quote } from "./refs";

const fake = (doc: unknown, range?: [number, number]) =>
  ({ doc: () => doc, rangePositions: () => range }) as unknown as DocHandle<unknown>;

describe("refs", () => {
  it("finds the document a ref is in", () => {
    expect(docUrlOf("automerge:abc")).toBe("automerge:abc");
    expect(docUrlOf("automerge:abc/diagrams/%7B%7D")).toBe("automerge:abc");
    expect(docUrlOf("automerge:abc#heads")).toBe("automerge:abc");
    expect(docUrlOf("automerge:abc/%5C%40anchors/x#h")).toBe("automerge:abc");
  });

  it("tells a whole-document ref from a part", () => {
    expect(isWholeDocument("automerge:abc")).toBe(true);
    expect(isWholeDocument("automerge:abc/content")).toBe(false);
    expect(isWholeDocument("automerge:abc#h")).toBe(false);
  });

  it("quotes a text range, and calls a collapsed one removed", () => {
    expect(fallback([fake("  some\n text ", [3, 14])]).label).toBe("“some text”");
    expect(fallback([fake("", [4, 4])]).removed).toBe(true);
  });

  it("calls a part that no longer resolves removed", () => {
    expect(fallback([fake(undefined)]).removed).toBe(true);
    expect(fallback([]).removed).toBe(true);
    expect(fallback([fake({ a: 1 }), fake({ b: 2 })]).label).toBe("2 parts");
  });

  it("shortens long quotes", () => {
    expect(quote("x".repeat(100), 10)).toBe(`“${"x".repeat(9)}…”`);
  });

  it("builds the url the frame opens a document by", () => {
    expect(locationUrl("abc", ["docs", "a b.md"])).toBe("automerge:abc/docs/a%20b.md");
    expect(locationUrl("abc", [])).toBe("automerge:abc");
  });

  it("previews a thread by its first saved comment", () => {
    const thread = {
      comments: [{ id: "1", contactUrl: "c", timestamp: 0 }, { id: "2", content: " hi\nthere ", contactUrl: "c", timestamp: 0 }],
    } as unknown as CommentThread;
    expect(firstLine(thread)).toBe("hi there");
  });
});
