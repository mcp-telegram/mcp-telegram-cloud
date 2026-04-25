## What

<!-- One or two sentences: what does this PR change? -->

## Why

<!-- The motivation. What problem does it solve? Link to an issue if there is one. -->

## How

<!-- Optional: notable implementation choices, tradeoffs, anything a reviewer should know. -->

## Checklist

- [ ] `pnpm lint:fix` clean
- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` succeeds
- [ ] Touched user-facing strings or env vars → `README.md` and `.env.example` updated
- [ ] Touched `stacks/*.yml` → operational impact described above
- [ ] No secrets, tokens, or session strings in the diff
- [ ] Scope appropriate for `mcp-telegram-cloud` (not an upstream `mcp-telegram` change)
