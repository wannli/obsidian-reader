# Reader storage contract

Approved by Wannes: articles and subscriptions are identified by YAML outside Templates and .trash; folder membership determines article queue, while YAML status remains a mirror for Reader status actions. Four configurable queue folders determine article placement. Article statuses, automatic expiry, missing-status protection and `bookmark` were approved on 15 October. The later [hosted-highlight contract](hosted-highlights.md) authorizes typed destinations, native paragraph references, quotation snapshots and new-note `origin`. No automatic migration or personal-vault installation.

## Article

For property types, defaults, highlight syntax and public Fileclass typing, see the [file schema reference](file-schema.md). It documents this contract without changing stored data.

Example: `Reading/Inbox/261015 A useful article.md`. Moving an article between queue folders changes its Reader queue without rewriting YAML.

```markdown
---
type: article
status: inbox
url: https://example.com/article
title: A useful article
published: 2026-10-15T08:00
feed: '[[Reading/Feeds/Example.md]]'
topics:
  - '[[Topics/Example topic.md]]'
bookmark: These words identify the reading position
dog_ear: true
---

The article is ordinary Markdown.

An ==important passage== (※ [[Topics/Example topic]]) stays readable without Reader. ^reader-k7m2

==Clear **rules** build [trust](https://example.com/report).== (※ [[Governance]], [[Institutional trust]]) ^reader-t9b3

Institutions build [[Institutional trust|institutional trust]]. ^reader-n8c4
```

- Identification: exact `type: article`, except in Templates or .trash at any depth. Typed articles outside the four queue folders remain readable but unqueued. A source URL is needed for capture/acquisition, not for reading an existing local article.
- `status` remains in YAML as a mirror of Reader status actions; queue membership comes from physical folder, not this property. When they disagree, folder wins. External folder moves do not rewrite YAML.
- `inbox`: manually captured, awaiting attention. `feed`: imported, not explicitly retained. `later`: deliberately retained for further attention. `archive`: retained, no longer needing attention; not necessarily finished.
- Missing, invalid or conflicting YAML status does not change folder-derived list membership. Reading does not add a status. Expiry still requires fresh explicit `status: feed` in the Feed folder; missing/conflicting values protect against deletion.
- Only a note in the Feed folder with explicit, freshly verified `status: feed` is eligible for expiry. Topics, highlights and other annotations block Reader trash and archive on explicit Delete or expiry instead.
- Reader queue selection is reversible and writes the chosen status then moves the note into the corresponding folder, even if YAML already had that value but placement disagreed. No startup/settings-apply migration or bulk YAML rewrite runs.
- A saved highlight or user-created passage link promotes an article in the Feed folder to Later before annotation is committed, regardless of existing YAML status. Inbox, Later and Archive annotations leave status unchanged. Removing a highlight never demotes an article. Publisher links do not count.
- Opening, scrolling, reaching the end, or saving a bookmark never changes status. There is no completion flag or read history. Opening an article in Reader moves the optional `dog_ear: true` current-article pointer to it, without changing status or its own reading-position `bookmark`.
- `title`, `published`, `feed`, `topics`, `bookmark`, and `error` are optional. Existing notes may lack dates; there is no legacy backfill. The `feed` link retains subscription provenance after status changes; `status: feed` does not identify a subscription note.
- `bookmark` is the existing bounded text-anchor representation, not a pixel offset, percentage, favorite or completion marker. It may cross inline formatting. Duplicate passages remain best effort; image-only pages keep the last valid text anchor.
- `dog_ear: true` identifies the last successfully opened Reader article for the Open dog-eared article command and URI. The pointer moves on article entry, not on list display, and is independent of position and queue. If no usable pointer exists, the route opens the newest Inbox article. Only exact boolean `true` counts; other authored values are never overwritten automatically. The handoff writes two Markdown notes with ordinary guarded writes; cross-device Sync cannot make them atomic, so interruptions or concurrent device edits can temporarily leave multiple pointers.
- `reading_position` is no longer read or written. Existing values are preserved as unknown data, with no automatic conversion or fallback.
- Reader captures always write `published`: a valid supplied publication wins, otherwise the original capture time. New writes use an unquoted local wall-clock minute in Obsidian's `YYYY-MM-DDTHH:mm` format, without seconds or timezone suffix. Zone-free values follow the current device's timezone/DST interpretation, not a unique instant across devices or repeated DST hours. Existing date-only, offset and full ISO values remain readable and are never normalized by unrelated edits.
- Externally created articles qualify only through a live native vault `create` event after layout readiness, with a finite `file.stat.ctime` between that readiness boundary and event observation. Reader freezes its local minute then, waits for exact `type: article`, and adds `published` only when the property is absent. Nonempty/offline bodies are preserved. Dirty or racing notes can retry on metadata/editor-layout changes. Every existing publication value, including empty, null or invalid values, stays untouched.
- This is conservative create-time evidence, not sharesheet provenance: ordinary URL-only shares are not converted to articles. Startup indexing/replayed creates, cold-launch shares before readiness, older synced ctimes and unknown/future ctimes do not authorize writes. Sync can regenerate ctime; a live imported file with a fresh ctime cannot be distinguished from a genuinely new note. No original share timestamp is claimed without trustworthy host ctime. Native cold-launch/sharesheet and cross-device behavior remain unverified; stronger coverage requires a dedicated provenance source, not a date backfill.
- `error` describes acquisition failure and is cleared by successful acquisition.
- Article `topics` remembers only typed destination links, of any Fileclass, without retroactively reassigning old highlights. Every new highlight needs a typed host; inherit one valid default, otherwise choose. Unknown/legacy values are preserved, not silently accepted as typed defaults.
- Inline references use `(※ [[Destination]], [[Other]])`. One native paragraph block ID serves all highlights in its paragraph. Node-only conversion uses an ordinary wikilink, without `==` or a redundant group. Existing highlights/links remain readable; no automatic conversion.
- Explicit multiselect collection appends blockquotes under each selected note’s `## Highlights`, grouped by `### [[Article|Article title]]`, ending with `(※ [[Article#^paragraph|Article title]] [[YYYY-MM-DD]])`. Capture one local collection day per operation; retries preserve existing dates/legacy undated copies. New notes receive `origin: "[[Article#^paragraph]]"`; never overwrite an origin or assign one on reuse.
- Explicitly removing a destination from a particular highlight may remove its uniquely matching unedited quotation and source reference together; missing/edited/ambiguous copies block removal before source mutation. Do not delete notes, other quotations, origin or authored sections. Article Related notes changes, source edits/conversion and source-local Undo never prune stored copies. Clearing all highlight destinations removes its marks/references, not words or shared anchors.
- No article/highlight IDs, acquisition hashes/stamps, annotation arrays, sidecars, synchronized copies or persisted recovery queues. Native block IDs identify paragraphs, not excerpts. New grouping/date formatting does not bulk-migrate old quotations. Preserve unknown properties/comments/text/links; report non-atomic added/removed target progress honestly.

