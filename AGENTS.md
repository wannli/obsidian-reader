# Reader — agent guide

## Identity and compatibility

- Product: Reader. Obsidian plugin ID: `obsidian-reader`; GitHub repository: `wannli/obsidian-reader`.
- This is a standalone plugin. Do not import or migrate settings, hotkeys, workspace views, plugin enablement, or vault data from another plugin without Wannes's explicit migration plan.
- Preserve unknown Markdown/frontmatter and user-authored content. Before changing persisted note schemas or data structure, present the proposal and wait for approval. Do not add `created-by` properties to Markdown files.
- Keep documentation under 200 lines unless approved otherwise.

## Development and release

- Use the pinned Node runtime from `.mise.toml` and the existing npm scripts. `npm run check` is the full local validation command.
- Never use a personal vault. Runtime tooling is restricted to the repository's marked synthetic vaults under `.sandbox`; a missing or mismatched ownership marker blocks work.
- Do not stash, discard, auto-merge, or include unrelated work. Commit completed validated development work directly to `main` using Conventional Commits. Pushes, version changes, tags, publication, and vault installation require explicit authorization.
- Release Please owns version and changelog updates. Release only by merging its PR; do not create or move tags manually.
- Report actual checks run. Browser simulations do not prove native iOS, e-ink hardware, or cross-device sync behavior.

## Storage principles

- Markdown is authoritative. Article body and inline highlights use ordinary Markdown; operational reading state is YAML.
- Preserve unknown properties, explicit titles, authored headings/comments, user text, journals, and backlinks. Do not introduce sidecars or generated synchronized copies.
- Follow `src/types.ts` for code schemas. New article notes must not persist retired IDs or acquisition metadata; unknown nonempty text remains protected unless ownership is proven from its current bytes.
- Runtime must work on Obsidian mobile and avoid Node/Electron-only imports in plugin code.
