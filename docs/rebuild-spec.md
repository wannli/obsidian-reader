# Reader clean-slate rebuild

## Status and authority

- Functional scope below: approved by Wannes in the rebuild discussion.
- Implementation is authorized ("OK go implement this"). The [storage contract](storage-contract.md) and latest-20-on-every-refresh policy are explicitly approved.
- Rebuild application code from scratch; old code supplies lessons, not inherited features.
- No legacy article support, conversion, settings import, or migration.
- Existing user files and personal installations remain untouched. No publication or personal-vault deployment is authorized.
- Local synthetic-vault setup, plugin installation and development Hot Reload are explicitly authorized. Reader's disposable-vault Obsidian Sync setup is also authorized; joint testing excludes Hot Reload/instrumentation from Sync and requires the other plugin owner's verified build/clearance.
- Added functionality requires explicit approval; engineering choices must serve this scope.
- Folder-authoritative queues approved on 19 October: this source retains YAML `status` as a mirror and uses `bookmark` as detailed below. Earlier native acceptance predates this change; no installed-vault conversion or deployment is authorized.
- Current installed Reader: `f4bf22574068b7605753cced90af11dc018602804b238c6dad71f53b2041224d`, Reader-only reloaded on 2026-10-14T14:46:50.332Z. Recorded checks: 1042 unit + 72 tooling = 1114; test-only 8.258s, full check 12.361s. Earlier build/benchmark metrics are historical, not current.
- Final bounded Mac acceptance and audit are complete. The native lane is returned to Wannes, **hold true**; he can use the window now. No agent native access without fresh clearance. Actual iPhone/Boox acceptance remains pending; Sync reports synced with restored settings untouched.

## Approved platforms and storage principles

- Obsidian desktop, iPhone/iPad, and Boox/Android e-ink are first-version targets.
- Articles are ordinary vault Markdown, readable and editable without Reader.
- Markdown is authoritative; any index is disposable and rebuildable.
- No separate article/highlight database, sidecars, or synchronized content copies.
- Preserve unknown frontmatter, authored text, and ordinary Markdown links during edits.
- Vault sync is provided by the user's existing solution, not Reader.
- A clean implementation does not imply reimplementing mature parsing/extraction libraries.

## Approved capture and feeds

- Native Add URL command: extract readable article content and retain its source URL.
- Offline capture saves the URL immediately; acquisition resumes online while Obsidian is active.
- Capturing an existing URL opens the existing article rather than making a duplicate.
- Clicking a web link in Reader offers Save to Inbox, Open link, or Cancel. Saving reuses capture/deduplication and keeps the current article open; internal note links and section anchors retain their normal behavior.
- Adding an RSS/Atom subscription saves only its feed note, with no network request or article import. Initial title/prefix use the URL hostname and can be edited before Sync.
- Import feed entries with `status: feed` only through explicit Sync in Manage feeds or the Refresh feeds command. No startup, timer, online, visibility or metadata-driven feed imports.
- On Sync, save feed-provided content immediately; fetch missing full text on open or move to Inbox/Later.
- Saved text is available offline; unfetched full text is not guaranteed offline.
- Automatic housekeeping still recovers offline URL captures and safely expires explicit `status: feed` notes; it never refreshes subscriptions.
- Consider at most the latest 20 entries on every explicit refresh, before deduplication/age filtering; no historical backfill feature.
- Deduplicate feed imports against existing articles, including articles moved to another queue.
- Approved 15 October: subscription `deleted_urls` remembers future explicit Reader deletions of feed-associated articles across queues. Refresh skips these normalized URLs; manual Add URL remains allowed. Native/external and past deletions are not recorded; expiry does not add history.
- Unsubscribing stops imports and leaves existing articles untouched.
- Failed extraction preserves the URL and available text, reports failure, and offers Retry.
- Automatic acquisition and Retry never overwrite authored text or annotations to repair extraction. Approved 15 October follow-up: native Share Sheet singleton Markdown source links matching the article URL are acquisition placeholders; extra content stays protected. An explicit **Run Defuddle again (replace article content)** command may replace any existing article body after confirmation, including highlights and inline links, while preserving unknown frontmatter, explicit titles and all revision/editor/lifetime guards. Failed extraction preserves the current body.
- Remote images load only as needed; no permanent offline image downloads.
- No capture URI, QuickAdd dependency/adapter, Reader setup command or template installer. Native iOS capture locations, templates, widgets and Shortcuts are configured directly in Obsidian; existing vault templates remain untouched. Reader retains foreground/online extraction for empty native captures and the approved singleton source-link placeholder, plus confirmed re-download. Native Full Text and authored content stay protected from automatic acquisition. No note-schema change or native-settings modification. The existing reading-list URI remains navigation-only.

