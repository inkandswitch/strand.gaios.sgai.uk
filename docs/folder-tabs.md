# Folder tabs: build brief

Instructions for building "folder tabs" in GAIOS. You have this repository and nothing else: the design was worked out in conversation, and everything decided there is written down here. Read the three sketches first; they are the target.

- [Comparing](sketches/folder-tabs-1-comparing.svg): a folder tab as a review of changed documents
- [Not comparing](sketches/folder-tabs-2-files.svg): a folder tab as a plain file listing
- [A version from history, two panes](sketches/folder-tabs-3-version-two-panes.svg)

The sketches are drawn by `docs/sketches/folder-tabs.py`. Background on overlays, drafts, comparing and history is in [drafts-and-compare.md](drafts-and-compare.md); read it before touching `packages/drafts` or the compare code.

## The problem

The bar has an "Open documents / All documents" switch. It only changes what the History and Comments columns list. The main pane ignores it, so with "All documents" on and a multi-document version picked, the main pane shows "Open something from the project" while the side column talks about five documents.

## The design

There is no mode. A folder opens in a tab like a file does, and History and Comments cover whatever is visible in the dock.

1. **A folder is a tab.** Clicking a folder's name in the tree opens it; its arrow still unfolds it. The project is the tree's top row and opens the same way. With nothing else open, the main pane shows the project's folder tab instead of the empty message.
2. **Not comparing, a folder tab lists its own entries**: direct children only, folders first, in the folder's order. Two columns: name, and when it was last edited. Clicking a row opens it.
3. **Comparing, a folder tab is a review**: every document beneath the folder, at any depth, that differs between the two versions, one under another, like a pull request's "Files changed". Each is drawn by that document's own compare view under a header. Documents that don't differ aren't listed.
4. **History and Comments cover what is visible** in any pane. An open folder counts as every document beneath it. The switch is removed.

"Comparing" means the existing comparison is on (`state.comparing()` in `packages/projects`): two overlays, a merge against its target, or two points in one history. A draft on its own, or a single picked version, is not comparing and shows the listing.

### Each changed document's header (sketch 1)

Left: an arrow that folds the document away, its name, and its folder path when it isn't directly in the open folder. Right, the controls a document's tab bar has today, for that document alone:

- its compare mode picker, offering only the modes its view takes
- the mode's own controls, where they belong to the panel
- "collapse unchanged", where its view supports it
- open it in a tab of its own

The bar's existing picker ("Compare every panel") keeps working and now reaches these documents too. Modes whose options belong to the workspace, such as Onion skin's slider, keep their controls in the bar.

### Marks

A dot on a tree row or a listing row means "changed", using the tree's existing colours:

- comparing: as today
- a picked version: the documents that version changed, and the folders above them
- a draft, not comparing: the documents the draft changed since it was forked, and the folders above them
- Main's working copy: no dots

### What to leave out

These were tried in sketches and rejected. Do not add them.

- No counts or statistics above the listing, and no heading that repeats the tab's title.
- No comment badges in the tree or the listing.
- No label saying what History covers when it covers the whole project. Only when it covers less, e.g. "History · figures".
- No sorting by activity, no hiding of unchanged files in the listing.
- No cards or previews.

## How the code is laid out today

All paths are under `packages/`. Each package builds on its own into `dist/`, and the app loads the built files.

| What | Where |
|---|---|
| The frame: bar, card, side column | `projects/src/project.tsx`, `header.tsx` |
| The router; refuses to open folders | `projects/src/navigation.ts` (`go`, `endsInFolder`), `resolve.ts`, `location.ts` |
| The tree beside the dock | `projects/src/folder-tool.tsx` mounts sideboard's tool `chee/document-list` |
| Tree rows, change marks | `sideboard/src/sideboard/document-list/item.tsx`, `folder.tsx`, `changes.ts` |
| The dock and its tabs | `projects/src/dock.tsx` (`DockPanel`, `groupActions`, `watermark`) |
| One document shown and compared | `projects/src/panel.tsx` (`Compared`, `PanelCompareControls`, `createPanelState`, `createPanelModes`) |
| Mode picker, collapse toggle | `projects/src/compare-ui.tsx`; modes in `compare-modes/src` |
| The scope switch | `projects/src/header.tsx` (`ScopeToggle`), `side-panels.ts` (`PanelScope`) |
| History column | `projects/src/history.tsx` (`inScope` filters by open documents) |
| Comments column | `projects/src/comments.tsx` (`useOpenDocs`, the `comments:context` it answers), `comments/src/Sidebar.tsx` |
| Members, history entries, checkout | `drafts/src/providers/OverlayProvider.ts`, `overlay-repo.ts`, `overlay-types.ts` |

Useful existing pieces:

