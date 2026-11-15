---
created: 2026-11-15
---

# Reader outcomes and compatibility baseline

Reader currently supports a Markdown-first save → read → retain → collect workflow inside Obsidian. This is a factual baseline, not a decision about adopting W.

## Evidence and scope

- Investigation: [Establish Reader’s current outcomes and compatibility baseline](https://github.com/wannli/obsidian-reader/issues/96), within [Assess whether W’s thinking belongs in Obsidian Reader](https://github.com/wannli/obsidian-reader/issues/94).
- Inspected published Reader `main`: **`92b5d7507143a52ef949d6d92d852614846bbabf`**, matching the map’s initial reference. All source citations below pin this revision. No W audit was used as current Reader evidence.
- Method: read repository documentation, implementation and selected test assertions in an isolated `/tmp` clone. No tests, builds, native tooling, device checks, installation or vault access were performed.
- Evidence classes: **intent** means current README promises or repository instructions; **implementation** means inspected source; **test evidence** means assertions read, not tests executed or proven passing.
- Documentation gap: this revision contains no root `GLOSSARY.md`, `docs/adr/` or `specs/`, although AGENTS references domain documents. The baseline cannot establish separate ADR/spec approval provenance. AGENTS is the current normative constraint source, not a historical approval transcript. [Guide][guide]
- README describes current source, not necessarily an installed release. Historical sync research is advisory and partly stale: its feed-error popup description differs from current console logging. Prefer current code. [README][readme] [Prior research][prior] [Main][main]

## Intended outcomes and current implementation

### Acquisition and feeds

- **Intent:** save a URL immediately, fetch readable text when online, avoid duplicate manual captures, and keep existing work when a batch is cancelled. Browser-link saving should leave the current article open. [README][readme]
- **Implementation:** HTTP(S) URLs reject embedded credentials and drop fragments. Manual capture deduplicates against existing articles. Native/QuickAdd captures retain filenames and do not inherit that deduplication. Only empty bodies, matching standalone Markdown source links, or currently proven excerpts permit ordinary acquisition; unknown text is protected. [Model][model] [Document][document] [Store][store] [Ingestion][ingestion]
- **Implementation:** manual/browser captures enter Inbox; RSS imports enter Feed. Observed live native `type: article`, `status: inbox` creation can be placed in Inbox. This is not a startup folder-migration sweep. Foreground/online recovery can fetch eligible Inbox/Later placeholders. [Main][main] [Vault][vault] [Store][store]
- **Implementation:** adding a subscription is local-only. Feed imports require explicit refresh; startup, visibility, online and timer events may recover captures or expire articles, but do not poll feeds. Unsubscribing leaves articles intact. [Ingestion][ingestion] [Main][main]
- **Implementation limit:** refresh sorts parsed entries by publication and takes 20 **before** deduplication/age filtering. The parser first limits input to 500 entries. Missing publication dates weaken chronological ordering; this is recent reading, not a complete archive. [Feed parser][feed] [Ingestion][ingestion]
- **Implementation:** explicit Reader deletion records `deleted_urls` in the associated subscription before trashing. Expiry/external deletion do not record suppression. Missing/ambiguous subscription provenance can block deletion; suppression is not globally atomic across devices. [Store][store] [Vault][vault]
- **Recovery boundary:** confirmed “Run Defuddle again” may replace the body, including highlights and links; ordinary Retry cannot overwrite unproven authored content. Extraction rejects restricted/title-only results rather than bypassing access controls. [Document][document] [Extractor][extract] [Main][main]

### Queues and retention

- **Intent and implementation:** four configurable nonoverlapping folders own queue membership: Inbox `Reading/Inbox`, Feed `Reading/Stream`, Later `Reading/Later`, Archive `Reading/Treasury`. Exact `type: article` notes outside them remain readable but unqueued. `Templates` and `.trash` are excluded at any depth. [README][readme] [Model][model] [Queue folders][folders]
- YAML `status` is a persisted mirror, not list authority. Reader actions write YAML first and then relocate; external folder/YAML edits do not repair the other representation. Settings changes do not migrate notes. A failed move can leave updated YAML in the old folder, and reports that partial result. [Store][store] [Queue tests][queue-tests]
- Only a Feed-folder article with fresh explicit `status: feed` can expire. Age is one calendar month from publication, with filename date fallback; unknown age and in-use notes are protected. Fresh bytes and final mutation checks must still authorize deletion. [Model][model] [Store][store] [Status tests][status-tests]
- Reading and saving a bookmark do not retain a Feed article. Reader annotations retain it as Later before committing annotation content; physical relocation follows the annotation write. External annotations/native backlinks can also trigger retention. [Store][store] [Main][main] [Status tests][status-tests]
- Explicit Delete and expiry archive topic-bearing or annotated articles rather than trashing them. Unprotected deletion uses recoverable vault-local Obsidian trash. Failed protection/promotion checks preserve the note. [Store][store] [Vault][vault] [Status tests][status-tests]

### Reading, resume and navigation

- **Intent:** focused lists/articles, topic-or-phrase filtering, explicit Open Markdown, keyboard/touch reading, and saved-position entry across article switches. Filtering includes topic aliases, explicit assignments and case-insensitive whole-word/phrase title/body matches; free text needs no topic note. General search remains native Obsidian search. [README][readme]
- **Implementation:** article entry restores YAML `bookmark`, a bounded text anchor, not a page/completion/history value. A native citation fragment may then reveal its target. Legacy `reading_position` remains inert and preserved. [View][view] [Document][document] [Status tests][status-tests]
- `dog_ear: true` is a separate current-article pointer, moved during successful Reader entry. The shortcut checks marked articles, then newest Inbox. Destination marking precedes old-marker clearing, so interruption/concurrent device opens can leave several markers; there is no globally latest-pointer guarantee. [View][view] [Main][main] [Store][store]
- List opened/highlight indicators derive from bookmarks and Markdown, without persistent extra flags or promotion. Reads are restricted to visible rows with a shared two-read ceiling and stale-result rejection. [Indicators][indicators] [Indicator tests][indicator-tests]
- Article status controls/Delete advance within the original browsing list; command-palette status change stays on the article. Topic filters persist across queues and scope navigation. Keyboard actions guard inputs, menus, dialogs, selections and held keys. [README][readme] [View][view] [Keyboard tests][keyboard-tests]
- Passive native article routing checks durable/editor bytes, file identity, selection and navigation state. Uncertain or dirty editors and explicit Open Markdown remain native rather than being forcibly replaced. [Main][main] [Routing tests][routing-tests]

### Highlights, quotations and typed connections

- **Intent and implementation:** every new hosted highlight needs at least one Fileclass-typed destination. One remembered destination can be inherited; none/several invoke a multiselect picker. Untyped files are excluded; existing content remains readable without Fileclass. [README][readme] [Guide][guide] [Store][store]
- Source highlights use ordinary `==Markdown==`, native destination links and paragraph block anchors. Rich formatting/publisher links are preserved; there is no separate highlight entity database. Paragraph anchors are not article/highlight identity properties. [Hosted contract tests][hosted-tests] [Guide][guide]
- Each host receives a quotation under `## Highlights`, grouped by article heading, with paragraph citation and local collection-date link. Deduplication uses quotation plus paragraph citation; retries preserve the original date. [Quotation source][quotation] [Quotation tests][quotation-tests]
- Quotations are user-owned snapshots: source edits, source-only removal and brief Undo never prune them or reverse retention. Only explicit destination removal may delete one uniquely matching unedited copy. Edited/ambiguous/commented examples do not authorize deletion. [README][readme] [Quotation source][quotation] [Quotation tests][quotation-tests]
- Convert to note link produces an ordinary aliased wikilink rather than a redundant highlight/reference. Only newly created notes receive `origin` to the source paragraph; existing origins remain untouched. Cancellation can leave a created note, which Reader must not delete. [README][readme] [Store][store] [Hosted contract tests][hosted-tests]
- Related notes edit future defaults (`topics`), not past quotations. The relation workflow connects rendered typed notes through eligible Fileclass File/MultiFile fields, using drag/drop or explicit selection. Occupied single-value replacement requires confirmation; provider revisions and eligibility are rechecked. [View][view] [Relations][relations] [Fileclass relations][fc-relations]
- Source/target saves are guarded but **not atomic**. Collection validates targets, saves source/retention, then writes destinations sequentially. Failures expose saved-source and verified target/removal progress; completed removals must not be blindly replayed. Fileclass v1 also lacks conditional `setValue`, leaving a race after relation checks. [Store][store] [README][readme] [Fileclass relations][fc-relations]

## Compatibility, privacy and operating boundaries

- **Normative baseline:** Markdown is authoritative; reading state is YAML. Preserve unknown properties, authored content/comments, journals, backlinks and quotation snapshots. No sidecars, synchronized quotation copies, automatic migrations or imported companion settings. Persisted-format changes require Wannes’s approval. [Guide][guide] [Document][document]
- Reader requires Obsidian ≥1.8.0; new hosted highlights require ≥1.12.7 and Fileclass public API v1. Fileclass Inline is optional. The bridge binds only plugin ID `fileclass`, validates v1 methods, pins API identity, and reads its binding alias without changing companion settings. [README][readme] [Fileclass bridge][bridge]
- Typed notes remain ordinary notes. Reader owns picker/creation interaction; Fileclass owns schema eligibility, validation and field writes. Reader’s internal `NodesApi` version 2 is a separate adapter contract, not permission to use another external plugin or schema. [Guide][guide] [Nodes seam][nodes] [Relations][relations]
- Local mutation safety uses serialized per-file writes, exact snapshot-byte comparison, file identity and dirty/uncertain-editor checks. YAML mutations preserve untouched values and comments or fail closed. These checks do not coordinate Obsidian Sync or provide cross-device transactions. [Document][document] [Store][store] [Vault][vault]
- Folder-runtime reconfiguration stops old views/work, drains already dispatched writes, reseeds metadata and recreates list views. It must not reopen/acquire/promote existing articles as an Apply side effect. Abrupt unload cannot guarantee the final unsaved bookmark/selection. [Main][main] [Guide][guide] [Generation tests][generation-tests]
- **Offline:** saved text is local; unfetched text is unavailable. Images remain remote, not permanent offline assets. Pagination is device-local. Desktop, iPhone/iPad and Android/e-ink are targets, not source-proven device certifications. Leaf-owned controls, ≥44px targets, content clearance and aligned paged columns are normative UI constraints. [README][readme] [Main][main] [Guide][guide]
- **Privacy evidence:** inspected acquisition uses Obsidian `requestUrl` for publisher/feed requests, and extraction disables Defuddle background fetches. Remote images and explicit browser links remain network surfaces. This inspection does not establish a complete traffic audit, host/companion privacy guarantee, or an approved AI-data policy. No external AI call on vault data is authorized by the map. [Network][network] [Extractor][extract] [README][readme] [Map](https://github.com/wannli/obsidian-reader/issues/94)
- Imported HTML/XML is bounded and sanitized. Limits include 2 MB decoded content, 20,000 DOM nodes and depth 64; this is not a network-response allocation cap. Known default Dataview/Templater expressions are rejected, not sandboxed for custom processors. [Bounds][bounds] [Security][security] [Network][network] [Security tests][security-tests]
- **Operating costs:** execution lives in the active Obsidian plugin. Network and ingestion each use two work slots; the network backlog defaults to 64 waiting requests and a 20-second delivery timeout. Uncancellable native requests retain active slots until settlement. These bounds do not cap all recovery jobs or response memory. [Network][network] [Ingestion][ingestion] [Network tests][network-tests]
- Feed cache is session-local (five feeds, five-minute reuse where applicable); explicit refresh requests fresh data. Maintenance uses a minute timer with a four-hour ordinary maintenance gate, plus explicit/foreground triggers. Metadata indexing/reference recovery can enumerate vault Markdown; expiry reads candidate bodies. No measured battery, latency, memory or scale result is asserted here. [Ingestion][ingestion] [Main][main] [Vault][vault] [Store][store]
- Developer checks use pinned Node, types, unit/component/tooling tests and build; there is no automated E2E suite. Runtime tooling is limited to owned synthetic vaults; installation, Sync/companion settings, deployment and release are separate authorization boundaries. [README][readme] [Guide][guide] [Package][package]

## Reusable seams, not integration proposals

- `core`: document/snapshot transforms, catalog, queue authority, quotation ownership and guarded `VaultPort` operations. [Document][document] [Store][store]
- `content` + `host`: extraction with injected network function, bounded external content, vault/network adapters and Fileclass/typed-relation provider contracts. [Extractor][extract] [Network][network] [Nodes seam][nodes] [Relations][relations]
- `reader` + `main`: article/list interaction, text-anchor surface, native routing and generation-bound lifecycle. These are existing responsibilities, not evidence that another product fits them unchanged. [View][view] [Main][main]

## Comparison checklist for later human decisions

For each inventoried W idea, record the desired outcome, provenance (proposal/approval/implementation/device evidence), and Reader overlap before selecting any disposition.

- Does it change capture/deduplication, feed completeness, refresh triggers, source provenance or overwrite permission?
- Does it preserve folder authority, explicit expiry eligibility, annotation retention, deletion suppression and recoverable trash?
- Does it preserve text-anchor resume, dog-ear separation, filtered navigation and explicit native Markdown escape?
- Does it preserve rich passage text, precise paragraph citations, snapshot ownership, dated grouping and conservative removal?
- Does it need new note/entity types, fields, IDs, databases, sidecars, migrations or synchronized copies? Flag approval needs explicitly.
- Does it retain Fileclass’s type/schema/write authority and safe behavior when that provider is absent, cancelled or reloaded?
- What happens after stale bytes, dirty editors, rename, partial multi-note success, runtime replacement and cross-device conflict?
- What leaves the device, through which provider, with what consent? What remains usable offline, and what new host/resource cost appears?
- Which desktop/mobile/e-ink, touch, keyboard, accessibility, abrupt-exit and Sync claims need new manual evidence?

This ticket supplies facts only. W inventory completeness, adoption categories, product boundaries and acceptance choices remain unresolved here.

## Pinned sources

[readme]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/README.md
[guide]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/AGENTS.md
[prior]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/docs/research/261102-reader-sync-risks.md
[main]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/src/main.ts
[model]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/src/core/model.ts
[document]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/src/core/document.ts
[store]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/src/core/store.ts
[ingestion]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/src/host/ingestion.ts
[vault]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/src/host/vault.ts
[feed]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/src/content/feed.ts
[folders]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/src/core/status-folders.ts
[queue-tests]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/tests/status-folders.test.ts
[status-tests]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/tests/core-status.test.ts
[view]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/src/reader/view.ts
[indicators]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/src/reader/row-indicators.ts
[indicator-tests]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/tests/row-indicators.test.ts
[keyboard-tests]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/tests/reader-keyboard-view.test.ts
[routing-tests]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/tests/article-routing.test.ts
[hosted-tests]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/tests/hosted-contract.test.ts
[quotation]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/src/core/quotation.ts
[quotation-tests]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/tests/quotation.test.ts
[relations]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/src/host/node-relations.ts
[fc-relations]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/src/host/fileclass/relations.ts
[bridge]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/src/host/fileclass/fileclass.ts
[nodes]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/src/host/nodes.ts
[generation-tests]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/tests/folder-runtime-races.test.ts
[network]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/src/host/network.ts
[extract]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/src/content/extract.ts
[bounds]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/src/content/bounds.ts
[security]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/src/content/security.ts
[security-tests]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/tests/content-security.test.ts
[network-tests]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/tests/network-pending.test.ts
[package]: https://github.com/wannli/obsidian-reader/blob/92b5d7507143a52ef949d6d92d852614846bbabf/package.json
