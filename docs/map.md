# Reader codebase map

One runtime, one Markdown store. Start with the [approved scope](rebuild-spec.md) and [storage contract](storage-contract.md); neither a cache nor UI state is write authority.

Folder-authoritative queues and initial hosted highlights were installed in the owned E2E vault on 20 October; loaded artifacts/public APIs and queue composition were checked, not full workflow/device/Sync acceptance. Earlier Mac evidence below remains historical.

The initial hosted-highlight installation was `2fca7e18…` on 2026-10-20T20:39:39Z (2196 unit + 92 tooling tests). Follow-up build `9238ba5b…` was installed and verified loaded on 2026-10-21T01:45:10Z (2416 unit/component + 92 tooling tests; 52 installer guards). Native-tag/picker build `9a152ca4…` was installed and verified loaded at 03:05Z. Grouped pills, empty highlight search and top topics were installed as `66bf883b…` at 15:44Z (2434 unit/component + 92 tooling tests; 52 installer guards), and Wannes reported that it works. This confirmation does not complete the full manual desktop matrix or iPhone/Boox/Sync acceptance. Native input is **returned to Wannes / hold true** outside a fresh scoped maintenance session; closed leases confer no authority.

## Entry and flow

```text
src/main.ts                         Obsidian lifecycle, commands, routing
  ├─ host/vault.ts → core/catalog.ts     public metadata → disposable index
  ├─ host/ingestion.ts → content/        bounded web input → safe Markdown
  └─ reader/view.ts → core/store.ts      guarded user operations → vault files
```

`main.ts` owns plugin lifetime, explicit feed refresh, active/online capture recovery and expiry housekeeping, safe native routing, tracked generation-aware presentation transitions and unload cleanup. It wires the library, ingestion and Reader view; there is no parallel legacy entry point.

## Core: data and guarded writes

| File in `src/core/`      | Responsibility                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `model.ts`               | Article/feed types, paths, URLs, safe filenames, calendar-month age                             |
| `folders.ts`             | Feed-subscription creation destination and preserved inert article setting; portable validation |
| `document.ts`            | YAML AST updates and exact-revision Markdown snapshots                                          |
| `capture-placeholder.ts` | Exact singleton native source-link eligibility; no authored-body override                       |
| `catalog.ts`             | Metadata-only queue/search/URL index and stable browsing snapshots                              |
| `store.ts`               | Serialized capture, acquisition, annotations, bookmark, status and trash                        |
| `annotations.ts`         | Inline highlight/link operations, annotation detection, import escaping                         |
| `hosted-highlights.ts`   | Typed destination groups, balanced quotation extraction and shared paragraph anchors            |
| `quotation.ts`           | Native source grouping, collection dates, exact append/dedup/removal and new-note `origin`      |
| `projection.ts`          | Conservative mapping from rendered words to original Markdown ranges                            |
| `work.ts`                | Small keyed work queue and file-identity write serialization                                    |

`work.ts` keeps FIFO foreground/background lanes and one shared promise per key. A foreground request moves only pending background work to the foreground tail; dispatched work is never interrupted or rerun. `FOREGROUND_BURST = 3` bounds consecutive foreground dispatches across worker lanes: the next dispatch serves a waiting background job, then resets the burst. Either priority runs freely when the other is empty; foreground-only dispatches still count toward the burst. Stop rejects pending work but lets dispatched jobs settle. Keyed cancellation removes only not-yet-dispatched jobs from either lane; dispatched jobs retain their slots and keys until settlement.

`store.ts` is the mutation boundary. It rechecks current identity/revision, promotes Feed-folder articles to Later before annotation, writes Reader status changes in YAML, then moves them to their queue folder using guarded native moves (also used for capture retitling). Annotation promotion saves Later, then the annotation, then moves; postmove snapshots use actual bytes/links. Session-only capture receipts permit safe filename retitling; they never become persisted ownership stamps. Explicit Reader deletion archives annotated/topic-bearing articles; unprotected feed-associated deletions record URLs in subscription `deleted_urls` before trash; RSS import rechecks suppression under a shared local import/delete lane. Expiry does not record suppression: it requires explicit `status: feed` in metadata and fresh bytes, protects active work/backlinks, then reads only candidate bodies. Folder determines queue; expiry additionally requires explicit fresh `status: feed` in the Feed folder.

## Content: untrusted publisher input

- `content/feed.ts`: RSS/Atom parsing; no historical cursor.
- `content/extract.ts`: HTML response checks, title-only rejection and Defuddle extraction without background fetching.
- `content/stream.ts`: inert restoration of unambiguous empty React streaming boundaries before extraction; ordinary hidden content stays excluded.
- `content/html.ts`: DOMPurify sanitization, hidden-content removal, safe destinations, Markdown conversion.
- `content/bounds.ts`: byte, node and nesting limits before expensive conversion.
- `content/code.ts` / `security.ts`: literal passive code, processor-label removal, fail-closed default Dataview/Templater checks.

