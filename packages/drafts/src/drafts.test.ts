import { beforeAll, describe, expect, it } from "vitest";
import {
  Repo,
  initSubduction,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo";
import { getRegistry } from "@inkandswitch/patchwork-plugins";

import {
  deleteDraft,
  forkDraft,
  mergeIntoParent,
  renameDraft,
} from "./draft-actions.js";
import { DraftRepo } from "./draft-repo.js";
import type { DraftDoc, DraftList, HasDrafts } from "./draft-types.js";
import { draftEntries } from "./picker/picker.js";
import { treeLines } from "./picker/tree-lines.js";

type Note = { "@patchwork": { type: "note" }; text: string };
type Folder = HasDrafts & {
  docs: { url: AutomergeUrl; type: string; name: string }[];
};

beforeAll(() => {
  initSubduction();
  getRegistry("patchwork:children").register(
    {
      type: "patchwork:children",
      id: "test-folder-children",
      name: "Folder children",
      datatypes: ["folder"],
      load: async () => (doc: Folder) =>
        doc.docs.map(({ url, type }) => ({ url, type })),
    } as never,
    "test"
  );
});

function project() {
  const repo = new Repo();
  const note = repo.create<Note>({
    "@patchwork": { type: "note" },
    text: "main",
  });
  const folder: Folder = {
    "@patchwork": { type: "folder" },
    docs: [{ url: note.url, type: "note", name: "Note" }],
  };
  const root = repo.create<HasDrafts>(folder);
  return { repo, note, root };
}

async function checkOut(
  repo: Repo,
  root: DocHandle<HasDrafts>,
  draft: AutomergeUrl
) {
  const draftRepo = new DraftRepo(repo);
  draftRepo.setRoot(root.url);
  draftRepo.checkout({ draft: await repo.find<DraftDoc>(draft), at: null });
  return draftRepo;
}

describe("drafts of a project", () => {
  it("keeps a draft's edits off main until it's merged", async () => {
    const { repo, note, root } = project();
    const draft = await forkDraft(repo, root, null);
    const draftRepo = await checkOut(repo, root, draft);

    const onDraft = await draftRepo.find<Note>(note.url);
    onDraft.change((d) => {
      d.text = "draft";
    });

    expect(onDraft.url).toBe(note.url);
    expect(onDraft.doc().text).toBe("draft");
    expect(note.doc().text).toBe("main");
    expect((await repo.find<DraftDoc>(draft)).doc().clones[note.url].cloneUrl)
      .toBeDefined();

    expect(await mergeIntoParent(repo, draft)).toBeNull();
    expect(note.doc().text).toBe("draft");
    expect((await repo.find<DraftDoc>(draft)).doc().mergedAt).toBeDefined();
  });

  it("forks drafts of drafts, and merges one into the draft it came from", async () => {
    const { repo, note, root } = project();
    const parent = await forkDraft(repo, root, null);
    const parentRepo = await checkOut(repo, root, parent);
    (await parentRepo.find<Note>(note.url)).change((d) => {
      d.text = "parent";
    });

    const child = await forkDraft(repo, root, parent);
    const childDoc = (await repo.find<DraftDoc>(child)).doc();
    expect(childDoc.parent).toBe(parent);
    expect(childDoc.name).toBe("Draft 2");
    expect((await repo.find<DraftDoc>(parent)).doc().drafts).toEqual([child]);

    const childRepo = await checkOut(repo, root, child);
    const onChild = await childRepo.find<Note>(note.url);
    expect(onChild.doc().text).toBe("parent");
    onChild.change((d) => {
      d.text = "child";
    });

    expect(await mergeIntoParent(repo, child)).toBe(parent);
    const onParent = await parentRepo.find<Note>(note.url);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onParent.doc().text).toBe("child");
    expect(note.doc().text).toBe("main");
  });

  it("deletes a draft by unlinking it from its parent", async () => {
    const { repo, root } = project();
    const draft = await forkDraft(repo, root, null);
    const mainDraftUrl = root.doc()["@patchwork"]!.mainDraftUrl!;

    expect(await deleteDraft(repo, draft)).toBeNull();
    expect((await repo.find<DraftDoc>(mainDraftUrl)).doc().drafts).toEqual([]);
  });

  it("names main, which makes its main draft", async () => {
    const { repo, root } = project();
    await renameDraft(repo, root, null, "  Published  ");
    const mainDraftUrl = root.doc()["@patchwork"]!.mainDraftUrl!;
    expect((await repo.find<DraftDoc>(mainDraftUrl)).doc().name).toBe(
      "Published"
    );
  });
});

describe("draftEntries", () => {
  const url = (id: string) => `automerge:${id}` as AutomergeUrl;

  it("lists main, then each draft beneath the one it was forked off", () => {
    const list: DraftList = {
      main: { url: url("main"), parent: null, childCount: 1, name: null },
      drafts: [
        { url: url("a"), parent: url("main"), childCount: 1, name: "A" },
        { url: url("b"), parent: url("a"), childCount: 0, name: null },
      ],
    };
    expect(draftEntries(list)).toEqual([
      { url: null, name: "Main", depth: 0, parent: null, parentName: null, childCount: 1 },
      { url: url("a"), name: "A", depth: 1, parent: null, parentName: "Main", childCount: 1 },
      { url: url("b"), name: "Draft", depth: 2, parent: url("a"), parentName: "A", childCount: 0 },
    ]);
  });

  it("is just main before the list arrives", () => {
    expect(draftEntries(undefined).map((entry) => entry.name)).toEqual(["Main"]);
  });
});

describe("treeLines", () => {
  const url = (id: string) => `automerge:${id}` as AutomergeUrl;
  // main
  // ├ tune-lr
  // │ ├ warmup      (checked out)
  // │ └ lr-sched
  // │   └ lr-cosine
  // └ docs-pass
  const list: DraftList = {
    main: { url: url("main"), parent: null, childCount: 2, name: "main" },
    drafts: [
      { url: url("tune"), parent: url("main"), childCount: 2, name: "tune-lr" },
      { url: url("warm"), parent: url("tune"), childCount: 0, name: "warmup" },
      { url: url("sched"), parent: url("tune"), childCount: 1, name: "lr-sched" },
      { url: url("cos"), parent: url("sched"), childCount: 0, name: "lr-cosine" },
      { url: url("docs"), parent: url("main"), childCount: 0, name: "docs-pass" },
    ],
  };
  // Each cell as up, down and tick: "-" none, "|" plain, "#" path.
  const draw = (checkedOut: AutomergeUrl | null) =>
    treeLines(draftEntries(list), checkedOut).map((cells) =>
      cells
        .map(({ up, down, tick }) =>
          [up, down, tick].map((line) => ({ none: "-", plain: "|", path: "#" })[line]).join("")
        )
        .join(" ")
    );

  it("joins each draft to its parent's line, colouring the way to the checked-out one", () => {
    expect(draw(url("warm"))).toEqual([
      "",
      "#|#", // tune-lr: on the way, and main's line runs on past it
      "||- #|#", // warmup: reached from tune-lr
      "||- |-|", // lr-sched: after warmup, so plain
      "||- --- |-|",
      "|-|", // docs-pass: the last of main's
    ]);
  });

  it("colours the line past earlier drafts on the way to a later one", () => {
    expect(draw(url("docs"))).toEqual([
      "",
      "##|",
      "##- |||",
      "##- |-|",
      "##- --- |-|",
      "#-#",
    ]);
  });

  it("is plain everywhere on main", () => {
    expect(draw(null).join(" ")).not.toContain("#");
  });
});
