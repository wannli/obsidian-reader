# Minimal Reader MCP prototype

Run a synthetic-only MCP server on demand, without desktop Obsidian or changes to the Reader plugin.
The server uses stdio and has no HTTP listener or new dependencies.

## Run

From this repository, using its pinned Node runtime:

```sh
mise exec -- npm run mcp -- setup
mise exec -- node scripts/reader-mcp.mjs serve --enable-read --enable-capture
```

Configure a local MCP client's stdio command as `mise`, with these arguments:

```json
["exec", "--", "node", "scripts/reader-mcp.mjs", "serve", "--enable-read", "--enable-capture"]
```

Set the working directory to this checkout's absolute path.
Do not use `npm run` as the client command: npm's banner can corrupt protocol stdout.
Omit either enable flag to withhold that capability. With neither flag, both are disabled.
Flags are operator authorization for that process, not caller-controlled tool arguments.
The local process owner's access to stdin is the trust boundary; this is not OAuth authentication.

Setup creates only `.sandbox/Reader MCP Sandbox`, with an ownership marker and two fictional articles.
It refuses an existing unmarked or mismatched vault. It never installs Reader or enables plugins.
The source allowlist is the small, operator-owned fixture table in `scripts/reader-mcp.mjs`.
Each fixture includes a private canary that must never appear in tool output.
Only the independent synthetic publisher projection is disclosed, never raw note contents.

## Tools

- `search_sources`: query up to 500 characters; at most ten permitted matches with temporary handles and snippets.
- `get_source`: retrieve permitted source text, publisher citation and synthetic article return link.
- `capture_url`: create an empty-body, URL-only article with `status: inbox` in `Reading/Inbox`, without downloading anything. YAML status selects the Reader queue; the folder is only this prototype's capture destination.

Capture accepts only these synthetic URLs, with fragments removed and query parameters preserved:

- `https://example.com/reader-mcp/gardens`
- `https://example.com/reader-mcp/libraries`
- `https://example.com/reader-mcp/capture`

Capture permission is standing authorization. There is no per-URL approval ceremony.
The server cannot establish whether a model call originated in a direct human request.
It accepts no caller-supplied paths, titles, bodies or permission grants.
An existing URL returns generic `Unavailable`, never an existence-revealing duplicate result.
A successful creation returns `Saved`, explicitly stating that text was not downloaded.
An interrupted dispatched creation may return `Uncertain`; cancellation does not delete a note.
New captures do not enter the permitted read corpus automatically.

Source handles are random and process-local. Source bytes and file identity are rechecked before delivery.
Changed or replaced fixture files become unavailable until a new locally authorized session accepts exact fixture bytes.
Reads do not open articles, acquire content, or change bookmarks, dog-ear or reading state.

## Headless Sync

Install Obsidian Headless under the pinned Node runtime first.
An installation under another mise Node version may not be available here.
Authentication, a dedicated synthetic remote vault, and bidirectional Sync configuration are separate operator setup.
Do not connect a personal vault or let desktop Sync and Headless Sync operate on the same device.
Once the dedicated synthetic vault is configured, run one sync explicitly:

```sh
mise exec -- npm run mcp -- sync
```

The wrapper validates ownership and executes `ob sync --path` with this checkout's fixed synthetic vault path.
It never logs in, chooses a remote vault, configures Sync, or starts a continuous watcher.
Headless's own terminal output is separate from MCP stdout; do not copy credentials into reports.
Sync is not a distributed transaction or proof that remote editors are clean.

## Bounds and stopping

The transport serializes work, including capture. It accepts at most eight outstanding requests and a 64 KiB input buffer.
Exceeding those limits revokes the session and closes it after dispatched work settles.
Queries and URLs have schema limits; capture discovery visits at most 500 entries and bounds each file to 100 KB.
Each call has a five-second cooperative budget; queued requests older than five seconds are cancelled.
Native filesystem operations already dispatched may exceed that budget and retain their slot until settlement.
Queued cancellation notifications prevent execution. An already dispatched write cannot be recalled.

Send `SIGUSR1` to revoke both capabilities and invalidate handles without terminating the transport.
Send `SIGTERM` to revoke and close input. EOF drains queued requests, then revokes the session.
Restart with the desired enable flags to grant access again. No authorization state is persisted in notes.
The server emits no payload logs; protocol stdout contains only JSON-RPC responses.

## Validation and limits

```sh
mise exec -- node --test scripts/reader-mcp.test.mjs
mise exec -- npm run check
```

Tests exercise stdio discovery/calls, source projection, canary exclusion, bounds, revocation, ownership,
symlink rejection, changed/replaced sources, private duplicates and create-only captures.
This is a local prototype, not the completed ChatGPT/Sync acceptance journey or a production security boundary.
It does not provide OAuth, HTTP, a tunnel, account provisioning, arbitrary source selection, or real-source provenance.
Public ingress must not be attached to this unauthenticated stdio boundary without a separately validated authenticated adapter.

Only one server process may own this synthetic vault. Checks do not provide hostile-local-process isolation,
remote-editor visibility, cross-process deduplication, or protection against concurrent directory replacement.
Run under a trusted local account, without competing writers during capture tests.
Stop the server before manually removing the prototype directory. Cleanup is explicit, not automatic rollback.
Remote Sync vault and credentials require separate operator revocation/removal.
