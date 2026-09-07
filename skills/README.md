# Plugin skills

Workflow instructions shipped with the ChatGPT plugin listing, not code the
server runs. Each directory holds one skill with a `SKILL.md`; the directory
name must match the `name` in its front matter.

The MCP server exposes tools. These skills tell the model how to combine them:
which tool to call first, when to stop and ask, and what the answer must
contain. `telegram-reply` additionally requires explicit user confirmation of
the recipient and the exact text before anything is sent.

Delivery: zip the skill directories at archive root and upload the archive on
the **Skills** tab of the plugin submission portal.

```sh
cd skills && zip -r -X /tmp/mcp-telegram-skills.zip telegram-* -x '.*' '__MACOSX*'
```

The alternative — serving skills from the MCP server via the draft SEP-2640
`skills/list` extension so they are imported at **Scan Tools** — is not
implemented.
