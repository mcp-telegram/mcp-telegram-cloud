# OSS Split Inventory

**Phase:** 1.3 (Open Source Readiness Audit)
**Date:** 2026-04-25
**Goal:** разделить текущий приватный `mcp-telegram-cloud` на два репо — публичный (MIT) и приватный (`mcp-telegram-infra`) — без утечки секретов и инфраструктурных деталей.

## TL;DR

После Phase 0.5 ENV-волны (commit `bebf787`) **в tracked-файлах не осталось CRITICAL утечек**:
- ✅ Прод-IP (149.154.184.31, 193.169.52.83) — только в локальном `.env` и GitHub Secrets
- ✅ Личные контакты (`overpod@yandex.ru`, `@overpod`) — вычищены, в коде через ENV
- ✅ Прод-домен `mcp-telegram.com` — присутствует, но используется как **дефолт** через `config.issuer`; в self-hosted ставится свой через `ISSUER` env
- ✅ ADMIN_TOKEN, OAuth secrets, LOG_HASH_SALT, BOT_TOKEN, TELEGRAM_API_HASH — все только в GitHub Secrets / `.env`
- ⚠️ Один transitive GPL-3.0-or-later — `@cryptography/aes` через `telegram` (GramJS) → не блокер для MIT (см. Licensing)

**Готовность к публикации:** код в `src/` ~95% готов, нужен мини-cleanup `stacks/` + workflows + дефолтов в `config.ts`. Audit всей `.git history` через gitleaks — отдельная задача (Phase 4.4).

---

## 1. Sensitive Data Inventory

### 1.1 Hardcoded values в tracked файлах

| Файл | Строка | Значение | Тип | Действие при split |
|---|---|---|---|---|
| `src/config.ts` | 20 | `ISSUER` default `https://mcp-telegram.com` | Domain default | Заменить на `http://localhost:3000` или удалить default → `required()` |
| `stacks/mcp-telegram.yml` | 27 | `ISSUER: "https://mcp-telegram.com"` | Production override | Move to `mcp-telegram-infra` |
| `stacks/mcp-telegram.yml` | 28 | `BRAND_NAME: "MCP Telegram"` | Brand override | Move to `mcp-telegram-infra` (или оставить — generic) |
| `stacks/mcp-telegram.yml` | 38 | `Host("mcp-telegram.com")` Traefik rule | Production-specific | Move to `mcp-telegram-infra` |
| `README.md` | 7, 88 | references to `mcp-telegram.com` | Public marketing | Stays public — это и есть наш hosted instance |
| `SECURITY.md` | 7, 9 | `security@mcp-telegram.com`, link to landing | Maintainer contact | Stays public |
| `docs/self-hosting.md` | 5 | mention of hosted instance | Reference | Stays public |
| `src/mcp-handler.ts` | 181 | `config.issuer.includes("mcp-telegram.com")` | Conditional logic | OK — это тест "hosted vs self-hosted" |

**Output:** только `stacks/*.yml` имеют hardcoded прод-значения. Остальное — generic defaults или public-facing references на наш hosted instance.

### 1.2 GitHub Secrets (already secured)

Из `deploy.yml` и `notify-release.yml`:

```
TELEGRAM_API_ID
TELEGRAM_API_HASH
ADMIN_TOKEN
ADMIN_EMAIL              # для Let's Encrypt
SIGNOZ_ENDPOINT
OPENAI_APPS_CHALLENGE
CONTACT_EMAIL
CONTACT_TELEGRAM
LOG_HASH_SALT
BOT_TOKEN                # release notifier
RELEASE_CHAT_ID          # supergroup id
```

И GitHub Variables: `SHARE_NETWORK_NAME`.

**Действие:** все secrets останутся в репо `mcp-telegram-cloud` (Settings → Secrets), потому что CI/CD деплоит из этого же репо. После split CI/CD логика workflow'ов мигрирует в `mcp-telegram-infra`, secrets вместе с ней.

### 1.3 SSH / Server access

- Self-hosted GitHub Actions runner с label `mcp-telegram` живёт на сервере 149.154.184.31
- SSH доступ описан в Serena memory (`reference_server_ssh.md`)
- В tracked коде **никаких ссылок на сервер нет** ✅

### 1.4 Что ещё проверить (Phase 4.4)

- [ ] `git log --all -p` через gitleaks — поиск утечек в **истории** (не только current state)
- [ ] Поиск в bun.lock / pnpm-lock.yaml на наличие прод-URL (transitive resolution)
- [ ] `grep -rE "192\.168\.|10\.0\.|127\.0\.0\.1|localhost:" src/` — internal IPs (низкий приоритет)

