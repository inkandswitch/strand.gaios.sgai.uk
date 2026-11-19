import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHubRemote } from "./remote.js";

describe("GitHubRemote", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never reads a branch from the browser's cache", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(JSON.stringify({ object: { sha: "abc", type: "commit" } }), {
        status: 200,
      });
    });
    const remote = new GitHubRemote("o", "r", "token");
    expect(await remote.tip("main")).toBe("abc");
    expect(calls[0].cache).toBe("no-store");
  });
});
