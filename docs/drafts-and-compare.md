# Overlays and comparison: a simpler interface

Status: implemented on the `overlays` branch. Not backwards compatible, on
purpose: existing drafts and links are not read or migrated.

This note describes a smaller interface between the overlay provider (today's
draft provider), the compare provider and the views that show two versions of
a document.

## Terms

| Term | Meaning |
|---|---|
| root | The document an overlay provider is mounted on. A folder in GAIOS, but any document works. |
| workspace | The document listing a root's drafts and pull requests. The root points at it. |
| member | A document that is part of the root: the root itself and everything reachable from it through children plugins. |
| overlay | A document that changes how the members read and where writes to them go. There are two kinds: a draft and a merge. |
| main | The members as they really are, with no overlay. Named by `null` wherever an overlay is named. Always called Main. |
| draft | An overlay forked off main or another draft (its parent). It has its own clone of each member it changed. |
| merge | An overlay that reads as two others merged together: its source merged into its target. It has its own clone of each member edited while it is looked over. |
| preview | A merge nobody else can see: not in the workspace, reached only by its url. Every merge starts as one. |
| pull request | A merge listed in the workspace, for everyone. |
| conflict | A place in a merged member where a conflicts plugin says the two sides' changes don't go together. Only members a plugin is installed for have any. |
| version A, version B | The two sides of a comparison. Each is an overlay or main. |

## The model

1. **A root has overlays**, listed in its workspace. Main isn't in it, and
   the workspace holds nothing but the lists.
2. **Main is not an overlay.** It is the absence of one.
3. **Drafts and merges are separate documents** with separate shapes. What
   they share is how an overlay works: checking one out, reading members
   through it, copying a member on its first write.
4. **A comparison is two versions**, named by overlay. The compare provider
   holds which two and nothing else.
5. **A view reads and edits both versions through ordinary handles.** No
   contents are passed in messages, and there is no special way to edit. A
   view asks the overlay provider where the other version lives, with
   `repo:handle-descriptor { url, overlay }`, and opens that like any other
   document.
6. **Everything merges by default.** A merge is blocked only by conflicts an
   installed conflicts plugin reports. They are worked out from the documents
   each time and never stored.

## What is stored

```ts
// On the root: one pointer, written when the first overlay is made.
"@patchwork": { workspaceUrl: AutomergeUrl }

// The workspace it points at: every draft of the root, and its pull requests.
type Workspace = {
  "@patchwork": { type: "workspace" }
  drafts: AutomergeUrl[]
  merges: AutomergeUrl[]          // pull requests; previews aren't listed
}

type DraftDoc = {
  "@patchwork": { type: "draft" }
  name?: string                   // absent: "Draft"
  parent: AutomergeUrl | null     // the draft it was forked off; null is main
  clones: Record<AutomergeUrl, CloneEntry>   // per member: this draft's version of it
}

type MergeDoc = {
  "@patchwork": { type: "merge" }
  source: AutomergeUrl | null     // the draft merged in; null is main
  target: AutomergeUrl | null     // the draft merged into; null is main
  clones: Record<AutomergeUrl, CloneEntry>   // per member edited in the merge
}
```

- The workspace is not in the root itself. The root is a member, so overlays
  clone it, and a list stored there would be forked and merged with the
  content.
- The tree of drafts is stored once, as each draft's `parent`. Today it is
  stored twice, as `parent` and as a `drafts` list on the parent.
- A draft's `parent` only says where it was forked off. Where it merges to is
  a merge's `target`, which can be any draft or main.
- A merge has no name and no parent. It is named after the two it joins.
- A preview and a pull request are the same document. Listing it in the
  workspace is all that makes a preview a pull request.
- Nothing about conflicts is stored: not which there are, and not which way
  each was resolved. Both are read off the documents (see Conflicts).
- A merge's source and target are drafts or main, never another merge, and
  never the same.
- `CloneEntry` is as today, minus `mergedAt`. A merge records only
  `cloneUrl`, with `clonedAt` the heads it was cloned at.
- A draft that's merged, or deleted, comes off the workspace. Nothing marks it
  as merged: a draft whose `parent` is no longer listed is listed under the
  nearest ancestor that is.

Gone from storage: the "main draft" document with `isMain`, a draft's `drafts`
list, `preview`, `mergedAt`, and the counter behind numbered default names.

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

This works as it did, with two changes: a child is just a url, and the walk
reads each member through the overlay, so a merge's tree is walked as merged.
A child used to carry its datatype, so the walk could skip loading leaves;
with `overlay:members` every member is loaded anyway.