## Approved organization and reading

- Four queues: Inbox (`Reading/Inbox`), Feed (`Reading/Stream`), Later (`Reading/Later`), Archive (`Reading/Treasury`), controlled by configurable physical folders. Discover exact `type: article` and `type: feed` outside Templates and .trash.
- YAML status does not assign a queue: missing, invalid and conflicting values do not override placement. Reading never adds a missing status. Only a Feed-folder note with explicit fresh `status: feed` can expire.
- Manual/browser captures create in Inbox; RSS imports in Feed. A live native/QuickAdd capture with exact article type and inbox status is placed in Inbox when Reader observes it; external capture tools must target Inbox while Reader is inactive. Subscription creation defaults to `Reading/Feeds`. The old article capture destination remains inert/preserved; applying settings does not move existing files.
- Newest-first ordering; no manual ordering.
- Reading-list rows show full titles without URL subtitles or an embedded search field; use native Obsidian search. Preserve source URL metadata and core search capabilities.
- Previous/next follows the originating browsing queue, even after changing an article's status.
- Explicit status changes preserve file identity, content, bookmark and links while moving the path to the destination queue folder. Normal transitions: Inbox → Later/Archive, Feed → Later/Archive, Later → Archive, Archive → Later; manual changes are reversible.
- UI: one aligned title/content area, flat reading-list rows, no “End of article” label or action divider. Compact leaf-owned floating bottom controls use accessible labels and 44px targets: Previous, Next, Read later, Archive, Delete, List. Archive uses an archive icon, not the bookmark icon.
- Floating controls stay within the Reader pane, with safe-area and final-content clearance. Desktop uses the available pane width, and scrollbars must not overlap text.
- Right-side indicators show opened-before (existing usable `bookmark`, not completion) and highlights (derived Markdown). Use bounded, cancellable reads; no whole-vault body scan, new YAML fields, timestamps, sidecars or persisted read/annotation history.
- Archive and subscription-management buttons are absent from the main view; Open Archive and Manage feeds commands retain access without deleting data.
- Open reading list and Copy reading-list link commands share a navigation-only URI route using the current device’s encoded vault name; clipboard access is explicit and write-only. Open dog-eared article and Copy dog-ear link use the same vault-aware route (`view=dog-ear`); without a valid pointer they open the newest Inbox article.
- Read later (clock) writes `status: later`, stays open and preserves browsing context. Archive writes `status: archive` and advances; Delete uses recoverable trash and advances. Previous/Next retain the original browsing context; List returns to it.
- Open Markdown, Topics and explicit Change article status remain context-aware commands, not duplicate article buttons. Visually avoid a repeated leading title without rewriting authored Markdown/headings.
- Ordinary highlights must remain visible when the host does not define its optional highlight-colour variable; preserve native theme integration with a safe fallback.
- Deletion uses recoverable Obsidian trash, never permanent removal.
- No user-facing batch-delete or "delete newer articles" command in v1.
- Exact `type: article` notes open in Reader. Open Markdown explicitly retains the native editor; dirty/uncertain editors, stale files and navigation intent are protected.
- Ordinary notes remain native; folder wins over YAML status for queue membership. Typed articles outside queue folders remain readable but unqueued. Templates and .trash are never indexed or routed into Reader. Settings Apply never migrates notes.
- Remember reading position as a text anchor in `bookmark` and restore it across sessions/devices via vault sync. The separate `dog_ear: true` current-article pointer moves on successful article entry and leaves reading-position anchors intact. Legacy `reading_position` remains preserved and inert, without fallback or conversion. List opens and next/previous navigation, including boundary keys, resume each article’s own saved position; do not force next-start/previous-end entry.
- Desktop j/k navigates articles, except while typing or interacting with menus/dialogs.
- Use native typography, themes, menus, and pickers; no Reader theme/type settings.
- Hide the floating mobile navigation bar only while Reader is active; restore it on normal notes/exit/unload, without hiding capture/keyboard controls.
- Boox pagination supports previous/next device buttons and touch buttons, without animations. Up/PageUp at the article start opens the previous article; Down/PageDown at its end opens the next. Preserve ordinary scrolling/paging, guard editing/modal/selection input, and prevent held-key skipping.
- Pagination itself is device-local, not shared through vault sync. A separate Reader plugin setting, default off, reveals double-chevron article navigation only while pagination is enabled; single-chevron touch page buttons remain available. Non-paged article arrows are unchanged.

## Approved annotations and Nodes integration

