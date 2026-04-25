# Proxy Pool Strategy — Research

**Phase:** 1.2 (Cloud OSS roadmap)
**Date:** 2026-04-25
**Status:** **Variant A active** (no proxy pool). Implementation deferred to trigger conditions below.
**Goal:** определить когда и как переключаться с single-IP на proxy pool, чтобы не делать research под давлением incident'а.

## TL;DR

1. **Сейчас:** все юзеры идут через **один публичный IP** сервера (single-IP, Variant A). Никакой ротации, никакого pool'а.
2. **Почему так:** прод-baseline 7 дней — **0 FLOOD_WAIT, 0 AUTH_KEY_DUPLICATED**. Вводить инфраструктуру без боли = прожигание бюджета.
3. **Триггеры активации** — привязаны к существующим SigNoz alerts (Phase 0.2) и DAU sustained 10+, **не календарные**. См. §3.
4. **Pool ≠ silver bullet:** `AUTH_KEY_DUPLICATED` и `FLOOD_WAIT` — **не IP-проблемы** (см. §2 mis-attribution). Pool помогает только при IP-reputation throttling и geo-latency.
5. **При активации:** Variant B (datacenter VPS pool ~$20-40/мес) — default. Variant C (residential) — escalation only. Точные SKU и цены **проверять на момент закупки** — provider lineups меняются часто.
6. **Stickiness** — primary через `users.assigned_proxy_id` в SQLite (modulus hash только для initial distribution). MTProto session **не строго IP-bound**, forced re-login на failover не нужен по умолчанию.

---

## 1. Текущее состояние (Variant A)

| Параметр | Значение |
|---|---|
| Public IP | single dedicated VPS (NL/AM hosting, see `whois` if needed) |
| GramJS proxy config | none (direct connection к Telegram DC через MTProto) |
| Распределение юзеров по IP | N/A — все через один |
| Sticky routing | N/A |
| Health monitoring | только app-level (SigNoz) |
| Failover | отсутствует |

**Замечание:** в локальных maintainer-заметках зафиксированы periodic `AUTH_KEY_DUPLICATED`-эпизоды на dev-машине. Это, скорее всего, **same-session-used-by-multiple-processes** (semantics из MTProto), не IP-density issue — см. §3 ниже про правильную интерпретацию триггеров. Прод за последние 7 дней — 0 `AUTH_KEY_DUPLICATED`, 0 `FLOOD_WAIT` событий по SigNoz.

---

## 2. Зачем proxy pool вообще

Single-IP риски при росте (**гипотезы**, не подтверждённые в нашем проде):

- **IP-reputation throttling** — Telegram может ужесточить лимиты или замедлять ответы на IP, с которого идёт неестественно много параллельных сессий из разных аккаунтов. Точные пороги Telegram не публикует ([rate-limits research §1.2](./telegram-rate-limits.md)).
- **IP ban** — крайний случай при явном abuse-паттерне (массовая регистрация, спам, joining flood). Маловероятно для legitimate-traffic, но при расширении функциональности риск растёт.
- **Geo-latency** — концентрация юзеров с разных геолокаций на одном датацентровом IP даёт subоптимальную маршрутизацию к разным Telegram DC.

**Что НЕ является single-IP проблемой (типичные mis-attribution):**

- `AUTH_KEY_DUPLICATED` — это семантически «один auth-key используется одновременно несколькими процессами/устройствами», а не «много auth-keys с одного IP». Лечится **single-flight per session** (наш Master/Client IPC уже это делает) и careful session storage, не proxy pool.
- `FLOOD_WAIT_X` — почти всегда per-method или per-account, не per-IP. Один шумный аккаунт получает FLOOD_WAIT **только сам**, остальные юзеры на том же IP не страдают (см. [rate-limits research §1.2](./telegram-rate-limits.md), цитата Telegram Core: "flood limits apply to the method, the chat and the account").

**Все три реальных риска — эмерджентные, проявляются при росте.** Сейчас юзеров мало → риск практически нулевой.

---

## 3. Триггеры активации (когда переключаться на pool)

