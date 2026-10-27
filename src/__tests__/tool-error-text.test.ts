/**
 * Raw GramJS "Could not find the input entity" errors reach the model as an actionable sentence
 * (one agent retried the same unreachable channel ~400 times a day on the raw text).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toolErrorText } from "../tool-error-text.js";

const raw = (id: string, className: string, key = "channelId") =>
  `Could not find the input entity for {"${key}":"${id}","className":"${className}"}.\n         Please read https://docs.telethon.dev/en/stable/concepts/entities.html to find out more details.`;

describe("toolErrorText", () => {
  it("turns an unresolved channel into a plain sentence without the Telethon link", () => {
    const text = toolErrorText(raw("4304313856", "PeerChannel"));
    assert.match(text, /^Error: Telegram could not resolve channel 4304313856 for this account\./);
    assert.match(text, /Repeating the same ID will fail/);
    assert.doesNotMatch(text, /telethon/i);
  });

  it("names groups and users too", () => {
    assert.match(toolErrorText(raw("123", "PeerChat", "chatId")), /resolve group 123 /);
    assert.match(toolErrorText(raw("456", "PeerUser", "userId")), /resolve user 456 /);
  });

  it("leaves every other error as it was", () => {
    assert.equal(toolErrorText("CHAT_WRITE_FORBIDDEN"), "Error: CHAT_WRITE_FORBIDDEN");
    assert.equal(
      toolErrorText('Cannot find chat "-1004304313856". Use a numeric ID'),
      'Error: Cannot find chat "-1004304313856". Use a numeric ID',
    );
  });
});
