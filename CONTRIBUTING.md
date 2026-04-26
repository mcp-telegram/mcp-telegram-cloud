# Contributing to MCP Telegram Cloud

Thanks for your interest in improving this project. This document covers what
you need to know before opening an issue or pull request.

## Project scope

`mcp-telegram-cloud` is the **hosted, multi-user, read-only** flavour of the
[`@overpod/mcp-telegram`](https://github.com/mcp-telegram/mcp-telegram) MCP
server. It is intended to run as a service that multiple Telegram users
connect to via OAuth + QR login.

Two repos, two scopes:

| Repo | Scope | Where to send PRs |
|------|-------|-------------------|
| [`mcp-telegram`](https://github.com/mcp-telegram/mcp-telegram) | Telegram tooling, MTProto integration, new MCP tools | All tool/protocol-level changes |
| `mcp-telegram-cloud` (this repo) | Hosting, OAuth, multi-user session storage, rate limiting, landing page, ops | Hosting/deployment changes |

Tool-level features (new `telegram-*` tools, new MTProto coverage) belong in
the upstream repo. Cloud only **whitelists** which upstream tools are exposed.

## Before opening an issue

1. Check open and closed issues — your problem may already be tracked.
2. For security issues, **do not open a public issue**. See
   [`SECURITY.md`](./SECURITY.md).
3. Include reproduction steps, the version (commit SHA or Docker tag), and
   logs when relevant.

## Development setup

```bash
pnpm install
cp .env.example .env   # fill in TELEGRAM_API_ID / TELEGRAM_API_HASH / ADMIN_TOKEN
pnpm dev               # tsx watch on src/server.tsx
```

You can run against a live Telegram account, but **use a throwaway test
account** for development. The session DB stores plaintext MTProto sessions.

## Code style and conventions

- **Linter / formatter**: [Biome](https://biomejs.dev). Run `pnpm lint:fix`
  before committing. The pre-commit hook (`husky` + `lint-staged`) will format
  staged files automatically.
- **Pre-commit secrets scan**: if [`gitleaks`](https://github.com/gitleaks/gitleaks)
  is installed locally (`brew install gitleaks`), the pre-commit hook blocks
  any commit that contains a token, API hash, or session string. The same
  scan plus TruffleHog runs in CI on every PR (see
  `.github/workflows/security-scan.yml`), so missing it locally is not a
  bypass — please install it anyway. Do not use `--no-verify`.
- **Types**: TypeScript strict mode. No `any` without a comment explaining
  why.
- **Comments**: only when the *why* is non-obvious. Don't restate the code.
- **Tests**: unit tests live in `src/__tests__/*.test.ts` and run via
  `pnpm test` (powered by `tsx --test`, which uses Node's built-in
  `node:test`). Add tests for new behaviour where it's reasonable —
  pure functions, parsers, validation, security guards. PRs that
  expand coverage (especially around OAuth and rate-limiting paths)
  are very welcome.

## Pull request workflow

1. Fork and create a branch off `main`.
2. Make your change. Keep PRs focused — one logical change per PR.
3. Run locally:
   ```bash
   pnpm lint:fix
   pnpm typecheck
   pnpm build
   ```
4. Open the PR using the template. Fill in **what** and **why** — reviewers
   should not have to guess your motivation.
5. CI will run gitleaks + TruffleHog on every PR
   (`.github/workflows/security-scan.yml`). Build and deploy run on push to
   `main` and tagged releases (`.github/workflows/deploy.yml`) — there is
   no separate lint/typecheck PR job today, so please run them locally.
6. Maintainer review: usually within a few days. We may request changes
   focused on scope, security, or operational impact.

## What we will likely **not** merge

- New write-capable tools on the cloud side. Cloud is read-only by design;
  if you need write tools, self-host the upstream `mcp-telegram` package.
- Changes that add new ENV variables without documenting them in
  `.env.example` and `README.md`.
- Changes that touch `stacks/*.yml` without explaining the operational
  impact (this is live production config).
- Refactors without a concrete bug or perf rationale. We try to keep the
  surface small.

## Releasing (maintainers only)

Tagged release process: bump `package.json` version, push a `vX.Y.Z` git
tag, GitHub Actions builds the Docker image and runs
`.github/workflows/deploy.yml`. The OSS preparation roadmap and split
plan live in
[`claudedocs/workflow_cloud_open_source.md`](./claudedocs/workflow_cloud_open_source.md).

## License

By contributing, you agree that your contributions will be licensed under
the MIT License (see [`LICENSE`](./LICENSE)).
