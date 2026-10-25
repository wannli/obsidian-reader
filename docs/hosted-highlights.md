# Hosted highlights

Approved by Wannes in the Reader highlight-design discussion, the 20 October E2E follow-up and the subsequent native-tag and picker visual clarifications: one native-sized reference pill per highlight, with only Fileclass icons/names, a native-style multiselect, direct highlight-to-reference collection, explicit matching-copy removal, source grouping and collection dates. This supersedes shared-picker-only, single-destination and unconditional snapshot-retention restrictions only where stated below. It does not authorize migration, release or personal-vault installation.

## Markdown contract

An article preserves its selected words, emphasis and publisher links:

```markdown
==Clear **rules** build [trust](https://example.com/report).== (※ [[Governance]], [[Institutional trust]]) ^reader-k7m2
```

Each destination is an ordinary Fileclass-typed note. Collect a self-contained snapshot under `## Highlights`, grouped by a native source heading:

```markdown
## Highlights

### [[Reading/Decision rules|Decision rules]]

> Clear **rules** build [trust](https://example.com/report). (※ [[Reading/Decision rules#^reader-k7m2|Decision rules]] [[2026-10-20]])
```

- One native source heading groups new quotations from that article; each quote retains its own precise paragraph citation. Match source paths, not title equality. Do not move legacy flat quotations or rewrite authored headings on startup.
- The date is the local collection day, captured once for all new copies in an operation. It is an ordinary `[[YYYY-MM-DD]]` link, not a property or highlight identity. Retries preserve the existing date, including legacy undated copies.
- `(※ …)` is one unified reference group. One native block ID identifies a source paragraph; multiple highlights reuse it. Existing valid IDs are retained and are not per-highlight identities.
- Native formatting can require several `==…==` fragments for one logical selection. Keep one corresponding trailing reference group; no invisible IDs, annotation arrays, comments or sidecars.
- Only selected words are highlighted/quoted. Publisher URLs remain attached to their labels, including partial-label selections. Do not replace an external link with a node association.
- Reference labels, Fileclass icon decorations and block markers are not article prose: exclude them from quotation matching, tap ranges and reading-position anchors. Ordinary note-link labels remain prose even when an icon is displayed.
- Existing authored Markdown and unknown properties survive. There is no startup conversion, date backfill, regrouping or automatic reassignment.
- An older `==[[Note|words]]==` is still an ordinary linked highlight, not proof that a particular quotation may be deleted. Do not automatically convert it or backfill destination copies; any migration requires a separate reviewed proposal.

## Reader interaction

All destinations for one highlight share a single pill using Obsidian’s native tag sizing, padding, radius and theme tokens. Each destination retains its own Fileclass icon/name and independent link; no generic marker is rendered. The ordinary `(※ …)` citation grammar remains unchanged in Markdown. They remain note-reference links, not tag-search controls; they do not enlarge paragraph line boxes or add invisible hit areas over adjacent prose. Floating actions and picker rows retain ≥44px targets. All links to publicly recognized Fileclass notes keep their resolved node icon, falling back only to a matching registered class icon. Icons and reference labels are decoration, not quotation text. Publisher links and untyped notes keep their normal presentation. No raw-YAML class inference or private Fileclass icon lookup.

- One main action, **Add highlight to notes…**, opens initially empty full-width search, never preset to the highlighted quotation, and quiet native-style suggestion rows with checked multiselection, compact icons and visibly separated title/type metadata. No existing/create mode switch, selected-details panel or **Link** confirmation. Choose several notes, then apply once.
- A normal click on a highlight selects it and shows its actions. Clicking a note-reference opens that exact note, even while a highlight is selected. Native modifier-click opens it in another pane. The separate **Open note** action is unnecessary.
- A second click on the same selected highlight opens **Add highlight to notes…**. The same action remains in the passage toolbar and opens that highlight's notes multiselect. **Choose from article…** can select another highlighted passage as a destination; note links continue to navigate. Removing a destination happens in the multiselect, not through a separate passage button.
- The article’s existing `topics` also appear in the top reading header with the same compact pill styling and Fileclass icons. A matching authored title remains untouched in the body, below that metadata row. This is metadata presentation, not a new tag field or a filing gesture.
- The blue **Related notes** action sits to the right of the green **Create node** action and separately edits remembered defaults. It does not reassign earlier highlights or erase previously filed quotes.
- **Create node** handles an unhighlighted passage's ordinary note-link conversion. The selected-highlight toolbar does not repeat that conversion action.
- The separate **Create node** article control uses the same first/last word or Sentence/Paragraph tap range as Highlight mode, but does not save a highlight first. Its picker is titled **Create typed note from passage**. Leading and trailing punctuation and quotation marks stay in the article outside the new link and are omitted from the suggested passage text. It opens typed destination choice (including explicit public creation), without inheriting a highlight default. The article receives an ordinary aliased note link and paragraph anchor, no `==` or quotation snapshot. A newly created destination receives `origin` for that paragraph; reuse never changes an existing origin. Publisher-link conflicts and unmappable selections fail without altering the source.

