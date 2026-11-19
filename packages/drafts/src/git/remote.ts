import { fromBase64, toBase64 } from "./blob.js";

// What sync needs of a git host. `GitHubRemote` talks to GitHub's REST API;
// tests use `MemoryRemote`.

export type TreeEntry = {
  path: string;
  // "100644" a file, "100755" an executable, "120000" a symlink, "160000" a
  // submodule. Only the first two are synced; the others are left alone.
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
};

export type CommitInfo = {
  sha: string;
  message: string;
  parents: string[];
};

// How `head` relates to `base`: the same commit, descended from it, an
// ancestor of it, or neither.
export type Relation = "identical" | "ahead" | "behind" | "diverged";

export type FileChange = {
  path: string;
  mode: string;
  // null deletes the file
  content: Uint8Array | null;
};

export interface Remote {
  // The branch's latest commit, or null when there's no such branch.
  tip(branch: string): Promise<string | null>;
  branches(): Promise<string[]>;
  // How `head` relates to `base`, and the commits on `head` that `base`
  // doesn't have, oldest first.
  compare(base: string, head: string): Promise<{ relation: Relation; commits: CommitInfo[] }>;
  treeOf(commit: string): Promise<string>;
  // Every entry of a tree, at every depth; blobs and submodules only.
  readTree(tree: string): Promise<TreeEntry[]>;
  readBlob(sha: string): Promise<Uint8Array>;
  // A commit of `baseTree` with `changes` applied. Moves no branch.
  commit(input: {
    parents: string[];
    baseTree: string;
    changes: FileChange[];
    message: string;
  }): Promise<{ sha: string; tree: string }>;
  // Fast-forward `branch` to `sha`. False when the branch moved meanwhile
  // (the push isn't a fast-forward).
  moveBranch(branch: string, sha: string): Promise<boolean>;
  // False when there's already a branch of that name.
  createBranch(branch: string, sha: string): Promise<boolean>;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const API = "https://api.github.com";

// GitHub's REST API, called straight from the page. `token` is a personal
// access token (fine-grained, with read and write access to the repo's
// contents).
export class GitHubRemote implements Remote {
  #trees = new Map<string, TreeEntry[]>();
  #blobs = new Map<string, Uint8Array>();

  constructor(
    readonly owner: string,
    readonly repo: string,
    readonly token: string,
  ) {}

  async tip(branch: string): Promise<string | null> {
    const res = await this.#call(`/git/ref/heads/${encodeRef(branch)}`, {
      allow: [404],
    });
    if (!res) return null;
    const ref = res as { object: { sha: string; type: string } };
    return ref.object.sha;
  }

  async branches(): Promise<string[]> {
    const names: string[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = (await this.#call(`/branches?per_page=100&page=${page}`)) as { name: string }[];
      names.push(...batch.map((b) => b.name));
      if (batch.length < 100) break;
    }
    return names;
  }

  async compare(base: string, head: string) {
    const res = (await this.#call(`/compare/${base}...${head}`)) as {
      status: Relation;
      commits: {
        sha: string;
        commit: { message: string };
        parents: { sha: string }[];
      }[];
    };
    return {
      relation: res.status,
      commits: res.commits.map((c) => ({
        sha: c.sha,
        message: c.commit.message,
        parents: c.parents.map((p) => p.sha),
      })),
    };
  }

  async treeOf(commit: string): Promise<string> {
    const res = (await this.#call(`/git/commits/${commit}`)) as {
      tree: { sha: string };
    };
    return res.tree.sha;
  }

  async readTree(tree: string): Promise<TreeEntry[]> {
    const cached = this.#trees.get(tree);
    if (cached) return cached;
    const res = (await this.#call(`/git/trees/${tree}?recursive=1`)) as {
      tree: TreeEntry[];
      truncated: boolean;
    };
    if (res.truncated) {
      throw new GitError("This repository is too large to sync: GitHub truncated its file list.");
    }
    const entries = res.tree.filter((e) => e.type !== "tree");
    this.#trees.set(tree, entries);
    return entries;
  }

  async readBlob(sha: string): Promise<Uint8Array> {
    const cached = this.#blobs.get(sha);
    if (cached) return cached;
    const res = (await this.#call(`/git/blobs/${sha}`)) as {
      content: string;
      encoding: string;
    };
    const bytes =
      res.encoding === "base64" ? fromBase64(res.content) : new TextEncoder().encode(res.content);
    this.#blobs.set(sha, bytes);
    return bytes;
  }

  async commit(input: {
    parents: string[];
    baseTree: string;
    changes: FileChange[];
    message: string;
  }) {
    const tree = await Promise.all(
      input.changes.map(async (change) => {
        if (!change.content) {
          return { path: change.path, mode: change.mode, type: "blob", sha: null };
        }
        const blob = (await this.#call(`/git/blobs`, {
          method: "POST",
          body: { content: toBase64(change.content), encoding: "base64" },
        })) as { sha: string };
        return {
          path: change.path,
          mode: change.mode,
          type: "blob",
          sha: blob.sha,
        };
      }),
    );
    const newTree = (await this.#call(`/git/trees`, {
      method: "POST",
      body: { base_tree: input.baseTree, tree },
    })) as { sha: string };
    const commit = (await this.#call(`/git/commits`, {
      method: "POST",
      body: { message: input.message, tree: newTree.sha, parents: input.parents },
    })) as { sha: string };
    return { sha: commit.sha, tree: newTree.sha };
  }

  async moveBranch(branch: string, sha: string): Promise<boolean> {
    const res = await this.#call(`/git/refs/heads/${encodeRef(branch)}`, {
      method: "PATCH",
      body: { sha, force: false },
      allow: [422],
    });
    return res !== null;
  }

  async createBranch(branch: string, sha: string): Promise<boolean> {
    const res = await this.#call(`/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha },
      allow: [422],
    });
    return res !== null;
  }

  // A call to the repo's API. A status in `allow` answers null; any other
  // failure throws.
  async #call(
    path: string,
    options: { method?: string; body?: unknown; allow?: number[] } = {},
  ): Promise<unknown> {
    const res = await fetch(`${API}/repos/${this.owner}/${this.repo}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      // GitHub lets browsers reuse its answers for a minute, so a branch read
      // straight after moving it would still name the old commit. Trees and
      // blobs are kept above, by their ids, which never change.
      cache: "no-store",
    });
    if (res.ok) return res.json();
    if (options.allow?.includes(res.status)) return null;
    throw new GitError(await describe(res), res.status);
  }
}

async function describe(res: Response): Promise<string> {
  let detail = "";
  try {
    detail = ((await res.json()) as { message?: string }).message ?? "";
  } catch {
    // no body
  }
  switch (res.status) {
    case 401:
      return "GitHub didn't accept the token. Check it, or make a new one.";
    case 403:
      return `GitHub refused: ${detail || "the token may lack access to this repository"}.`;
    case 404:
      return "GitHub can't find that. Check the repository name and that the token can read it.";
    case 409:
      return "The repository is empty. Make a first commit on GitHub (a README is enough), then try again.";
    default:
      return `GitHub answered ${res.status}${detail ? `: ${detail}` : ""}`;
  }
}

function encodeRef(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

// Whether `name` can be a branch name (git check-ref-format, roughly).
export function validBranchName(name: string): boolean {
  if (!name || name.length > 200) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) return false;
  if (name.endsWith(".") || name.endsWith(".lock") || name === "@") return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)) return false;
  return name.split("/").every((part) => part && !part.startsWith("."));
}