## Subscription

Example: `Reading/Feeds/Example.md`; subscriptions are discovered anywhere by exact `type: feed`.

```yaml
---
type: feed
url: https://example.com/feed.xml
title: Example
prefix: Example
enabled: true
deleted_urls:
  - https://example.com/dismissed-article
---
```

- `title`, `prefix`, and `enabled` are optional; enabled defaults to true. `error` may describe the last failed refresh. Article statuses do not apply to subscriptions.
- New subscription notes do not write `id` or `ID`. Existing unknown properties, including old IDs, remain preserved. No automatic cleanup or migration of existing IDs.
- Unsubscribe trashes the subscription note, not its articles, and leaves their `feed` links intact. Explicit Reader deletion fails closed if a linked subscription cannot be resolved for deleted-URL recording; it does not silently drop suppression history. Articles and subscriptions may share a folder.

### Deleted articles

Optional `deleted_urls` stores normalized article URLs in the subscription note. Reader records a feed-associated article's URL before explicit recoverable deletion, in any queue. Refresh skips these URLs; manual Add URL remains allowed. Removing an entry permits future feed import again. History travels with ordinary vault sync, without sidecars or custom conflict resolution.

This covers future Reader deletions, not past or native/external deletions. Suppression is per subscription; another feed can still import the URL. Expiry does not add history. Concurrent edits remain subject to the vault sync provider; an unsynced device may import before receiving suppression. Existing articles are not automatically removed when records arrive.

### Bounded refresh

Add feed saves only the subscription; no network or article import. Only explicit Sync imports articles from enabled subscriptions with `status: feed`. Each Sync considers at most the latest 20 entries before deduplication/age filtering. No startup/timer/online refresh, historical cursor or backlog service.

Articles deleted outside Reader or before suppression was recorded can return while in that window. More than 20 new entries between Syncs can mean missed entries; reordering can change which entries fall in the window.

## Acquisition and safety