## Typed destination selection

Reader owns the picker. Fileclass Inline supplies public API v2 discovery, classes/icons, creation and required-field completion; Reader never copies schemas/forms or calls private provider APIs.

- Only current registered Fileclass members are eligible, validated with `classes.includes(...)`, including multi-class notes. A primary `type` or arbitrary YAML string is not proof. All types means all Fileclasses, not all files.
- Show clear primary titles with separately styled muted types; add path context only when otherwise ambiguous. Creation rows remain compact even for long selected passages, while preserving the full query and accessible action name. Search/alias/fuzzy reuse remains explicit. Draft checks survive search/type filters; Apply/Cancel is staged and cancellation performs no write.
- Creation is explicit with a registered class and title. Reader passes the already chosen title through Fileclass Inline's public `acceptSuggestedTitle` option, so a valid unique name needs no second name prompt in Add highlight, Related notes or Create typed note from passage. One new typed note can be created together with existing checked destinations; the public callback commits the source before required completion. Never invent an untyped or standalone-creation fallback.
- Every new highlight needs at least one typed host. Inherit one eligible article default; zero or several requires explicit selection. Never silently choose the first or last-used note.
- Article `topics` remembers typed destination links from any Fileclass. Bulk editing replaces only known eligible links; retain unknown/untyped/unresolved authored values, retained aliases and order. It does not rewrite previous passage associations.
- Cancelling never authorizes deletion of a provider-created note. A stale/reloaded/missing provider blocks new writes with a clear error; existing content remains readable.

## Explicit removal and snapshot ownership

Quotations are user-owned snapshots, not synchronized projections. Source text edits, file removal, conversion, ordinary source-local Undo and article-level Related notes changes never automatically rewrite or delete them.

An explicit removal of a note from a particular highlight is different: remove its source reference **and the corresponding saved quotation**, only when the current quote text/formatting and paragraph citation identify one exact, unchanged active top-level copy—not code or comment examples. A valid collection date is not its identity; legacy undated copies remain removable.

- Preflight every added/removed target before changing the source. Missing, edited or ambiguous matching copies block removal with a clear warning, rather than deleting another passage or silently claiming success.
- Never delete the note, other quotations, birth `origin`, unknown text or authored sections. Empty section/source headings may remain because their authorship cannot be inferred safely.
- Clearing all checked notes from an existing highlight removes that logical highlight's delimiters/reference group, not its words, formatting, publisher/wiki links or shared paragraph anchor. This also preserves source-order associations inside shared publisher links.
- Multi-file writes are not atomic. Preserve saved source state and verified target progress; report a failed append/removal honestly. A retry must not retry already completed removals or treat a missing copy as proof of an earlier deletion. No persisted recovery queue or blind rollback.
- Exact quote plus paragraph citation deduplicates unchanged filing retries independently of the optional date. Different quotations from one paragraph stay distinct. Without per-highlight IDs, edited citations, disabled native link updates and cross-device races cannot promise perfect matching.

## Explicit node-only conversion

```markdown
Institutions build [[Institutional trust|institutional trust]]. ^reader-k7m2
```

Conversion is explicit, never inferred from title equality. Remove highlight markers/redundant destination group, retain the words as a native alias where needed, and refuse publisher-link conflicts rather than discarding URLs. Do not add a quotation of the node's own name.

Only a newly created note receives birth provenance, alongside its normal Fileclass properties:

```yaml
origin: '[[Reading/Decision rules#^reader-k7m2]]'
```

Preserve existing origins, including empty/null/unusual values; reuse never invents an origin. Paragraph citations and new source headings use the actual postmove article path.

## Write safety and acceptance

- Recheck source identity/revision/displayed body, destination eligibility, writable buffers and provider/view lifetime at mutation boundaries. Reject stale sources, dirty/uncertain editors and duplicate callbacks.
- Promotion remains source-first: retain Feed → save annotation → move → reread actual bytes/path. Preserve bookmarks, browsing context and native link-update preferences. Removal never reverses retention.
- One source commit serves all selected destinations; destination work uses nonnested file lanes and phase-aware guards. A later new selection must not cancel a quotation whose source annotation is already saved.
- Drain dispatched writes on close/reconfiguration. Cancellation stops undispatched work and never holds navigation hostage to an uncooperative required-field provider.

Automated tests cover mapping, shared-link associations, typed multiselection/creation, exact removal, grouping/dates, source relocation, revision/editor guards, provider lifetime and partial writes. DOM tests are not native/device proof.

The owned E2E vault has a backed-up manual corpus. Preserve its marker, settings, existing classes, companion settings and Sync boundaries. Native input is returned to Wannes / **hold true** outside a fresh scoped maintenance session. No agent runtime access through a closed lease.

Deferred: collecting several source highlights at once (#39), last-used destinations (#38), node-first collection (#41) and evidence roles (#40). Multiselect here means several destination notes for **one** highlight.
