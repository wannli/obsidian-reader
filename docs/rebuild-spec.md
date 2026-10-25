# Reader clean-slate rebuild

## Status and authority

- Functional scope below: approved by Wannes in the rebuild discussion.
- Implementation is authorized ("OK go implement this"). The [storage contract](storage-contract.md) and latest-20-on-every-refresh policy are explicitly approved.
- Rebuild application code from scratch; old code supplies lessons, not inherited features.
- No legacy article support, conversion, settings import, or migration.
- Existing user files and personal installations remain untouched. No publication or personal-vault deployment is authorized.
- Local synthetic-vault setup, plugin installation and development Hot Reload are explicitly authorized. Reader's disposable-vault Obsidian Sync setup is also authorized; joint testing excludes Hot Reload/instrumentation from Sync and requires the other plugin owner's verified build/clearance.
- Added functionality requires explicit approval; engineering choices must serve this scope.
- Folder-authoritative queues approved on 19 October retain YAML `status` as a mirror and use `bookmark`. The initial hosted-highlight build and backed-up corpus were installed in the owned E2E vault on 20 October under explicit authorization; this is not personal-vault deployment or migration.
- Initial hosted-highlight E2E installation: `2fca7e18ab7fc9369f507f75632d9918ec71305f83644b8bc76264954101f809`, reloaded 2026-10-20T20:39:39Z after 2196 unit + 92 tooling tests and the full check passed. Its loaded artifact/public API and 8/2/1/1 queue composition were verified. Follow-up UI/storage behavior needs its own validated artifact/receipt; earlier Mac metrics are historical.
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
- UI: one aligned title/content area, flat reading-list rows, no “End of article” label or action divider. Compact leaf-owned floating bottom controls use accessible labels and 44px targets: Related notes, Change status (opens the queue picker), Delete, List, and the two tap-mode triggers. Article navigation uses keyboard shortcuts instead of left/right article controls; paged touch page controls remain.
- Floating controls stay within the Reader pane, with safe-area and final-content clearance. Desktop uses the available pane width, and scrollbars must not overlap text.
- Right-side indicators show opened-before (existing usable `bookmark`, not completion) and highlights (derived Markdown). Use bounded, cancellable reads; no whole-vault body scan, new YAML fields, timestamps, sidecars or persisted read/annotation history.
- Archive and subscription-management buttons are absent from the main view; Open Archive and Manage feeds commands retain access without deleting data.
- Open reading list and Copy reading-list link commands share a navigation-only URI route using the current device’s encoded vault name; clipboard access is explicit and write-only. Open dog-eared article and Copy dog-ear link use the same vault-aware route (`view=dog-ear`); without a valid pointer they open the newest Inbox article.
- Choosing any queue through the article status control writes the chosen status, moves the article and advances (or returns to the list at the end). The explicit Change article status command stays on the article. Desktop L/A directly choose Later/Archive and advance. Delete uses recoverable trash and advances. Keyboard previous/next retain the original browsing context; List returns to it.
- Open Markdown, Related notes and explicit Change article status remain context-aware commands, not duplicate article buttons. Visually avoid a repeated leading title without rewriting authored Markdown/headings.
- Ordinary highlights must remain visible when the host does not define its optional highlight-colour variable; preserve native theme integration with a safe fallback.
- Deletion uses recoverable Obsidian trash, never permanent removal.
- No user-facing batch-delete or "delete newer articles" command in v1.
- Exact `type: article` notes open in Reader. Open Markdown explicitly retains the native editor; dirty/uncertain editors, stale files and navigation intent are protected.
- Ordinary notes remain native; folder wins over YAML status for queue membership. Typed articles outside queue folders remain readable but unqueued. Templates and .trash are never indexed or routed into Reader. Settings Apply never migrates notes.
- Remember reading position as a text anchor in `bookmark` and restore it across sessions/devices via vault sync. The separate `dog_ear: true` current-article pointer moves on successful article entry and leaves reading-position anchors intact. Legacy `reading_position` remains preserved and inert, without fallback or conversion. List opens and next/previous navigation, including boundary keys, resume each article’s own saved position; do not force next-start/previous-end entry.
- Desktop j/k navigates articles, except while typing or interacting with menus/dialogs.
- Use native typography, themes, menus, and pickers; no Reader theme/type settings.
- Hide the floating mobile navigation bar only while Reader is active; restore it on normal notes/exit/unload, without hiding capture/keyboard controls.
- Boox pagination supports previous/next device buttons and touch page buttons, without animations. Up/PageUp at the article start opens the previous article; Down/PageDown at its end opens the next. Preserve ordinary scrolling/paging, guard editing/modal/selection input, and prevent held-key skipping.
- Pagination itself is device-local, not shared through vault sync. Up/down touch page buttons remain available in paged mode; the former left/right article controls are removed.

