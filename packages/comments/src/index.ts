import type { Plugin, ToolElement } from "@inkandswitch/patchwork-plugins";

export const plugins: Plugin<any>[] = [
  // The sidebar: a component with no document of its own. The frame mounts
  // it beside what's open and answers `comments:context` for it.
  {
    type: "patchwork:component",
    id: "gaios-comments",
    name: "Comments",
    async load() {
      const { renderSidebar } = await import("./main");
      return (element: ToolElement) => renderSidebar(null as never, element);
    },
  },
  // The datatype for a comment thread subdocument, so a thread opened on its
  // own resolves a title and a tool.
  {
    type: "patchwork:datatype",
    id: "comment-thread",
    name: "Comment Thread",
    icon: "MessageSquare",
    unlisted: true,
    async load() {
      const { CommentThreadDatatype } = await import("./datatype");
      return CommentThreadDatatype;
    },
  },
  // One thread, from its subdocument url: mounted by the sidebar per thread.
  {
    type: "patchwork:tool",
    id: "comment-thread",
    name: "Comment Thread",
    supportedDatatypes: ["comment-thread"],
    async load() {
      const { renderCommentThread } = await import("./main");
      return renderCommentThread;
    },
  },
];
