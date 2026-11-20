# Overlays and comparison: a simpler interface

Status: proposal, not implemented. Not backwards compatible, on purpose:
existing drafts and links are not read or migrated.

This note describes a smaller interface between the overlay provider (today's
draft provider), the compare provider and the views that show two versions of
a document.

## Terms

| Term | Meaning |
|---|---|
| root | The document an overlay provider is mounted on. A folder in GAIOS, but any document works. |
| member | A document that is part of the root: the root itself and everything reachable from it through children plugins. |
| overlay | A document that changes how the members read and where writes to them go. There are two kinds: a draft and a merge. |
| main | The members as they really are, with no overlay. Named by `null` wherever an overlay is named. Always called Main. |
| draft | An overlay forked off main or another draft (its parent). It has its own clone of each member it changed. |
| merge | An overlay that reads as two others merged together: its source merged into its target. It has its own clone of each member edited while it is looked over. |
| version A, version B | The two sides of a comparison. Each is an overlay or main. |

## The model

1. **A root has overlays.** There is no "workspace".
2. **Main is not an overlay.** It is the absence of one.
3. **Drafts and merges are separate documents** with separate shapes. What
   they share is how an overlay works: checking one out, reading members
   through it, copying a member on its first write.
4. **A comparison is two versions**, named by overlay. The compare provider
   holds which two and nothing else.
5. **A view reads and edits both versions through ordinary handles.** No
   contents are passed in messages, and there is no special way to edit.

## What is stored

```ts
// On the root: one pointer, written when the first overlay is made.
"@patchwork": { overlaysUrl: AutomergeUrl }

// The index it points at: every overlay of the root.
type OverlayIndex = {
  "@patchwork": { type: "overlay-index" }
  drafts: AutomergeUrl[]
  merges: AutomergeUrl[]
}

type DraftDoc = {
  "@patchwork": { type: "draft" }
  name?: string                   // absent: "Draft"
  parent: AutomergeUrl | null     // the draft it was forked off; null is main
  clones: Record<AutomergeUrl, CloneEntry>   // per member: this draft's version of it
  mergedAt?: number               // set once merged; it then drops out of the list
}

type MergeDoc = {
  "@patchwork": { type: "merge" }
  source: AutomergeUrl | null     // the draft merged in; null is main
  target: AutomergeUrl | null     // the draft merged into; null is main
  clones: Record<AutomergeUrl, CloneEntry>   // per member edited in the merge
}
```

- The index is not in the root itself. The root is a member, so overlays clone
  it, and a list stored there would be forked and merged with the content.
- The tree of drafts is stored once, as each draft's `parent`. Today it is
  stored twice, as `parent` and as a `drafts` list on the parent.
- A draft's `parent` only says where it was forked off. Where it merges to is
  a merge's `target`, which can be any draft or main.
- A merge has no name and no parent. It is named after the two it joins.
- A merge's source and target are drafts or main, never another merge, and
  never the same.
- `CloneEntry` is as today.

Gone from storage: the "main draft" document with `isMain`, a draft's `drafts`
list, `preview`, and the counter behind numbered default names.

## What belongs to an overlay

The members are found by walking from the root through `patchwork:children`
plugins. A datatype's package registers one for the datatypes it knows:

```ts
type ChildrenDescription = PluginDescription & {
  type: "patchwork:children"
  datatypes: string[]             // "*" for all
}

// What the plugin loads: the documents that are part of `doc`.
type ChildrenOf = (doc: unknown) => AutomergeUrl[]
```

- A plugin returns only documents that belong to the document, never ones it
  merely refers to (authors, accounts, tools).
- A write to a member through an overlay copies it into the overlay; a write
  to anything else lands on the document itself.
- A member with overlays of its own is read as a plain member. Only the root's
  overlays count.

This works as it does today, with two changes: the plugin type moves into a
package of its own, and a child is just a url. Today a child also carries its
datatype, so the walk can skip loading leaves; with `overlay:members` every
member is loaded anyway.

The folder package registers the only two plugins so far, for `folder` and
pushwork `directory` documents.

## Overlay provider

Today's draft provider, renamed, handling both kinds. All messages are
`patchwork:subscribe` selectors. A *stream* keeps pushing new values; a
*command* answers once.

