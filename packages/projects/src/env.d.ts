import "@inkandswitch/patchwork-elements/solid"

declare module "solid-js" {
	namespace JSX {
		interface ExplicitAttributes {
			/** the overlay provider's starting overlay */
			overlay: string | undefined
			/** the overlay provider's starting point in that overlay's history */
			at: string | undefined
			/** what the compare provider starts out comparing with: an overlay, or "main" */
			against: string | undefined
			/** the point in its history the compare provider starts out comparing with */
			"against-at": string | undefined
		}
	}
}
