# Reader storage contract

Approved by Wannes: “Yes, the contract looks good.” The refresh limit is also approved: “Yes, only the last 20 entries.” Independent folder settings were additionally approved on 14 October. This is not a note migration plan; existing Markdown is not converted.

## Article

Example: `Reading/Inbox/261012 Example - A useful article.md`. The examples use default locations; a shared `Reading` parent is not required.

```markdown
---
type: article
url: https://example.com/article
title: A useful article
published: 2026-10-12T08:00
feed: '[[Reading/Wires/Example.md]]'
topics:
  - '[[Topics/Example topic.md]]'
reading_position: These words identify the reading position
---

The article is ordinary Markdown.

An ==important passage== stays readable without Reader.
A ==[[Nodes/Example.md|linked passage]]== preserves its words.
A ==[**formatted** passage](/Nodes/Example.md)== preserves its formatting.
```

- Identification: `type: article`. A source URL is needed for capture/acquisition, not for reading an existing local article.
- `title`, `published`, `feed`, `topics`, `reading_position`, and `error` are optional. Missing dates are not invented.
- New captures write `published` as an unquoted local wall-clock minute in Obsidian’s `YYYY-MM-DDTHH:mm` format, without seconds or a timezone suffix. Zone-free values follow the current device’s timezone and native date/DST interpretation, not an instant-preserving cross-device convention. Repeated DST hours cannot retain their original offset. Existing date-only, offset and full ISO values remain readable; unrelated edits and duplicate captures do not normalize them. No timezone fields, bulk rewrite or migration.
- `error` is a human-readable acquisition failure, cleared by successful acquisition.
- Position is a bounded text anchor, not a pixel offset. It may cross inline formatting. Duplicate passages remain a best-effort restoration case; image-only pages persist the last valid text anchor, not an exact page number.
- Queue is the folder, not another YAML property. Identified articles outside the configured queues remain readable but unqueued.
- No article IDs, acquisition hashes/stamps, annotation arrays, sidecars, or synchronized copies.
- Existing unknown properties and authored text are preserved. Markdown remains editable without Reader.

## Subscription

Example: `Reading/Wires/Example.md`

```yaml
---
type: feed
url: https://example.com/feed.xml
title: Example
prefix: Example
enabled: true
---
```

- `title`, `prefix`, and `enabled` are optional; enabled defaults to true. `error` may describe the last failed refresh.
- New subscription notes do not write `id` or `ID`. Existing unknown properties, including old IDs, remain preserved during unrelated edits and duplicate subscription attempts. Removing existing IDs requires separately authorized targeted cleanup, not automatic deletion or migration.
- Subscription notes and articles can share the configured subscription folder (default `Reading/Wires`); their `type` distinguishes them. Articles outside the four queue folders remain unqueued.
- Unsubscribe trashes the subscription note, not its articles.

### Bounded refresh

Add feed saves the subscription only, allowing its parameters to be edited before an explicit Sync. Startup and periodic timers do not refresh RSS/Atom feeds. Only explicit Sync imports entries from enabled subscriptions; each Sync considers at most the latest 20 entries, before deduplication and age filtering. No cursor, backlog traversal, or deleted-URL history is stored.

Deleted entries still in that window can return. More than 20 new entries between explicit Syncs can mean missed entries; feed reordering can change which entries fall in the window.

## Acquisition and safety

- Offline Add URL immediately creates the note; unfinished acquisition can resume while Reader is active and online.
- Save feed-provided text first. Replace a body only if it is empty or exactly equals an independently retrieved, current feed excerpt, and the entire raw note revision still matches.
- If the excerpt is no longer available or cannot be proved, nonempty content stays protected. Retry must not become permission to overwrite it.
- Explicit titles (including empty ones), authored headings/comments, unknown YAML, and existing links are not regenerated from publisher content.
- A new untitled manual capture may be renamed from its provisional hostname filename after acquisition, using a session-only receipt and guarded native move. An explicit title, duplicate capture, user move/rename, or restart prevents that automatic retitle; no ownership marker is persisted.
- Filenames use the original parsed publication instant’s UTC date, before local-minute formatting; otherwise the local capture day. Feed ordering and age filtering likewise use the full-precision incoming publication value before writing. Names contain `YYMMDD`, a safe UTF-8-bounded title, optional feed prefix, and collision suffix. A receipt-based retitle reuses the capture instant (the current system timezone still determines its local date). Expiry uses the UTC rules below.
- Writes serialize by file identity and compare current bytes. Native source editors, dirty preview buffers, and ambiguous editor state are conservatively protected.
- Publisher content is sanitized and bounded before conversion. Executable fence labels are removed; default Dataview inline expressions and Templater delimiters fail capture, including in external titles. Reader is not a sandbox for arbitrary third-party Markdown processors.
- Promote Stream to Inbox before annotation/link writes. A failed save may leave a retained Inbox note, never a successfully annotated disposable Stream note.
- Native/synced annotations and authored vault links must also be protected before expiry. Publisher web/section links do not protect Stream articles.
- Native link-aware moves preserve references. Deletion and expiry use recoverable trash only.

## Expiry and settings

- One calendar month means the clamped UTC calendar-month cutoff, not 30 days. Explicit-zone and date-only values retain the strict before-cutoff comparison. Canonical local-minute values remain protected through their whole parsed minute: eligible only when minute start plus 60 seconds is at or before the cutoff. Both the metadata candidate filter and the fresh final trash guard apply this precision safeguard.
- Use publication date; otherwise the filename's `YYMMDD` date, interpreted in 2000–2099. Unknown age is retained. Old published feed entries are skipped to prevent import/expiry loops.
- An article in use, awaiting a protected write/promotion, or with uncertain backlink resolution is retained rather than raced by cleanup.
- Inbox, Stream, Later, Treasury and feed-subscription folders are independent organization settings. No shared parent is required; duplicate or overlapping role paths are rejected. Changing paths does not migrate, move or rewrite existing notes.
- E-ink pagination is device-local. Reading position remains in the note for existing vault sync.

## Acceptance

Fast unit/component tests and manual synthetic-vault/device checks only. No automated E2E suite. Passing DOM tests do not prove native desktop, iOS, Boox pagination, sync, or Hot Reload behavior.