- `overlay:members { overlay, at }` answers every member with its heads and its parent. Two lists compared by heads give "what differs"; following `parent` gives "beneath this folder". `compare()` in sideboard's `changes.ts` is the reference for the rules.
- `overlay:history { overlay }` answers entries with the members each changed. The entry whose `id` equals the checked-out `at` is the picked version.
- `Compared` already draws one document in a compare mode from a `PanelCompare`. The review is a list of these.
- `folderLinks`, `isFolder`, `segmentFor` in `projects/src/folders.ts` read a folder's entries.
- The dock answers `dock:groups` and an open takes a `Placement`, so "open in the pane beside" needs no new plumbing.

## The work, in order

Each step should leave the app working. Commit after each.

### 1. Let folders open, and show the listing

- `navigation.ts`: a location ending in a folder is shown, not dropped. The comment above `go` and the tests that assert the old behaviour change with it.
- The project itself: a folder project with nothing open currently has no `docUrl`. Make that state show the project's folder tab. Decide whether that is a real dock panel or the dock's empty state; a real panel is simpler to reason about for step 3.
- `dock.tsx`: when a panel's document is a folder, render a new folder panel instead of `Compared`, and hide the tab bar's compare and "open with" controls for it.
- New `projects/src/folder-panel.tsx`, listing state only: the folder's entries read through the panel's repo (so it follows the checked-out overlay and version), and "last edited" from the history entries. For a folder row, the newest edit of anything beneath it.
- A row opens through `patchwork:open-document`, in the neighbouring pane when the dock has one, otherwise as a tab in its own.
- Sideboard: add the project's top row; a folder row's click opens it while the arrow toggles. Sideboard builds child locations with `childLocation` in `sideboard/src/sideboard/lib/location.ts`.

### 2. The review, while comparing

- In the folder panel, when comparing: subscribe to both versions' members, keep the documents beneath the folder whose heads differ or that only one version has, leave folders themselves out, and order them as the tree does.
- One section per document: a header and a `Compared`. Give each section its own `createPanelState()` and add those states to the list `createPanelModes` is given in `dock.tsx`, so the bar's picker reaches them and the modes they offer are reported back.
- Sections start with "collapse unchanged" on.
- A document only the other version has gets a header and one line saying so. Do not try to mount it.
- Sizing: tool views fill their container. Give each section's body a fixed height to begin with. Making text fit its content needs a change in `packages/file`; do it as a follow-up, not in this step.
- Cost: every `Compared` mounts two views, and the other version's sits inside its own overlay provider (`OtherOverlay`). Mount a section's views only when it scrolls near the viewport, and check a folder with twenty changed documents stays responsive.

### 3. Remove the switch

- Delete `ScopeToggle`, `PanelScope`, the stored setting, and the `scope` props that carry it.
- `useOpenDocs` in `comments.tsx` finds open documents by listening for views mounting. A folder panel is not a document view, so make it count: either have it report itself the same way, or have the dock report what each group is showing. Then expand each open folder to the members beneath it before the list reaches History and the comments context.
- Check what happens to a tab hidden behind another in the same group. Only the tab showing in each group should count.
- History's header names what it covers only when that is less than the project.
- `comments/src/Sidebar.tsx` has its own scope for when no frame tells it one. Leave that path alone.

### 4. Marks outside comparing

- A picked version: mark the members of that history entry, and the folders above them, in the tree and the listing.
- A draft: the overlay provider does not yet say which members a draft has changed. Add that to what `overlay:members` answers (the draft document already records each copy and the heads it was cloned at), with tests in `packages/drafts`. Then mark them the same way.
- These marks are a different fact from the comparison's, so do not fade unchanged rows as comparing does.

### 5. Finish

- Update [drafts-and-compare.md](drafts-and-compare.md): navigation, what the side column covers, and the new member field.
- Remove anything left that only the switch used.

## Working in this repository

- `pnpm dev` at the root runs the app and rebuilds packages as they change. If you build by hand, the app only sees a package after `pnpm --dir packages/<name> build`.
- `pnpm test` at the root runs every package's tests; `pnpm --dir packages/projects typecheck` checks types. `packages/file` has two type errors in `new-file-tool.tsx` that predate this work.
- Match the style of the file you're in; it differs between packages and sometimes within one (`projects` uses tabs and no semicolons, `drafts` two spaces and semicolons). Comments say what the code is for, briefly.
- Commits read `area: what changed`, e.g. `projects: folders open as tabs`.
- Opening a document must never write to it. An earlier bug did exactly that and showed up as phantom history entries.
- Check each step in the running app as well as in tests: open a folder, compare with a draft, pick a version in History, open two panes side by side.

## Done when

- A folder and the project open as tabs; the main pane is never empty while a project is open.
- Comparing, a folder tab lists exactly the documents that differ beneath it, each with working mode, collapse and open controls, and the bar's picker changes all of them.
- Not comparing, it lists the folder's own entries with last-edited times and nothing else.
- The switch is gone, and History and Comments follow what is visible, including folders.
- Picking a version or checking out a draft marks what it changed in the tree and the listing.
- Tests and typecheck pass, and the overlay documentation matches the code.
