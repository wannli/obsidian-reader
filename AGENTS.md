# Reader — agent guide

Start with the [codebase map](docs/map.md), [approved scope](docs/rebuild-spec.md), and [storage contract](docs/storage-contract.md).

## Identity and compatibility

- Product: Reader. Obsidian plugin ID: `obsidian-reader`; GitHub repository: `wannli/obsidian-reader`.
- Reader alone requires Obsidian ≥1.8.0. New hosted highlights require Obsidian ≥1.12.7 and public `fileclass-inline.api` v2 typed-note discovery; typed creation additionally requires `createNodeForLink`. No old plugin-ID fallback or migration.
- This is a standalone plugin. Do not import or migrate settings, hotkeys, workspace views, plugin enablement, or vault data from another plugin without Wannes's explicit migration plan.
- Preserve unknown Markdown/frontmatter and user-authored content. Before changing persisted note schemas or data structure, present the proposal and wait for approval. Do not add `created-by` properties to Markdown files.
- Keep documentation under 200 lines unless approved otherwise.

## Rebuilt architecture

- `src/main.ts` owns commands, routing and generation-bound services. Folder reconfiguration stops old views/work, drains dispatched writes and creates fresh Reader list views; it must not reopen/acquire/promote articles as a side effect.
- `src/core/` owns Markdown snapshots, metadata indexing, capture-destination validation and guarded writes. Recheck source bytes, file identity and dirty-editor safety at mutation boundaries.
- `src/content/` bounds and sanitizes external content. `src/host/` adapts native vault, network, dialogs/settings and optional Nodes APIs; keep uncancellable native requests in their occupied slots until settlement.
- `src/reader/` renders the list/articles. `src/reader/styles.css` is the sole source stylesheet: leaf-owned floating controls, ≥44px targets, scrollbar/final-content clearance and aligned paged column geometry.
- Use ordinary Fileclass-typed notes, not a separate Reader node entity. Reader owns the highlight-specific typed picker; Fileclass Inline owns schema-aware creation/required completion through its public API. No untyped/All files route or standalone creation fallback. New highlights require a host; existing content remains readable without the provider. Follow [hosted highlights](docs/hosted-highlights.md), including source citations, quotation snapshots and new-note `origin`. Cancellation never authorizes deleting a created note or blocking navigation on an uncooperative provider.
- All article entry resumes the destination's saved position. Preserve explicit Open Markdown, dirty/uncertain editors, selection/modal/input guards and held-key protection.

## Development and release

- Use `mise exec -- ...` with the pinned Node runtime from `.mise.toml`. `npm run check` runs formatting, metadata, types, both test suites, and build; `npm run format` applies the shared formatter.
- Target <5s for focused checks and <10s for the full automated test suite locally. Use Node by default and DOM only where needed. No automated E2E suite; native/device checks are manual.
- Never use a personal vault. Runtime tooling is restricted to the repository's marked synthetic vaults under `.sandbox`; a missing or mismatched ownership marker blocks work.
- With multiple worktrees, verify source authority and active file ownership before editing/building. Never replace validated code with an older partial rebuild or overwrite parallel features.
- Pin native CLI calls to the registered vault ID before the command; verify the owned path and renderer. Respect native-input holds, even for read-only evaluation.
- In the shared Sync acceptance vault, keep Hot Reload, watchers, corpora, backups and instrumentation out of Sync. Do not change Sync or companion-plugin settings without explicit authorization.
- Whenever requested work is complete and you are confident in its correctness after appropriate validation, commit your changes and push them to remote `main`; Wannes grants standing authorization for these commits and pushes. If validation or a safe push is blocked, report the blocker rather than forcing the push. Use Conventional Commits and describe the implemented scope and validation in the body.
- Do not stash, discard, auto-merge, or include unrelated work. Vault installation remains a separate authorization boundary. Hot Reload is for isolated development, never the shared Sync acceptance profile.
- Release management is exclusively Wannes's responsibility. Do not perform version bumps, changelog release updates, tag creation/movement, release PR merges, publication, or other release actions. Release Please owns version and changelog updates; Wannes handles releases by merging its PR.
- Report actual checks run. Browser simulations do not prove native iOS, e-ink hardware, or cross-device sync behavior.

## Storage principles

- Markdown is authoritative. Article body and inline highlights use ordinary Markdown; operational reading state is YAML. Keep the article/feed examples in README and the storage contract consistent with implementation.
- Discover articles/subscriptions by exact `type`, excluding Templates and .trash at any depth. Article queue membership comes from four configurable nonoverlapping queue folders (defaults Inbox, Stream/Feed, Later, Treasury/Archive), not YAML `status`; outside folders, typed articles remain readable but unqueued. Reader status actions write YAML then move; external folder/YAML edits do not rewrite the other representation. Only a Feed-folder article with fresh explicit `status: feed` can expire. Manual/browser captures and observed live native/QuickAdd inbox articles enter Inbox; RSS imports enter Feed. The old article capture destination is inert. No startup/settings-apply sweep or automatic migration.
- Opened-before indicators derive from existing usable `bookmark` text anchors; highlight indicators derive from Markdown. The approved `dog_ear: true` current-article pointer is separate from position and indicators; move it on successful Reader article entry and use newest Inbox as the shortcut fallback. Legacy `reading_position` remains untouched and inert. Feed-folder annotations promote to Later before commit; Reader Delete/expiry archives topic-bearing or annotated articles rather than trashing them. Reads stay bounded/cancellable for visible rows and never persist extra flags or trigger promotion.
- Preserve unknown properties, titles, authored sections/comments, user text, journals and backlinks. No sidecars or synchronized copies. Quotations are user-owned snapshots: source edits/Undo never prune them; only an explicit highlight-destination removal may delete a uniquely matching unedited copy. Follow the hosted contract for source grouping, local date links and partial removals.
- Follow the approved [storage contract](docs/storage-contract.md), `src/core/model.ts`, and `src/core/document.ts`. New notes must not persist IDs, cursor/history state, or acquisition metadata; unknown nonempty text remains protected unless ownership is proven from its current bytes.
- Every feed refresh is limited to the latest 20 entries before deduplication/age filtering. Do not revive superseded implementations, migrations, QuickAdd assets, or old settings.
- Runtime must work on Obsidian mobile and avoid Node/Electron-only imports in plugin code.
