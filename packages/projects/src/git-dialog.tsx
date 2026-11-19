import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {request} from "@inkandswitch/patchwork-providers"
import {createSignal, For, onMount, Show, type JSX} from "solid-js"
import type {DraftEntry} from "./types.ts"

// The draft provider's git commands (drafts' `git/commands.ts`), and what they
// answer.

/** where the draft provider looks for this device's GitHub token */
const TOKEN_KEY = "gaios:github-token"

type CommitInfo = {sha: string; message: string; parents: string[]}

type LineStatus =
	| {kind: "not-connected"}
	| {kind: "unlinked"; branch: string; problem?: string}
	| {
			kind: "linked"
			branch: string
			synced: {sha: string; at: number}
			local: string[]
			incoming: CommitInfo[]
			rewritten: boolean
			missing: boolean
			duplicate: boolean
	  }

type SyncResult = {
	imported: string[]
	exported: string[]
	sha: string
	merged: AutomergeUrl[]
}

type Answer<T> = ({ok: true} & T) | {ok: false; error: string}

/**
 * Syncing the checked-out draft with git, as one deliberate step: what's
 * changed on each side since they last agreed, then a commit message and
 * Sync. Main connects to a repository first; another draft gets a branch of
 * its name.
 */
export function GitDialog(props: {
	draft: DraftEntry
	isMain: boolean
	/** where requests go from, inside the draft provider */
	element: HTMLElement
	onClose(): void
}) {
	let dialog!: HTMLDialogElement
	const [status, setStatus] = createSignal<LineStatus>()
	const [error, setError] = createSignal<string>()
	const [busy, setBusy] = createSignal(false)
	const [done, setDone] = createSignal<string>()
	const [message, setMessage] = createSignal("")
	const [token, setToken] = createSignal(readToken() ?? "")
	const [editingToken, setEditingToken] = createSignal(!readToken())
	const [branches, setBranches] = createSignal<string[]>()
	const draft = () => (props.isMain ? null : props.draft.url)

	async function call<T>(
		selector: Record<string, unknown>
	): Promise<(T & {ok: true}) | undefined> {
		setError(undefined)
		const answer = await request<Answer<T> | null>(
			props.element,
			selector as never
		)
		if (!answer) {
			setError("Nothing answered. Is the workspace still open?")
			return undefined
		}
		if (!answer.ok) {
			setError(answer.error)
			if (/token/i.test(answer.error)) setEditingToken(true)
			return undefined
		}
		return answer
	}

	async function refresh() {
		const answer = await call<{status: LineStatus}>({
			type: "git:status",
			draft: draft(),
		})
		setStatus(answer?.status)
	}

	async function act(
		selector: Record<string, unknown>,
		describe: (result: SyncResult) => string
	) {
		setBusy(true)
		setDone(undefined)
		try {
			const answer = await call<{result: SyncResult}>(selector)
			if (answer) {
				setDone(describe(answer.result))
				setMessage("")
			}
			await refresh()
		} finally {
			setBusy(false)
		}
	}

	const saveToken = (event: SubmitEvent) => {
		event.preventDefault()
		writeToken(token().trim())
		setEditingToken(false)
		void refresh()
	}

	onMount(() => {
		dialog.showModal()
		void refresh()
	})

	return (
		<dialog
			ref={dialog}
			class="projects__dialog projects__git"
			aria-labelledby="git-dialog-title"
			onClose={() => props.onClose()}
			onClick={event => {
				if (event.target === dialog) dialog.close()
			}}
		>
			<header class="projects__dialog-header">
				<h2 id="git-dialog-title">Git · {props.draft.name}</h2>
				<button
					type="button"
					class="projects__token-clear"
					aria-label="Close"
					title="Close"
					onClick={() => dialog.close()}
				>
					×
				</button>
			</header>

			<Show when={editingToken()}>
				<form class="projects__git-section" onSubmit={saveToken}>
					<label class="projects__git-field">
						<span>GitHub token</span>
						<input
							type="password"
							autocomplete="off"
							value={token()}
							onInput={event => setToken(event.currentTarget.value)}
							placeholder="github_pat_…"
						/>
					</label>
					<p class="projects__git-hint">
						A fine-grained personal access token with read and write access to
						the repository's contents. It's kept on this device only.
					</p>
					<div class="projects__git-actions">
						<button
							type="submit"
							class="projects__button"
							disabled={!token().trim()}
						>
							Save token
						</button>
					</div>
				</form>
			</Show>

			<Show when={error()}>
				{text => (
					<p class="projects__git-error" role="alert">
						{text()}
					</p>
				)}
			</Show>
			<Show when={done()}>
				{text => (
					<p class="projects__git-done" role="status">
						{text()}
					</p>
				)}
			</Show>

			<Show
				when={status()}
				fallback={
					<Show when={!error()}>
						<p class="projects__git-hint">Checking…</p>
					</Show>
				}
			>
				{current => (
					<>
						<Show when={current().kind === "not-connected"}>
							<Show
								when={props.isMain}
								fallback={
									<p class="projects__git-section">
										This workspace isn't connected to git yet. Connect it from
										Main.
									</p>
								}
							>
								<Connect
									busy={busy()}
									connect={(owner, repo, branch) =>
										act(
											{
												type: "git:connect",
												owner,
												repo,
												branch,
												message: message(),
											},
											result => summary(result, "Connected")
										)
									}
								/>
							</Show>
						</Show>

						<Show
							when={
								current().kind === "unlinked" &&
								(current() as Extract<LineStatus, {kind: "unlinked"}>)
							}
						>
							{unlinked => (
								<section class="projects__git-section">
									<p>
										Not on a branch yet. Publishing makes the branch{" "}
										<code>{unlinked().branch}</code> from main and commits this
										draft's changes to it.
									</p>
									<Show when={unlinked().problem}>
										{problem => (
											<p class="projects__git-warning">{problem()}</p>
										)}
									</Show>
									<Show when={!unlinked().problem}>
										<MessageField
											value={message()}
											set={setMessage}
											placeholder={`Start ${unlinked().branch}`}
										/>
										<div class="projects__git-actions">
											<button
												type="button"
												class="projects__button projects__button--primary"
												disabled={busy()}
												onClick={() =>
													act(
														{
															type: "git:publish",
															draft: draft(),
															message: message(),
														},
														result =>
															summary(
																result,
																`Published to ${unlinked().branch}`
															)
													)
												}
											>
												Publish branch
											</button>
										</div>
									</Show>
								</section>
							)}
						</Show>

						<Show
							when={
								current().kind === "linked" &&
								(current() as Extract<LineStatus, {kind: "linked"}>)
							}
						>
							{linked => (
								<section class="projects__git-section">
									<p>
										Branch <code>{linked().branch}</code>, last synced at{" "}
										<code>{linked().synced.sha.slice(0, 7)}</code>{" "}
										{ago(linked().synced.at)}.
									</p>
									<Show when={linked().rewritten}>
										<p class="projects__git-warning">
											The branch was rewritten on the git side (force-pushed or
											rebased). Syncing it isn't supported yet.
										</p>
									</Show>
									<Show when={linked().missing}>
										<p class="projects__git-warning">
											The branch is gone from the repository.
										</p>
									</Show>
									<Show when={linked().duplicate}>
										<p class="projects__git-warning">
											The last commit was recorded twice, perhaps synced from
											two places at once. Check its files for doubled text.
										</p>
									</Show>
									<Changes
										title="Changed here"
										empty="Nothing changed here."
										items={linked().local}
									/>
									<Changes
										title="New on the branch"
										empty="Nothing new on the branch."
										items={linked().incoming.map(commit =>
											firstLine(commit.message)
										)}
									/>
									<Show when={!linked().rewritten && !linked().missing}>
										<Show when={linked().local.length > 0}>
											<MessageField
												value={message()}
												set={setMessage}
												placeholder="Describe these changes"
											/>
										</Show>
										<div class="projects__git-actions">
											<button
												type="button"
												class="projects__button"
												disabled={busy()}
												onClick={() => void refresh()}
											>
												Refresh
											</button>
											<button
												type="button"
												class="projects__button projects__button--primary"
												disabled={
													busy() ||
													(linked().local.length === 0 &&
														linked().incoming.length === 0)
												}
												onClick={() =>
													act(
														{
															type: "git:sync",
															draft: draft(),
															message: message(),
														},
														result => summary(result, "Synced")
													)
												}
											>
												{busy() ? "Syncing…" : "Sync"}
											</button>
										</div>
									</Show>
									<Show when={props.isMain}>
										<OpenBranch
											branches={branches()}
											busy={busy()}
											list={async () => {
												const answer = await call<{branches: string[]}>({
													type: "git:branches",
												})
												setBranches(answer?.branches ?? [])
											}}
											open={async branch => {
												setBusy(true)
												const answer = await call({
													type: "git:open-branch",
													branch,
												})
												setBusy(false)
												if (answer) dialog.close()
											}}
										/>
									</Show>
								</section>
							)}
						</Show>
					</>
				)}
			</Show>

			<Show
				when={!editingToken() || (props.isMain && status()?.kind === "linked")}
			>
				<footer class="projects__git-footer">
					<Show when={!editingToken()}>
						<button
							type="button"
							class="projects__git-link"
							onClick={() => setEditingToken(true)}
						>
							Change GitHub token
						</button>
					</Show>
					<Show when={props.isMain && status()?.kind === "linked"}>
						<button
							type="button"
							class="projects__git-link projects__git-link--danger"
							onClick={async () => {
								if (
									!window.confirm(
										"Disconnect this workspace from git? Its files stay as they are."
									)
								)
									return
								await call({type: "git:disconnect"})
								setDone(undefined)
								await refresh()
							}}
						>
							Disconnect
						</button>
					</Show>
				</footer>
			</Show>
		</dialog>
	)
}

