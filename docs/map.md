# Reader codebase map

One runtime, one Markdown store. Start with the [approved scope](rebuild-spec.md) and [storage contract](storage-contract.md); neither a cache nor UI state is write authority.

The YAML-status/bookmark update is source-only and has not received native/device acceptance. Earlier folder-queue evidence below is historical, not validation of the new schema.

The last native build verified by this rebuild is `f4bf22574068b7605753cced90af11dc018602804b238c6dad71f53b2041224d`, Reader-only reloaded 2026-10-14T14:46:50.332Z. Bounded Mac acceptance and the final audit are complete; actual iPhone/Boox tests remain pending. The native lane is **returned to Wannes / hold true**: he can use the window now; agents must not access native Obsidian without fresh clearance.

## Entry and flow

```text
src/main.ts                         Obsidian lifecycle, commands, routing
  ├─ host/vault.ts → core/catalog.ts     public metadata → disposable index
  ├─ host/ingestion.ts → content/        bounded web input → safe Markdown
  └─ reader/view.ts → core/store.ts      guarded user operations → vault files
```

`main.ts` owns plugin lifetime, explicit feed refresh, active/online capture recovery and expiry housekeeping, safe native routing, tracked generation-aware presentation transitions and unload cleanup. It wires the library, ingestion and Reader view; there is no parallel legacy entry point.

## Core: data and guarded writes

| File in `src/core/`      | Responsibility                                                             |
| ------------------------ | -------------------------------------------------------------------------- |
| `model.ts`               | Article/feed types, paths, URLs, safe filenames, calendar-month age        |
| `folders.ts`             | Two creation destinations, portable validation; root/shared/nested allowed |
| `document.ts`            | YAML AST updates and exact-revision Markdown snapshots                     |
| `capture-placeholder.ts` | Exact singleton native source-link eligibility; no authored-body override  |
| `catalog.ts`             | Metadata-only queue/search/URL index and stable browsing snapshots         |
| `store.ts`               | Serialized capture, acquisition, annotations, bookmark, status and trash   |
| `annotations.ts`         | Inline highlight/link operations, annotation detection, import escaping    |
| `projection.ts`          | Conservative mapping from rendered words to original Markdown ranges       |
| `work.ts`                | Small keyed work queue and file-identity write serialization               |

`store.ts` is the mutation boundary. It rechecks current identity/revision, promotes Feed/missing status to Later before annotation, writes queue changes in YAML, then optionally relocates mapped transitions using guarded native moves (also used for capture retitling). Annotation promotion saves Later, then the annotation, then moves; postmove snapshots use actual bytes/links. Session-only capture receipts permit safe filename retitling; they never become persisted ownership stamps. Explicit Reader deletion records feed-associated URLs in subscription `deleted_urls` before trash; RSS import rechecks suppression under a shared local import/delete lane. Expiry does not record suppression: it requires explicit `status: feed` in metadata and fresh bytes, protects active work/backlinks, then reads only candidate bodies. Missing status displays in Feed but never expires; invalid statuses remain unqueued/protected.

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
- `host/network.ts`: bounded request slots and delivery timeouts. An uncancellable timed-out request retains its slot until the host settles it.
- `host/ingestion.ts`: local-only subscription creation (editable hostname title/prefix), explicit latest-20 Sync/Refresh feeds imports, dedupe, cancellation, and acquisition proof against current excerpt/standalone native source-link bytes. Explicit confirmed re-download is separate from conservative acquisition/Retry and retains snapshot/editor/lifetime guards. No automatic feed polling or add-time fetch/import.
- `host/dialogs.ts` / `settings.ts`: native input/dialogs, staged independent-folder settings and subscription controls.
- `host/folder-settings.ts` / `folder-picker.ts`: two creation destinations in `captureFolders`, native suggestions including vault root. Existing legacy folder settings stay inert/preserved; no conversion or migration. Applying destinations drains old work and creates fresh list views without acquisition or promotion. Exact article/feed types are indexed anywhere in the vault.
- `core/status-folders.ts` / `host/status-observer.ts`: optional `statusFolders` settings, mapped capture placement and observed explicit YAML transitions. Exact-byte own-write receipts and synchronous write notifications prevent delayed metadata from replaying moves. Identity baselines exclude startup/body/path-only sweeps; an explicit command can reconcile currently mapped articles on demand. Bounded unsafe-editor deferral retries on workspace events and busy file lanes. Superseded status/path/settings/unload cancels pending work. Native link-update preferences remain untouched; failures do not roll back retained YAML or saved annotations.
- `host/nodes.ts`: optional public `fileclass-inline.api` v2. Passage Link/Change and Create note require `pickNodeForLink` and delegate to Fileclass Inline’s shared picker. Topic creation within the assignment multiselect uses optional `createNodeForLink` constrained to the exact `topic` class, with guarded source linking before required completion. No Reader-owned creation form, All notes route, standalone fallback, private Fileclass calls or migration.

