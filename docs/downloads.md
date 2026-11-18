# Private media downloads

`telegram-download-media` with `file: true` returns a download ticket for the
original file: voice notes, audio, video, documents and full-size images. The
server never stores the file. Every download reads it from Telegram while the
bytes go to the client, so the size limit is Telegram's own (up to 4000 MiB).
There is no permanent public link: `url` needs the owner's sign-in, and
`oneTimeUrl` is a short-lived bearer link (see below).

Without `file`, images come back as a small inline thumbnail (`full: true`
returns the full image inline, up to about 950 KB).

## Flow for an assistant / MCP host

1. Call `telegram-download-media` with the original `chatId`, `messageId` and
   `file: true`. The result (`structuredContent`, or the text JSON) is a ticket:

   ```json
   {
     "downloadId": "dl_<32 hex characters>",
     "fileName": "report.final.pdf",
     "safeFileName": "tg-123-report_final-tg.pdf",
     "mimeType": "application/pdf",
     "size": 79872,
     "url": "https://<issuer>/my/download/dl_<32 hex characters>",
     "oneTimeUrl": "https://<issuer>/d/<token>",
     "linkExpiresAt": "<ISO-8601 UTC, 5 minutes>",
     "expiresAt": "<ISO-8601 UTC, 15 minutes>",
     "chatId": "<original chat>",
     "messageId": 123,
     "chunkBytes": 65536
   }
   ```

2. Fetch `oneTimeUrl` right away, into a folder of its own, under
   `safeFileName`:

   ```sh
   curl -fsS --create-dirs -o 'telegram-downloads/<safeFileName>' '<oneTimeUrl>'
   ```

   The link needs no sign-in: anyone who has it can use it, once, until
   `linkExpiresAt` (5 minutes, but never past the ticket's `expiresAt`).
   Asking again for the same message from the same account while the ticket
   is live and the file is unchanged returns the same `downloadId` with a
   fresh `oneTimeUrl`; the previous link stops working.
3. Check the received byte count against `size`. There is no hash: the server
   does not hold the file, so it cannot hash it in advance.
4. `fileName` is the name from the chat, chosen by whoever sent the file. Show
   it to the user, but never put it into a shell command or path.
   `safeFileName` is `tg-<messageId>-<name>-tg.<ext>` (or `tg-<messageId>.<ext>`
   when the name has other characters) in letters, digits, `_`, `-` and one
   `.`, so it is never a dotfile, an option or a file a tool would pick up by
   name.

### Pulling chunks through MCP

A host without HTTP access can repeat **the same tool** with the same `chatId`
and `messageId`, adding `downloadId` and `offset` (0, then `nextOffset`;
multiples of 65536). Each response holds up to 64 KiB as base64 plus
`nextOffset` and `eof`. Each chunk is read from Telegram at that moment.
Write at the offset rather than appending blindly, and **keep the base64 out
of the model conversation**.

### Recovery

Errors start with a code, for example `[DOWNLOAD_BUSY retryable retryAfterMs=3000]`
or `[MEDIA_NOT_DOWNLOADABLE]`. HTTP routes return the same code as JSON with
`Retry-After` when it is retryable, as long as the error happens before the
file starts streaming. Once bytes are flowing (status 200 or 206), a failure
can only cut the response short, so check each response against its
`Content-Length` and the finished file against `size`.

- `DOWNLOAD_NOT_FOUND` (404): the ticket or link is unknown, already used,
  expired, belongs to someone else, or was lost in a restart. Ask for the file
  again and start from offset 0.
- `MESSAGE_NOT_FOUND`, `NO_MEDIA`, `MEDIA_CHANGED`, `FILE_REFERENCE_EXPIRED`
  (410): the message or its file changed. Ask again; do not mix bytes from two
  tickets.
- `TRANSFER_BUSY` (HTTP 429) / `DOWNLOAD_BUSY` (MCP), retryable: too many
  transfers at once. Wait for `Retry-After` / `retryAfterMs`; do not retry in
  a tight loop. Extra MCP calls wait in a per-user queue, so fetch media one
  call at a time.
- `TRANSFER_TOO_SLOW`: the client read too slowly (see limits below). Before
  streaming starts this is a 408; during streaming the response is cut short.
- `MEDIA_NOT_DOWNLOADABLE` (422): Telegram has no file to download for this
  media type (for example a contact card or a web document).

## Flow for a person

The assistant shows `url`. Open it in a browser signed into **the same owner
account** on this server (`tg_sid` session). If not signed in, the browser gets
a sign-in link; sign in and reopen the URL before the ticket expires. The link
does not authorize a new MCP client and does not transfer access to anyone it
is forwarded to.

Programmatic clients may call `url` with a valid OAuth Bearer in the
**Authorization header**, never in a URL. An invalid Authorization header is a
hard 401 even if a valid browser cookie is also present. `url` supports `HEAD`
and single HTTP ranges (`206`, or `416` past the end), so an interrupted
download can resume while the ticket lives.

`oneTimeUrl` answers only `GET`; `HEAD` gets `405`, so a link preview cannot
use it up.

## Security and resource limits

- `downloadId` and `url` are selectors, not credentials: every read checks the
  authenticated owner, the fixed expiry, and that the Telegram account the
  ticket was made for is still attached with the same session. `oneTimeUrl`
  carries a 128-bit token that is the only credential: single use, 5 minutes,
  bound to the owner and account. Tokens are stored hashed; the log pipeline
  masks `/d/` and `/u/` paths.
- Nothing is written to disk, SQLite or backups. Tickets live in process
  memory, so a restart invalidates them.
- Ticket limits: 15 minutes, 32 per user, 10,000 per process.
- Transfers are bounded per user, per client IP and per server. A client
  that takes less than 384 KiB per 30 seconds of its own reading time (time
  spent waiting for Telegram does not count; checked from the 30th second) is
  cut off, and no transfer runs longer than 60 minutes.
- Responses use `application/octet-stream`, attachment disposition, `nosniff`
  and `private, no-store`. File names lose paths, controls and bidi overrides.
  Cross-origin credentialed CORS is not enabled.

Tickets are process-local, matching the single-process deployment. During a
rolling update a live link can return 404; the recovery flow above applies.
