# Telegram Rate Limits — Research

**Phase:** 1.1 (Cloud OSS roadmap)
**Date:** 2026-04-25
**Goal:** собрать факты о том, как Telegram ограничивает API-вызовы по методам и какие cooldown'ы он возвращает, чтобы спроектировать per-method adaptive rate limiter в Phase 3.1.

## TL;DR

1. **Telegram не публикует точные числовые лимиты** по большинству методов. Вместо этого он возвращает **`FLOOD_WAIT_X`** (где X — секунды ожидания) когда лимит превышен. Сервер сам определяет, сколько ждать.
2. **`SLOWMODE_WAIT_X`** — отдельная категория, на уровне чата (slow mode supergroups), не глобальная.
3. **Класс ошибок 420** — `FLOOD_WAIT_*`, `SLOWMODE_WAIT_*`, `2FA_CONFIRM_WAIT_*`, `PHONE_PASSWORD_FLOOD` — всё это retry-after сигналы.
4. **GramJS** имеет встроенный механизм `floodSleepThreshold` — клиент сам спит, если ожидание ≤ порога; иначе бросает `FloodWaitError` через cb.
5. **Наш текущий лимитер** — глобальный (per-process, 20 req/sec, FLOOD_WAIT auto-retry) + per-IP HTTP rate-limit на `/oauth/*`. **Нет per-user, нет per-method.**
6. **Продакшен бейзлайн (7 дней SigNoz):** **0 ERROR**, 0 FLOOD_WAIT, 0 AUTH_KEY_DUPLICATED, 459 WARN (все — мусорные сканеры на /wp-admin/install.php). Низкий трафик → real-world incidence пока не репрезентативна.

---

## 1. Что говорит Telegram (Telegram Core docs)

Источники: `core.telegram.org/api/errors`, `core.telegram.org/api/flood`, `core.telegram.org/bots/faq`.

### 1.1 Класс ошибок 420 (rate-limit signals)