## Reader: presentation and transient state

- `reader/view.ts`: flat library/article UI, original browsing context, selection operations, guarded async lifetimes, native menus and Markdown escape. Transient topic filters retain filtered navigation; the Topics toolbar action reuses guarded assignment. Opened-before (not finished) and highlight indicators use existing `bookmark` + Markdown highlights only; the separate `dog_ear` pointer is for shortcut navigation, not an indicator or read history.
- `core/topic-filter.ts`, `reader/topic-scan.ts`, `host/topic-filter-dialog.ts`: pure topic/alias/visible-text matching, cancellable current-queue reads and the topic/free-text filter picker. Filtering never acquires or writes articles; see [acceptance scope](topic-filter.md).
- `reader/render.ts`: sanitized Markdown rendering and lazy remote images with failure cooldown.
- `reader/images.ts`: disposable click/tap/keyboard image enlargement; inline image height remains bounded by the reading viewport.
- `reader/highlight-feedback.ts`: transient save acknowledgement, distinct from the immutable text/revision write snapshot and cleared with its surface lifetime.
- `reader/surface.ts`: scroll/pagination layout, selection/pointer deferral, position save/restore.
- `reader/text.ts`: visible-text indexing across inline nodes.
- `reader/styles.css`: the **only source stylesheet**, with leaf-owned floating controls and scroll clearance. Only Obsidian’s floating mobile navigation bar is hidden while Reader is active; native editing/capture controls remain.

Shared-picker linking/creation must reject an uncertain source write, commit in the v2 callback before required completion, and never prune the target. Preserve single-use callbacks, cancellation races and dispatched-write draining. Creation's chosen class may differ from discovery's last bound class; validate membership, not unique-type equality.

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

The source additionally preserves image enlargement, web-link capture, transient highlight acknowledgement and tracked native-title refresh. The six-action toolbar sets Later (clock) without advancing, or Archive (archive icon) and advances; queue changes write YAML and leave paths unchanged unless that status has an opt-in folder mapping. Reading position is `bookmark`, with legacy position values preserved/inert; `dog_ear` independently identifies the current shortcut article. Source regressions do not extend earlier native acceptance; implementation does not install, convert or reload a vault.

Remaining checks require a future authorized window; the current native hold remains true:

1. Complete unrun offline/error/cancel capture and the full mobile Nodes capture/Date/cancellation matrix; do not promote earlier desktop signoff into mobile proof.
2. On specified iPhone/iPad and Boox models, check selection handles, touch/device buttons, pagination/images, background/resume and restore.
3. Exercise interrupted/conflicting cross-device writes and verify authored bytes/links; synced status alone is not conflict acceptance.
4. Record device/article sizes and cold-start, list/open/navigation/annotation latency for the approved 10,000-article/100-feed dataset. Test-suite timing is separate.

Do not use personal vaults, enable Hot Reload in the shared Sync profile, claim hardware acceptance from mocks, or add automation to conceal missing manual evidence.