---

## 2. File Disposition Plan

### 2.1 → `mcp-telegram-infra` (PRIVATE)

```
stacks/
  mcp-telegram.yml          # production stack: ISSUER, hostname, secrets refs
  traefik.yml               # reverse proxy, Let's Encrypt config
.github/workflows/
  deploy.yml                # self-hosted runner, docker stack deploy
  diagnose.yml              # workflow_dispatch ops tool
  notify-release.yml        # release → Telegram bot
scripts/
  notify-release.ts         # ↑ co-located here for self-contained CI
```

**Notes:**
- `notify-release.ts` — generic enough чтобы остаться публичным (использует только `BOT_TOKEN`/`RELEASE_*` env), но если оставить — придётся перепроверять при breaking changes. Безопаснее в private.
- `traefik.yml` — generic, можно оставить как `docker-compose.example.yml` в публичном `cloud` для self-hosters.

### 2.2 → `mcp-telegram-cloud` (PUBLIC, MIT)

```
src/                        # все исходники приложения
docs/                       # self-hosting + research docs
.husky/                     # git hooks
.gitleaks.toml              # secret scanning rules
.gitignore                  # generic ignores (extended in Phase 0.3)
.env.example                # 12 ENV vars с inline docs (Phase 0.5 v2)
biome.json                  # lint config
Dockerfile                  # build instructions
README.md                   # rewrite for public audience (Phase 4.6)
SECURITY.md                 # disclosure policy
LICENSE                     # → MIT (Phase 4.5)
package.json + lockfiles
tsconfig.json
.github/workflows/
  security-scan.yml         # gitleaks + trufflehog (public-friendly)
```

**New files for OSS public release (Phase 4.3, 4.5, 4.6):**
- `LICENSE` — MIT
- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md` — Contributor Covenant
- `.github/ISSUE_TEMPLATE/` — bug_report, feature_request
- `.github/PULL_REQUEST_TEMPLATE.md`
- `docs/architecture.md`
- `docs/configuration.md` — full ENV reference
- `docs/self-hosting.md` — already exists, expand
- `docker-compose.example.yml` — self-hosters quickstart (адаптация traefik.yml + cloud stack без secrets)

### 2.3 Грейзоны (требуют решения)

| Файл | Почему grey | Рекомендация |
|---|---|---|
| `notify-release.ts` | Зависит от наличия BOT_TOKEN/RELEASE_CHAT_ID, эти secrets — наши | Переместить в `mcp-telegram-infra`. Если кому-то надо в public — pure functions можно extract в `scripts/notify-template.ts` без env-логики |
| `Dockerfile` | Использует `git clone --depth 1 https://github.com/mcp-telegram/mcp-telegram.git` | Stays public — публичный репо, нет утечки. Потенциально можно через `npm install` без clone, но это отдельная оптимизация |
| `.husky/pre-commit` + `.gitleaks.toml` | Защита от утечки — нужна и в public, и в infra | Stays public (полезный артефакт для contributors); скопировать в `mcp-telegram-infra` отдельно |

---

## 3. Dependency License Audit

### 3.1 Direct dependencies (8 prod)

| Package | Version | License | OSS-friendly? |
|---|---|---|---|
| `@hono/node-server` | ^2.0.0 | MIT | ✅ |
| `@modelcontextprotocol/sdk` | ^1.29.0 | MIT | ✅ |
| `@overpod/mcp-telegram` | ^1.34.0 | MIT | ✅ |
| `better-sqlite3` | ^12.9.0 | MIT | ✅ |
| `dotenv` | ^17.4.2 | BSD-2-Clause | ✅ |
| `hono` | ^4.12.15 | MIT | ✅ |
| `zod` | ^4.3.6 | MIT | ✅ |

**DevDependencies:** все MIT (biome, husky, lint-staged, tsx, typescript, types).

### 3.2 Transitive license summary

`pnpm licenses list --prod` показывает в основном MIT, ISC, BSD, Apache-2.0, 0BSD — все OSS-friendly.

**Особый случай — GPL-3.0-or-later:**

```
@cryptography/aes@0.1.1
└─ telegram@2.26.22 (GramJS)
   └─ @overpod/mcp-telegram@1.34.0
      └─ mcp-telegram-cloud
```

