# Contributing to MCP Telegram Cloud

Thanks for your interest in improving this project. This document covers what
you need to know before opening an issue or pull request.

## Project scope

`mcp-telegram-cloud` is the **hosted, multi-user** flavour of the
[`@overpod/mcp-telegram`](https://github.com/mcp-telegram/mcp-telegram) MCP
server. It is intended to run as a service that multiple Telegram users
connect to via OAuth + QR login.

Issues and pull requests are welcome in any language. We answer in English,
and in Russian if you wrote in Russian. Priorities and planned work are on the
public [roadmap board](https://github.com/orgs/mcp-telegram/projects/1).

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

Requirements: [Bun](https://bun.sh) 1.4.

```bash
bun install
cp .env.example .env   # fill in TELEGRAM_API_ID / TELEGRAM_API_HASH / ADMIN_TOKEN
bun run dev            # bun --hot src/server.tsx
```

You can run against a live Telegram account, but **use a throwaway test
account** for development. The session DB stores plaintext MTProto sessions.

## Code style and conventions

- **Linter / formatter**: [Biome](https://biomejs.dev). Run `bun run lint:fix`
  before committing. The pre-commit hook (`husky` + `biome check --staged`)
  will format staged files automatically.
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
  `bun run test` (`bun test`). Add tests for new behaviour where it's reasonable —
  pure functions, parsers, validation, security guards. PRs that
  expand coverage (especially around OAuth and rate-limiting paths)
  are very welcome.

## Pull request workflow

1. Fork and create a branch off `main`.
2. Make your change. Keep PRs focused — one logical change per PR.
3. Run locally:
   ```bash
   bun run lint
   bun run typecheck
   bun run test
   ```
   If you touched `web/` or `app/`, also run their `web:*` / `app:*` lint,
   typecheck and test scripts.
4. Open the PR using the template. Fill in **what** and **why** — reviewers
   should not have to guess your motivation.
5. CI runs gitleaks + TruffleHog on every PR
   (`.github/workflows/security-scan.yml`) and the `check` job
   (lint, typecheck, tests, parity and translation checks for the server,
   `web/` and `app/`) on every PR that touches code
   (`.github/workflows/build.yml`). Deploy is in a separate private repo.
6. Maintainer review: usually within a few days. We may request changes
   focused on scope, security, or operational impact.

## What we will likely **not** merge

- Tools that bypass the per-user safety switches. Destructive tools are
  opt-in per user (off by default) and write tools show the outgoing
  content for confirmation; new write-capable tools must fit that model.
- Changes that add new ENV variables without documenting them in
  `.env.example` and `README.md`.
- Operational/infra changes — Docker Swarm stacks, deploy workflows, and
  Traefik config live in a separate private repo (`mcp-telegram-infra`).
  PRs against this repo should stay focused on application code, build,
  docs, and the public `docker-compose.example.yml`.
- Refactors without a concrete bug or perf rationale. We try to keep the
  surface small.

## Releasing (maintainers only)

Tagged release process: bump `package.json` version, push a `vX.Y.Z` git
tag, and `.github/workflows/build.yml` builds the Docker images, pushes
them to GHCR, and creates the GitHub Release with an auto-generated
changelog. Production deploy is a manual trigger in the private
`mcp-telegram-infra` repo.

## License

By contributing, you agree that your contributions will be licensed under
the MIT License (see [`LICENSE`](./LICENSE)).
