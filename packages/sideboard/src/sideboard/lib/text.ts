import { isImmutableString, updateText } from "@automerge/automerge-repo/slim";

type Path = (string | number)[];

/** A doc string read the same whether it's a plain string or an ImmutableString. */
export function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isImmutableString(value)) return String(value);
  return undefined;
}

/**
 * Write `value` at `path`. A collaborative string is spliced, so concurrent
 * edits merge; anything else (an ImmutableString pushwork wrote, or nothing
 * yet) is replaced outright, since an ImmutableString can't be spliced.
 */
export function setText(doc: any, path: Path, value: string) {
  const parent = path.slice(0, -1).reduce((obj, key) => obj?.[key], doc);
  if (!parent) return;
  const key = path[path.length - 1];
  if (typeof parent[key] === "string") updateText(doc, path, value);
  else parent[key] = value;
}