The plugin type and the walk are a module of their own in the drafts package
(`children.ts`), not a package. Every folder under `packages/` is built and
shipped as a tool, and the only thing that walks the tree is the overlay
provider; a datatype's package registers its plugin by type name and imports
nothing.

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
| `merge:publish { merge }` | command | `true` |
| `merge:accept { merge }` | command | `true` |
| `merge:conflicts { merge }` | stream | `MergeConflicts` (see Conflicts) |

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
  published: boolean              // a pull request; false for a preview
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
- `merges` holds the pull requests, and the checked-out merge too while it's a
  preview, so a preview is named and recognised like any other merge.
- `overlay:checkout`, `overlay:delete` and `merge:accept` take a preview as
  well as a listed overlay: any merge document whose source and target are
  listed drafts or main.
- `overlay:delete` checks main out if the overlay was checked out, or the
  source when it's a merge. Deleting a merge leaves its source and target as
  they were. Deleting a preview only checks something else out: it isn't
  listed, and its document is left behind.
- `overlay:members` answers for any overlay, not only the checked-out one, and
  pushes again when the members or any heads change.
- `repo:handle-descriptor` with an `overlay` says where that overlay's version
  of `url` lives, whatever is checked out. Without one it answers for the
  checked-out overlay, as before. This is the one place where leaving an
  argument out differs from `null`. Like a write, it clones the member into
  the overlay first, merges included, so what it names is always a stored
  document, read and written like any other.

Every view in the page reads through this: Patchwork gives each view a repo
of its own that resolves what the view finds with `repo:handle-descriptor`,
and that repo doesn't carry an overlay. So a view that needs the other
version asks the provider itself, naming the overlay, and opens what it's
told on the base repo (`repo.baseRepo`).

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
`Automerge.merge` of the two versions, and saves nothing. It lives in a repo
of its own that neither stores nor syncs. The first write to it
saves that merge as the merge's clone, records it in `clones`, turns the
stand-in into a real handle on the clone, and makes the change there.

### Merges

- **A merge follows both inputs**, so it always shows what accepting would
  leave the target as. Edits made in it, conflict resolutions included, stay
  in it until it is accepted.
- **Every merge starts as a preview.** `merge:create` makes the merge
  document and checks it out without listing it, so nobody else sees it.
  Reading it writes nothing; only an edit clones a member into it.
- **Publishing** is `merge:publish`. It lists the merge in the workspace, which
  makes it a pull request. Edits already made in the preview stay.
- **Accepting** is `merge:accept`, from a preview or a pull request alike. The
  target takes the merge's content, the merge comes off the workspace if it was
  on it, the target is checked out, and a source that is a draft is marked
  merged.
- **Cancelling a preview, or closing a pull request,** is `overlay:delete`.
- **There is one pull request per source and target.** `merge:create` for a
  pair that has one answers it, which is how a review is picked up again.
  Previews aren't listed, so they aren't found again: each `merge:create`
  without a pull request makes a new one.
- **A pull request is deleted when its source or target is** deleted or merged
  elsewhere.
- **There is no merging without a merge.** Merging a draft straight into its
  target is `merge:create` followed by `merge:accept`.
- **Either side can be main.** A merge with main as its source brings a draft
  up to date with main.
- **Accepting needs no open conflicts.** `merge:accept` answers `null` while
  there are any, and the header doesn't offer it then.

### Merging, end to end

1. `merge:create { source, target }` opens a preview, compared with its
   target (see Compare provider).
2. The user reads what the merge does to the target, before and after, and
   resolves any conflicts, or edits the merge if something needs fixing.
3. Then one of:
   - `merge:accept` merges it, once there are no open conflicts;
   - `merge:publish` makes it a pull request, conflicts or not, for someone
     to accept later;
   - `overlay:delete` cancels it.

The header lists pull requests in a section of their own beneath the drafts,
each named from the two it joins. While a merge is checked out it offers
Merge (disabled while any conflict is open), Create pull request (for a
preview), and Cancel or Close. It knows a merge is shown from
`compare.kind`, and which kind of merge from `published`.

### Before and after

A preview and a pull request look the same: the target as it is, and as it
would be after the merge. A view knows it's showing a merge from
`compare.kind` being `"merge"`, and then:

- **Before is on the left, after on the right**: B (the target), then A (the
  merge). This is the other way round from any other comparison.
- **Before is read-only.** The target doesn't change while a merge is looked
  over; fixes go into the merge.
- **The sides are headed "Before" and "After"**, in neutral colours rather
  than the versions' own. The options name the source and the target, from
  the comparison.
- **Changes are marked against before**: added and removed, in
  `--compare-added` and `--compare-removed`. Conflicts are marked in
  `--compare-conflict`, open or resolved.
- **Modes that show one text** (inline, combined, stacked) show after, with
  what the merge does to before marked in it.