- Settled text selection saves an ordinary inline ==highlight== without a confirmation button. Do not write mid-gesture; keep queued selections bound to their captured source and reject superseded jobs.
- Expected unmappable passive selections quietly leave text unchanged; genuine save failures and explicit-action errors remain visible. Settling/feedback should be prompt, with accepted highlights renderable and visibly styled.
- Link highlighted passages to existing vault notes while preserving the original wording.
- Remove highlight, change target, and unlink while keeping the highlight are supported.
- Passage-menu language is “note”: Open note (linked), Link to note / Change link, Create note, then separated Remove link and Remove highlight actions. Approved shared-picker update: both Link/Change and Create note open Fileclass Inline’s existing picker, seeded with the passage title, for existing notes or inline creation. Remove All notes entirely; Reader owns no note picker.
- Topics are frontmatter links to notes with exact `type: topic`. Approved 16 October: bottom-toolbar multiselect assignment, and transient current-queue filtering by topic name/aliases or free text, matching explicit links OR whole words/phrases in titles/bodies. The Reader-owned list heading and filtered article context read `Reading list: <topic>`; Obsidian's host-owned native navigation header need not refresh. The accent filter button clears on click, without a separate banner. Wannes additionally approved Create topic through Fileclass Inline API v2 `createNodeForLink`, linking before required completion; no Reader-owned creation fallback. See [topic-filter acceptance scope](topic-filter.md).
- Optional Nodes integration supports schema-aware search of existing nodes AND node creation.
- Joint-testing follow-up requires public **Nodes API v2** (`fileclass-inline.api`), not Reader-created node files/forms/schemas or private Fileclass calls. Older API versions are not silently accepted.
- V2 exposes Fileclass classes/icons, not schema colors; highlights keep their standard appearance. This replaces the earlier v1 color integration requirement.
- Require optional v2 `pickNodeForLink(options, link)` for both note actions. Commit through its callback before required-field completion; reject uncertain source writes, validate intended class membership, and never prune a created node. Null/cancellation can still leave a note. No standalone creation fallback.
- Without a supported shared picker, Link/Change and Create note are unavailable. Ordinary highlights, opening existing links and unlinking still work. Use only `fileclass-inline`, with no old-ID fallback or migration.
- No arbitrary web-URL attachment action for highlights in v1; imported links still work normally.
- Personal comments are edited in Markdown; no dedicated Reader comment editor.

## Approved Feed lifecycle

- Only Feed-folder notes with explicit `status: feed` are disposable; missing or conflicting YAML protects against expiry.
- A saved highlight or user-created link promotes a Feed-folder article to Later before annotation commit. Other statuses do not change; removing annotations never demotes.
- Publisher links in imported content do not count as a user-created link.
- Promotion must not lose the annotation, selected text, reading position, or browsing context.
- Cleanup cannot race an unfinished annotation/save/promotion operation.
- Feed-folder articles with explicit `status: feed` expire after one calendar month into recoverable trash unless annotated or topic-bearing; Reader archives protected articles instead. Fresh folder and YAML checks both determine eligibility at deletion boundaries.
- Opening/reading, reaching the end or saving a bookmark never changes status or preserves an explicit-feed article.
- No legacy ownership archaeology, historical conversion rules, or generic content-retention heuristics.
- Exact clock/fallback and recovery semantics follow the approved storage contract.

## Approved filenames

- Manual capture: YYMMDD Title.md.
- Feed capture: YYMMDD Feed - Title.md.
- Use safe filenames and collision handling; never overwrite an existing file.
- Date selection and timezone rules follow the storage contract.

## Explicitly excluded

- AI features, generated journals, copied highlight collections, and a separate browser app.
- Custom sync, an annotation database, and general-purpose extension/plugin infrastructure.
- Legacy article readers, compatibility adapters, migration engines, and old settings adoption.
- Duplicate Nodes schemas/forms, custom comments UI, and runtime dummy-content modes.
- Speculative settings, abstraction frameworks, and features merely inherited from old projects.

## Small implementation architecture

Five focused responsibilities, not five independent frameworks:

1. Obsidian host: plugin lifecycle, native views/commands, vault operations, narrow Nodes adapter.
2. Library: lightweight article/feed metadata index and queue/URL lookup, updated per changed file.
3. Documents: one Markdown model, localized source edits, guarded saves, moves, and trash.
4. Ingestion: bounded/cancellable feed and article requests; failures visible; foreground interaction first.
5. Reader: one article view/state, source-mapped selection, annotations, position, scrolling/pagination.