Runtime libraries: `yaml`, `marked`, `entities`, `dompurify`, `defuddle`. No UI framework or secondary content database.

## Host: narrow Obsidian adapters

- `host/vault.ts`: public vault/metadata/editor APIs, dirty-buffer protection, folder/case collisions, recoverable trash, link-aware moves, change subscriptions. Session-local post-layout create receipts freeze eligible ctime minutes for missing publication on exact new articles; startup indexing remains read-only. See the storage contract for cold-launch/Sync provenance limits.
- `host/network.ts`: two native request slots, a default ceiling of 64 waiting requests, and delivery deadlines including queue wait. Overflow rejects with a retryable `NetworkOverflowError`; same URL/Accept consumers still join at capacity. Expired waiting jobs release their queue entry, request-map entry, guards and timer; identity-checked cleanup cannot delete a newer retry. An uncancellable timed-out native request retains its slot and shared result until the host settles it. These are processing/backlog bounds, not a download-memory cap: `requestUrl` may buffer its full response before content-size checks. The general ingestion/recovery queue is not capped.
- `host/ingestion.ts`: local-only subscription creation (editable hostname title/prefix), explicit latest-20 Sync/Refresh feeds imports, dedupe, cancellation, and acquisition proof against current excerpt/standalone native source-link bytes. Explicit confirmed re-download is separate from conservative acquisition/Retry and retains snapshot/editor/lifetime guards. No automatic feed polling or add-time fetch/import.
- `host/dialogs.ts` / `settings.ts`: native input/dialogs, staged independent-folder settings and subscription controls.
- `host/folder-settings.ts` / `folder-picker.ts`: feed subscription creation destination in `captureFolders`; old article destination remains inert/preserved. Applying destinations drains old work and creates fresh list views without acquisition or promotion. Exact article/feed types outside Templates/.trash are indexed anywhere in the vault.
- `core/status-folders.ts`: four required, nonoverlapping queue destinations with defaults including `Reading/Later`. Folder membership alone determines lists; Templates and .trash are excluded. Observed live native Inbox captures are moved after creation, while startup/settings/body/path-only changes never sweep old files. Native link-update preferences remain untouched; failed moves do not roll back retained YAML or saved annotations.
- `host/nodes.ts`: public `fileclass-inline.api` v2 discovery and optional creation. `host/highlight-picker.ts` owns native-style typed suggestions, full-width search with separated title/type metadata, staged multiselection, explicit public creation intent and secondary article selection. Fileclass Inline owns schemas, creation and required completion; no untyped/All files route, private calls or copied forms. See [hosted highlights](hosted-highlights.md).

## Reader: presentation and transient state

- `reader/view.ts`: flat library/article UI, browsing context, guarded operations/lifetimes and native menus/Markdown escape. Related notes edits defaults separately from highlight-note multiselection/removal. Selecting a highlight arms direct reference-click collection of that source, not target text. Topic filters retain navigation; indicators use existing `bookmark`/Markdown only, with a separate `dog_ear` shortcut pointer.
- `core/topic-filter.ts`, `reader/topic-scan.ts`, `host/topic-filter-dialog.ts`: pure topic/alias/visible-text matching, cancellable current-queue reads and the topic/free-text filter picker. Filtering never acquires or writes articles; see [acceptance scope](topic-filter.md).
- `reader/render.ts`: sanitized Markdown, lazy images and one native-sized pill per highlight’s references, containing only Fileclass icons/names with individually clickable destinations. `reader/topic-pills.ts` paints read-only header topics; Surface queues their reflow without adding metadata to source text. Its optional host painter decorates all recognized typed-note links with public Fileclass icons; icon metadata stays outside prose mapping.
- `reader/images.ts`: disposable click/tap/keyboard image enlargement; inline image height remains bounded by the reading viewport.
- `reader/highlight-feedback.ts`: transient save acknowledgement, distinct from the immutable text/revision write snapshot and cleared with its surface lifetime.
- `reader/surface.ts`: scroll/pagination layout, selection/pointer deferral, position save/restore.
- `reader/text.ts`: visible-text indexing across inline nodes.
- `reader/tap-text.ts` / `tap-highlighter.ts`: rect-verified word taps, block-scoped sentence/paragraph ranges, transient first-word paint and contextual article-bar controls. View owns guarded saves and short-lived Undo receipts; no native selection or extra persisted state.
- `reader/styles.css`: the **only source stylesheet**, with ≥44px floating controls/picker rows and scroll clearance; inline reference tags use native text sizing rather than oversized button boxes. Only Obsidian’s floating mobile navigation bar is hidden while Reader is active; native editing/capture controls remain.

