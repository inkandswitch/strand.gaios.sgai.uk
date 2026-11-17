// Where two drafts of a document parted: the version both came from, which
// each draft's changes are shown against. Drafts are clones of each other,
// so they share the history up to there.

import {Automerge} from "@automerge/automerge-repo/slim"

type Doc = Automerge.Doc<unknown>

/**
 * The heads of what's in the history of both `a` and `b`. Not always the
 * fewest that will do: one may be in the history of another, which reads
 * the same. Read it from `b` (or `a`), which has all of it. Empty when
 * they share nothing.
 */
export function commonAncestor(a: Doc, b: Doc): Automerge.Heads {
	const aHeads = Automerge.getHeads(a)
	const bHeads = Automerge.getHeads(b)
	if (Automerge.hasHeads(a, bHeads)) return bHeads
	if (Automerge.hasHeads(b, aHeads)) return aHeads
	// Both, to tell what's only in b: what came after a's heads.
	const both = Automerge.merge(Automerge.clone(b), a)
	const onlyB = Automerge.getChangesMetaSince(both, aHeads)
	const only = new Set(onlyB.map(change => change.hash))
	// What's shared ends where b's own changes start, or at b's heads.
	const heads = new Set(bHeads)
	for (const change of onlyB) for (const dep of change.deps) heads.add(dep)
	return [...heads].filter(hash => !only.has(hash))
}
