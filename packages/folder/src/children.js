import {
  DIRECTORY_RESERVED,
  asUrl,
  folderLinks,
  isDirectoryDoc,
} from "./links.js";

/**
 * The docs a folder holds, in entry order.
 * @returns {string[]}
 */
export function folderChildren(doc) {
  return folderLinks(doc).map(({ url }) => url);
}

/**
 * The files of a pushwork directory doc, at every depth.
 * @returns {string[]}
 */
export function directoryChildren(doc) {
  if (!isDirectoryDoc(doc)) return [];
  const children = [];
  for (const [key, value] of Object.entries(doc)) {
    if (DIRECTORY_RESERVED.has(key)) continue;
    const url = asUrl(value);
    if (url) children.push(url);
  }
  return children;
}