The panel follows the same rule for modes it lays out itself.

## Conflicts

Automerge never refuses a merge: it always has a result. A conflict is a
place where that result may not be what either side meant, and only a
datatype can say where those are. Text, for example, keeps both of two
insertions at one spot:

```
base     EXAMPLE_DAY = date(2031, 10, 13)
source   EXAMPLE_DAY = date(2031, 12, 15)
target   EXAMPLE_DAY = date(2031, 11, 3)
merged   EXAMPLE_DAY = date(2031, 12, 1511, 3)
```

Without a plugin that looks, a member merges as Automerge merges it and
nothing is reported.

### Two versions of a merged member

- **auto** is the source's and target's versions merged and nothing more:
  what Automerge does on its own. Conflicts are found in it.
- **merged** is the merge's version: auto, plus whatever was changed in the
  merge. Which way each conflict went is read from it.

The changes only the merge has, `merged` after the source's and target's
heads, are exactly what was done in the merge. That is the record of every
resolution, so nothing else is kept. For a member not yet edited in the merge,
merged is auto and every conflict is open.

### What reports them

Nothing: datatypes don't declare anything. A member has conflicts only where
a `patchwork:merge-conflicts` plugin installed for its datatype reports
them, whichever package registers it:

```ts
type MergeConflictsDescription = PluginDescription & {
  type: "patchwork:merge-conflicts"
  datatypes: string[]
}

// What the plugin loads.
type FindConflicts = (versions: { source: Doc; target: Doc; auto: Doc }) => Conflict[]

type Conflict = {
  at: Place
  source: unknown                 // the source's value there
  target: unknown                 // the target's value there
  both?: unknown                  // keeping both, where that makes sense
}

// Where a conflict is, in auto and in merged alike: a path into the
// document, and, inside a text, the stretch strictly between the two
// characters `from` and `to` name, as Automerge cursors ("start" and "end"
// for the text's ends).
type Place = { path: (string | number)[]; from?: Cursor; to?: Cursor }
```

- **A conflict has no id.** It is its place: the cursors stay put however the
  text around them changes, so a conflict is told apart from the others, and
  found again, by `at`.
- **Places are cursors**, not offsets, so they hold in merged, whose history
  has all of auto's, however much was changed since. A text place names the
  characters just outside it, which neither side changed, so rewriting
  everything inside it moves neither end.
- **Values are what the place holds on each side**: the text of the lines for
  text, the value of the key for JSON. They're what a view offers as the
  options, with `both` as a third where the plugin gives one.
- With no plugin for a datatype, its members merge as Automerge merges them
  and nothing is reported. That includes Automerge's own conflicts
  (concurrent writes to one key): one value silently wins unless a plugin
  reports them.

The `file` package installs one for text files. It reports a conflict where
the source and the target changed the same lines since the version they
share, identical changes included: Automerge keeps both copies of those too.
Its `both` is the target's lines, then the source's.

### How a conflict went

Worked out for every conflict, the same way for every datatype:

| A change only in the merge touching `at`, made after every input change touching it | Value at `at` in merged | State |
|---|---|---|
| none | | `open` |
| some | the source's | `source` |
| some | the target's | `target` |
| some | `both` | `both` |
| some | none of those | `edited` |

- **Touching** is read from `Automerge.diff`: a patch at `path`, or inside the
  text between the cursors. For the merge's own changes, the diff of merged
  from the source's and target's heads to its own. For the inputs' changes,
  each change on either side since the version they share, diffed on its own.
- **After** means the merge's change has the input change in its history.
  So when either side changes the place again after it was resolved, nothing
  resolves that change yet, and the conflict is open again.
- **Taking a side** is writing that side's value at `at` in the merge, even
  where auto already showed it.

### Asking for them

The overlay provider answers `merge:conflicts { merge }` (see Overlay
provider), for any merge, checked out or not:

```ts
// Every conflict of the merge, by member. Empty when nothing reported any.
type MergeConflicts = Record<AutomergeUrl, (Conflict & { state: ConflictState })[]>

type ConflictState = "open" | "source" | "target" | "both" | "edited"
```

- It looks at the members whose heads differ between source and target, and
  only those whose datatype has a plugin, loaded like the children plugins.
- It already has all three versions: the inputs as their overlays read them,
  auto as the merge's in-memory version of a member, and merged as the
  merge's clone once there is one.
- It pushes again when either input or the merge changes.
- Open conflicts are what block accepting. The header counts them; the
  sidebar marks the members with any; a view draws its own member's.

## Compare provider

| Selector | Kind | Answer |
|---|---|---|
| `compare` | stream | `Comparison \| null` |
| `compare:set { overlay }` | command | `true` |
| `compare:clear` | command | `true` |

