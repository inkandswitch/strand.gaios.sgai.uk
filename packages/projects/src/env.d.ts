import "@inkandswitch/patchwork-elements/solid"

declare module "solid-js" {
	namespace JSX {
		interface ExplicitAttributes {
			/** the draft provider's starting draft */
			draft: string | undefined
			/** the draft the compare provider starts out comparing with */
			against: string | undefined
		}
	}
}
