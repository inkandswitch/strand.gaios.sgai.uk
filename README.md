# strand

gaios, with its packages in the same repo. it's at
[strand.gaios.sgai.uk](https://strand.gaios.sgai.uk).

## what's here

- [`packages`](packages): gaios's own patchwork packages: the projects frame,
  drafts, compare and review, the sideboard, and the tools gaios loads. it
  started as [gaios-pkg-base](https://github.com/inkandswitch/gaios-pkg-base),
  brought in with its history, and lives here now.
- `src/main.ts`, `vite/`, `scripts/`: the site, and running it.

every package installs and builds on its own (`packages/` isn't a
workspace), then they're bundled into `packages/static-dist`, which the site
serves as its `/modules.json` and `/packages/*`.

```
pnpm install
pnpm dev        # installs and builds the packages the first time, then watches them
pnpm packages   # install, build and bundle every package
pnpm build      # the packages, then the site
pnpm test       # every package's tests
```

`PATCHWORK_SYSTEM_DIRECTORY=../system pnpm dev` runs against a patchwork
checkout instead of the installed `@inkandswitch/patchwork`.