- Offline Add URL immediately creates an article with `status: inbox`; unfinished acquisition may resume while Reader is active and online. Duplicate capture opens the existing article without resetting its status, bookmark or placement.
- Save feed-provided text first. Automatic acquisition replaces a body only if it is empty, exactly equals an independently retrieved current feed excerpt, or consists solely of a native Share Sheet Markdown source-link placeholder matching the article URL (approved in the 15 October capture follow-up). Extra text, annotations, other destinations and full-text captures remain protected. The entire raw note revision must still match.
- If the excerpt/placeholder cannot be proved, nonempty content stays protected. Retry must not become permission to overwrite it.
- Explicit **Run Defuddle again (replace article content)** is separately authorized on 15 October: after confirmation, replace the selected article body, including highlights and inline links, with newly extracted content. Preserve unknown frontmatter and explicit titles. Failure/cancellation leaves the existing body intact; confirmation never bypasses file identity, exact-revision, dirty-editor or generation guards. Automatic acquisition and Retry never inherit this override.
- Explicit titles (including empty ones), authored headings/comments, unknown YAML, and links are not regenerated from publisher content.
- A new untitled manual capture may be retitled from its provisional hostname filename after acquisition using a session-only receipt and guarded native move. Explicit titles, duplicate capture, user moves/renames or restart prevent automatic retitle. This filename correction is not queue organization.
- Filenames use the original publication instant's UTC date before local-minute formatting, otherwise the local capture day. Feed ordering and age filtering use the full-precision incoming publication value before writing. Names contain `YYMMDD`, a safe UTF-8-bounded title, optional feed prefix, and collision suffix; never overwrite. A receipt retitle reuses its capture instant.
- Writes serialize by file identity and compare current bytes. Dirty native editors, uncertain buffers and source revisions are protected.
- Publisher content is sanitized and bounded. Executable fence labels are removed; default Dataview/Templater expressions fail capture, including in titles. Reader is not a sandbox for arbitrary third-party processors.
- Promotion must succeed before annotation commit. Status is saved first, annotation second, guarded relocation to the Later queue folder last in the same file lane, so native relative-link rewriting never invalidates selection offsets. Failure can leave a retained Later note (with a saved annotation), never an annotation committed to stale Feed bytes. Browsing context and bookmark survive status changes.
- Native/synced annotations and authored vault links must also be protected before expiry. Publisher web/section links do not protect feed articles.
- Unprotected deletions and expiry use recoverable Obsidian trash only. Reader archives articles with topics, highlights or other annotations instead of deleting them. No bulk note rewrites or migration. Reader status moves and retitling use guarded link-aware native rename; Obsidian's link-update setting is respected, not changed.

## Expiry and settings

- Expiry applies only inside the Feed folder with explicit `status: feed`, after one clamped UTC calendar month. Explicit-zone and date-only values use strict before-cutoff comparison. Local-minute values retain their full minute: eligible only when minute start plus 60 seconds is at or before cutoff. Both candidate filtering and the final fresh-byte trash guard enforce this.
- Use publication date; otherwise filename `YYMMDD` interpreted in 2000–2099. Unknown age is retained. Old published feed entries are skipped to prevent import/expiry loops.
- In-use articles, pending writes/promotion and uncertain backlink resolution remain protected. Final trash validation rechecks status, identity, current bytes and annotations; UI classification alone never authorizes expiry.
- Manual Add URL and browser-link Save create articles in Inbox; feed imports create in Feed. A live observed native/QuickAdd article with explicit `status: inbox` is moved into Inbox after its creation is validated. Captures made while Reader is inactive must target Inbox in the external tool. Subscriptions default to `Reading/Feeds`. The old `captureFolders.articles` key is preserved but inert. Queue folders are discovery scopes for queue membership, not article identity.
- New configuration is stored in `captureFolders`; previous `folders`, root and flat settings remain inert and preserved. Applying destinations does not migrate files, rewrite Markdown, acquire articles or promote them.
- Four `statusFolders` destinations default to `Reading/Inbox`, `Reading/Stream`, `Reading/Later`, `Reading/Treasury`. Existing partial settings inherit missing defaults; paths must be nonempty, nonoverlapping, and outside Templates/.trash. Subscriptions are unaffected.
- Native/synced YAML edits do not move articles. Initial indexing, body-only edits, and path-only moves never migrate or rewrite existing notes; only observed live new native Inbox captures receive placement. Unsafe editors and races block placement; no startup or settings-apply sweep or migration occurs.
- Moves recheck identity, bytes, editor safety and late collisions, preserve filenames where available and add a collision suffix rather than overwrite. Native rename can rewrite links, so Reader rereads the result. Cross-device Sync and native I/O are not atomic transactions; disabled native link updates cannot guarantee link repair.
- E-ink pagination is device-local (`obsidian-reader:eink` in local storage). Touch page controls remain in paged mode; the former `showPagedArticleButtons` preference is preserved as inert plugin data, not displayed or migrated. It adds no article property. `bookmark` travels with the note through existing vault sync.

## Acceptance

Fast unit/component tests and guarded tooling tests; native synthetic-vault/device checks are separate. No automated E2E suite. DOM tests do not prove native desktop, iOS, Boox or Sync behavior. Wannes separately authorized a backed-up replacement E2E corpus for manual hosted-highlight testing; preserve ownership/settings and native holds. No personal-vault access, release, or existing-note migration.
