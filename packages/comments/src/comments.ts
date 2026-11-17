import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo/slim";

/**
 * The `@patchwork.type` stamped on a comment thread so a datatype (and thus a
 * relevant tool, e.g. `comment-thread`) can be resolved when the thread's
 * subdocument is opened on its own — for instance in a tiling-frame panel.
 */
export const COMMENT_THREAD_TYPE = "comment-thread";

export type DocWithComments = {
  "@comments"?: {
    threads: CommentThread[];
  };
};

export type CommentThread = {
  id: string;
  refs: AutomergeUrl[];
  isResolved: boolean;
  comments: Comment[];
  "@patchwork"?: { type: string; title?: string };
};

export type Comment = {
  id: string;
  content?: string;
  draftContent?: string;
  contactUrl: AutomergeUrl;
  timestamp: number;
  "@patchwork"?: { type: string; title?: string };
};

/** The document a ref (or a thread's url) lives in: everything before its path or heads. */
export function docUrlOf(url: string): AutomergeUrl {
  const cut = url.search(/[/#]/);
  return (cut === -1 ? url : url.slice(0, cut)) as AutomergeUrl;
}

/** A ref that is the bare document url: the comment is on the whole document. */
export const isWholeDocument = (ref: string) => !ref.includes("/") && !ref.includes("#");

/** The url of thread `id` stored on `handle`. */
export const threadUrlOf = (handle: DocHandle<unknown>, id: string) =>
  handle.sub("@comments", "threads", { id }).url as AutomergeUrl;

export function createReply({
  threadHandle: thread,
  content,
  contactUrl,
}: {
  threadHandle: DocHandle<CommentThread>;
  content?: string;
  contactUrl: AutomergeUrl;
}): DocHandle<Comment> {
  const commentId = crypto.randomUUID();
  thread.change((thread) => {
    const comment: Comment = {
      id: commentId,
      contactUrl,
      timestamp: Date.now(),
    };
    if (content) comment.content = content;
    thread.comments.push(comment);
  });
  return thread.sub("comments", { id: commentId }) as DocHandle<Comment>;
}

/** Unresolved threads that have at least one saved (non-draft) comment, or a draft. */
export function openThreads(doc: DocWithComments | undefined): CommentThread[] {
  return (doc?.["@comments"]?.threads ?? []).filter((t) => !t.isResolved);
}

/** The first saved comment's text, flattened onto one line. */
export function firstLine(thread: CommentThread, max = 80): string {
  const text = thread.comments.find((c) => c.content)?.content?.trim().replace(/\s+/g, " ");
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
