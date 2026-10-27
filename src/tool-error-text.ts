/**
 * Plain-language tool-result text for raw GramJS errors. The log keeps the raw message;
 * only what the model reads changes (directory review rule 2 allows error-text changes).
 *
 * Seen on prod 2026-10-27: one agent hit the same unreachable channels ~400 times a day.
 * The raw "Could not find the input entity ... read docs.telethon.dev" gave it nothing to
 * act on, so it kept repeating the call.
 */

const UNRESOLVED_PEER = /Could not find the input entity for \{"\w+":"?(-?\d+)"?,"className":"(Peer\w+)"\}/;

const PEER_KIND: Record<string, string> = {
  PeerChannel: "channel",
  PeerChat: "group",
  PeerUser: "user",
};

/** Text returned to the client for a failed tool call whose error message is `message`. */
export function toolErrorText(message: string): string {
  const peer = UNRESOLVED_PEER.exec(message);
  if (peer) {
    const kind = PEER_KIND[peer[2] ?? ""] ?? "chat";
    return (
      `Error: Telegram could not resolve ${kind} ${peer[1]} for this account. ` +
      "Usually the account is not a member (it left, was removed, or the chat is private) or the ID is wrong. " +
      "Repeating the same ID will fail the same way; if the account is a member, find the chat by name with " +
      "telegram-search-chats or use its @username."
    );
  }
  return `Error: ${message}`;
}
