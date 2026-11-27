import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import { createEffect, createSignal, For, Show } from "solid-js";
import { Chevron } from "../icons.tsx";
import type { ChangeMarks, Ghost } from "./changes.ts";
import { ChangeMark } from "./item.tsx";

/**
 * What the other version has in a folder and the checked-out one doesn't, after
 * the folder's own rows. Ghosts can't be opened: a ghost folder only expands.
 */
export function GhostRows(props: {
  parent: AutomergeUrl;
  depth: number;
  changes: ChangeMarks;
}) {
  return (
    <For each={props.changes.ghostsIn(props.parent)}>
      {(ghost) => (
        <div class="document-list__item">
          <Show
            when={ghost.folder}
            fallback={<GhostRow ghost={ghost} changes={props.changes} />}
          >
            <GhostFolder ghost={ghost} depth={props.depth} changes={props.changes} />
          </Show>
        </div>
      )}
    </For>
  );
}

function GhostFolder(props: { ghost: Ghost; depth: number; changes: ChangeMarks }) {
  const [expanded, setExpanded] = createSignal(false);
  createEffect(() => {
    if (props.changes.collapsed()) setExpanded(true);
  });
  return (
    <div class="document-list-folder" role="none" style={{ "--depth": props.depth }}>
      <GhostRow
        ghost={props.ghost}
        changes={props.changes}
        expanded={expanded()}
        toggle={() => setExpanded((yn) => !yn)}
      />
      <div
        role="group"
        class="document-list-folder__contents"
        style={{ "--depth": props.depth + 1 }}
      >
        <Show when={expanded()}>
          <GhostRows parent={props.ghost.url} depth={props.depth + 1} changes={props.changes} />
        </Show>
      </div>
    </div>
  );
}

function GhostRow(props: {
  ghost: Ghost;
  changes: ChangeMarks;
  expanded?: boolean;
  toggle?: () => void;
}) {
  const mark = () => props.changes.mark(props.ghost.url);
  return (
    <div
      role="treeitem"
      tabindex="-1"
      aria-label={props.ghost.name}
      aria-disabled="true"
      aria-expanded={props.toggle ? !!props.expanded : undefined}
      class="document-list-item document-list-item--ghost"
      data-doc-url={props.ghost.url}
      on:click={() => props.toggle?.()}
      onkeydown={(event: KeyboardEvent) => {
        if (event.target !== event.currentTarget || !props.toggle) return;
        const open = event.key === "ArrowRight" && !props.expanded;
        const close = event.key === "ArrowLeft" && props.expanded;
        if (event.key === "Enter" || event.key === " " || open || close) {
          event.preventDefault();
          props.toggle();
        }
      }}
    >
      <Show when={props.toggle}>
        <span aria-hidden="true" class="document-list-folder__toggle">
          <Show when={props.expanded} fallback={<Chevron />}>
            <Chevron style={{ rotate: "90deg" }} />
          </Show>
        </span>
      </Show>
      <span class="document-list-item__name">{props.ghost.name}</span>
      <Show when={mark()}>{(mark) => <ChangeMark mark={mark()} />}</Show>
    </div>
  );
}
