import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatMarkAsReadResult, formatMediaSuffix, renderMessage } from "../tools/helpers.js";

describe("message media suffix during the review freeze", () => {
  it("keeps photo and document suffixes as before", () => {
    assert.equal(formatMediaSuffix({ type: "photo" }), " [photo]");
    assert.equal(formatMediaSuffix({ type: "document", fileName: "a.pdf" }), " [document: a.pdf]");
    assert.equal(formatMediaSuffix(undefined), "");
  });

  it("hides link previews so read-messages output stays as reviewed", () => {
    const line = renderMessage({
      id: 1,
      date: "d",
      sender: "s",
      text: "https://example.com",
      media: { type: "webpage" },
    });

    assert.equal(line, "[#1] [d] s: https://example.com");
  });
});

describe("telegram-mark-as-read reply", () => {
  it("is unchanged for ordinary chats", () => {
    assert.equal(formatMarkAsReadResult("@chat", {}), "Marked @chat as read");
  });

  it("reports topics in forums", () => {
    assert.equal(
      formatMarkAsReadResult("-1001", { topicsMarked: 3, topicsRemaining: 2, topicError: "Rate limit: x" }),
      "Marked -1001 as read (3 unread topics marked). Stopped early: Rate limit: x. 2 more unread topics left, call again to mark them",
    );
    assert.equal(
      formatMarkAsReadResult("-1001", {
        topicsMarked: 0,
        topicsFailed: 1,
        topicError: "TOPIC_DELETED",
        topicsNotChecked: true,
      }),
      "Marked -1001 as read (0 unread topics marked). 1 topics could not be marked: TOPIC_DELETED. The forum has more topics than one call checks; call again to continue with the rest",
    );
  });
});
