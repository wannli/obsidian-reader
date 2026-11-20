---
created: 2026-11-15
updated: 2026-11-15
status: proposed-requires-approval
---

# Proposed native entry grammar

Historical notebook grammar: [clipping capture](reader-clipping-capture.md) defines new Keep files instead. Existing notebook records are preserved without conversion.

This is the exact record-format companion to the [persistence proposal](reader-thinking-persistence.md). **No persisted field, native anchor allocation or format convention below is approved yet.** All specimens are ordinary Obsidian callouts and block references, not runtime fixtures to install in a vault.

## Passage with a connection

```markdown
> [!quote] Passage
> **Source:** [[Reading/Later/Example|Example]]
>
> **URL:** <https://example.org/article>
>
> **Collected:** [[2026-11-15]]
>
> **Before:** Earlier visible words.
>
> **After:** Later visible words.
>
> ---
>
> Exact **selected words** with [publisher links](https://example.org/report).
>
> ---
>
> #### Connections
>
> - [[Reading notebook#^comment-small-stone]] — Contrasts with

^passage-quiet-river
```

## Attached comment

```markdown
> [!note] Comment
> **About:** [[Reading notebook#^passage-quiet-river]]
>
> **Collected:** [[2026-11-15]]
>
> ---
>
> My unfinished explanation.
>
> - This ordinary list is personal prose, not a connection record.
>
> ---
>
> #### Connections
>
> _None._

^comment-small-stone
```

## Independent comment at a source gap

```markdown
> [!note] Comment
> **Source:** [[Reading/Later/Example|Example]]
>
> **URL:** <https://example.org/article>
>
> **Collected:** [[2026-11-15]]
>
> **Before:** End of the preceding paragraph.
>
> **After:** Start of the following paragraph.
>
> ---
>
> This thought belongs between these paragraphs, not to selected words.
>
> ---
>
> #### Connections
>
> _None._

^comment-between-paragraphs
```

## Free comment without a source

```markdown
> [!note] Comment
> **Collected:** [[2026-11-15]]
>
> ---
>
> A thought that does not need an article or a class.
>
> ---
>
> #### Connections
>
> _None._

^comment-free-thought
```

## Parsing and edit ownership

- Each entry is one top-level, non-collapsed built-in quote/note callout followed by its native block-ID line. Its connection list is **inside that callout**, before the ID. Never assign ownership to an adjacent external list.
- Every metadata field is a distinct Markdown paragraph, separated by an empty quoted line. There are no soft-break-delimited metadata fields. The exact paragraph labels, order and role determine the parse.
- Passage metadata order is Source, optional URL, Collected, Before, After. Attached-comment order is About, Collected. Gap-comment order matches Passage, but the role is Comment. Free-comment metadata contains only Collected.
- Source/About hold one native link, URL holds one HTTP(S) autolink, and Collected holds a valid local-date link. The provider supplies file frontmatter independently; none of these fields assigns a semantic class to the entry.
- Before/After contain escaped single-paragraph visible text, bounded as proposed in the persistence companion. Empty context at a true source edge is permitted as an empty value. Escape Markdown punctuation in metadata text; no raw HTML or executable expressions are metadata.
- The first top-level horizontal rule after the complete fixed metadata starts the body. Body Markdown extends to the final top-level horizontal rule followed by the exact level-four Connections heading and a valid terminal connection list or `_None._` paragraph.
- Body content may include paragraphs, lists, fences, nested quotes and callouts. Parse nesting with the existing Markdown lexer. Do not find structural rules with global string splitting or treat delimiters inside code/nested blocks as record boundaries.
- An entry must have exactly one valid metadata parse and one terminal Connections parse. Missing delimiters, duplicate labels, extra metadata, conflicting anchors or multiple possible terminal sections make it read-only. Do not infer ownership from an anchor alone.
- Each connection is one list item containing a single native target link, optionally followed by `—` and an escaped single-line plain label. Empty labels are omitted. Reject embedded newline/control characters; escape markup so labels cannot introduce additional links/structure. A label does not encode an inverse predicate.
- Only this explicitly reserved terminal section supplies entry-owned edges. Links/lists elsewhere remain ordinary authored content. Manually authoring the reserved section is an explicit record-format edit; typing an incidental mention, label or @ string in prose does not create an edge.
- Reader edits only the exact parsed body, selected connection item or newly appended entry. Preserve unknown surrounding notebook content and frontmatter byte-for-byte. Unsupported native edits remain readable; Reader must not repair their shape automatically.
- Native anchor IDs use Obsidian-supported letters, digits and hyphens. The allocator checks the entire fresh target file for collisions and rechecks at commit. Duplicate anchors invalidate both affected records until deliberately fixed natively; never choose the first matching occurrence.
- Snapshot body delimiters/labels are structural only at the parsed record level. Golden tests must cover metadata-looking quotation text, repeated rules, a Connections heading inside a fenced block, nested callouts, multiline lists and trailing authored text.
- File renames follow native link behavior. Block-ID edits can break references. Display unresolved links, never create a replacement graph ID, silently retarget to similar content or rewrite source articles to restore a link.

## Approval relationship

Approve this grammar together with its persistence companion. Native anchors, source/context labels, entry-owned links and the changed structured-note origin convention are one concrete schema review. Generic approval of the workflow alone does not approve these details or any migration of old highlights/quotations.
