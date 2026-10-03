# Private media downloads

`telegram-download-media` can prepare voice notes, audio, videos, documents and
original images for download. It never creates a public sharing link. The same
MCP tool handles preparation and chunk retrieval, so a host does not need to
extract an OAuth token from its credential store or put it in the model context.

## Flow for an assistant / MCP host

1. Call `telegram-download-media` with the original `chatId`, `messageId` and
   `file: true`. This bypasses thumbnails. Without `file`, image previews retain
   their old inline behaviour; non-image results also prepare a private snapshot.
2. Read the result's `structuredContent` (or parse its text JSON):

   ```json
   {
     "downloadId": "dl_<32 hex characters>",
     "fileName": "media-123.ogg",
     "mimeType": "audio/ogg",
     "size": 79872,
     "sha256": "<SHA-256 hex>",
     "expiresAt": "<ISO-8601 UTC>",
     "chatId": "<original chat>",
     "messageId": 123,
     "url": "https://<issuer>/my/download/dl_<32 hex characters>",
     "chunkBytes": 65536
   }
   ```

3. To save locally, repeat **the same tool**, `chatId` and `messageId`, adding
   `downloadId` and `offset: 0`. This returns up to 64 KiB of file bytes as base64:

   ```json
   {
     "downloadId": "dl_<32 hex characters>",
     "offset": 0,
     "nextOffset": 65536,
     "eof": false,
     "base64": "<base64 bytes>"
   }
   ```

4. In host code, decode and write the bytes at `offset`, then continue at
   `nextOffset` until `eof`. **Do not print the base64 or pass all chunks back
   through the model conversation.** A scripting/tool orchestration host can
   receive the results, write them, and expose only progress and the final path.
5. Verify the final size and SHA-256 against the preparation result. Only then
   rename a partial file to its final destination or hand it to an audio decoder.
   Select a safe local destination yourself: `fileName` is sanitized but still
   remote-controlled. Do not overwrite existing files or execute downloaded data.

Chunk reads never call Telegram again and do not require an active MTProto
connection. Retrying the same offset returns the same bytes while the snapshot
is valid: write at the offset, not append blindly. Switching active Telegram
accounts does not relabel the snapshot or download the same message ID from the
new account. Removing the source account invalidates the snapshot.

The original required arguments, tool name, title and annotations remain
unchanged; `file`, `downloadId` and `offset` are optional additions. No new tool
is introduced while the connector catalogue is under directory review.

### Recovery

- `download_unavailable` / MCP error: the snapshot expired, was removed, belonged
  to someone else, or was lost during a restart/rolling update. Prepare the
  original message again, reset the offset, and verify the **new** hash and size.
  Do not mix bytes from two snapshots; a Telegram message may have been edited.
- Busy/quota error: no new file is fetched. Wait for the current download or
  expiry; do not retry in a tight loop.
- A download over 8 MiB is rejected. This first version targets voice notes and
  small files, not arbitrary-size video archives.
- A host without scripting/binary storage can show the authenticated browser
  link. It cannot promise to save a local file itself.

## Flow for a person

The assistant shows `url`. Open it in a browser signed into **the same owner
account** on this server (`tg_sid` session). The browser downloads an attachment.
If not signed in, a browser request gets a sign-in link; sign in and reopen the
original URL before it expires. The link does not silently authorize a new MCP
client and does not transfer authority to anyone it is forwarded to.

Programmatic HTTP clients may use a valid OAuth Bearer in the **Authorization
header**, never in a URL. Invalid or malformed Authorization is a hard 401 even
if a valid browser cookie is also present. Revoked/expired tokens cannot read the
file. An authenticated stranger, missing file and expired file all receive 404.

`HEAD` checks metadata without consuming the snapshot. `GET` can be retried until
expiry; HTTP Range is not implemented (GET returns the complete attachment).
Offset-based MCP reads are the resumable path. Authentication/expiry are checked
when a request starts; a response already accepted may finish after the deadline.

## Security and resource limits

- Download IDs and URLs are opaque **selectors, not credentials**. Both paths
  check the authenticated owner, fixed expiry, and continuing ownership of the
  source Telegram identity on every read. A random `user_sessions.attachment_id`
  distinguishes primary removal/reconnection even within the same second; secondary
  snapshots also bind to that primary attachment and their AUTOINCREMENT account ID.
  Routine session-string saves keep the attachment stable. The MCP transport also checks that a
  reused `mcp-session-id` belongs to the currently authenticated owner.
- Snapshot bytes live **only in process memory**, not SQLite, backups or `/tmp`.
  They are purged on access and every minute. A restart deliberately invalidates
  all snapshots. RAM is not secure erasure or protection against host compromise,
  swap or crash dumps: the usual self-hosting threat model still applies.
- Fixed TTL: 15 minutes after successful preparation; reads never extend it.
- Max file: 8 MiB; per owner: 32 MiB / 8 snapshots; process: 128 MiB / 128
  snapshots. Reservations conservatively account for a whole 8 MiB file before
  network IO. At most one preparation per owner and four per process are pending.
- The bounded core API rejects oversized document metadata before fetching the
  original, checks progress during native download, and checks the final buffer
  for cached thumbnails. GramJS reports progress after each native chunk, so
  transient allocation can overshoot the file cap by one chunk (up to 512 KiB),
  plus buffering overhead. These are storage caps, not exact process RSS caps.
- Cancellation is cooperative (60-second signal): it cannot immediately cancel
  a hung native MTProto request. The outer tool deadline still bounds the wait.
  A pending reservation stays held until actual work settles, preventing orphan
  IO from escaping the concurrency cap; permanently hung slots may require a
  process restart. Late/aborted work never publishes a snapshot.
- No public storage/CDN, secret URL token, or OAuth token in tool results. Audio
  bytes and filenames are not logged. The download route has a stable metric
  template and uses the existing upload HTTP rate limiter; MCP reads use the
  existing MCP request/usage limits.
- HTTP sends `application/octet-stream`, attachment disposition, `nosniff`,
  `private, no-store`, `no-referrer`, and a sandbox CSP, including through global
  middleware. File names lose paths, controls and bidi overrides and are encoded
  for Content-Disposition. Arbitrary HTML/SVG never renders on the OAuth origin.
  Cross-origin credentialed CORS is not enabled.

## Deployment dependency

Release the core implementing `TelegramService.downloadMediaBounded` **first**,
then update the cloud dependency and deploy cloud. An older core fails closed
before the media fetch rather than silently ignoring an unknown `maxBytes`
option. Until that release train runs, this feature is not live.

Snapshots are process-local, matching the current single-process deployment.
Horizontal replication without a shared authenticated snapshot store or routing
affinity is not supported. During rolling replacement a stale link can return
404: the recovery flow above is intentional, not a durable-file guarantee.