| Selector | Kind | Answer |
|---|---|---|
| `overlays` | stream | `OverlaysState` |
| `overlay:members { overlay }` | stream | `Member[]` |
| `repo:handle-descriptor { url, overlay? }` | stream | `HandleDescriptor` |
| `overlay:checkout { overlay }` | command | `true` |
| `overlay:delete { overlay }` | command | `true` |
| `draft:create { parent }` | command | the new draft's url |
| `draft:rename { draft, name }` | command | `true` |
| `merge:create { source, target }` | command | the merge's url |
| `merge:accept { merge }` | command | `true` |

```ts
// A draft or a merge by its url, or null for main.
type Overlay = AutomergeUrl | null

type OverlaysState = {
  checkedOut: Overlay
  status: "loading" | "ready" | "unavailable"
  drafts: DraftEntry[]
  merges: MergeEntry[]
}

type DraftEntry = {
  url: AutomergeUrl
  name: string                    // the stored name, or "Draft"
  parent: AutomergeUrl | null
}

type MergeEntry = {
  url: AutomergeUrl
  source: AutomergeUrl | null
  target: AutomergeUrl | null
}

// One member, as an overlay has it.
type Member = {
  url: AutomergeUrl               // the same in every overlay
  heads: UrlHeads                 // the version this overlay reads
  parent: AutomergeUrl | null     // the member it was reached from; null for the root
}
```

- Field names mean the same in messages as in storage. `null` is main.
- A command that couldn't be done answers `null`.
- `status` is `loading` while the overlay the provider was started on is being
  opened (documents beneath wait), `unavailable` once that has taken too long,
  and `ready` once a checkout holds.
- `draft:create` and `merge:create` check the new overlay out.
- `overlay:delete` checks main out if the overlay was checked out. Deleting a
  merge leaves its source and target as they were.
- `overlay:members` answers for any overlay, not only the checked-out one, and
  pushes again when the members or any heads change.
- `repo:handle-descriptor` with an `overlay` says where that overlay's version
  of `url` lives. Without one it answers for the checked-out overlay, as
  today. This is the one place where leaving an argument out differs from
  `null`.

Main isn't in either list, has no name to carry, and can't be renamed.

### How an overlay reads a member

Both kinds copy a member on its first write. They differ in what is read
before that.

A draft:

| The member | Read as |
|---|---|
| not yet edited in the draft | its parent's version, pinned at the heads it had when the draft was forked |
| edited in the draft | the draft's own clone |

A merge:

| The member | Read as |
|---|---|
| the same in source and target | the target's version, live |
| differs between them, not yet edited in the merge | the two merged in memory, merged again when either changes |
| edited in the merge | the merge's own clone, with both inputs' new changes merged into it as they come |

The in-memory case is a stand-in handle: it keeps the member's url, reads
`Automerge.merge` of the two versions, and saves nothing. The first write to it
saves that merge as the merge's clone, records it in `clones`, turns the
stand-in into a real handle on the clone, and makes the change there.

### Merges

- **A merge follows both inputs**, so it always shows what accepting would
  leave the target as. Edits made in it stay in it until it is accepted.
- **Accepting** is `merge:accept`. The target takes the merge's content, the
  merge is removed, the target is checked out, and a source that is a draft is
  marked merged.
- **Dropping** is `overlay:delete`.
- **There is one per source and target.** `merge:create` for a pair that has
  one answers it, which is how a review is picked up again.
- **It is deleted when its source or target is** deleted or merged elsewhere.
- **There is no merging without a merge.** Merging a draft straight into its
  parent is `merge:create` followed by `merge:accept`.
- **Either side can be main.** A merge with main as its source brings a draft
  up to date with main.

### Merging, end to end

1. `merge:create { source, target }`.
2. `compare:set { overlay: target }` shows what the merge changes in the target.
3. The user reads it, and edits the merge if something needs fixing.
4. `merge:accept` accepts it; `overlay:delete` drops it.

The header lists merges however it likes, for example beneath their target,
named from the two they join. It offers accept and drop while one is checked
out, which it knows from `checkedOut` being in `merges`.

## Compare provider

| Selector | Kind | Answer |
|---|---|---|
| `compare` | stream | `Comparison \| null` |
| `compare:set { overlay }` | command | `true` |
| `compare:clear` | command | `true` |

```ts
type Comparison = { a: Overlay; b: Overlay }
```

- A is the overlay checked out in the overlay provider the compare provider
  sits in. B is the overlay set with `compare:set`.
- `compare:set { overlay: null }` compares with main, so turning comparing off
  is its own command.
- Names come from `overlays`. Colours are theme CSS variables, the same for
  every comparison: `--compare-a`, `--compare-b`, `--compare-added`,
  `--compare-removed`, `--compare-conflict`.
