import { blobSha, toBytes, type FileContent } from "./blob.js";
import type { CommitInfo, FileChange, Relation, Remote, TreeEntry } from "./remote.js";

type Commit = { parents: string[]; tree: string; message: string };
type Tree = Map<string, TreeEntry>;

// A git host in memory, for tests: commits, trees and blobs are
// content-addressed by made-up ids, except blobs, which get git's own.
export class MemoryRemote implements Remote {
  readonly refs = new Map<string, string>();
  #commits = new Map<string, Commit>();
  #trees = new Map<string, Tree>();
  #blobs = new Map<string, Uint8Array>();
  #next = 0;

  // A commit straight onto `branch` (made if missing), as a git user would:
  // `files` maps paths to content, null deleting one.
  async push(
    branch: string,
    files: Record<string, FileContent | null>,
    message = "edit",
  ): Promise<string> {
    const parent = this.refs.get(branch);
    const baseTree = parent ? this.#commits.get(parent)!.tree : this.#tree(new Map());
    const { sha } = await this.commit({
      parents: parent ? [parent] : [],
      baseTree,
      changes: Object.entries(files).map(([path, content]) => ({
        path,
        mode: "100644",
        content: content === null ? null : toBytes(content),
      })),
      message,
    });
    this.refs.set(branch, sha);
    return sha;
  }

  // A merge commit of `from`'s tip into `into`, taking `from`'s files where
  // they differ.
  async merge(into: string, from: string, message = "merge"): Promise<string> {
    const ours = this.refs.get(into)!;
    const theirs = this.refs.get(from)!;
    const tree = new Map(this.#trees.get(this.#commits.get(ours)!.tree)!);
    for (const [path, entry] of this.#trees.get(this.#commits.get(theirs)!.tree)!) {
      tree.set(path, entry);
    }
    const sha = this.#commit({
      parents: [ours, theirs],
      tree: this.#tree(tree),
      message,
    });
    this.refs.set(into, sha);
    return sha;
  }

  // The files at a commit, as text.
  async files(commit: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const entry of await this.readTree(await this.treeOf(commit))) {
      out[entry.path] = new TextDecoder().decode(await this.readBlob(entry.sha));
    }
    return out;
  }

  message(commit: string): string {
    return this.#commits.get(commit)!.message;
  }

  parents(commit: string): string[] {
    return this.#commits.get(commit)!.parents;
  }

  async tip(branch: string) {
    return this.refs.get(branch) ?? null;
  }

  async branches() {
    return [...this.refs.keys()];
  }

  async compare(base: string, head: string) {
    const relation: Relation =
      base === head
        ? "identical"
        : this.#ancestors(head).has(base)
          ? "ahead"
          : this.#ancestors(base).has(head)
            ? "behind"
            : "diverged";
    const theirs = this.#ancestors(base);
    const commits: CommitInfo[] = [...this.#ancestors(head)]
      .filter((sha) => !theirs.has(sha))
      .reverse()
      .map((sha) => ({
        sha,
        message: this.#commits.get(sha)!.message,
        parents: this.#commits.get(sha)!.parents,
      }));
    return { relation, commits };
  }

  async treeOf(commit: string) {
    const found = this.#commits.get(commit);
    if (!found) throw new Error(`no commit ${commit}`);
    return found.tree;
  }

  async readTree(tree: string) {
    return [...this.#trees.get(tree)!.values()];
  }

  async readBlob(sha: string) {
    return this.#blobs.get(sha)!;
  }

  async commit(input: {
    parents: string[];
    baseTree: string;
    changes: FileChange[];
    message: string;
  }) {
    const tree = new Map(this.#trees.get(input.baseTree)!);
    for (const change of input.changes) {
      if (!change.content) {
        tree.delete(change.path);
        continue;
      }
      const sha = await blobSha(change.content);
      this.#blobs.set(sha, change.content);
      tree.set(change.path, {
        path: change.path,
        mode: change.mode,
        type: "blob",
        sha,
      });
    }
    const treeSha = this.#tree(tree);
    return {
      sha: this.#commit({
        parents: input.parents,
        tree: treeSha,
        message: input.message,
      }),
      tree: treeSha,
    };
  }

  async moveBranch(branch: string, sha: string) {
    const current = this.refs.get(branch);
    if (!current || !this.#ancestors(sha).has(current)) return false;
    this.refs.set(branch, sha);
    return true;
  }

  async createBranch(branch: string, sha: string) {
    if (this.refs.has(branch)) return false;
    this.refs.set(branch, sha);
    return true;
  }

  #tree(tree: Tree): string {
    const sha = `tree${this.#next++}`;
    this.#trees.set(sha, tree);
    return sha;
  }

  #commit(commit: Commit): string {
    const sha = `c${this.#next++}`;
    this.#commits.set(sha, commit);
    return sha;
  }

  // `sha` and every commit before it.
  #ancestors(sha: string): Set<string> {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(this.#commits.get(next)?.parents ?? []));
    }
    return seen;
  }
}
