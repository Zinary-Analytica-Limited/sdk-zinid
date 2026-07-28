# zinid-sdk

Vendor-facing JavaScript SDK for [ZinID](https://zinid.com) hosted verification flows.

- `packages/sdk-web` — `@zinid/sdk-web`, the browser SDK (embed / modal / redirect modes),
  distributed via npm and CDN.

## Development

```sh
pnpm install
pnpm build      # tsup — ESM, CJS, minified IIFE, .d.ts
pnpm lint       # eslint + prettier check
pnpm typecheck  # tsc --noEmit
pnpm test       # vitest + 8KB size budget
```

See [CLAUDE.md](CLAUDE.md) for architecture and workflow rules, and [PROGRESS.md](PROGRESS.md)
for project status.
