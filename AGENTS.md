# Reader — agent guide

Start with the [codebase map](docs/map.md), [approved scope](docs/rebuild-spec.md), and [storage contract](docs/storage-contract.md).

## Identity and compatibility

- Product: Reader. Obsidian plugin ID: `obsidian-reader`; GitHub repository: `wannli/obsidian-reader`.
- Reader alone requires Obsidian ≥1.8.0. Combined Nodes/Fileclass integration requires Obsidian ≥1.12.7 and public Nodes API v2.
- This is a standalone plugin. Do not import or migrate settings, hotkeys, workspace views, plugin enablement, or vault data from another plugin without Wannes's explicit migration plan.
- Preserve unknown Markdown/frontmatter and user-authored content. Before changing persisted note schemas or data structure, present the proposal and wait for approval. Do not add `created-by` properties to Markdown files.
- Keep documentation under 200 lines unless approved otherwise.

## Rebuilt architecture

- `src/main.ts` owns commands, routing and generation-bound services. Folder reconfiguration stops old views/work, drains dispatched writes and creates fresh Reader list views; it must not reopen/acquire/promote articles as a side effect.
- `src/core/` owns Markdown snapshots, metadata indexing, folder validation and guarded writes. Recheck source bytes, file identity and dirty-editor safety at mutation boundaries.
- `src/content/` bounds and sanitizes external content. `src/host/` adapts native vault, network, dialogs/settings and optional Nodes APIs; keep uncancellable native requests in their occupied slots until settlement.
- `src/reader/` renders the list/articles. `src/reader/styles.css` is the sole source stylesheet: leaf-owned floating controls, ≥44px targets, scrollbar/final-content clearance and aligned paged column geometry.
- Use Notes, not a separate Reader node entity. Nodes creation links the source before required completion through API v2 when available; cancellation must not delete a created note or block navigation on an uncooperative provider.
- All article entry resumes the destination's saved position. Preserve explicit Open Markdown, dirty/uncertain editors, selection/modal/input guards and held-key protection.

## Development and release

- Use `mise exec -- ...` with the pinned Node runtime from `.mise.toml`. `npm run check` runs formatting, metadata, types, both test suites, and build; `npm run format` applies the shared formatter.
- Target <5s for focused checks and <10s for the full automated test suite locally. Use Node by default and DOM only where needed. No automated E2E suite; native/device checks are manual.
- Never use a personal vault. Runtime tooling is restricted to the repository's marked synthetic vaults under `.sandbox`; a missing or mismatched ownership marker blocks work.
- With multiple worktrees, verify source authority and active file ownership before editing/building. Never replace validated code with an older partial rebuild or overwrite parallel features.
- Pin native CLI calls to the registered vault ID before the command; verify the owned path and renderer. Respect native-input holds, even for read-only evaluation.
- In the shared Sync acceptance vault, keep Hot Reload, watchers, corpora, backups and instrumentation out of Sync. Do not change Sync or companion-plugin settings without explicit authorization.
- Do not stash, discard, auto-merge, or include unrelated work. Commits, merges, pushes, version changes, tags, publication and vault installation are separate authorization boundaries. When authorized, use Conventional Commits and describe the implemented scope and validation in the body. Hot Reload is for isolated development, never the shared Sync acceptance profile.
- Release Please owns version and changelog updates. Release only by merging its PR; do not create or move tags manually.
- Report actual checks run. Browser simulations do not prove native iOS, e-ink hardware, or cross-device sync behavior.

## Storage principles

- Markdown is authoritative. Article body and inline highlights use ordinary Markdown; operational reading state is YAML. Keep the article/feed examples in README and the storage contract consistent with implementation.
- Inbox, Stream, Later, Treasury and subscriptions are five independent settings. Reject duplicate/overlapping paths; no legacy-root import, automatic note moves or note-schema rewrites. Preserve unknown settings inert.
- Opened-before indicators derive from existing usable `reading_position`; highlight indicators derive from Markdown. Reads stay bounded/cancellable for visible rows and never persist extra flags or trigger promotion.
- Preserve unknown properties, explicit titles, authored headings/comments, user text, journals, and backlinks. Do not introduce sidecars or generated synchronized copies.
- Follow the approved [storage contract](docs/storage-contract.md), `src/core/model.ts`, and `src/core/document.ts`. New notes must not persist IDs, cursor/history state, or acquisition metadata; unknown nonempty text remains protected unless ownership is proven from its current bytes.
- Every feed refresh is limited to the latest 20 entries before deduplication/age filtering. Do not revive superseded implementations, migrations, QuickAdd assets, or old settings.
- Runtime must work on Obsidian mobile and avoid Node/Electron-only imports in plugin code.
