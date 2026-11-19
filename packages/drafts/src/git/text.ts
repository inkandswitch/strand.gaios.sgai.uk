import * as Automerge from "@automerge/automerge/slim";
import { diffChars, diffLines } from "diff";

// Copied from pushwork's `updateTextByLines` (`src/shapes/file.ts`). Keep the
// two in step by hand.

// Hunks larger than this (in UTF-16 code units, both sides together) are
// replaced whole rather than diffed character by character.
const CHAR_DIFF_LIMIT = 4_000;

// Turn the text at `path` (currently `before`) into `after` with as few
// splices as it takes. `Automerge.updateText` diffs the whole text character
// by character, which takes minutes on a large file whose changes are large
// too (a notebook re-run, its base64 images all new). This diffs by lines
// first, then refines each changed run of lines by characters when it's
// small, and replaces it whole when it isn't. Indexes are UTF-16 code units,
// as JavaScript strings and Automerge's text both count them.
export function updateTextByLines(
  d: unknown,
  path: Automerge.Prop[],
  before: string,
  after: string,
): void {
  const doc = d as Automerge.Doc<unknown>;
  const parts = diffLines(before, after);
  let at = 0;
  for (let i = 0; i < parts.length;) {
    if (!parts[i].added && !parts[i].removed) {
      at += parts[i].value.length;
      i++;
      continue;
    }
    let removed = "";
    let added = "";
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      if (parts[i].removed) removed += parts[i].value;
      else added += parts[i].value;
      i++;
    }
    if (removed.length + added.length > CHAR_DIFF_LIMIT) {
      Automerge.splice(doc, path, at, removed.length, added);
      at += added.length;
      continue;
    }
    for (const part of diffChars(removed, added)) {
      if (part.removed) {
        Automerge.splice(doc, path, at, part.value.length);
      } else if (part.added) {
        Automerge.splice(doc, path, at, 0, part.value);
        at += part.value.length;
      } else {
        at += part.value.length;
      }
    }
  }
}
