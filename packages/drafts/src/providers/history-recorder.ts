import { Automerge } from "@automerge/automerge-repo/slim";
import type {
  AutomergeUrl,
  DocHandle,
  DocHandleChangePayload,
  Repo,
} from "@automerge/automerge-repo/slim";

import { sameHeads } from "../children.js";
import { hasAll } from "../history.js";
import { ensureHistory, writeRecord } from "../journal.js";
import type { OverlayRepo } from "../overlay-repo.js";
import type { HistoryGroupsDoc, JournalDoc, Workspace } from "../overlay-types.js";

export type HistoryRecorder = { dispose(): void };

// This page's changes already recorded, by hash, whichever recorder saw them
// (the page may have a provider per version shown).
const recordedChanges = new Set<string>();

/**
 * Records every edit this client makes to the checked-out draft's (or
 * main's) members in its journal, one record per change, as it's made:
 * nothing for edits that sync in from elsewhere, nothing for just looking,
 * and nothing at a point in history or on a merge (whose edits are recorded
 * when it's accepted).
 *
 * It watches what the overlay writes to (each member's own copy, or the
 * member itself on main). A change there made by this client (its actor)
 * that isn't recorded yet is an edit to record. When it starts watching a
 * document it looks for such changes already made: the first write to a
 * draft lands on a copy made in the same moment.
 */
export function createHistoryRecorder(options: {
  repo: Repo;
  overlayRepo: OverlayRepo;
  workspace: () => Promise<DocHandle<Workspace>>;
  // Who's signed in: a contact, if known.
  author: () => AutomergeUrl | undefined;
}): HistoryRecorder {
  const { repo, overlayRepo } = options;
  // What's being watched: backing document url → member and listener.
  const watched = new Map<AutomergeUrl, { member: AutomergeUrl; handle: DocHandle<unknown>; stop(): void }>();
  let queue = Promise.resolve();
  let disposed = false;
  let syncing = 0;

  const resync = () => void sync();
  const stopMembers = overlayRepo.onMembers(resync);
  const stopRemap = overlayRepo.onRemap(resync);
  resync();

  return {
    dispose() {
      disposed = true;
      stopMembers();
      stopRemap();
      for (const each of watched.values()) each.stop();
      watched.clear();
    },
  };

  // Watch what each member is written to now.
  async function sync(): Promise<void> {
    const run = ++syncing;
    const members = await overlayRepo.members();
    if (disposed || run !== syncing) return;
    const wanted = new Map<AutomergeUrl, AutomergeUrl>();
    if (!overlayRepo.at) {
      for (const { url } of members) {
        const version = overlayRepo.versionOf(url);
        // A version forked off and not written yet is read, never written.
        if (version && !version.heads) wanted.set(version.url, url);
      }
    }
    for (const [backing, each] of watched) {
      if (wanted.get(backing) === each.member) continue;
      each.stop();
      watched.delete(backing);
    }
    for (const [backing, member] of wanted) {
      if (watched.has(backing)) continue;
      const handle = await repo.find<unknown>(backing).catch(() => null);
      if (!handle || disposed || run !== syncing || watched.has(backing)) continue;
      const onChange = (payload: DocHandleChangePayload<unknown>) =>
        record(member, handle, Automerge.getHeads(payload.patchInfo.before));
      handle.on("change", onChange);
      watched.set(backing, { member, handle, stop: () => handle.off("change", onChange) });
      record(member, handle);
    }
  }

  // One check at a time, so a burst of changes can't record twice. `since`
  // is what the document was before the change; unset, its whole history.
  function record(member: AutomergeUrl, handle: DocHandle<unknown>, since?: Automerge.Heads): void {
    const line = overlayRepo.overlay;
    queue = queue
      .then(() => recordNow(member, handle, line, since))
      .catch((err) => console.warn(`[drafts] couldn't record an edit to ${member}:`, err));
  }

  async function recordNow(
    member: AutomergeUrl,
    handle: DocHandle<unknown>,
    line: AutomergeUrl | null,
    since: Automerge.Heads | undefined
  ): Promise<void> {
    if (disposed || overlayRepo.at || overlayRepo.overlay !== line) return;
    const doc = handle.doc() as Automerge.Doc<unknown> | undefined;
    if (!doc) return;
    const heads = Automerge.getHeads(doc);
    const from = since && hasAll(doc, since) ? since : ([] as unknown as Automerge.Heads);
    const mine = Automerge.getActorId(doc);
    const own = Automerge.getChangesMetaSince(doc, from).filter(
      (change) => change.actor === mine && !recordedChanges.has(change.hash)
    );
    for (const change of own) recordedChanges.add(change.hash);
    // Bookkeeping under `@patchwork` (a workspace pointer, say) isn't an edit.
    const edits = own.filter((change) => editsContent(doc, change));
    if (!edits.length) return;
    const workspace = await options.workspace();
    const refs = await ensureHistory(repo, workspace, line);
    const journal = await repo.find<JournalDoc>(refs.journal);
    if (sameHeads(Object.keys(journal.doc()?.members?.[member]?.heads ?? {}), heads)) return;
    const groups = await repo.find<HistoryGroupsDoc>(refs.groups);
    writeRecord(journal, groups, {
      members: { [member]: [...heads] },
      time: Math.max(...edits.map((change) => change.time)),
      message: { draft: line },
      author: options.author(),
    });
  }
}

// Whether `change` touches anything outside `@patchwork`.
function editsContent(doc: Automerge.Doc<unknown>, change: Automerge.ChangeMetadata): boolean {
  try {
    const patches = Automerge.diff(doc, change.deps as Automerge.Heads, [change.hash] as Automerge.Heads);
    return patches.some((patch) => patch.path[0] !== "@patchwork");
  } catch {
    return true;
  }
}
