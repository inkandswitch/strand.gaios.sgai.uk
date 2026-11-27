import type { AutomergeUrl } from "@automerge/automerge-repo/slim";

/**
 * What the frame tells the sidebar, answering `comments:context`:
 * the project, what's open in it, and the drafts.
 */
export type CommentsContext = {
  /** the project's root: a folder, or a document shown on its own */
  projectUrl: AutomergeUrl;
  projectId: string;
  projectName: string;
  root: "folder" | "document";
  /**
   * what's visible in the dock (or the root document), in order: an open
   * folder counts as every document beneath it
   */
  openDocs: AutomergeUrl[];
  /**
   * the documents shown in views, when the frame says: a thread on one that
   * isn't is opened to be revealed; `openDocs` when absent
   */
  viewed?: AutomergeUrl[];
  /** the checked-out draft's name */
  ours: string | null;
  /** the draft it's compared with, while comparing */
  theirs: string | null;
  /**
   * which threads to list, when the frame decides: on what's visible
   * (`openDocs`), or all of them; it then titles the sidebar too
   */
  scope?: "open" | "all";
  /** the thread a tool last asked to show (counted, so asking again is new) */
  active: { threadUrl: AutomergeUrl; count: number } | null;
};

export const CONTEXT = "comments:context";
/** tool → frame (a bubbling event): show the sidebar on a thread */
export const SHOW = "patchwork:show-comments";
/** tool → frame: start a thread `{ refs }` in the root document; answers its url or null */
export const CREATE = "comments:create";

/** The url `patchwork:open-document` takes for a document in the project. */
export function locationUrl(projectId: string, segments: string[]) {
  return `automerge:${projectId}${segments.map((s) => `/${encodeURIComponent(s)}`).join("")}`;
}
