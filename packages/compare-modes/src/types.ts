import type { PluginDescription } from "@inkandswitch/patchwork-plugins";

/**
 * A way to show two versions of a document, A and B. A mode with `compose`
 * lays out two views, one of each version, and works for any view that
 * supports it; one without is drawn by a view that says it can.
 */
export type CompareModeDescription = PluginDescription & {
  type: "patchwork:compare-mode";
  id: string;
  name: string;
  /** an SVG file, as a URL */
  icon: string;
  /** offered to every view unless it opts out */
  default?: boolean;
};

export type CompareModeImplementation<O = unknown> = {
  /** what the options start as */
  options?: O;
  /** lays out the two versions; absent means the view draws the mode */
  compose?(slots: Slots, options: Options<O>): () => void;
  /** renders the mode's controls */
  controls?(element: HTMLElement, options: Options<O>): () => void;
};

/** The two views, side by side in a grid that is their parent. */
export type Slots = { a: HTMLElement; b: HTMLElement };

export type Options<O> = {
  current(): O;
  set(next: O): void;
  /** called on every change; returns an unsubscribe */
  subscribe(listener: (options: O) => void): () => void;
};
