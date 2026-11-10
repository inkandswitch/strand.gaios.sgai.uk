import {
  parseAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo/slim";
import type { DocLink } from "@inkandswitch/patchwork-filesystem";
import { asString } from "./text.ts";

/**
 * Where `link` lives, one segment below the folder at `parent`:
 * `automerge:<root>/<name>/<name>`. Locations are what the project frame opens
 * documents by, instead of their bare urls.
 */
export function childLocation(
  parent: string,
  link: DocLink,
  siblings: readonly DocLink[] = []
): AutomergeUrl {
  return `${parent}/${encodeURIComponent(segmentFor(link, siblings))}` as AutomergeUrl;
}

/**
 * The segment naming `link` among its siblings: its name, or its document id
 * when the name is empty or another entry in the same folder shares it.
 */
function segmentFor(link: DocLink, siblings: readonly DocLink[]) {
  const name = asString(link.name) ?? "";
  const url = asString(link.url);
  const clash = siblings.some(
    (sibling) => asString(sibling.url) !== url && asString(sibling.name) === name
  );
  if (name && !clash) return name;
  return parseAutomergeUrl(link.url).documentId;
}
