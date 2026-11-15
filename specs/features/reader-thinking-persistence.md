---
created: 2026-11-15
updated: 2026-11-15
status: proposed-requires-approval
---

# Persistence proposal: native notebooks, entries and explorations

This companion to the [workflow spec](reader-thinking-workflow.md) is a **proposal**, not a decided schema. No implementation may create these structures until Wannes approves their concrete format. No existing article, highlight, quotation or companion setting may be migrated implicitly.

## Approved invariants

- Meaningful work is ordinary Obsidian Markdown/native links, readable without Reader. Obsidian alone synchronizes files.
- A passage can stand alone, without classification, comment, destination selection or a compulsory per-item note.
- Comments may attach to a passage or sit independently between paragraphs. New personal content does not rewrite article bodies.
- Reuse and exploration inclusion must not manufacture synchronized copies of the same personal writing.
- Deliberately created standalone structured notes remain Fileclass-typed. Native note/block links supply ordinary reference targets; no general knowledge-identity system is approved.
- Unknown authored content and legacy marks/quotation snapshots are protected. Saved snapshot text is never silently updated to match a changed source.

## Recommended representation

Use **ordinary Fileclass-typed notebooks as containers**, with unclassified Markdown entries inside them. Use ordinary Fileclass-typed exploration notes for authored prose and native references. A notebook is independent authored content, not a machine mirror or article sidecar. There is no mandatory one-notebook-per-article relationship.

This separates infrastructure typing from semantic classification: selecting words does not ask whether they are a Claim, Topic or Person. It also avoids a new physical note for every passage/comment. Entries are addressable through native block references, not UUID properties or a separate entity store.

### Notebook setup and provider behavior

- Add an explicit one-time setup action to choose an existing eligible Fileclass notebook or create one through Fileclass. Store only its normal note link as the capture preference; obtain approval for that setting before implementation.
- Show the intended notebook during setup. Ordinary Keep afterwards uses it without a destination picker. Allow explicit notebook switching from settings, not a required choice for every passage.
- New notebook/exploration creation uses Fileclass schema validation and required-field prompts. Reader must not install or modify Fileclass types/settings automatically. No implicit generic type is fabricated.
- Discover notebooks/explorations by configured Fileclass type bindings, not magic folders, filenames or an imported W catalog. Proposed roles are configured existing types, not new Reader-specific node classes.
- Existing notebook content stays readable without Fileclass. Proposed rule: append/edit existing validated entry regions without Fileclass; disable container/structured-note creation and schema-field writes when it is unavailable. This narrow body-edit exception needs approval against today's provider-dependent creation guide.
- Missing, renamed, dirty, ambiguous or malformed capture notebooks block the affected save with an actionable local error; do not silently select another or create a hidden fallback file. Native renames update resolved links subject to Obsidian's link preference.
- Setup is a real usability cost: first capture requires one configured container. This is not a semantic classification prompt, but must be approved rather than hidden behind “no setup.”

### Proposed native Markdown vocabulary

The following field names and shapes are proposed persisted contracts. Built-in callouts distinguish entry roles; native block IDs address saved records. Visible labels supply source evidence. No HTML comments, encoded JSON, custom processor expressions or synchronized shadow files are introduced.

The [native record grammar](reader-thinking-record-format.md) supplies complete passage, attached-comment, gap-comment and free-comment specimens. That companion is part of this proposed schema, not an optional implementation detail. An example notebook's Fileclass binding could be `fileClass: Notebook`; the actual binding/type comes from its configured provider.

- Fileclass supplies its actual binding property and selected type; `fileClass: Notebook` is illustrative, not an imposed property/type. Existing required fields are preserved by the provider.
- Native block IDs are proposed **record references**, not article IDs or a general graph identity. Approve this limited exception to the prohibition on new persisted IDs; do not smuggle UUID properties or history/cursor fields into notes.
- Keep source link, publisher URL when available, local collection-date link and bounded adjacent visible text. Do not persist full article copies, numeric reading offsets, hashes, acquisition metadata or device history.
- Parse records using the exact grammar companion: separate metadata paragraphs, a metadata/body divider, and a final reserved Connections section inside the same callout before its block ID. Only the explicit section defines new entry-owned edges. Ordinary body lists/links remain prose. Preserve all other blocks byte-for-byte; ambiguous structures are read-only.
- Proposed context bound is 160 Unicode code points before and after the selected words within eligible source blocks. The snapshot preserves the full user selection; selections spanning unsupported Markdown blocks are rejected with a reason before any save.
- Preserve rich quotation formatting using the current source projection; normalize neither authored comment text nor snapshot words after save. Snapshot edits made natively become user-authored content and cannot authorize automatic dedup/removal.
- A Comment's **About** may reference a passage or another saved item. An independent interleaved comment instead carries **Source**, optional **URL**, **Before**, **After** and **Collected** labels; its insertion gap is recovered only from a unique adjacent-context match.
- Do not auto-save a source block ID into the article. Reuse an existing valid source block target when already present; otherwise native article-level return plus saved quote/context is the durable fallback.
- No explicit source means a local free comment, not a fabricated source citation. Never treat selected private comment words as public publisher text.

### Exploration and connection shape

```markdown
---
fileClass: Exploration
---

# A question I am exploring

Unfinished personal writing.

- [[Reading notebook#^passage-quiet-river|A useful passage]]
- [[Reading notebook#^comment-small-stone|My response]]
- [[Reading/Later/Example|A source to revisit]]

More authored writing can follow without a special section.
```

