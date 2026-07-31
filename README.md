# zinid-sdk

Vendor-facing JavaScript SDK for [ZinID](https://zinid.africa) hosted verification flows.

- `packages/sdk-web` — `@zinid/sdk-web`, the browser SDK (embed / modal / redirect modes),
  distributed via npm and CDN.

## Development

```sh
pnpm install
pnpm build      # tsup — ESM, CJS, minified IIFE, .d.ts
pnpm lint       # eslint + prettier check
pnpm typecheck  # tsc --noEmit
pnpm test       # vitest + 8KB size budget

pnpm --filter @zinid/sdk-web dev       # tsup --watch, for local linking
pnpm --filter @zinid/sdk-web test:e2e  # Playwright, Chromium
```

## Using the SDK from another repo

See **[docs/INTEGRATION.md](docs/INTEGRATION.md)** for local linking (tarball, `pnpm link`, or a
`file:` path), a copy-paste React component and hook, and the failure modes worth knowing about.

See [CLAUDE.md](CLAUDE.md) for architecture and workflow rules, and [PROGRESS.md](PROGRESS.md)
for project status.