Hosted collection/creation rejects uncertain source/target writes and commits in the public callback before required completion. Preserve single-use/source-bound callbacks, cancellation races, phase guards and dispatched-write draining. Validate current registered class membership, not primary type. Only explicit highlight-destination removal may delete a uniquely matching unedited quote; snapshots otherwise stay independent. Multi-file errors report saved source and verified append/removal progress, with no hidden recovery ledger.

Displayed text must match the write snapshot before a selection action. Position-only changes do not remount the article. Close saving is best effort: Obsidian unload cannot await completion or undo host I/O already started.

## Tests and tooling

- `tests/*.test.ts`: fast unit/component regressions; `helpers/memory-vault.ts` supplies an isolated vault port. Node is the default; DOM-dependent tests opt in or install explicit local fixtures.
- `scripts/*.test.mjs`: build/setup/Hot Reload/release safety, with isolated fixture repositories from `tooling-fixture.mjs`.
- `build.mjs`: browser-only bundling from `src/main.ts` and `src/reader/styles.css`; only `obsidian` stays external.
- `dev.mjs`: direct installed-vault build; `setup-vault.mjs` / `seed.mjs`: explicit create-only synthetic setup and backed-up artifact updates.
- `hot-reload.mjs`: explicit pinned development-plugin installation; never a build-time download.
- `sandbox.mjs` / `safety-hold.mjs`: fixed owned paths, link checks and fail-closed holds. Historical **Reader2** names are safety identities, not legacy runtime compatibility.
- `artifacts.mjs`: artifact hash/build-identity verification before installation.
- `validate-release.mjs`, root metadata, `.github/`: validation and the existing Release Please publication path. The serialized workflow builds the exact release tag and can retry existing drafts without overwriting mismatched assets; it never creates or moves tags outside Release Please.

`mise exec -- npm run benchmark:scale` is an opt-in 10,000-article/100-feed core and filesystem benchmark, not native UI/E2E automation. Its synthetic corpus and measurements stay ignored.

Use `mise exec -- npm run check`; see [README](../README.md) for focused commands. Prettier keeps source/tests/tooling consistent. No test exclusions hide retired code; no automated E2E suite exists.

## Recorded Mac acceptance and remaining device gates

The recorded `f4bf…` native Mac checks passed: full 927px list pane; article 903px with no cap, 16px text padding plus 15px native scrollbar, five 44px controls, one H1, visible highlight and final-line clearance. Trusted ArrowDown advanced exactly one despite held repeat and resumed the destination marker at scrollTop 675. Open Markdown → Welcome native Markdown → the same article Reader passed in the same leaf after completed escape; OS URI with vault ID forced the list.

Final overall backup audit: 43 → 43, no additions/deletions; only `reading_position` changed in two articles. Welcome, companion/core/community enablement and data hashes stayed unchanged. Sync reports synced; restored settings were untouched. No duplicate-title notes existed in current Mac metadata; the earlier phone cause remains undiagnosed, with no deduplication/deletion.

See [recorded evidence and phone checklist](mobile-smoke.md) (`reader-redesign-audit.json`, `native-folder-apply.json`, `native-resume.json`, `routing.json`, `uri.json`) and the [historical/current report](rebuild-report.html). That installed build's recorded validation: 1042 unit + 72 tooling = 1114; test-only 8.258s, full check 12.361s. Automated geometry and the four-width production Surface browser checks are not physical-device evidence.

The source additionally preserves image enlargement, web-link capture, transient highlight acknowledgement and tracked native-title refresh. The article toolbar groups queue changes behind Change status; every toolbar status choice advances, while the context-aware command stays on the article. Reader queue changes write YAML and move into the corresponding queue folder. Reading position is `bookmark`, with legacy position values preserved/inert; `dog_ear` independently identifies the current shortcut article. Source regressions do not extend earlier native acceptance; implementation does not install, convert or reload a vault.

Remaining checks require a future authorized window; the current native hold remains true:

1. Complete unrun offline/error/cancel capture and the full mobile Nodes capture/Date/cancellation matrix; do not promote earlier desktop signoff into mobile proof.
2. On specified iPhone/iPad and Boox models, check selection handles, touch/device buttons, pagination/images, background/resume and restore.
3. Exercise interrupted/conflicting cross-device writes and verify authored bytes/links; synced status alone is not conflict acceptance.
4. Record device/article sizes and cold-start, list/open/navigation/annotation latency for the approved 10,000-article/100-feed dataset. Test-suite timing is separate.

Do not use personal vaults, enable Hot Reload in the shared Sync profile, claim hardware acceptance from mocks, or add automation to conceal missing manual evidence.