**Анализ:**
- GramJS сам опубликован под MIT, [public репо](https://github.com/gram-js/gramjs)
- `@cryptography/aes` — отдельный npm-пакет под GPL-3.0
- `@overpod/mcp-telegram` уже опубликован под MIT (npm) — **прецедент: эту цепочку MIT уже принял**
- В строгой интерпретации GPL "viral" — но это касается **distribution бинарника**, не npm install transitive

**Вывод:** для нашего use case (server-side приложение, используем как библиотеку, не распространяем модифицированный AES) — risk acceptable. Это та же ситуация что у GramJS (MIT) и `@overpod/mcp-telegram` (MIT). Если в будущем GramJS заменит `@cryptography/aes` на MIT-альтернативу — мы автоматически наследуем.

**Action:** добавить в `LICENSE` или `NOTICE.md` упоминание transitive dependencies при публикации (best practice, не обязательно для MIT).

---

## 4. Code Quality Snapshot

### 4.1 Config centralization (✅ done)

Весь runtime сконцентрирован в `src/config.ts` (51 строка, 12 env vars). Прямого `process.env.X` доступа за пределами config.ts **нет** — grep подтверждает.

### 4.2 PII handling (✅ done after Phase 0.5)

- `logUser()` через HMAC-SHA256 + `LOG_HASH_SALT` (commit `bebf787`)
- `LOG_USER_IDS=false` дефолт для OSS
- Все 11 user-id log sites в `mcp-handler.ts` обёрнуты
- Никаких phone, firstName, username в логах

### 4.3 Self-hosting friendly (✅ done after Phase 0.5)

- `OPENAI_APPS_CHALLENGE` — пустой → endpoint 404 silently
- `SIGNOZ_ENDPOINT` — пустой → no-op OTLP batching
- `CONTACT_EMAIL` / `CONTACT_TELEGRAM` — пустые → contact blocks условный рендеринг
- `iconUrl` через config.issuer
- `freeTierLimit=0` → unlimited (для self-hosters)

### 4.4 Что ещё нужно для self-hosters (Phase 4)

- [ ] `docker-compose.example.yml` без Traefik dependency (или с включаемым reverse proxy)
- [ ] `docs/configuration.md` с полным ENV reference
- [ ] `docs/architecture.md` с диаграммой (Hono → IPC daemon → MTProto)
- [ ] HTTPS/TLS guidance (nginx termination, caddy, traefik как варианты)

---

## 5. Risk Map → Phase 4.1 Repo Split

| Риск | Severity | Mitigation |
|---|---|---|
| Утечка прод-IP в `stacks/*.yml` если зайдём в публичный репо без cleanup | **HIGH** | Move `stacks/` в `mcp-telegram-infra` ДО `git checkout --orphan` |
| Утечка GitHub Secrets имён через workflows | LOW | Имена secrets — публичная информация, значения остаются защищены |
| Confusion для contributors при self-hosting (default `mcp-telegram.com`) | MEDIUM | Заменить default на `http://localhost:3000` в `config.ts` или сделать required env |
| `Dockerfile` `git clone` ссылается на public org `mcp-telegram` | LOW | OK — это публичный репо |
| Transitive GPL `@cryptography/aes` мешает MIT | LOW | Document в LICENSE/NOTICE; precedent — MIT already published @overpod/mcp-telegram |
| `notify-release.ts` логирует через BOT_TOKEN | LOW | Move to infra-repo, или extract pure functions |

---

## 6. Recommendations / Next Actions

**Immediate (Phase 4.1 prep):**
1. Create `mcp-telegram-infra` private repo
2. Move `stacks/`, deploy/diagnose workflows, `notify-release.ts` + `notify-release.yml` to infra
3. Replace `config.issuer` default `https://mcp-telegram.com` → required env (force self-hosters to set ISSUER explicitly)
4. Add `docker-compose.example.yml` for self-hosters
5. Add `LICENSE` (MIT) — Phase 4.5
6. Run gitleaks scan on full `.git` history (Phase 4.4) before orphan branch

**Pending decisions:**
- Оставить `BRAND_NAME` env как override или хардкодить `"MCP Telegram"` в config? (override полезен для self-hosted forks)
- Включить ли `docker-compose.example.yml` Traefik блок, или оставить пользователю свой reverse proxy?
- Need a public `NOTICE.md` для перечисления GPL transitive (`@cryptography/aes`)?

---

## 7. Files NOT to publish (final allowlist for `git rm` before orphan)

```bash
# Already gitignored (.env, *.db, claudedocs/) — no action needed
# Move to mcp-telegram-infra:
stacks/mcp-telegram.yml
stacks/traefik.yml
.github/workflows/deploy.yml
.github/workflows/diagnose.yml
.github/workflows/notify-release.yml
scripts/notify-release.ts
```

Everything else → public repo.
