import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo/slim";
import { accept, type SubscribeEvent } from "@inkandswitch/patchwork-providers";

import type { DraftDoc, HasDrafts } from "../draft-types.js";
import { GitHubRemote, type Remote } from "./remote.js";
import {
  connect,
  disconnect,
  mainDraft,
  noteMerge,
  openBranch,
  openableBranches,
  publishDraft,
  remoteConfig,
  status,
  sync,
  type GitContext,
} from "./sync.js";

// The draft provider's git commands. Each answers `{ ok: true, ... }`, or
// `{ ok: false, error }` with something to show:
//   - `git:status { draft }` → `{ status }` (see `LineStatus`)
//   - `git:connect { owner, repo, branch, message }` → links main with a
//     branch of a GitHub repo, and syncs it
//   - `git:disconnect` → forgets the repo
//   - `git:sync { draft, message }` → `{ result }` (see `SyncResult`)
//   - `git:publish { draft, message }` → puts the draft on a branch of its name
//   - `git:branches` → `{ branches }` that could be opened as drafts
//   - `git:open-branch { branch }` → `{ draft }`, checked out
// The GitHub token is this device's, in localStorage under TOKEN_KEY.

export const TOKEN_KEY = "gaios:github-token";

export type GitCommandHost = {
  repo: Repo;
  root(): Promise<DocHandle<HasDrafts>>;
  // a draft named in a command: null for main, undefined if it isn't one
  draftIn(value: unknown): AutomergeUrl | null | undefined;
  checkedOut(): AutomergeUrl | null;
  select(draft: AutomergeUrl | null): Promise<void>;
  // tests hand one in; otherwise it's GitHub, with this device's token
  remote?: (owner: string, repo: string) => Remote;
};

export function handleGitCommand(event: SubscribeEvent, host: GitCommandHost): boolean {
  const selector = event.detail.selector as Record<string, unknown> & {
    type: string;
  };
  if (!selector.type.startsWith("git:")) return false;

  const run = (body: (ctx: GitContext) => Promise<Record<string, unknown>>) =>
    accept<Record<string, unknown>>(event, (respond) => {
      context(host, selector)
        .then(body)
        .then(
          (answer) => respond({ ok: true, ...answer }),
          (err: unknown) => {
            console.warn(`[drafts] ${selector.type} failed:`, err);
            respond({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        );
    });

  const draftOf = async (ctx: GitContext): Promise<DocHandle<DraftDoc> | null> => {
    const url = selector.draft == null ? null : host.draftIn(selector.draft);
    if (url === undefined) throw new Error("No such draft.");
    return url ? ctx.repo.find<DraftDoc>(url) : null;
  };
  const message = typeof selector.message === "string" ? selector.message : "";

  switch (selector.type) {
    case "git:status":
      run(async (ctx) => ({ status: await status(ctx, await draftOf(ctx)) }));
      return true;
    case "git:connect":
      run(async (ctx) => {
        const config = {
          owner: String(selector.owner ?? "").trim(),
          repo: String(selector.repo ?? "").trim(),
          branch: String(selector.branch ?? "").trim() || "main",
        };
        if (!config.owner || !config.repo) throw new Error("Name the repository as owner/name.");
        return {
          result: await connect(ctx, config, message || "Connect to strand"),
        };
      });
      return true;
    case "git:disconnect":
      run(async (ctx) => {
        await disconnect(ctx);
        return {};
      });
      return true;
    case "git:sync":
      run(async (ctx) => {
        const result = await sync(ctx, await draftOf(ctx), message);
        const current = host.checkedOut();
        if (current && result.merged.includes(current)) await host.select(null);
        return { result };
      });
      return true;
    case "git:publish":
      run(async (ctx) => {
        const draft = await draftOf(ctx);
        if (!draft) throw new Error("Main is connected, not published.");
        return { result: await publishDraft(ctx, draft, message) };
      });
      return true;
    case "git:branches":
      run(async (ctx) => ({ branches: await openableBranches(ctx) }));
      return true;
    case "git:open-branch":
      run(async (ctx) => {
        const draft = await openBranch(ctx, String(selector.branch ?? ""));
        await host.select(draft);
        return { draft };
      });
      return true;
    default:
      return false;
  }
}

// Before a draft merges here, so main's next export makes the merge commit of
// its branch.
export async function beforeMerge(
  host: GitCommandHost,
  draft: AutomergeUrl,
  into: AutomergeUrl | null,
): Promise<void> {
  const repo = host.repo;
  const root = await host.root();
  const handle = await repo.find<DraftDoc>(draft);
  if (!handle.doc()?.git) return;
  const ctx: GitContext = { repo, root, remote: unreachable };
  await noteMerge(ctx, handle, into ? await repo.find<DraftDoc>(into) : null);
}

async function context(
  host: GitCommandHost,
  selector: Record<string, unknown>,
): Promise<GitContext> {
  const root = await host.root();
  const base: GitContext = { repo: host.repo, root, remote: unreachable };
  const config =
    selector.type === "git:connect"
      ? {
          owner: String(selector.owner ?? "").trim(),
          repo: String(selector.repo ?? "").trim(),
        }
      : remoteConfig(await mainDraft(base));
  if (!config) return base;
  if (host.remote) return { ...base, remote: host.remote(config.owner, config.repo) };
  const token = readToken();
  if (!token) throw new Error("Add a GitHub token first.");
  return { ...base, remote: new GitHubRemote(config.owner, config.repo, token) };
}

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

// For contexts that never reach the remote.
const unreachable: Remote = new Proxy({} as Remote, {
  get: () => () => Promise.reject(new Error("This workspace isn't connected to git.")),
});
