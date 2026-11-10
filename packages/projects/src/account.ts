import type {DatatypeImplementation} from "@inkandswitch/patchwork-plugins"
import type {AccountDoc} from "./types.ts"

export const AccountDatatype: DatatypeImplementation<AccountDoc> = {
	init(doc) {
		doc.frameToolId = "gaios-projects"
	},
	getTitle: () => "GAIOS Account",
}
