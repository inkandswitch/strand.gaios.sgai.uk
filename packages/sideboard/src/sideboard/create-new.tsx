import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type ChangeFn,
  type Repo,
} from "@automerge/automerge-repo/slim";
import {
  type DatatypeDescription,
  type Plugin,
  createDocOfDatatype2,
  getRegistry,
  isLoadablePlugin,
  isLoadedPlugin,
} from "@inkandswitch/patchwork-plugins";
import { lazy } from "solid-js";
import type { DocLink, FolderDoc } from "@inkandswitch/patchwork-filesystem";
import { docLinkFromUrl } from "./lib/doc-link.ts";
import { childLocation } from "./lib/location.ts";
import type { OpenDocumentEventDetail } from "@inkandswitch/patchwork-elements";
import type { Anchor } from "./popmenu.tsx";

export async function createNew(
  repo: Repo,
  datatype: Plugin<DatatypeDescription>
): Promise<DocLink> {
  // registry.load returns a new loaded plugin rather than mutating the one
  // we were handed, so use what it gives back.
  if (isLoadablePlugin(datatype)) {
    const registry = getRegistry("patchwork:datatype");
    datatype = (await registry.load(datatype.id)) ?? datatype;
  }
  if (!isLoadedPlugin(datatype)) {
    throw new Error("plugin not loaded after loading");
  }

  const docHandle = await createDocOfDatatype2(datatype, repo);
  const doc = docHandle.doc();
  const name = datatype.module.getTitle(doc);

  return {
    name,
    type: datatype.id,
    url: docHandle.url,
  };
}

const CreateNewMenu = lazy(() =>
  import("./create-new-menu.tsx").then((m) => ({ default: m.CreateNewMenu }))
);

/** Fetch the menu ahead of the first right-click, so that click isn't dead. */
export function preloadCreateNew() {
  void CreateNewMenu.preload();
}

export interface CreateNewProps {
  repo: Repo;
  changeFolder(fn: ChangeFn<FolderDoc>): void;
  open(detail: OpenDocumentEventDetail): void;
  /** Where the folder sits: new documents open by location under it. */
  location: string;
  /** where the menu was asked for: the pointer, for a right-click */
  at: Anchor;
  onClose(): void;
}

/**
 * The menu for a new document in a folder: a filter that also takes an
 * automerge url to add, and the datatypes. Picking one adds it to the end of
 * the folder and opens it.
 */
export default function CreateNew(props: CreateNewProps) {
  async function selectDatatype(datatype: Plugin<DatatypeDescription>) {
    const freshy = await createNew(props.repo, datatype);
    const url = addToFolder(freshy);
    props.open({ url });
    props.onClose();
  }

  async function handleUrlSubmit(url: string) {
    const trimmed = url.trim();
    if (!isValidAutomergeUrl(trimmed)) return;
    const docLink = await docLinkFromUrl(props.repo, trimmed as AutomergeUrl);
    const location = addToFolder(docLink);
    props.open({ url: location });
    props.onClose();
  }

  // Push `link` onto the folder and say where it landed. The location is worked
  // out against the folder as it is after the push, name clashes and all.
  function addToFolder(link: DocLink) {
    let siblings: DocLink[] = [];
    props.changeFolder((doc) => {
      doc.docs.push(link);
      siblings = doc.docs.map((entry) => ({ ...entry }));
    });
    return childLocation(props.location, link, siblings);
  }

  return (
    <CreateNewMenu
      anchor={props.at}
      onClose={props.onClose}
      onPickDatatype={selectDatatype}
      onSubmitUrl={handleUrlSubmit}
    />
  );
}
