import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Set env vars BEFORE any module that pulls in src/config.ts. Static imports
// hoist past these assignments under ESM, so we use dynamic import() below.
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";

const { createAlertRoutes, formatPayload } = await import("../routes/alerts.js");
type BotClientType = typeof import("../bot/api.js")["BotClient"];
type SendResult = Awaited<ReturnType<InstanceType<BotClientType>["sendMessage"]>>;

class FakeBot {
  public sent: { chatId: number; text: string }[] = [];
  public next: SendResult = { ok: true };

  async sendMessage(chatId: number, text: string): Promise<SendResult> {
    this.sent.push({ chatId, text });
    return this.next;
  }
}

const SECRET = "shared-secret-for-tests";
const CHAT = 12345;

const buildApp = (bot: FakeBot) =>
  createAlertRoutes({
    client: bot as unknown as InstanceType<BotClientType>,
    webhookSecret: SECRET,
    alertChatId: CHAT,
  });

const post = async (app: ReturnType<typeof buildApp>, body: unknown, headers: Record<string, string> = {}) =>
  await app.request("/alerts/signoz", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("formatPayload", () => {
  it("renders firing alert with summary, labels, and generatorURL", () => {
    const out = formatPayload({
      status: "firing",
      alerts: [
        {
          status: "firing",
          labels: { alertname: "Disk usage above 85 percent", "host.name": "am.vpn", severity: "warning" },
          annotations: { summary: "Disk fills up — investigate before runner crashes again." },
          generatorURL: "https://signoz.api-app.org/alerts/edit?ruleId=019df2ec",
        },
      ],
    });
    assert.match(out, /^🔥 FIRING: Disk usage above 85 percent$/m);
    assert.match(out, /Disk fills up — investigate before runner crashes again\./);
    assert.match(out, /host\.name=am\.vpn/);
    assert.match(out, /severity=warning/);
    assert.match(out, /https:\/\/signoz\.api-app\.org\/alerts\/edit\?ruleId=019df2ec/);
  });

  it("renders resolved alert with checkmark prefix", () => {
    const out = formatPayload({
      alerts: [{ status: "resolved", labels: { alertname: "Test" }, annotations: {} }],
    });
    assert.match(out, /^✅ RESOLVED: Test$/m);
  });

  it("falls back when alerts array empty", () => {
    const out = formatPayload({ status: "firing", alerts: [] });
    assert.equal(out, "SigNoz webhook received with no alerts (status=firing)");
  });

  it("rejects non-http generatorURL (no anchor leak)", () => {
    const out = formatPayload({
      alerts: [{ labels: { alertname: "X" }, generatorURL: "javascript:alert(1)" }],
    });
    assert.doesNotMatch(out, /javascript:/);
  });

  it("truncates output to 4096 chars (Telegram limit)", () => {
    const giant = "x".repeat(5000);
    const out = formatPayload({
      alerts: [{ labels: { alertname: "Big" }, annotations: { summary: giant } }],
    });
    assert.equal(out.length, 4096);
    assert.equal(out.endsWith("…"), true);
  });

  it("ignores non-string annotation/label values without crashing", () => {
    // SigNoz payloads come from the wire — exercise runtime garbage that the
    // type signature `Record<string, unknown>` already permits but the
    // formatter must defend against.
    const out = formatPayload({
      alerts: [
        {
          labels: { alertname: "X", "host.name": 42 },
          annotations: { summary: { nested: true } },
        },
      ],
    });
    assert.match(out, /🔥 FIRING: X/);
    assert.doesNotMatch(out, /42/);
  });

  it("joins multiple alerts with blank line", () => {
    const out = formatPayload({
      alerts: [
        { status: "firing", labels: { alertname: "A" }, annotations: {} },
        { status: "resolved", labels: { alertname: "B" }, annotations: {} },
      ],
    });
    assert.match(out, /A\n\n.*B/s);
  });
});

describe("POST /alerts/signoz", () => {
  it("rejects missing secret with 401 and does not call bot", async () => {
    const bot = new FakeBot();
    const res = await post(buildApp(bot), { status: "firing", alerts: [] });
    assert.equal(res.status, 401);
    assert.equal(bot.sent.length, 0);
  });

  it("rejects wrong secret with 401", async () => {
    const bot = new FakeBot();
    const res = await post(buildApp(bot), { alerts: [] }, { "X-Webhook-Secret": "wrong" });
    assert.equal(res.status, 401);
    assert.equal(bot.sent.length, 0);
  });

  it("rejects wrong-length secret without timing leak (length mismatch path)", async () => {
    const bot = new FakeBot();
    const res = await post(buildApp(bot), { alerts: [] }, { "X-Webhook-Secret": "x" });
    assert.equal(res.status, 401);
    assert.equal(bot.sent.length, 0);
  });

  it("400s on malformed JSON without calling bot", async () => {
    const bot = new FakeBot();
    const res = await post(buildApp(bot), "{not json", { "X-Webhook-Secret": SECRET });
    assert.equal(res.status, 400);
    assert.equal(bot.sent.length, 0);
  });

  it("posts a formatted message to alertChatId on valid request", async () => {
    const bot = new FakeBot();
    const res = await post(
      buildApp(bot),
      {
        status: "firing",
        alerts: [
          { status: "firing", labels: { alertname: "Disk above 85%" }, annotations: { summary: "Investigate." } },
        ],
      },
      { "X-Webhook-Secret": SECRET },
    );
    assert.equal(res.status, 200);
    assert.equal(bot.sent.length, 1);
    assert.equal(bot.sent[0].chatId, CHAT);
    assert.match(bot.sent[0].text, /🔥 FIRING: Disk above 85%/);
    assert.match(bot.sent[0].text, /Investigate\./);
  });

  it("accepts HTTP Basic auth (alertmanager webhook_password path)", async () => {
    const bot = new FakeBot();
    const basic = Buffer.from(`signoz:${SECRET}`).toString("base64");
    const res = await post(
      buildApp(bot),
      { alerts: [{ labels: { alertname: "B" } }] },
      { Authorization: `Basic ${basic}` },
    );
    assert.equal(res.status, 200);
    assert.equal(bot.sent.length, 1);
  });

  it("rejects Basic auth with wrong password", async () => {
    const bot = new FakeBot();
    const basic = Buffer.from("signoz:nope").toString("base64");
    const res = await post(buildApp(bot), { alerts: [] }, { Authorization: `Basic ${basic}` });
    assert.equal(res.status, 401);
    assert.equal(bot.sent.length, 0);
  });

  it("rejects malformed Authorization header", async () => {
    const bot = new FakeBot();
    const res = await post(buildApp(bot), { alerts: [] }, { Authorization: "Bearer something" });
    assert.equal(res.status, 401);
    assert.equal(bot.sent.length, 0);
  });

  it("returns 500 when bot send fails (so SigNoz retries)", async () => {
    const bot = new FakeBot();
    bot.next = { ok: false, errorCode: 502, description: "Bad Gateway" };
    const res = await post(buildApp(bot), { alerts: [{ labels: { alertname: "X" } }] }, { "X-Webhook-Secret": SECRET });
    assert.equal(res.status, 500);
    assert.equal(bot.sent.length, 1);
  });
});