- Exploration inclusion is an ordinary list link to the original. Repeated inclusion of the same resolved target in one exploration is a no-op. Native Obsidian embeds are optional user-authored presentation, not a second copy of the source record.
- Inclusion removal deletes only the exact unedited membership line the user selected. Authored surrounding prose, reused references elsewhere and the referenced item remain intact. Ambiguity blocks removal.
- Reordering moves only selected native list entries through guarded Markdown edits; do not reorder free prose or assume the entire file is Reader-owned.
- Explicit connections live in the owning callout's final reserved Connections section, before its block ID. Each list entry is a native target link with an optional plain-text label after an em dash. Encode labels as escaped single-line Markdown text; reject newlines/control characters. This is a visible record convention, not a new relation catalog.
- Direction is the owning entry → linked target. Reverse display derives from native backlinks/current parsing; do not persist a second inverse edge. Duplicate exact resolved endpoint+label is a no-op. Changed labels are an explicit edit.
- Notebook entries are the only proposed new connection owners. Existing Fileclass note-to-note relation fields retain provider ownership; connecting from a structured note uses supported Fileclass fields or remains unavailable, rather than writing a hidden generic edge.
- Native block/file links resolve after moves under Obsidian preferences. Removing or changing a target block ID natively can break its link; show unresolved evidence rather than mint a replacement identity.
- Editing a saved comment updates its owned body region only after checking fresh bytes. Reader does not offer deletion of individual shared-notebook records in this first scope: native trash cannot recover one block. Users may edit/delete blocks in native Markdown with Obsidian's ordinary history/Undo limitations. Keep unresolved links visible rather than pruning them. Entire notebook/exploration file deletion uses recoverable native trash.

## Safety, limits and approval consequences

- Each document is meaningful by itself. No content depends on a generated index, private graph or daemon. Rebuild read-only indexes from observed notes; never persist completeness or activity flags into them.
- Explicit Create structured note from a saved entry gives a newly created note an `origin` native link to that saved notebook block, preserving an existing origin. The entry already contains source citation/context, so no article anchor is inserted. Link back to the created note through the entry's explicit Connections section; do not automatically duplicate a quotation. If creation succeeds and backlink fails, preserve the note and show the incomplete link. This proposed origin convention needs approval; explicit legacy source conversion remains separate.
- File-wide guarded updates preserve current bytes outside the exact selected record/list region. No reconstruction from a parsed whole-file model may erase comments, frontmatter, unknown callouts or hand-edited text.
- A source retention change and notebook append are not a transaction. Save retention first; failed append leaves a protected source. Notebook success followed by failed exploration inclusion keeps the saved item and reports the incomplete inclusion.
- Validate a save by fresh snapshot evidence before dispatch and readback after settlement. A native edit after readback is a later user change, not grounds for background repair. No cross-device lock or uniqueness guarantee is invented.
- Current repeat capture may reuse an unedited passage only when source identity, quote and adjacent-context evidence prove the same selected occurrence. Repeated identical paragraphs remain ambiguous; ask the user to open candidates, not assign identity by quotation equality.
- Allocate native anchors only after scanning fresh target bytes for collisions; recheck in the guarded update. Missing/duplicate anchors and multiple matching structural boundaries make the affected records read-only. A native write followed by failed/changed readback returns **Possibly saved**, not failed/unsaved. Preserve it and inspect existing evidence before any retry.
- First overview derives dates only from explicitly saved collection dates and ordinary authored date links. Do not use file mtime or synthetic event history as proof that thinking developed. Initial overlapping lenses are existing exploration memberships; arbitrary Domain labels/fields and a new Domain schema are deferred until their concrete semantics are approved.
- Deleting a notebook can break many links. Warn on Reader-initiated deletion, use native recoverable trash and never cascade deletion. Native deletion outside Reader remains possible; source articles stay protected when reference-index coverage is uncertain.
- Source expiry safety requires current protection authority at final trash dispatch, not a cached negative. Track a generation-local content revision over relevant notebook/exploration and native-reference observations. Creation, native edits, moves, trash, lost type bindings, stale metadata or malformed formerly recognized records revoke negative coverage before async work. Untyped/malformed formerly known containers remain possible incoming-reference evidence; conservatively retain sources until a fresh native-reference scan proves otherwise. Revision mismatch at final dispatch aborts deletion. The ArticleStore module consumes this read-only authority and existing final-byte guard without taking another file write lane. No completeness flag is persisted.
- A single shared notebook increases simultaneous-edit conflict risk; native file/block links can break when users edit anchors. These are standard-file tradeoffs, not solvable by claiming Obsidian Sync is transactional.

## Alternatives considered, not approved

1. **One ordinary typed note per passage/comment:** simpler file-level ownership and links, but creates many notes and makes unclassified capture look like mandatory per-item note creation. Not recommended for the agreed lightweight flow.
2. **Source-side marks or embedded comment records:** simple local anchors, but contradicts source-body preservation. Not recommended; legacy marks remain unchanged.
3. **An authoritative graph, hidden JSON/SQLite or article sidecars:** easier machine identity, but violates the chosen Obsidian durability/clean-content direction. Rejected as the default.
4. **Notebook entries, recommended above:** fewer notes and no per-item classification, with an explicit setup step and a native Markdown record convention that needs approval.

## Approval gate

Review this as one concrete persisted-format proposal, not a claim that these fields are already approved. In particular approve or revise: notebook/exploration setup through Fileclass; exact callout labels and native block IDs; context bounds and source-return evidence; membership/connection ownership; existing-container edits without Fileclass; the local capture preference; and the effect of new references on retention/deletion. URL equivalence and cross-device duplicate conflicts need the compatibility acceptance described in the main spec.

If the proposal is declined, revise this companion and affected tests before implementation. Do not implement a temporary format and migrate it later. No permission is requested here to convert existing material, configure a personal vault or automatically reconcile duplicates.
