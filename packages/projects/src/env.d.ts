import "@inkandswitch/patchwork-elements/solid"

declare module "solid-js" {
	namespace JSX {
		interface ExplicitAttributes {
			/** the overlay provider's starting overlay */
			overlay: string | undefined
			/** what the compare provider starts out comparing with: an overlay, or "main" */
			against: string | undefined
		}
	}
}