- UI issues explicit operations; it does not implement its own persistence or retention rules.
- Indexes are derived read models, never an alternative authority for file writes.
- Always revalidate current file/buffer contents before mutation; serialize overlapping operations.
- A multi-step move/save is not advertised as an atomic cross-device transaction.
- Prefer a safely retained/promoted article over deletion after a partial failure; report failures.
- Do not remount the article for position saves, unrelated feed updates, or list changes.
- Parse/render an article body when needed, not every article to populate a list.
- No full-vault body scan on navigation, highlighting, or reading-position updates. An explicitly active topic filter may read the current queue on demand with bounded concurrency and cancellation; no acquisition, mutation or persistent body index.
- Keep list rendering and background concurrency bounded; cancel work when no longer relevant.
- Do not replace platform constraints with a fake browser application or large automation framework.

## Approved storage contract

[storage-contract.md](storage-contract.md) records the article/feed schemas, exact-byte acquisition proof, annotation syntax, position anchors, promotion, recoverable expiry, and filename rules. Wannes approved it with “Yes, the contract looks good.” The later refresh clarification was “Yes, only the last 20 entries.” No cursor or read history is authorized. Subscription deleted-URL suppression was additionally approved on 15 October.

Changes to this contract still require approval. Development uses an explicitly approved, marked synthetic vault; never old/personal data.

## Approved development workflow and test budget

- Use a local, owned dummy vault under the repository's gitignored .sandbox directory.
- Create it if absent; do not adopt an unmarked vault or bypass a safety hold.
- Install pinned Hot Reload separately and opt Reader in with a local .hotreload marker.
- Development builds write directly into the installed plugin folder, not a second dist copy.
- Release builds remain separate; no vault files, plugin settings, or .hotreload marker enter Git/releases.
- Target <5 seconds for focused checks and <10 seconds for the full automated test suite locally.
- Keep all correctness tests enabled and isolated; do not meet budgets by weakening assertions.
- Prefer pure Node tests; create DOM environments only for behavior that needs them.
- No general automated E2E suite. Wannes requested local E2E acceptance for topic filtering on 16 October before remote delivery; a synthetic-host browser run is not native/device acceptance. No live network, deliberate sleeps, or release builds in routine unit/component tests.
- Time and report actual runs; physical-device acceptance stays explicit and separate.

## Performance and acceptance

- Approved benchmark dataset: 10,000 articles and 100 feeds.
- Actual iPhone/iPad and Boox models remain unspecified; record them before native acceptance.
- Define measurable cold-start, list-open, saved-article-open, navigation, and annotation latency budgets.
- Budgets must distinguish local work from network/extraction time and identify device/article size.
- Test durations are measured separately. Native startup/navigation/annotation latency is not yet verified.
- Every approved capability gets a focused acceptance case, including offline/error/cancel paths.
- Test month boundaries, feed duplicates, stale writes, promotion failures, and interrupted operations.
- Test selection stability, image loading, bounded work, restart recovery, and unknown-text preservation.
- Physical iOS/Boox and real sync results must be reported separately from automated tests.
- Completed Mac checks: flat full-width list; article 903px inside a 927px pane, no cap, 16px text padding plus 15px native scrollbar; five 44px article buttons, one H1, visible highlight and final-line clearance.
- Trusted ArrowDown at the end advanced exactly one article despite held repeat; destination resumed its stored marker at scrollTop 675. Open Markdown → Welcome native Markdown → the same article Reader passed in the same leaf after completed escape; OS URI with vault ID forced the list.
- Native folder Apply aborted the old generation and opened a fresh Reader list. Overall backup audit: 43 → 43, no additions/deletions; only `reading_position` changed in two articles. Welcome and companion/core/community enablement/data hashes stayed unchanged.
- Current Mac metadata had no duplicate-title notes; the earlier phone cause remains undiagnosed. No deduplication/deletion was performed. Browser Surface tests at four fractional widths are not physical-device proof.
- See [final Mac evidence and remaining phone cases](mobile-smoke.md) and the [historical/current report](rebuild-report.html). Remaining real-adapter/device checks require fresh native clearance; unit/component tests do not replace them. Do not add an automated E2E harness.

## Delivery gates

1. Scope, implementation, storage contract, and bounded refresh policy are approved.
2. Implement narrow slices and fast regressions; validate the small architecture against real measurements.
3. Activate the coherent new runtime, then remove the superseded runtime/tests/dependencies—not retain two implementations.
4. Bounded current Mac validation and the final audit are complete. Actual iOS/Boox, the full mobile capture/Date/cancellation matrix, conflict/interruption and native-scale acceptance remain separate pending gates; the native lane is held for Wannes.
5. Personal-vault installation, replacement, migration, publication, and deployment need separate authorization.

`src/main.ts` now contains the rebuilt plugin; superseded runtime/tests and QuickAdd assets have been removed, not merely excluded. See the [codebase map](map.md) for maintained entry points and remaining native/device acceptance.
No commit, push, version change, or publication is authorized by these implementation/setup decisions.