- The compare provider knows nothing about merges and computes no differences.

### What differs between two versions

Nothing answers "what changed". Whoever wants to know subscribes to
`overlay:members` for A and for B and compares the two lists:

| In A | In B | Means |
|---|---|---|
| same heads | same heads | unchanged |
| different heads | different heads | changed |
| present | absent | only in A |
| absent | present | only in B |

- A member is marked as holding changes when something beneath it differs,
  found by following `parent`.
- The sidebar and the header both need this, so it is one shared function over
  two lists.
- A member only in the other version has no name here. The sidebar opens it in
  that overlay to read its title.
- A change that was undone again still reads as changed, since heads differ.

## Compare modes

The mode (side by side, swipe, and so on) is display state, separate from the
comparison.

| Selector | Kind | Answered by | Answer |
|---|---|---|---|
| `compare-mode:view { supports, draws?, prefers? }` | stream | the panel | `{ mode, options } \| null` |
| `compare-mode:picked` | stream | the frame | `{ mode, count } \| null` |
| `compare-mode:options { mode, defaults }` | stream | the frame | that mode's options |
| `compare-mode:set-options { mode, value }` | command | the frame | `true` |
| `compare-mode:report { offered, inUse }` | command | the frame | `true` |

- `compare-mode:view` is what a view asks: which mode to draw, given the ones
  it supports. It replaces `compare:view`.
- The other four are today's `workspace:compare*` messages renamed, without
  the versions' names. They have not been simplified here.
- Folding unchanged stretches away is an option of the mode.

## Navigation

`workspace:route` and `workspace:focus` are renamed `navigation:route` and
`navigation:focus`.

## What a view does

1. Open its document as usual. That is its own side.
2. Subscribe to `compare` for A and B, and to `overlays` for its own overlay
   (`checkedOut`). The other side is whichever of A and B isn't its own.
3. Ask `repo:handle-descriptor { url, overlay }` for the other side's version
   and open it. If there is none, the document is missing on that side.
4. Ask `compare-mode:view` which mode to draw.
5. Diff the two handles and paint with the CSS variables.
6. Edit either side through its handle, where `isReadOnly()` allows.

A mode that lays out two views wraps the B view in an overlay provider checked
out on B. That view follows the same steps from the other side. So does a view
nested inside another, so an embedded document shows the comparison too.

## Removed

| Removed | Replaced by |
|---|---|
| `compare:edit`, in the compare provider and in the panel | editing the other side's handle |
| `compare:version` and the `other` bytes | `repo:handle-descriptor { url, overlay }` |
| `compare:view` and its `missing`, `editable`, `merging`, `names`, `collapsed` fields | `compare`, `compare-mode:view`, the handle itself |
| `compare:against` and its `previewing`, `merging`, `after` fields | `compare` |
| `compare:changes`, with its marks, ghosts and `mode` | `overlay:members` for each side |
| `compare:preview` | nothing; no code sends it today |
| `compare:set { draft: null }` meaning "off" | `compare:clear` |
| Version names and colours in messages | `overlays`, CSS variables |
| `merge:start`, `merge:cancel`, `merge:commit` in the compare provider | `merge:create`, `overlay:delete`, `merge:accept` in the overlay provider |
| `draft:merge`, `draft:preview-merge`, `draft:discard`, hidden preview drafts | merges |
| `drafts`, `draft:checkout`, `draft:delete` | `overlays`, `overlay:checkout`, `overlay:delete` |
| `DraftsState.workspace` and `.main`, and every `isMain` check | `null` for main |
| `DraftEntry.depth` | follow `parent` |
| Commands answering with what they were given (`{ name }`, `{ draft }`, `{ into }`, `{ parent }`) | `true` |
| `draftRepoAbove`, the compare provider's hidden draft providers and tree walks | `overlay:members` |

## Work needed in the drafts package

- The rename: the draft provider, its repo and its handle become the overlay
  provider, repo and handle, and take a draft or a merge.
- Storage as above: the index, separate draft and merge documents, `parent` as
  the only record of the draft tree, `null` for main.
- `repo:handle-descriptor` with an `overlay`.
- `overlay:members` for any overlay, with heads. Reporting heads loads every
  member, as today's comparison does. A draft's `clones` record which members
  it changed and the heads the rest are pinned at, so this can later be
  answered mostly without loading.
- Merges: the merge document, the stand-in handle, keeping edited clones
  merged with both inputs, marking the source merged on accept, deleting a
  merge when an input goes.
- The children plugin type in its own package.