```ts
// Two versions side by side, or a merge against what it changes.
type Comparison =
  | { kind: "compare"; a: Overlay; b: Overlay }
  | {
      kind: "merge"
      a: AutomergeUrl             // the merge: after
      b: Overlay                  // its target: before
      source: Overlay
      target: Overlay
      published: boolean          // a pull request; false for a preview
    }
```

- A is the overlay checked out in the overlay provider the compare provider
  sits in.
- **Comparing** (`kind: "compare"`): B is the overlay set with `compare:set`.
  `compare:set { overlay: null }` compares with main, so turning comparing
  off is its own command.
- **Merging** (`kind: "merge"`): whenever a merge is checked out, A is the
  merge and B its target, always. `compare:set` and `compare:clear` answer
  `null` then. What was set before comes back when something else is
  checked out.
- Whether it's a merge, and its source, target and kind, are read from
  `overlays`, once, here. Nothing downstream works it out again.
- Names come from `overlays`. Colours are theme CSS variables, the same for
  every comparison: `--compare-a`, `--compare-b`, `--compare-added`,
  `--compare-removed`, `--compare-conflict`.
- The compare provider computes no differences.

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
- While a merge is shown (`compare.kind` is `"merge"`), the same comparison reads as
  what merging does to the target: changed, added (only in the merge),
  removed (only in the target), each in its own colour rather than the
  versions'. A member with open conflicts, and every folder above it, is
  marked as having them. The sidebar says whether it's a preview or a pull
  request.

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
  it supports. It replaces `compare:view`. A's and B's views of the document
  are both told; a view nested inside B is told null.
- The other four are today's `workspace:compare*` messages renamed, without
  the versions' names. They have not been simplified here.
- Folding unchanged stretches away is an option of the mode: a view is told
  `collapsed` inside `options`.

## Navigation

`workspace:route` and `workspace:focus` are renamed `navigation:route` and
`navigation:focus`.

## What a view does

1. Open its document as usual. That is its own side.
2. Subscribe to `compare` for A and B, and to `overlays` for its own overlay
   (`checkedOut`). The other side is whichever of A and B isn't its own.
3. Ask `repo:handle-descriptor { url, overlay }` for the other side, and open
   its `cloneUrl ?? url` on `repo.baseRepo`. If `overlay:members` for that
   side doesn't list the document, it's missing there.
4. Ask `compare-mode:view` which mode to draw.
5. Diff the two handles and paint with the CSS variables.
6. Edit either side through its handle, where `isReadOnly()` allows.

A mode that lays out two views wraps the B view in an overlay provider checked
out on B. That view follows the same steps from the other side.

Showing a merge (see Before and after), a view also:

7. Puts before (B) first and keeps it read-only, and marks what the merge
   does to it.
8. Subscribes to `merge:conflicts { merge }` and draws its member's conflicts,
   offering each side's value, and both, and editing as usual. Taking one
   writes that value at the conflict's place in the merge. The text view
   hides an open conflict under a hatch beneath its options, shows an option
   in place while it's hovered, and colours each taken line by its side until
   it's edited; before shows the target's lines there, then the source's.

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
| `DraftsState.workspace` (the old main draft) and `.main`, and every `isMain` check | `null` for main |
| `DraftEntry.depth` | follow `parent` |
| Commands answering with what they were given (`{ name }`, `{ draft }`, `{ into }`, `{ parent }`) | `true` |
| `draftRepoAbove`, the compare provider's hidden draft providers and tree walks | `overlay:members` |

## Links

The hash names the checked-out overlay as `overlay=<url>` (main when absent)
and what it's compared with as `compare=<url>`, or `compare=main`.

## Where it lives

| Part | Code |
|---|---|
| Stored shapes and message types | `packages/drafts/src/overlay-types.ts` |
| Children plugins and the member walk | `packages/drafts/src/children.ts` |
| Reading through an overlay, merges in memory | `packages/drafts/src/overlay-repo.ts` |
| Making, publishing, deleting, accepting | `packages/drafts/src/overlay-actions.ts` |
| The overlay provider | `packages/drafts/src/providers/OverlayProvider.ts`, `overlay-list.ts` |
| The compare provider | `packages/review/src/provider.ts` |
| Finding conflicts, how each went | `packages/drafts/src/conflicts.ts` |
| Text conflicts | `packages/file/src/conflicts.ts` |
| The header, panels, links | `packages/projects/src/` |
| Comparing members, for the sidebar | `packages/sideboard/src/sideboard/document-list/changes.ts` |
| Text and image views | `packages/file/src/components/draft-diff.ts`, `ImageFileViewer.tsx` |
