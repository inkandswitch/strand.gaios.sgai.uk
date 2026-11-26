import {Show, Match, Switch} from "solid-js"
import {
	useDocHandle,
	createDocumentProjection,
} from "solid-automerge"
import type {FileDoc} from "../types"
import {isTextBytesFileDoc} from "../datatype"
import {isImageFile} from "../utils"
import {HTMLFileViewer, isHTMLFile} from "./HTMLFileViewer"
import {ImageFileViewer} from "./ImageFileViewer"
import {PDFFileViewer, isPDFFile} from "./PDFFileViewer"
import {AudioFileViewer, isAudioFile} from "./AudioFileViewer"
import {VideoFileViewer, isVideoFile} from "./VideoFileViewer"
import {TextFileEditor, isTextFile} from "./TextFileEditor"
import {DocHandle} from "@automerge/automerge-repo/slim"
import {UnixFileEntry} from "@inkandswitch/patchwork-filesystem"
import {PatchworkViewElement} from "@inkandswitch/patchwork-elements"

export function FileEditor(props: {
	handle: DocHandle<UnixFileEntry>
	element: PatchworkViewElement
}) {
	const handle = useDocHandle<FileDoc>(props.handle.url, props.element)
	const doc = createDocumentProjection<FileDoc>(() => handle.latest)

	return (
		<Show when={doc()} fallback={"Loading..."}>
			<Switch
				fallback={
					<div>
						No preview available for this file type
						<table>
							<tbody>
								<tr>
									<td>mimeType</td>
									<td>{doc()?.mimeType}</td>
								</tr>
							</tbody>
						</table>
					</div>
				}>
				<Match when={isHTMLFile(doc()!)}>
					<HTMLFileViewer doc={doc()!} />
				</Match>
				{/* Media viewers are matched before text so a string-backed asset
				    (e.g. an SVG) still renders as media rather than its markup. */}
				<Match when={isImageFile(doc()!)}>
					<ImageFileViewer
						doc={doc()!}
						element={props.element}
						handle={props.handle}
					/>
				</Match>
				<Match when={isPDFFile(doc()!)}>
					<PDFFileViewer doc={doc()!} />
				</Match>
				<Match when={isAudioFile(doc()!)}>
					<AudioFileViewer doc={doc()!} />
				</Match>
				<Match when={isVideoFile(doc()!)}>
					<VideoFileViewer doc={doc()!} />
				</Match>
				{/* Text, editable or not: the editor tells from the handle and the
				    content (see TextFileEditor). */}
				<Match when={isTextFile(doc()!) || isTextBytesFileDoc(doc()!)}>
					<TextFileEditor
						doc={doc()!}
						handle={props.handle}
						element={props.element}
					/>
				</Match>
			</Switch>
		</Show>
	)
}
