## What

<!-- One or two sentences: what does this PR change? -->

## Why

<!-- The motivation. What problem does it solve? Link to an issue if there is one. -->

## How

<!-- Optional: notable implementation choices, tradeoffs, anything a reviewer should know. -->

## Checklist

- [ ] `bun run lint`, `bun run typecheck` and `bun run test` pass
- [ ] Touched `web/` or `app/` → their lint, typecheck and test scripts pass
- [ ] Touched user-facing strings or env vars → `README.md` and `.env.example` updated
- [ ] Touched `Dockerfile` or `docker-compose.example.yml` → operational impact described above
- [ ] No secrets, tokens, or session strings in the diff
- [ ] Scope appropriate for `mcp-telegram-cloud` (not an upstream `mcp-telegram` change)