| Error | Семантика | Cooldown | Кто бросает |
|---|---|---|---|
| `FLOOD_WAIT_X` | Превышен глобальный лимит для метода/класса методов | X секунд | API server |
| `SLOWMODE_WAIT_X` | Slow mode на supergroup чате — следующее сообщение через X сек | X секунд (configurable owner'ом, обычно ≤ 60) | API server, per-chat |
| `2FA_CONFIRM_WAIT_X` | 2FA recovery cooldown | X секунд | API server, per-account |
| `PHONE_PASSWORD_FLOOD` | Слишком много попыток ввести пароль 2FA | "wait a little" (без числа) | API server, per-account |
| `PHONE_PASSWORD_PROTECTED` | Аккаунт защищён 2FA, нужен пароль | — | API server |
| `PHONE_NUMBER_FLOOD` | Слишком много phone code requests | secondhalf hour-ish | API server, per-phone |

### 1.2 Что Telegram говорит про лимиты

> "Be aware that flood limits apply to the **method**, the **chat** and the **account**. Most have not been documented to discourage abuse."

Иными словами — публичных таблиц "метод X = N req/sec" нет. Лимиты:
- **Per-method** (некоторые методы строже, типа `messages.SendMessage` к новым контактам)
- **Per-chat** (slow mode + neighbor flood detection)
- **Per-account** (общая активность, особенно подозрительная)
- **Per-IP** (неявно — IP бан при abuse)

### 1.3 Известные числовые ориентиры (community knowledge, не официально)

| Сценарий | Ориентир | Источник |
|---|---|---|
| Сообщения "себе/контактам" | ~20 msg/sec | tdlib issues, Telegram Advanced Group |
| Сообщения новым people (не contacts) | ~1 msg/sec | tdlib issues |
| Bulk forward (одно sendmedia) | ~30 msg/sec | community testing |
| Joining channels/groups | ~50/day для нового аккаунта, до ~500/day для старого | анекдотически |
| Resolving usernames (`contacts.ResolveUsername`) | ~200/day на новом аккаунте | анекдотически |
| Searching globally (`contacts.Search`) | ~30/min | анекдотически |
| Get participants (`channels.GetParticipants`) | ~10/min | анекдотически |
| Download media | bandwidth-driven, не call-count | core.telegram.org |
| `auth.SignIn` / `auth.SendCode` | очень строго, минуты-часы между попытками | core.telegram.org |

**Вывод:** числовые лимиты — moving target. Дизайнить надо **реактивно** (по `FLOOD_WAIT_X` ответу), не **проактивно** (по hardcoded таблице).

---

## 2. Что делает GramJS

Источники: gram.js.org docs, telegram npm package source.

### 2.1 Конструктор `TelegramClient`

```ts
new TelegramClient(session, apiId, apiHash, {
  // Auto-sleep on FLOOD_WAIT if X <= threshold (in seconds).
  // Default: 60. If FLOOD_WAIT_X с X > threshold — throws FloodWaitError.
  floodSleepThreshold: 60,

  // Auto-reconnect on connection drop / migrate.
  autoReconnect: true,

  // Limits concurrent file chunks during download.
  maxConcurrentDownloads: 1,

  // Connect retry interval / count.
  connectionRetries: 5,
  retryDelay: 1000,
})
```

### 2.2 Что GramJS обрабатывает сам

- **`FLOOD_WAIT_X` где X ≤ 60 sec** — спит автоматически, не бросает наружу
- **Connection drop / migrate** — auto-reconnect через `connectionRetries`
- **DC migration** — следует автоматически
- **AUTH_KEY_DUPLICATED** — НЕ обрабатывает; падает с ошибкой (наша головная боль до v1.27 IPC)

### 2.3 Что НЕ делает GramJS

- **Per-method tracking** — не различает методы
- **Per-account / per-user tracking** — все запросы клиента одинаковы
- **Adaptive throttling** — нет soft-limit / preemptive slow-down

---

## 3. Наш текущий стек — audit

### 3.1 `mcp-telegram/src/rate-limiter.ts` (open-source core)

**Текущее поведение:**
- Глобальный `RateLimiter` per-process: **20 req/sec** (50ms между slot'ами)
- Сериализация через `slotQueue` (chained Promise) — concurrent-callers выстраиваются в очередь
- При `FLOOD_WAIT_X`: ждём X секунд, retry до `maxRetries=3`, иначе throw
- При network error (ETIMEDOUT, ECONNREFUSED, etc): exponential backoff (1s → 2s → 4s, capped at 60s), retry до 3
- При 5xx (500/502/503): exponential backoff, retry до 3
- Опция `throwOnFloodWait` — bypass auto-sleep для long-running API типа stats

**Чего нет:**
- Per-method bucket
- Per-user / per-account quota
- Soft-limit preemptive throttle ("осталось N/M запросов")
- Метрики (как часто срабатывает, на каком методе)
- Алерты при flood
- Coordination между процессами (cloud имеет 1 replica, но в будущем — issue)

### 3.2 `mcp-telegram-cloud/src/rate-limit.ts`

**Текущее поведение:**
- Hono middleware, **per-IP** bucket в памяти (`Map<scope:ip, {count, resetAt}>`)
- Применяется **только на `/oauth/*` endpoint** (через `oauthRateLimit` export)
- Defaults: 30 req/min per IP (через `OAUTH_RATE_LIMIT` / `OAUTH_RATE_WINDOW_MS` env)
- Возвращает 429 с `Retry-After` header
- Sweeper раз в 60 sec удаляет expired buckets

**Чего нет:**
- **Per-user MCP tool-call limit** (есть `freeTierLimit=100/day` в `usage.ts`, но это count-tracking, не rate)
- Per-tool / per-method limit
- Distributed coordination (если будет ≥ 2 replicas)

### 3.3 `mcp-telegram-cloud/src/usage.ts` — что уже есть

- `getTodayCount(userId)` — простой счётчик за UTC день
- `freeTierLimit=100` daily quota
- При превышении — MCP error response с self-host CTA на `SOURCE_REPO_URL` (исторически здесь была "Upgrade to Pro" фраза с `PRO_UPGRADE_URL`; убрана в Phase 4.6 commit `d824c26` вместе с paid-tier удалением — нет paid плана, unlimited = self-host)

**Это quota, не rate-limit.** Нет защиты от burst в 100 запросов за 1 секунду.

---

## 4. Production baseline (7 days SigNoz observation)

Service: `mcp-telegram-cloud`, период: 2026-04-18 → 2026-04-25.

| Метрика | Значение |
|---|---|
| ERROR logs | **0** |
| WARN logs | 459 |
| INFO logs | 275 |
| FLOOD_WAIT events | 0 |
| AUTH_KEY_DUPLICATED events | 0 |

**Анализ WARN:** все 459 — `http.request` с status 401/404. Топ patterns:
- `GET /wp-admin/install.php 404` — WordPress сканеры (большинство)
- `POST /mcp 401` — попытки без OAuth токена (сканеры или клиенты с протухшим токеном)
- `GET /robots.txt 404` — поисковые боты

**Real MCP tool-call traffic:** в текущем формате логирования event `mcp.tool.call` за неделю не зафиксирован (либо реальных активных пользователей < 1, либо event labelling не пишется в SigNoz). Это совпадает с MEMORY.md — "billing deferred до 5+ free users".

**Вывод:** real-world FLOOD_WAIT incidence сейчас **не наблюдается, потому что трафика мало**. Дизайнить per-method limiter сейчас — over-engineering. **Триггер для активной работы по Phase 3.1: рост до 10+ DAU или появление первого FLOOD_WAIT в логах.**

---

## 5. Method → Limit → Strategy table

Подход: метод → известный лимит (если есть) → как реагировать в нашем стеке.

### 5.1 Hot methods (часто вызываются нашими tools)

| Telegram method | Наши tools | Известный лимит | Стратегия |
|---|---|---|---|
| `messages.GetHistory` | read-messages, read-topic-messages | flexible, обычно высокий | Reactive only (FLOOD_WAIT) |
| `messages.GetDialogs` | list-chats | ~10/min быстро всё, потом FLOOD | Reactive + кеш entity (уже есть) |
| `messages.SendMessage` | send-message | ~20/sec contacts, ~1/sec strangers | Reactive + slow on first-strangers |
| `messages.SendMedia` / `SendMultiMedia` | send-file, send-album | bandwidth-driven | Reactive |
| `contacts.ResolveUsername` | поиск чатов by @username | ~200/day fresh accounts | **Cache resolved** (уже есть entity-cache) |
| `contacts.Search` | search-chats | ~30/min | Reactive + per-user 1 req/2s soft |
| `messages.SearchGlobal` | search-global | строгий лимит (~5-10/min) | **Per-user 1 req/6s soft** + reactive |
| `channels.GetParticipants` | get-chat-members | ~10/min | Reactive + cursor pagination |
| `users.GetFullUser` | get-profile | ~50/min | Reactive |
| `photos.GetUserPhotos` | get-profile-photo | ~30/min | Reactive |
| `auth.ExportLoginToken` | qr-login (start) | строгий, минуты | Reactive only (one-shot per user) |
| `auth.ImportLoginToken` | qr-login (poll) | tied to ExportLoginToken | Reactive only |

### 5.2 Destructive (часто строже)

| Method | Наши tools | Strategy |
|---|---|---|
| `messages.DeleteMessages` | delete-message | Per-user destructive daily counter (Phase 2.1) |
| `channels.LeaveChannel` | leave-group | Same |
| `channels.EditBanned` | ban-user, kick-user | Same |
| `messages.EditMessage` | edit-message | Reactive |

### 5.3 OAuth / setup (per-IP важнее чем per-user)

| Method/endpoint | Текущее | Достаточно? |
|---|---|---|
| `/oauth/authorize` | 30/min per IP | ✅ да |
| `/oauth/token` | 30/min per IP | ✅ да |
| `/oauth/register` | 30/min per IP | ✅ да |
| QR SSE stream `/login` | **нет лимита** | ⚠️ TODO (Phase 3.1) — нужен limit на новые QR sessions |

---

## 6. Recommended architecture for Phase 3.1

### 6.1 Layered approach

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: HTTP per-IP (already have on /oauth/*)             │ ← protects OAuth from brute
│   - Hono middleware, in-memory bucket                       │
│   - TODO: extend to /login (QR SSE)                         │
├─────────────────────────────────────────────────────────────┤
│ Layer 2: MCP per-user quota (already have via usage.ts)     │ ← billing/abuse layer
│   - Daily count from SQLite usage_log                       │
│   - freeTierLimit=100/day default                           │
│   - Returns MCP error response                              │
├─────────────────────────────────────────────────────────────┤
│ Layer 3: MCP per-user RATE (TODO)                           │ ← burst protection
│   - Token bucket: 10 calls/min per user, refill 1/6sec      │
│   - Per-user, in-memory                                     │
│   - Returns MCP error with retry-after                      │
├─────────────────────────────────────────────────────────────┤
│ Layer 4: GramJS process-level (already have rate-limiter.ts)│ ← MTProto traffic shaping
│   - Global 20 req/sec, FLOOD_WAIT auto-retry                │
│   - Stays as is                                             │
├─────────────────────────────────────────────────────────────┤
│ Layer 5: Per-method soft limits (TODO, only if needed)      │ ← reactive escalation
│   - Track method-level FLOOD_WAIT freq in SigNoz            │
│   - Apply soft limit only on methods that ACTUALLY flood    │
│   - Config-driven via src/rate-limits.ts                    │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Recommendation: что делать когда

**До 10 DAU — оставить как есть.** Текущий стек справляется. Прирост Layer 3 преждевременный.

**При 10-50 DAU — добавить Layer 3** (per-user burst limit, in-memory token bucket):
- Реализация: расширить `rate-limit.ts` middleware на `/mcp` с key = `user_id` вместо IP
- Defaults: 10 calls/min per user, 1 token/6sec refill
- ENV: `MCP_PER_USER_RATE_LIMIT=10`, `MCP_PER_USER_RATE_WINDOW_MS=60000`

**При 50+ DAU или появлении FLOOD_WAIT в SigNoz — добавить Layer 5** (per-method soft):
- `src/rate-limits.ts` — таблица `methodName → {soft_limit_per_min, escalate_on_flood}`
- Реализация в обёртке `withRateLimit(client, method, args)`
- Метрики в SigNoz: `event=flood_wait`, `method=<name>`

**При появлении ≥ 2 cloud replicas — добавить Layer 6** (distributed):
- Redis token bucket вместо in-memory
- Или sticky-session по user_id (Traefik consistent hash)

### 6.3 Что писать в SigNoz

Сейчас структурный лог уже есть (`event`, `component`, `userId`, `path`). Добавить при flood:

```ts
logger.warn("FLOOD_WAIT received", {
  component: "mtproto",
  event: "flood_wait",
  method: methodName,         // e.g. "messages.SendMessage"
  waitSec: floodSeconds,
  userId: logUser(userId),
  attempt: attemptNumber,
});
```

Это даст dashboard "методы по частоте FLOOD_WAIT" → база для Layer 5 решений.

### 6.4 Alert thresholds (для Phase 0.2 Observability)

| Условие | Severity | Действие |
|---|---|---|
| `event=flood_wait` rate > 10/hour | WARN | Telegram бот → админ |
| `event=flood_wait` для одного user > 5/hour | INFO + log | Возможно, скриптинг — посмотреть |
| `event=flood_wait` для метода > 50/hour | ERROR | Срочно расширять Layer 5 для этого метода |
| `body CONTAINS "AUTH_KEY_DUPLICATED"` > 1/24h | ERROR | Telegram бот → админ (несмотря на v1.27 IPC) |

---

## 7. Open questions / next research

- [ ] **Proxy pool & rate limits** — будет ли rate limit per-IP важен после Phase 1.2 (proxy pool)? Если IP rotates, FLOOD_WAIT уже **per-account**, не per-IP. Phase 1.2 закроет вопрос.
- [ ] **GramJS `floodSleepThreshold` config** — сейчас дефолт 60. Для cloud разумно повысить до **180** (тогда GramJS сам ждёт до 3 минут не бросая в наш код)? Или НЕ повышать — иначе "застрявшие" tool calls съедают MCP timeout?
- [ ] **Telegram Premium account benefits** — даёт ли Premium больше квот для нашего hosted instance? (Не использовали, но возможно стоит для cloud account.)
- [ ] **Real measurements нужны** — без реального трафика 5.1 — это анекдотические числа из community. После 50+ DAU — повторить research через 4-6 недель.

---

## 8. Decisions captured

1. ✅ **Per-method static limit таблица — НЕ строим сейчас.** Telegram сам не публикует, real-world ещё нет данных. Делаем reactive (`FLOOD_WAIT` → backoff).
2. ✅ **Layer 3 (per-user burst) — отложить до 10+ DAU.** Quota (Layer 2) сейчас достаточно.
3. ✅ **Cache `contacts.ResolveUsername` — уже есть** (entity-cache в mcp-telegram v1.26.1).
4. ✅ **Add `event=flood_wait` structured log** — добавить в `rate-limiter.ts` уже сейчас, чтобы SigNoz накапливал данные для будущего Layer 5.
5. ✅ **`/login` (QR SSE) endpoint — добавить rate-limit** в Phase 3.1 (а не сейчас — пока нет abuse).
6. ✅ **Layer 1 (per-IP /oauth/*) — already done in H4 fix.** Не трогаем.

---

## 9. References

- **Telegram Core docs**: https://core.telegram.org/api/errors, https://core.telegram.org/api/flood
- **GramJS docs**: https://gram.js.org/ (TelegramClient constructor options, Api error tables per method)
- **Bots FAQ rate limits**: https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this (для bot API, не client API, но похожие принципы)
- **Community knowledge**: gram-js/gramjs GitHub issues, t.me/TelegramAdvancedGroup, Stack Overflow tag `telegram-api`
- **Наш код**: [mcp-telegram/src/rate-limiter.ts](https://github.com/mcp-telegram/mcp-telegram/blob/main/src/rate-limiter.ts), [mcp-telegram-cloud/src/rate-limit.ts](../../src/rate-limit.ts), [mcp-telegram-cloud/src/usage.ts](../../src/usage.ts)