## Approved annotations and Nodes integration

- Approved tap highlighting: the existing article bottom bar enters Highlight mode and changes to icon-only Sentence, Paragraph, Done controls, with tooltips/accessibility labels and no visible explainer above the bar. Tap a first and last word for an inclusive single-block range, or tap a word then Sentence/Paragraph for its containing prose. The first tap is transient only; Done cancels/exits, Escape clears the endpoint then exits. Stay armed after save with a six-second guarded Undo; Undo never restores an entire note or reverses promotion. Native drag highlighting remains available outside the mode.
- Settled native text selection creates a hosted ordinary inline ==highlight==; inherit one valid typed article default without extra confirmation, otherwise require Reader's destination picker. Do not write mid-gesture; bind queued selections to their source and reject superseded jobs. Cancel passive jobs on tap-mode entry; suppress article-boundary/shortcut handoffs until exit.
- Expected unmappable passive selections quietly leave text unchanged; genuine save failures and explicit-action errors remain visible. Settling/feedback should be prompt, with accepted highlights renderable and visibly styled.
- Hosted highlights retain words/formatting/publisher URLs with one `(※ [[typed destination]])` group and native paragraph ID. Collect snapshots under each checked note’s `## Highlights`, grouped by native article H3, with precise citation + local `[[YYYY-MM-DD]]`. No automatic synchronization, regrouping or date backfill.
- One main **Add highlight to notes…** action opens staged multiselect; source-only removal/Undo and Done remain. Clicking the selected highlight again opens that action. Clicking a typed-note reference or link opens its note. Quiet accent references and all typed-note links show public Fileclass-resolved icons; decoration is not prose.
- Reader owns one lean typed-only title/type/icon picker with checked multiselection, fixed Apply/Cancel, exact/fuzzy reuse and public Fileclass creation; conversion remains single. No mode switch, generic files or untyped fallback. Explicit uncheck may remove only its uniquely matching unedited saved quote; missing/edited/ambiguous copies block before source mutation. See [hosted highlights](hosted-highlights.md).
- The footer **Related notes** multiselect edits article defaults, never earlier quotations. Preserve checked drafts on write errors/cancel, 44px rows/actions and public required-field completion. Only results scroll; no details pane, repeated Link confirmation or extra header row.
- Article `topics` now remembers typed destinations of any Fileclass; no untyped defaults or automatic reassignment of earlier highlights. Preserve transient current-queue filtering by topic name/aliases or free text, explicit links OR whole words/phrases, `Reading list: <topic>` context and accent clear-on-click behavior. Existing topic creation remains through public `createNodeForLink`; no private schemas/forms. The [topic-filter scope](topic-filter.md) predates the broader typed destination policy.
- Optional Nodes integration supports schema-aware search of existing nodes AND node creation.
- Joint-testing follow-up requires public **Nodes API v2** (`fileclass-inline.api`), not Reader-created node files/forms/schemas or private Fileclass calls. Older API versions are not silently accepted.
- V2 exposes Fileclass classes/icons, not schema colors; highlights keep their standard appearance. This replaces the earlier v1 color integration requirement.
- Use API v2 discovery for Reader's picker and optional `createNodeForLink` for creation. Commit through its callback before required completion; validate class membership, file/revision/editor safety and provider lifetime. Null/cancellation can leave a note; never prune it or silently create a fallback.
- Without a supported typed provider, new hosted highlights are unavailable; existing content stays readable. Use only `fileclass-inline`, no old-ID fallback/migration. Multi-file saves/removals are non-atomic: report verified progress, never guess absence as successful deletion, retry completed removals or remove an edited/unrelated copy.
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

- AI features, generated journals, synchronized/generated highlight collections and a separate browser app. Explicit snapshots and one-highlight-to-several-notes selection are approved; collecting several source highlights at once, last-used-node shortcuts, node-first collection and evidence roles remain deferred.
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