function Connect(props: {
	busy: boolean
	connect(owner: string, repo: string, branch: string): void
}) {
	const [repo, setRepo] = createSignal("")
	const [branch, setBranch] = createSignal("main")
	const parts = () =>
		repo()
			.trim()
			.replace(/^https:\/\/github\.com\//, "")
			.replace(/\.git$/, "")
			.split("/")
	const valid = () => parts().length === 2 && parts().every(Boolean)
	return (
		<form
			class="projects__git-section"
			onSubmit={event => {
				event.preventDefault()
				if (valid())
					props.connect(parts()[0], parts()[1], branch().trim() || "main")
			}}
		>
			<p>
				Connect main to a branch of a GitHub repository. Files only on the
				branch are copied in; then this workspace's files are committed to it,
				replacing the branch's versions where both have one.
			</p>
			<label class="projects__git-field">
				<span>Repository</span>
				<input
					value={repo()}
					onInput={event => setRepo(event.currentTarget.value)}
					placeholder="owner/name"
				/>
			</label>
			<label class="projects__git-field">
				<span>Branch</span>
				<input
					value={branch()}
					onInput={event => setBranch(event.currentTarget.value)}
				/>
			</label>
			<div class="projects__git-actions">
				<button
					type="submit"
					class="projects__button projects__button--primary"
					disabled={props.busy || !valid()}
				>
					{props.busy ? "Connecting…" : "Connect"}
				</button>
			</div>
		</form>
	)
}

function OpenBranch(props: {
	branches: string[] | undefined
	busy: boolean
	list(): void
	open(branch: string): void
}) {
	return (
		<div class="projects__git-branches">
			<Show
				when={props.branches}
				fallback={
					<button
						type="button"
						class="projects__git-link"
						onClick={() => props.list()}
					>
						Open a branch from git as a draft…
					</button>
				}
			>
				{branches => (
					<>
						<h3>Branches without a draft</h3>
						<Show
							when={branches().length > 0}
							fallback={<p class="projects__git-hint">None.</p>}
						>
							<ul>
								<For each={branches()}>
									{branch => (
										<li>
											<code>{branch}</code>
											<button
												type="button"
												class="projects__button"
												disabled={props.busy}
												onClick={() => props.open(branch)}
											>
												Open as draft
											</button>
										</li>
									)}
								</For>
							</ul>
						</Show>
					</>
				)}
			</Show>
		</div>
	)
}

function Changes(props: {
	title: string
	empty: string
	items: string[]
}): JSX.Element {
	return (
		<div class="projects__git-changes">
			<h3>{props.title}</h3>
			<Show
				when={props.items.length > 0}
				fallback={<p class="projects__git-hint">{props.empty}</p>}
			>
				<ul>
					<For each={props.items.slice(0, 50)}>{item => <li>{item}</li>}</For>
					<Show when={props.items.length > 50}>
						<li class="projects__git-hint">
							and {props.items.length - 50} more
						</li>
					</Show>
				</ul>
			</Show>
		</div>
	)
}

function MessageField(props: {
	value: string
	set(value: string): void
	placeholder: string
}) {
	return (
		<label class="projects__git-field">
			<span>Commit message</span>
			<textarea
				rows={2}
				value={props.value}
				placeholder={props.placeholder}
				onInput={event => props.set(event.currentTarget.value)}
			/>
		</label>
	)
}

function summary(result: SyncResult, verb: string): string {
	const parts = [verb]
	if (result.imported.length)
		parts.push(
			`${result.imported.length} ${files(result.imported.length)} from git`
		)
	if (result.exported.length)
		parts.push(
			`${result.exported.length} ${files(result.exported.length)} to git`
		)
	if (result.merged.length)
		parts.push(
			`${result.merged.length} merged ${result.merged.length === 1 ? "draft" : "drafts"}`
		)
	return `${parts.join(" · ")}. Now at ${result.sha.slice(0, 7)}.`
}

function files(n: number) {
	return n === 1 ? "file" : "files"
}

function firstLine(message: string) {
	return message.split("\n")[0]
}

function ago(at: number): string {
	const minutes = Math.round((Date.now() - at) / 60000)
	if (minutes < 1) return "just now"
	if (minutes < 60) return `${minutes} min ago`
	const hours = Math.round(minutes / 60)
	if (hours < 24) return `${hours} h ago`
	return new Date(at).toLocaleDateString()
}

function readToken(): string | null {
	try {
		return localStorage.getItem(TOKEN_KEY)
	} catch {
		return null
	}
}

function writeToken(token: string) {
	try {
		if (token) localStorage.setItem(TOKEN_KEY, token)
		else localStorage.removeItem(TOKEN_KEY)
	} catch {
		// storage blocked: the token can't be kept
	}
}