**Ни один из этих триггеров не является автоматическим основанием для proxy pool — это сигналы для investigation.** Pool — одно из возможных решений, но сначала проверяем root cause (per-method tuning, per-user limit, IPC bug).

| # | Сигнал | Источник | Что делать первым шагом |
|---|---|---|---|
| T1 | Alert A1 fires: `flood_wait > 10/hour` (WARN) | SigNoz alert `A1` ([rate-limiter-dashboard §A1](../observability/rate-limiter-dashboard.md)) | Drill down на `context` field — выяснить какой method и аккаунт триггерит. Если **системно** один и тот же IP-adjacent flood pattern → начать Phase 3.2 шорт-плэн. Если просто шумный аккаунт → Layer 3 per-user limit. |
| T2 | Alert A2 fires: `flood_wait > 50/hour` (CRITICAL) | SigNoz alert `A2` | Manual investigation на конкретного юзера (см. A2 rationale). Pool обычно не помогает — это per-account flood. |
| T3 | Alert A3 fires: `AUTH_KEY_DUPLICATED > 1/24h` (CRITICAL) | SigNoz alert `A3` | **НЕ включать pool** — это IPC bug (single-flight broken). Investigate Master/Client IPC code path. См. A3 rationale. |
| T4 | DAU sustained 10+ за 7 consecutive UTC-days | `UsageTracker.getDailyActiveUsers(7)` — значение должно быть ≥10 для **каждого** дня (server timezone UTC, current day excluded если день не завершён) | Превентивно начать Phase 3.2 — даёт время инициализировать pool до того как реально упрёмся. Бюджет $20-30/мес approved. |
| T5 | Multiple users (3+) reproducibly report «sessions drop without action» в течение 7 дней | Broadcast bot inbox + GitHub issues | Investigation (см. local maintainer notes on VPN↔Telegram DC routing) — может быть IP-related или другая причина. Pool рассматривать только после исключения IPC/session storage bugs. |

**Где мониторить:** все alerts описаны в [docs/observability/rate-limiter-dashboard.md](../observability/rate-limiter-dashboard.md) (Phase 0.2). DAU считается через `UsageTracker.getDailyActiveUsers()` в `src/usage.ts`.

---

## 4. Варианты pool'а (shortlist)

### Variant B — Datacenter VPS pool (own infra) — first option при T4 (sustained DAU)

