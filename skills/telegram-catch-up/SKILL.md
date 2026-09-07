---
name: telegram-catch-up
description: Summarize what the user missed in Telegram — unread chats, who is waiting for a reply, and what needs a decision. Use when the user asks what they missed, wants a digest of their chats, or asks to catch up on a specific chat or time period.
---

Use this skill when the user wants an overview of Telegram activity rather than
one specific message. Typical requests: "what did I miss", "catch me up",
"summarize my unread", "anything important in the work group today".

## Gather

1. Call `telegram-get-unread` first. It returns the dialogs with unread
   counters and is the cheapest entry point.
2. If the user named a chat or a folder, resolve it with
   `telegram-search-chats` and work only inside that scope.
3. Read the actual messages with `telegram-read-messages` for each dialog you
   will report on. Never summarize from the dialog preview alone — the preview
   holds one truncated line.
4. For forum-style groups, list topics with `telegram-list-topics` and read
   each active topic with `telegram-read-topic-messages`. Reporting a forum
   group as a single stream loses the structure the user needs.
5. Stop gathering after 10 dialogs. If more are unread, report the busiest 10
   and state how many were left out.

## Report

Group the output by chat, most active first. For each chat give:

- The chat name and the number of unread messages.
- What happened, in one to three sentences.
- Who is waiting for the user: quote the sender and the request.
- A link from `telegram-get-message-link` for anything that needs an answer or
  a decision, so the user can jump straight there.

Finish with a short "needs your reply" list across all chats. If nothing needs
a reply, say so plainly instead of padding the summary.

## Rules

- Report only messages you actually fetched. Never infer content from a chat
  name, an unread count, or a truncated preview.
- Keep the sender's own words for requests and decisions. Paraphrase the
  surrounding chatter, not the ask.
- Do not call `telegram-mark-as-read`. Reading a digest must not clear the
  user's unread state; do it only if the user asks explicitly.
- Do not send, edit, react, or delete anything in this workflow. If the user
  wants to answer, hand over to the `telegram-reply` skill.
- Media is reported as a placeholder with its type and file name. Call
  `telegram-download-media` only when the user asks for the content, and leave
  `full` unset so the cheap thumbnail is returned first.
- If the account is not connected, `telegram-status` explains how to link it.
  Report that instead of guessing.
