# Files, highlights and typed notes

This is a field reference for the current implementation, not a schema change or migration. The [storage contract](storage-contract.md) governs capture, retention and guarded writes; [hosted highlights](hosted-highlights.md) governs collection and removal.

## File kinds and identity

All persisted content is ordinary vault Markdown. Reader recognizes an article by the exact YAML scalar `type: article`, and a subscription by `type: feed`. Discovery excludes path components named `Templates` or `.trash`, case-insensitively, at any depth. A filename, folder or Fileclass membership alone does not identify a Reader article/subscription.

Article/subscription mutations require a leading YAML frontmatter mapping delimited by `---`. Duplicate keys, unsupported YAML and unsafe editor/revision state block writes. Unknown properties, comments and authored body content are preserved; no `created-by`, record IDs, annotation arrays, sidecars or acquisition stamps are added.

| File kind                    | Identity and location                                                                           | Body                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Article                      | Exact `type: article`; readable anywhere outside excluded paths                                 | Article Markdown, inline highlights, note links and native paragraph anchors |
| Subscription                 | Exact `type: feed`; new notes default to `Reading/Feeds`                                        | Any authored text remains user-owned                                         |
| Highlight destination / node | Ordinary note recognized by public Fileclass membership; no Reader-specific node type or folder | Authored content plus explicitly collected quotation snapshots               |

Paths and native links connect these files. Renames use Obsidian's link-aware move API and respect its link-update preference. There is no independent persisted Reader identity to repair links when native link updates are disabled.

## Article frontmatter

| Property    | Shape                                              | Meaning and missing-value behavior                                                                                                                                                                   |
| ----------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`      | Exact string `article`                             | Required for Reader article recognition                                                                                                                                                              |
| `url`       | HTTP(S) URL string, without credentials            | Required for capture/acquisition; optional for reading local text. Invalid URLs do not prevent reading. URL matching normalizes the URL and removes its fragment.                                    |
| `title`     | String                                             | Optional display title; a missing/blank title displays the filename without a leading `YYMMDD `. Acquisition preserves an explicitly present title, even empty.                                      |
| `status`    | `inbox`, `feed`, `later` or `archive`              | Optional mirror written by Reader status actions. Folder membership determines the list; missing/invalid/conflicting status protects against expiry.                                                 |
| `published` | Date string; new writes use `YYYY-MM-DDTHH:mm`     | Optional on existing notes. Reader captures write publication or capture time. New values are unquoted local minutes; valid existing date-only/offset/ISO values are readable without normalization. |
| `feed`      | Quoted wikilink string                             | Optional subscription provenance, e.g. `'[[Reading/Feeds/Example.md]]'`; retained after queue changes                                                                                                |
| `topics`    | List of quoted wikilink strings                    | Remembered typed destinations for future highlights, e.g. `['[[Topics/Reading]]']`. Existing unknown/unresolved/untyped values remain protected.                                                     |
| `bookmark`  | Trimmed text string, at most 256 UTF-16 code units | Optional reading-position anchor, not a page/percentage or completion marker. Empty saves remove the property; an unsupported existing value blocks position replacement.                            |
| `dog_ear`   | Boolean `true`                                     | Optional current-article pointer, moved on successful Reader entry. Only exact boolean `true` counts; other authored values are preserved. Independent of `bookmark`.                                |
| `error`     | String                                             | Optional acquisition failure message; successful acquisition clears it                                                                                                                               |

Legacy `reading_position` is inert and preserved. No read history or completion property is stored. Opened-before indicators use usable `bookmark` text; highlight indicators inspect Markdown.

| Queue   | Default folder     | Status written by Reader |
| ------- | ------------------ | ------------------------ |
| Inbox   | `Reading/Inbox`    | `inbox`                  |
| Feed    | `Reading/Stream`   | `feed`                   |
| Later   | `Reading/Later`    | `later`                  |
| Archive | `Reading/Treasury` | `archive`                |

The four folders are configurable and cannot overlap. Articles elsewhere are unqueued. External folder/YAML edits do not rewrite the other representation; Reader status actions write YAML then move. Only a Feed-folder article with fresh explicit `status: feed` can expire. Feed annotations retain the article in Later; topics/annotations cause Reader Delete or expiry to archive rather than trash it.

Minimal local article:

```markdown
---
type: article
---

Text that can be read without a source URL or Fileclass provider.
```

For a complete capture example, see the [article contract](storage-contract.md#article). Reader capture filenames are `YYMMDD Title.md` or `YYMMDD Feed - Title.md`, sanitized and collision-suffixed; existing/native captures need not use that naming scheme.

## Subscription frontmatter

| Property       | Shape                                   | Meaning and missing-value behavior                                                                                                                                                  |
| -------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`         | Exact string `feed`                     | Required for subscription recognition; distinct from article `status: feed`                                                                                                         |
| `url`          | HTTP(S) URL string, without credentials | Required for successful refresh; type recognition alone does not validate it                                                                                                        |
| `title`        | String                                  | Optional; display falls back to the filename without `.md`                                                                                                                          |
| `prefix`       | String                                  | Optional article filename prefix; missing/blank falls back to the subscription title                                                                                                |
| `enabled`      | Boolean                                 | Optional, defaults to enabled; only exact boolean `false` disables imports                                                                                                          |
| `deleted_urls` | List of HTTP(S) URL strings             | Optional per-feed suppression history, default empty. New entries are normalized without fragments; malformed existing history blocks mutations/import rather than being discarded. |
| `error`        | String                                  | Optional refresh failure message                                                                                                                                                    |

