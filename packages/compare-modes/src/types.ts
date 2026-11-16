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
  /** shows just this version: a host that knows its name calls it "<name> only" */
  only?: "a" | "b";
};

export type CompareModeImplementation<O = unknown> = {
  /** what the options start as */
  options?: O;
  /**
   * Where its controls show and how far its options reach: one set for the
   * whole workspace, its controls with the workspace's, or one per panel,
   * its controls with the panel's (the default).
   */
  scope?: "workspace" | "panel";
  /** lays out the two versions; absent means the view draws the mode */
  compose?(slots: Slots, options: Options<O>, versions?: Versions): () => void;
  /** renders the mode's controls */
  controls?(element: HTMLElement, options: Options<O>, versions?: Versions): () => void;
};

/**
 * What the host calls the two versions, and the colour it marks each with
 * (any CSS colour). Without it they're just A and B.
 */
export type Versions = { a: Version; b: Version };
export type Version = { name: string; color?: string };

/**
 * The two views, side by side in a grid that is their parent: A the version
 * being worked on, B the one it's compared with.
 */
export type Slots = { a: HTMLElement; b: HTMLElement };

export type Options<O> = {
  current(): O;
  set(next: O): void;
  /** called on every change; returns an unsubscribe */
  subscribe(listener: (options: O) => void): () => void;
};
