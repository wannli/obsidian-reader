# Reader — agent guide

Start with the [codebase map](docs/map.md), [approved scope](docs/rebuild-spec.md), and [storage contract](docs/storage-contract.md).

## Identity and compatibility

- Product: Reader. Obsidian plugin ID: `obsidian-reader`; GitHub repository: `wannli/obsidian-reader`.
- This is a standalone plugin. Do not import or migrate settings, hotkeys, workspace views, plugin enablement, or vault data from another plugin without Wannes's explicit migration plan.
- Preserve unknown Markdown/frontmatter and user-authored content. Before changing persisted note schemas or data structure, present the proposal and wait for approval. Do not add `created-by` properties to Markdown files.
- Keep documentation under 200 lines unless approved otherwise.

## Development and release

- Use `mise exec -- ...` with the pinned Node runtime from `.mise.toml`. `npm run check` runs formatting, metadata, types, both test suites, and build; `npm run format` applies the shared formatter.
- Target <5s for focused checks and <10s for the full automated test suite locally. Use Node by default and DOM only where needed. No automated E2E suite; native/device checks are manual.
- Never use a personal vault. Runtime tooling is restricted to the repository's marked synthetic vaults under `.sandbox`; a missing or mismatched ownership marker blocks work.
- Do not stash, discard, auto-merge, or include unrelated work. Commits, pushes, version changes, tags, publication, and vault installation require explicit authorization. When authorized, use Conventional Commits. Synthetic-vault installation and Hot Reload are approved for this rebuild, not personal-vault deployment.
- Release Please owns version and changelog updates. Release only by merging its PR; do not create or move tags manually.
- Report actual checks run. Browser simulations do not prove native iOS, e-ink hardware, or cross-device sync behavior.

## Storage principles

- Markdown is authoritative. Article body and inline highlights use ordinary Markdown; operational reading state is YAML.
- Preserve unknown properties, explicit titles, authored headings/comments, user text, journals, and backlinks. Do not introduce sidecars or generated synchronized copies.
- Follow the approved [storage contract](docs/storage-contract.md), `src/core/model.ts`, and `src/core/document.ts`. New notes must not persist IDs, cursor/history state, or acquisition metadata; unknown nonempty text remains protected unless ownership is proven from its current bytes.
- Every feed refresh is limited to the latest 20 entries before deduplication/age filtering. Do not revive superseded implementations, migrations, QuickAdd assets, or old settings.
- Runtime must work on Obsidian mobile and avoid Node/Electron-only imports in plugin code.