See the [subscription example](storage-contract.md#subscription). New subscriptions have no `id`/`ID`; unknown existing IDs remain untouched. Articles retain their `feed` link when a subscription is removed. No cursor, import backlog, or refresh history is persisted; each explicit refresh considers only the latest 20 entries before filtering.

## Highlight and quotation syntax

Source file `Reading/Inbox/Decision rules.md`:

```markdown
==Clear **rules** build [trust](https://example.com/report).== (※ [[Notes/Governance]], [[Notes/Institutional trust]]) ^reader-k7m2
```

| Syntax                                    | Meaning                                                                                                                                                              |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `==selected Markdown==`                   | Highlighted words with original emphasis and publisher links; a logical selection may require several marked fragments                                               |
| `(※ [[Note]], [[Other note]])`            | One trailing destination group for that logical highlight; ordinary vault wikilinks, not tags or YAML                                                                |
| `^reader-k7m2`                            | Native source paragraph block ID; shared by highlights in that paragraph. Reuse a unique valid authored ID; new IDs are collision-checked. It is not a highlight ID. |
| `[[Article#^reader-k7m2\|Article title]]` | Precise source paragraph citation using the actual article path after any move                                                                                       |
| `[[YYYY-MM-DD]]`                          | Local collection day, captured once per filing operation; linking it does not create a daily note                                                                    |

Each chosen destination receives this body addition, alongside its existing properties and authored content:

```markdown
## Highlights

### [[Reading/Inbox/Decision rules|Decision rules]]

> Clear **rules** build [trust](https://example.com/report). (※ [[Reading/Inbox/Decision rules#^reader-k7m2|Decision rules]] [[2026-10-24]])
```

Group by source path, not equal titles. Quote Markdown plus paragraph citation identifies an unchanged saved copy; collection date is not its identity. Retries deduplicate and preserve the existing date, including legacy undated copies. Different quotations in one paragraph remain distinct.

Snapshots are user-owned: source edits, conversion and source-local Undo never prune them. Explicitly removing a destination from a highlight can remove only its uniquely matching unedited copy; missing, edited or ambiguous copies block removal. Clearing all destinations removes marks/references, preserving words and shared anchors. Multi-file writes are guarded but non-atomic. See [snapshot ownership](hosted-highlights.md#explicit-removal-and-snapshot-ownership).

Existing plain `==words==` and linked `==[[Note|words]]==` highlights remain readable without automatic conversion or quotation backfill. Every newly created hosted highlight requires a typed host. Reference labels/icons/block markers are excluded from prose mapping, quotation matching and bookmarks; normal aliased note-link words remain prose.

## Nodes and typing

A “node” is an ordinary Fileclass-typed Markdown note. Reader does not define a `type: node`, a node database, class-definition files or a universal YAML membership property. Fileclass Inline owns how its schemas, required fields and membership are stored. Writing an arbitrary `type` or `classes` property is not proof of an eligible host.

Reader consumes the public `fileclass-inline.api` v2 values below. These are API result fields, **not a frontmatter template**:

| API value            | Shape                                            | Reader use                                                                                        |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `listTypes()` entry  | `{ type: string, label: string, icon?: string }` | Registered class key, display label and optional icon                                             |
| `NodeResult.path`    | String ending in `.md`                           | Resolve the current vault file and recheck identity                                               |
| `NodeResult.title`   | String                                           | Display/search title; not an identity                                                             |
| `NodeResult.type`    | String                                           | Provider primary type; insufficient to establish membership                                       |
| `NodeResult.classes` | String array                                     | Membership authority: must include a currently registered class. Multi-class notes are supported. |
| `NodeResult.aliases` | String array                                     | Explicit alias matching/search                                                                    |
| `NodeResult.icon`    | Optional string                                  | Public resolved icon; otherwise use a matching registered class icon                              |

`searchNodes(query)` supplies candidates and `getNode(path)` revalidates them. Reader's picker excludes `article` and `feed` classes (case-insensitively), including multi-class candidates containing either. “All types” covers the remaining registered Fileclasses, not untyped files. The current source article cannot be its own destination. Existing authored topic values are not rewritten to satisfy picker filters.

New hosted highlights require Obsidian ≥1.12.7 and public API v2 discovery. The runtime adapter also checks that `createNode` exists, but typed linked creation uses `createNodeForLink`, with explicit class/title and a callback that commits the source before required-field completion. There is no fallback to standalone `createNode` or a copied form. `pickNodeForLink` is optional compatibility surface, not the current Reader-owned highlight picker.

Only a newly created destination receives Reader birth provenance, if the property is absent:

```yaml
origin: '[[Reading/Inbox/Decision rules#^reader-k7m2]]'
```

`origin` is a single source-paragraph wikilink string, not a list of all collected sources. Reusing a note never adds/changes it; an existing empty/null/unusual origin is preserved. Other Fileclass properties remain provider/user-owned. Cancellation can leave a created note, which Reader never deletes.

Explicit node-only conversion stores `[[Notes/Governance|original words]]` and a native paragraph anchor in the article, without highlight marks, destination group or quotation snapshot. It preserves selected words and refuses publisher-link conflicts. Creation can add `origin`; reuse does not.

Article `topics` controls future defaults, source reference groups control individual highlight destinations, and destination blockquotes hold independent snapshots. Editing any one is not an automatic rewrite of the others. Without the provider, existing files/highlights/links stay readable; new hosted writes are unavailable.

## Implementation authority

See [model.ts](../src/core/model.ts) and [document.ts](../src/core/document.ts) for file parsing/properties, [status-folders.ts](../src/core/status-folders.ts) for queue placement, [hosted-highlights.ts](../src/core/hosted-highlights.ts) and [quotation.ts](../src/core/quotation.ts) for Markdown syntax, and [nodes.ts](../src/host/nodes.ts), [node-choices.ts](../src/core/node-choices.ts) and [highlight-picker.ts](../src/host/highlight-picker.ts) for public typing and picker eligibility.
