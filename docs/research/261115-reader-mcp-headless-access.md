---
created: 2026-11-15
---

# Reader MCP: headless access and explicit URL capture

## Finding and authority

A narrow headless MCP can search and return **permitted projections**, not raw Reader notes. Reader's existing syntax is not an authorship or disclosure classifier. Explicit URL capture can avoid modifying existing notes, but neither headless nor in-app local guards provide cross-device transactions or remote dirty-editor certainty. These are feasibility findings, not a schema or architecture choice. [1–8]

Research for [#100](https://github.com/wannli/obsidian-reader/issues/100), under [map #98](https://github.com/wannli/obsidian-reader/issues/98). Source authority: isolated `research/reader-mcp-headless-access`, Reader `bb5b92acce82398349369a20088a656da45777da`. Only this report changes. Map/ticket bodies and all comments were read, along with README, core model/document/main and the acquisition/store/guard code cited below. [1,3]

W permits explicitly enabled public-source/public-text-highlight assistance; private writing, questions, connections and activity remain excluded. Uncertainty fails closed. Private-derived AI output stays private; source/human/AI authorship must remain distinct. Processing does not authorize publishing or external actions. Reader's charter excludes private excerpts initially because later filtering cannot retract a persistent chat transcript. Selected-source versus collection-wide authority is still a human choice. [1,2]

W's chosen allocation makes bwd a trusted personal endpoint using Headless Sync and direct files, **not desktop Obsidian/CLI**. This does not extend trust to MCP callers or authorize real-vault access. Reader investigates that allocation without importing W's model or choosing Reader's final adapter. [1; W host resolution below]

## What existing Reader files establish—and do not

| Evidence | Consequence for remote find/read/compare |
| --- | --- |
| `articleInfo`/`subscription` require exact `type: article`/`type: feed`; case-insensitive Templates and .trash path components are excluded at any depth. | Discovery eligibility, not disclosure permission. Local articles can have no URL; typed articles outside queues remain readable. [4] |
| Catalog queues derive from configured nonoverlapping folders, not YAML status. Title is authored `title` or filename fallback; topics/feed/error/dog-ear/date are indexed too. | Never serialize `ArticleInfo` wholesale. Folders, queue, type, topic membership and valid URLs grant no disclosure. [1,4,5] |
| `readDocument` requires supported YAML, unique keys, bounded aliases; `requireArticle` checks fresh exact type. Unknown properties/comments/body are preserved by normal updates. | Metadata is only a shortlist; reparse current bytes. Arbitrary private fields, comments and prose remain possible inside an article. [6] |
| Highlights are ordinary `==...==`, optional host citations `(※ [[...]] )`, native links and paragraph IDs. Parser helpers map syntax to source offsets. | They identify passages and editing boundaries, not publisher authorship. A user can highlight their own private prose in an article. [7] |
| Typed host notes contain quotation snapshots grouped by article title, precise vault citation and collection-date link; edits to the source do not prune snapshots. | Do not crawl hosts/backlinks or expose host names, grouping, dates, origins or surrounding private writing as source context. [3,8] |
| Acquisition ownership is session-local capture receipts or exact current feed-excerpt equality; new notes persist no acquisition proof. | A URL, filename, feed link, clean-looking prose or absence of annotations cannot establish that today's body came from a public publisher. [6,9,10] |

`hasAnnotations` protects highlights/native relationships during mutation. It is **not** a privacy detector: private unmarked paragraphs and private titles need no special syntax. Conversely publisher code and syntax may be protected for editing reasons. `blockProjection`, `inlineProjection` and topic-filter text include visible labels/prose; removing markup or comments cannot turn their output into an authorized public projection. [7,11]

## Projection options to bring to the human decision

These are alternatives, not selected contracts. All require enablement, caller authorization and a trusted disclosure boundary; no caller-supplied flag or tool annotation can grant permission. [1,2]

1. **Approved public-source material, detached from saved prose.** Find against a bounded permitted source corpus and return source-owned title/text/URL plus approved article-level return context. Synthetic publisher fixtures can establish this provenance for a proof. Real-source acquisition and durable provenance remain separate approvals. This avoids claiming the saved body is public, but may not reproduce its saved version. [1,6,9]
2. **Proven source spans from a saved article.** Admit only text whose public-source provenance and current-byte association can be established under approved rules. Exact text comparison to an independently permitted source can support a match, but cannot prove surrounding prose, title, URL parameters or relationships are public. Changed/ambiguous spans are excluded; no heuristic subtraction of “annotations.” Version drift may reduce useful coverage. [2,6,7,10]
3. **Public-text highlights as optional context.** W allows them within enabled scope, but Reader syntax alone cannot distinguish public quotations from highlighted private writing. Establish permitted source text first, then validate quotation membership/current association and omit hosts, comments and private context. If that cannot be established, omit the highlight rather than downgrade the rule. [2,7,8]
4. **In-app projection adapter.** Can supply local Reader snapshots, parser behavior and local lifecycle checks without headless reimplementation. It still needs the same provenance/permission policy; having an editor nearby does not classify authorship. Requires a running app on an appropriate device, so it cannot silently become a desktop dependency on bwd. [2,6,12,13]

“Compare” can operate on these permitted source projections with publisher citations; it does not need private topics or inferred connections. Distinguish source quotations from model synthesis and suggestions from Wannes's conclusions. Existing Reader has no general-purpose permission/provenance interface for this; fixture labels are not production approval. [1,2,4–11]

## Leak paths and read-side effects

- Filter **before search/ranking/snippet generation**, not only before returning bodies. Private query matches, result ordering/counts, suggestions and “already saved” responses can reveal excluded material. Reader's catalog search uses title/URL; topic filtering additionally uses topics, aliases, body and wiki labels. None is a disclosure-safe search API. [1,5,11]
- Allowlist every output surface: titles, snippets, text, URLs/query parameters, link labels, vault/file paths, errors, structured/text response envelopes, resources, logs and diagnostics. Publisher URLs can themselves contain sensitive identifiers; HTTP(S) is not a publicness test. Avoid unauthorized existence or omission details. [1,4,12]
- Article-level vault-aware return links meet the charter, but can disclose vault names, private filenames and paths. Their permitted representation remains a human decision; publisher citations and return links have different disclosure requirements. Build the approved return link without opening the article. [1,3,12]
- `ArticleStore.read` parses a snapshot and checks file identity without persisting reading state. Use a separate read-only path, not UI commands. `ReaderView.openArticle` moves dog-ear and invokes acquisition; paging can save bookmarks. `main` startup/change/tick paths can recover captures, promote annotated Feed articles and expire notes. Do not instantiate the plugin runtime as a headless “read API.” [9,12–14]
- Reads should be bounded/cancellable and recheck permission, source identity/bytes and scope generation before delivery; a revoked grant or changed file invalidates pending projection work. Revalidate cursors/return locators too. This extends Reader's stale-work discipline to disclosure; Reader currently has no MCP permission generation. [1,9,13]
- Imported material stays untrusted data, never instructions to call capture or widen scope. HTML sanitization and processor checks do not prevent prompt injection, disclose safely, or authorize external actions. Do not fetch remote images/embeds merely to answer a read. [1,15]

## Headless Sync and API facts refreshed on 2026-11-15

Official docs describe Headless as **open beta**, standalone, Node.js 22+, with an active Sync subscription required for Sync. One-shot `ob sync` and continuous watching are documented. E2EE protects transport/remote storage; a trusted endpoint's readable local files still need enforcement before disclosure. No installation, account or entitlement was checked here. [16,17]

`sync-config` exposes bidirectional/pull-only/mirror-remote modes, merge/conflict strategies and configuration/folder selection. Do not choose or change these here. Official guidance says back up first and do not use desktop Sync and Headless Sync on the same device. Pull-only does not upload captures; mirror-remote reverts local changes. [16,17]

The documented Headless surface is service synchronization, not Reader plugins, an editor-buffer API or `Vault.process`. Desktop CLI controls the running app and may launch it. Obsidian's public app API documents disk `Vault.read`, display-oriented `cachedRead`, and atomically read/modify/save `Vault.process`; these are app APIs, not a headless transaction service. No documented command here certifies all remote editors clean or grants distributed exclusion. [16–19]

Sync conflict documentation describes Markdown merging or conflict copies, not schema-aware transactions. Offline simultaneous edits can conflict; newly created same-name notes can also lose a local version. A successful sync/status check is not evidence of an unsaved remote buffer, global URL uniqueness or semantic YAML/highlight correctness. Headless-specific crash/recovery behavior needs a synthetic proof, not extrapolation from desktop success. [16,20]

## Existing write guarantees and headless gaps

| Boundary | Reader implementation and headless implication |
| --- | --- |
| Current bytes and identity | Store commits compare full current raw bytes with the snapshot inside native process; validate expected path and the same live file object; reject excluded paths. A path, mtime/size or hash alone is not replacement-file identity. A direct-file adapter needs equivalent local race/identity protection, not a read-then-unconditional-write translation. [6,9,12] |
| Dirty editor | `ObsidianVault.assertWritable` blocks source/live-preview, missing/uncertain editor state and multiple Markdown views; a single preview buffer must equal fresh durable bytes at commit. Headless has no such local workspace. Neither adapter sees an unsaved editor on another device. Disk equality on bwd is insufficient to authorize overwriting existing synced notes. [12,18–20] |
| Lifetime/settings | Per-file writes and capture creation are serialized within one store. Folder revisions invalidate queued transitions; retiring runtime aborts work, disposes the store and drains dispatched host writes before replacement. Headless needs corresponding lifetime/settings/permission invalidation; a process-local mutex cannot coordinate other devices. [9,13] |
| Cancellation/native work | Native I/O already dispatched cannot be recalled. Network has two occupied slots, bounded pending work and timeouts; timed-out uncancellable requests keep slots until settlement. Report actual committed progress; never imply cancellation rolled back a note. [10,12,13,15] |
| Authored content | Ordinary acquisition accepts empty bodies, a standalone matching Markdown source-link placeholder, or exact proven feed excerpt, with annotation/current-byte checks. Explicit confirmed replacement is separate. No MCP “retry” should bypass these protections or expose replacement/redownload. [6,9,10] |

An in-app adapter strengthens **same-device** buffer and file-object checks and reuses link-aware moves. It does not solve remote editors, cross-file atomicity or Sync order. If existing-note safety cannot be established, fail without mutation; do not substitute “sync just finished” or silence for a clean-editor guarantee. [9,12,19,20]

## Explicit URL capture: safe candidates, not an implementation choice

Current capture normalizes HTTP(S) URLs using `URL`, rejects embedded credentials and strips fragments. It does not strip tracking queries, equate HTTP/HTTPS, follow canonical URLs for identity, or provide distributed deduplication. Under its serialized create lane, it verifies indexed candidates against fresh type/URL bytes, repairs stale hits, and checks again at guarded create boundaries. Portable filename collision checks include folders and case/NFC aliases. This relies on a complete relevant local index; unsynced remote captures remain invisible. [4,5,9,12]

| Candidate | Benefit | Limit / prerequisite |
| --- | --- | --- |
| Defer capture / read-only initial proof | No headless mutation or dirty-editor downgrade. | Does not satisfy eventual end-to-end capture acceptance; explicit pending/unavailable feedback must not claim success. [1] |
| Create-only URL placeholder in Inbox; existing match is a no-op | Reuses Reader's ordinary article format, preserves existing content, avoids fetch-then-overwrite. Reader can acquire eligible placeholders later while active. | Approve concrete serialization/destination first. Need exclusive no-clobber creation, portable name checks, current settings/generation and dedup checks. Remote duplicates/name collisions remain possible; existing-match response must pass disclosure filtering. [3,6,9,12,20] |
| Acquire public URL first, then create-only new article | Can save readable content in one new-note write without later replacing a saved body. | Requires separately authorized network acquisition, publisher provenance and server-side egress/SSRF controls; validate DNS/redirect targets, private/loopback/link-local destinations, size/time limits and credentials. Existing-match must not overwrite. Reader's DOM/Obsidian extraction stack is not directly a Node service. [9,10,15] |
| Execute explicit capture through an in-app store adapter | Reuses create guards, metadata and acquisition safety where the app runs. | Requires availability/authenticated handoff and approved cross-process contract. Invoke capture separately from `plugin.capture()`/openArticle to avoid navigation, dog-ear and implicit fetch effects. Still no global dedup or remote-buffer guarantee. [9,12–14] |

`webUrl` only validates URL shape; it is **not** an SSRF defense or public-host verifier. Redirect/DNS authorization for a server is not established by existing `requestUrl`. Do not allow caller titles, bodies, arbitrary paths or generic file writes through a URL-only operation. Explicit capture permission does not authorize feeds, retrospective collection scans, retries that replace bodies, moves, deletes or authored edits. [1,4,9,10,15]

No option establishes exactly-once capture across retries, processes or devices. A timeout after dispatch can mean a note exists; reread/reconcile under guarded rules and report uncertainty. Durable request receipts/identities, if wanted, need human approval; do not add IDs, sidecars or acquisition metadata incidentally. [1,3,9,12]

## Decision-enabling proof and remaining gates

After scope/format approval, a small fixture-only proof could demonstrate permitted find/read/compare plus one chosen capture behavior without Sync, credentials, service provisioning or publisher acquisition. Treat fixtures as disposable tests, not production schemas. Include these denial/race cases: [1]

- Adjacent public quote/private reflection, highlighted private prose, private title/filename/topic, unknown YAML, comments, host quotations, private URLs and a local authored article carrying a public URL.
- Search/count/order/error/log/link leakage; malicious instructions in source text; no network or reading-state changes on find/read/compare.
- Permission revocation during reads; current-byte change, delete/recreate at same path, rename away/back, changed settings, cancelled queued jobs and generation retirement.
- Stale URL index, duplicate requests, name aliases/collisions, capture timeout after creation, and unavailable/unknown remote-editor safety. Existing content must remain unchanged.

Live synthetic Sync/recovery is a **separate authorized investigation**: offline competing edits/captures, dirty editors, conflict copies, restart/retry, arrival order and backup/recovery. Production acceptance additionally needs authenticated caller isolation, approved enablement/provenance/locator contracts, leak tests over every envelope, secure ChatGPT connectivity and the charter's desktop journey. Neither fixture tests nor a local MCP response proves these. [1,16–20]

Human decisions remain: source selection authority; acceptable provenance and changed-source behavior; permitted metadata/return links; capture candidate and duplicate/uncertainty feedback; adapter allocation and any durable representation. This report chooses none of them. Confidence is high in the cited source/API inventory, conditional in feasibility, and unverified for runtime, Sync, deployment and real devices.

## Sources

Reader links below pin the inspected revision. Official documents were read through first-party GitHub content APIs, not by running Obsidian or Headless. No tests/build, fixture prototype, native runtime, vault access, external article acquisition, Sync configuration or service was performed.

1. https://github.com/wannli/obsidian-reader/issues/98
2. https://github.com/wannli/W/issues/66#issuecomment-6836843205
3. https://github.com/wannli/obsidian-reader/blob/bb5b92acce82398349369a20088a656da45777da/README.md
4. https://github.com/wannli/obsidian-reader/blob/bb5b92acce82398349369a20088a656da45777da/src/core/model.ts
5. https://github.com/wannli/obsidian-reader/blob/bb5b92acce82398349369a20088a656da45777da/src/core/catalog.ts
6. https://github.com/wannli/obsidian-reader/blob/bb5b92acce82398349369a20088a656da45777da/src/core/document.ts
7. https://github.com/wannli/obsidian-reader/blob/bb5b92acce82398349369a20088a656da45777da/src/core/annotations.ts
8. https://github.com/wannli/obsidian-reader/blob/bb5b92acce82398349369a20088a656da45777da/src/core/quotation.ts
9. https://github.com/wannli/obsidian-reader/blob/bb5b92acce82398349369a20088a656da45777da/src/core/store.ts
10. https://github.com/wannli/obsidian-reader/blob/bb5b92acce82398349369a20088a656da45777da/src/host/ingestion.ts
11. https://github.com/wannli/obsidian-reader/blob/bb5b92acce82398349369a20088a656da45777da/src/core/topic-filter.ts
12. https://github.com/wannli/obsidian-reader/blob/bb5b92acce82398349369a20088a656da45777da/src/host/vault.ts
13. https://github.com/wannli/obsidian-reader/blob/bb5b92acce82398349369a20088a656da45777da/src/host/folder-runtime.ts
14. https://github.com/wannli/obsidian-reader/blob/bb5b92acce82398349369a20088a656da45777da/src/reader/view.ts#L1040-L1090
15. https://github.com/wannli/obsidian-reader/tree/bb5b92acce82398349369a20088a656da45777da/src/content
16. https://help.obsidian.md/sync/headless
17. https://help.obsidian.md/headless
18. https://help.obsidian.md/cli
19. https://github.com/obsidianmd/obsidian-api/blob/879c936660fcc45c90ee28ea6b4ef7068006477c/obsidian.d.ts#L10279-L10388
20. https://help.obsidian.md/sync/troubleshoot#Conflict%20resolution

Additional inspected evidence: [W host resolution](https://github.com/wannli/W/issues/72#issuecomment-6878459386); [Reader main](https://github.com/wannli/obsidian-reader/blob/bb5b92acce82398349369a20088a656da45777da/src/main.ts); [projection](https://github.com/wannli/obsidian-reader/blob/bb5b92acce82398349369a20088a656da45777da/src/core/projection.ts); [Markdown parser](https://github.com/wannli/obsidian-reader/blob/bb5b92acce82398349369a20088a656da45777da/src/core/markdown.ts); [network](https://github.com/wannli/obsidian-reader/blob/bb5b92acce82398349369a20088a656da45777da/src/host/network.ts); [Headless README](https://github.com/obsidianmd/obsidian-headless#readme). Official Help snapshot: [`0a01159`](https://github.com/obsidianmd/obsidian-help/tree/0a01159d5b613a8afc55ce02b9c0ea8a0cd44ef1/en), including Headless, Headless Sync, CLI and Sync troubleshooting.