| Параметр | Значение |
|---|---|
| Провайдеры (orientative) | Hetzner small ARM/x86 (~€4-6/мес/инстанс), DigitalOcean basic droplet (~$6/мес), Vultr cloud compute (~$6/мес) — **точные SKU и цены проверять на момент закупки**, провайдеры регулярно меняют lineup |
| Pool size | **5 IP** в 3 регионах (EU/US/APAC) — стартовый sizing для 10-50 DAU |
| Стоимость (estimate) | **~$20-40/мес** total в зависимости от выбора SKU и регионов |
| SOCKS5 server | [3proxy](https://github.com/3proxy/3proxy) или [Dante](https://www.inet.no/dante/) |
| Latency overhead | +20-50ms (acceptable) |
| Telegram detection risk | **Hypothesis (не verified):** datacenter ASN могут получать более жёсткое throttling чем residential. Telegram это не публикует. При нашем умеренном трафике + user-like patterns, скорее всего, незаметно. |
| Когда подходит | T4 (sustained DAU 10+), нет признаков что нужен residential |

**Распределение юзеров:**
- **Initial assignment** при первом spawn worker'а: `hash(user_id) % pool.healthy().length` для равномерного распределения.
- **Persistence (это и есть настоящая stickiness):** результат сохраняется в `users.assigned_proxy_id` (новая колонка SQLite). При перезапуске worker'а или add/remove proxy в pool — юзер остаётся на assigned IP, пока тот healthy.
- **Failover:** если assigned IP помечен dead — юзер переезжает на следующий по hash (`(hash + 1) % healthy`); `assigned_proxy_id` обновляется. **Пере-логин обычно не требуется** — MTProto сессии не строго IP-bound. Нужен только если новый proxy приводит к `AUTH_KEY_INVALID` от Telegram (rare; зависит от того, насколько строг Telegram к IP shifts на конкретном auth key — empirical).

**Почему `hash % pool_size` сам по себе недостаточен:** этот формула стабильна только при фиксированном `pool_size`. Add/remove proxy ремапит большинство юзеров на новые IP-ы. Поэтому `assigned_proxy_id` в SQLite — это primary stickiness mechanism, а hash — просто initial distribution function.

### Variant C — Residential proxies — escalation if Variant B показывает throttling

| Параметр | Значение |
|---|---|
| Провайдеры | [IPRoyal Royal Residential](https://iproyal.com/), [Bright Data](https://brightdata.com/), [Smartproxy](https://smartproxy.com/), [Oxylabs](https://oxylabs.io/) |
| Биллинг | Большинство — по трафику (premium $5-15/GB, есть и budget-варианты $0.5-3/GB у smaller players); часть — по IP/мес. **Сравнивать на момент закупки.** |
| Стоимость (estimate) | **~$50-200/мес** для 100-500 DAU при premium tier. Бюджетные провайдеры могут быть ~$20-50/мес. |
| Telegram detection risk | **Hypothesis (не verified):** residential IP visually неотличимы от обычных юзеров → меньше anti-fraud weight. Подтверждение требует A/B теста vs Variant B. |
| Этический момент | Часть провайдеров получает residential IPs через P2P/SDK в чужих приложениях (серая зона). Decline tier providers — opt-in P2P (IPRoyal позиционирует так). Делать due diligence на consent model. |
| Когда подходит | Только если Variant B демонстрирует throttling который не лечится тюнингом. Не премiere choice. |

### Variant D — Hybrid (long-term)

- **Free users** → общий IP или Variant B (cheap)
- **Heavy users / opt-in** → dedicated VPS из Variant B
- **Premium (если будет paid tier)** → Variant C residential

Откладывается до Phase 3+ когда будет реальный paid tier.

---

## 5. Архитектурные требования (для Phase 3.2 implementation)

### 5.1 GramJS integration

GramJS поддерживает SOCKS5 нативно:

```typescript
new TelegramClient(session, apiId, apiHash, {
  proxy: {
    ip: '1.2.3.4',
    port: 1080,
    socksType: 5,
    username: '...',
    password: '...',
    timeout: 5,
  },
});
```

### 5.2 IPC daemon changes (Master/Client)

Текущая IPC-архитектура (Master/Client daemon в `@overpod/mcp-telegram` v1.27+): Master spawn'ит Client per-user, передавая session credentials в spawn payload. Для proxy pool:

1. **Initial proxy assignment** — при первом spawn worker'а для юзера Master вызывает `pickProxy(userId)`:
   ```typescript
   function pickProxy(userId: number): ProxyConfig {
     const healthy = pool.healthy();
     const idx = hash(userId) % healthy.length; // initial distribution only
     return healthy[idx];
   }
   ```
   Результат сохраняется в `users.assigned_proxy_id` (SQLite). Modulus hashing нужен **только** для равномерного начального распределения; persistence в SQLite — primary stickiness mechanism.
2. **Spawn payload** — `proxy?: ProxyConfig` добавляется в spawn-request к Client (поле в существующем IPC-протоколе; backward-compatible — отсутствие = direct connection).
3. **Sticky persistence** — Master при каждом spawn сначала читает `users.assigned_proxy_id`. Если proxy всё ещё в healthy pool — переиспользует. Иначе re-pick (см. §5.3).
4. **Failover handling** — если assigned IP помечен dead, Master выбирает следующий healthy IP, обновляет `assigned_proxy_id`, restart'ит worker'а с новым proxy. **Re-login обычно не требуется** — MTProto session не bound к IP. Если Telegram возвращает `AUTH_KEY_INVALID` после смены IP (rare, empirical) — fallback на принудительный re-login через broadcast bot notification, но это не default.

### 5.3 Health monitoring

- **Periodic probe** — каждый IP пингует **Telegram DC endpoint** (например `pluto.web.telegram.org:443` или конкретный DC IP из `dc-config`). `api.telegram.org` — это Bot API endpoint, **не MTProto** path; пинговать его бесполезно для нашего юзкейса.
- **Альтернатива:** in-band health — отслеживать success rate реальных MTProto-вызовов через каждый proxy (пассивный health-check). Это надёжнее активного пинга для MTProto.
- **Per-IP метрики в SigNoz** — `proxy_id` attribute в access log + rate-limiter events.
- **Auto-marking dead** — **только** на сетевых индикаторах: 3 consecutive connection failures (TCP timeout / refused) ИЛИ `AUTH_KEY_INVALID` rate > threshold per assigned юзер. **НЕ** маркировать dead на `FLOOD_WAIT` — это per-method/per-account сигнал, не per-IP, иначе будем churn'ить healthy proxies.
- **Recovery** — health-check продолжается на dead IP, при 5 consecutive successes IP возвращается в pool. Уже мигрированные юзеры остаются на новом proxy (не возвращаем).

### 5.4 Configuration (planned for Phase 3.2 — not implemented yet)

Проектируемые ENV (будут добавлены в `src/config.ts` при активации Phase 3.2):

```bash
# Proxy pool — empty disables (Variant A behavior)
PROXY_POOL=socks5://user:pass@1.2.3.4:1080,socks5://user:pass@5.6.7.8:1080
PROXY_HEALTH_CHECK_INTERVAL_MS=60000
PROXY_FAILURE_THRESHOLD=3
```

Backward compatibility design: пустой `PROXY_POOL` = Variant A behavior (текущее single-IP поведение). Это план, не shipped — сейчас этих переменных в `src/config.ts` нет.

---

## 6. Decision log

| Дата | Решение | Обоснование |
|---|---|---|
| 2026-04-25 | **Variant A active**, pool deferred | 0 FLOOD_WAIT и 0 AUTH_KEY_DUPLICATED за 7 дней, < 10 DAU, нет смысла прожигать бюджет |
| 2026-04-25 | Триггеры — связаны с **существующими SigNoz alerts** A1/A2/A3 + DAU sustained, не с произвольными порогами | Уже сконфигурированные алерты (Phase 0.2) — единственный надёжный realtime signal |
| 2026-04-25 | При активации — **Variant B (datacenter VPS pool ~$20-40/мес)** как default | Дешевле residential, достаточно для 10-100 DAU. Точные SKU/цены проверять в момент закупки. |
| 2026-04-25 | Variant C (residential) — **только** после A/B-теста vs B | Premium стоимость и этические нюансы провайдеров. Не premiere choice. |
| 2026-04-25 | Stickiness — primary через `users.assigned_proxy_id` в SQLite, hash только для initial distribution | Modulus hashing alone нестабилен при изменении pool size; SQLite persistence гарантирует sticky behavior |
| 2026-04-25 | `AUTH_KEY_DUPLICATED` — **НЕ** триггер для proxy pool | Это IPC bug (single-flight broken), proxy pool не помогает; investigate Master/Client code path |
| 2026-04-25 | `FLOOD_WAIT` — **НЕ** signal для proxy health | Per-method/per-account scope; маркировать proxy dead на FLOOD_WAIT приведёт к self-inflicted instability |

---

## 7. Связанные документы

- [docs/research/telegram-rate-limits.md](./telegram-rate-limits.md) — почему лимитер реактивный (§9 Decisions)
- [docs/research/oss-split-inventory.md](./oss-split-inventory.md) — что идёт в `mcp-telegram-infra` repo при split
- [docs/observability/rate-limiter-dashboard.md](../observability/rate-limiter-dashboard.md) — SigNoz alerts A1/A2/A3 которые служат триггерами в §3
- IPC daemon spec — см. `@overpod/mcp-telegram` v1.27+ release notes + commits (Master/Client IPC introduction)
- Phase 3.2 implementation план — внутренние maintainer-заметки (не в публичном репо)
