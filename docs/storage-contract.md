# Reader storage contract

Approved by Wannes: articles and subscriptions are identified by YAML anywhere in the vault; capture folders determine creation placement, with optional status-folder mappings for future transitions. Article statuses, automatic expiry, missing-status protection and `bookmark` were approved on 15 October. This is not authorization to convert existing Markdown or install the plugin into a vault.

## Article

Example: `Reading/Articles/261015 A useful article.md`. Users may move or rename it anywhere in the vault without changing its Reader state.

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
---

The article is ordinary Markdown.

An ==important passage== stays readable without Reader.
A ==[[Nodes/Example.md|linked passage]]== preserves its words.
A ==[**formatted** passage](/Nodes/Example.md)== preserves its formatting.
```

- Identification: exact `type: article`, independent of location. A source URL is needed for capture/acquisition, not for reading an existing local article.
- `status` is one of `inbox`, `feed`, `later`, `archive`. It controls queue membership, never completion; optional settings can map each status to a physical folder.
- `inbox`: manually captured, awaiting attention. `feed`: imported, not explicitly retained. `later`: deliberately retained for further attention. `archive`: retained, no longer needing attention; not necessarily finished.
- A missing `status` appears in Feed but is never automatically expired. Reading does not add a status. Explicit null, empty, malformed or unknown statuses remain readable but unqueued and protected from expiry; they are not treated as missing.
- Only an explicit, freshly verified `status: feed` is eligible for expiry. Displayed queue membership is never deletion authority.
- Normal transitions: Inbox → Later/Archive; Feed → Later/Archive; Later → Archive; Archive → Later. Manual queue selection is reversible and writes the chosen status. A changed explicit status moves the note only if that status has a folder mapping; same-status selection leaves its path unchanged.
- A saved highlight or user-created passage link promotes Feed (including missing status) to Later before annotation is committed. Inbox, Later and Archive annotations leave status unchanged. Removing a highlight never demotes an article. Publisher links do not count.
- Opening, scrolling, reaching the end, or saving a bookmark never changes status. There is no completion flag or read history.
- `title`, `published`, `feed`, `topics`, `bookmark`, and `error` are optional. Existing notes may lack dates; there is no legacy backfill. The `feed` link retains subscription provenance after status changes; `status: feed` does not identify a subscription note.
- `bookmark` is the existing bounded text-anchor representation, not a pixel offset, percentage, favorite or completion marker. It may cross inline formatting. Duplicate passages remain best effort; image-only pages keep the last valid text anchor.
- `reading_position` is no longer read or written. Existing values are preserved as unknown data, with no automatic conversion or fallback.
- Reader captures always write `published`: a valid supplied publication wins, otherwise the original capture time. New writes use an unquoted local wall-clock minute in Obsidian's `YYYY-MM-DDTHH:mm` format, without seconds or timezone suffix. Zone-free values follow the current device's timezone/DST interpretation, not a unique instant across devices or repeated DST hours. Existing date-only, offset and full ISO values remain readable and are never normalized by unrelated edits.
- Externally created articles qualify only through a live native vault `create` event after layout readiness, with a finite `file.stat.ctime` between that readiness boundary and event observation. Reader freezes its local minute then, waits for exact `type: article`, and adds `published` only when the property is absent. Nonempty/offline bodies are preserved. Dirty or racing notes can retry on metadata/editor-layout changes. Every existing publication value, including empty, null or invalid values, stays untouched.
- This is conservative create-time evidence, not sharesheet provenance: ordinary URL-only shares are not converted to articles. Startup indexing/replayed creates, cold-launch shares before readiness, older synced ctimes and unknown/future ctimes do not authorize writes. Sync can regenerate ctime; a live imported file with a fresh ctime cannot be distinguished from a genuinely new note. No original share timestamp is claimed without trustworthy host ctime. Native cold-launch/sharesheet and cross-device behavior remain unverified; stronger coverage requires a dedicated provenance source, not a date backfill.
- `error` describes acquisition failure and is cleared by successful acquisition.
- No article IDs, acquisition hashes/stamps, annotation arrays, sidecars, or synchronized copies. Unknown properties, comments, authored text and existing links are preserved.

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
- Unsubscribe trashes the subscription note, not its articles. Articles and subscriptions may share a folder.

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
- Promotion must succeed before annotation commit. Status is saved first, annotation second, optional relocation last in the same file lane, so native relative-link rewriting never invalidates selection offsets. Failure can leave a retained Later note (with a saved annotation), never an annotation committed to stale Feed bytes. Browsing context and bookmark survive status changes.
- Native/synced annotations and authored vault links must also be protected before expiry. Publisher web/section links do not protect feed articles.
- Deletion and expiry use recoverable Obsidian trash only. No bulk note rewrites or migration. Opt-in status moves and retitling use guarded link-aware native rename; Obsidian's link-update setting is respected, not changed.

## Expiry and settings

- Expiry applies only to explicit `status: feed`, after one clamped UTC calendar month. Explicit-zone and date-only values use strict before-cutoff comparison. Local-minute values retain their full minute: eligible only when minute start plus 60 seconds is at or before cutoff. Both candidate filtering and the final fresh-byte trash guard enforce this.
- Use publication date; otherwise filename `YYMMDD` interpreted in 2000–2099. Unknown age is retained. Old published feed entries are skipped to prevent import/expiry loops.
- In-use articles, pending writes/promotion and uncertain backlink resolution remain protected. Final trash validation rechecks status, identity, current bytes and annotations; UI classification alone never authorizes expiry.
- Two configurable creation destinations: articles (default `Reading/Articles`) and subscriptions (default `Reading/Feeds`). Same, nested and vault-root destinations are allowed; paths must remain safe and vault-relative. These are not discovery scopes or queue boundaries.
- New configuration is stored in `captureFolders`; previous `folders`, root and flat settings remain inert and preserved. Applying destinations does not migrate files, rewrite Markdown, acquire articles or promote them.
- Optional `statusFolders` maps lowercase `inbox`/`feed`/`later`/`archive` to safe vault-relative folders. An absent key is unmapped; `""` maps to vault root (shown as `/` in settings). Shared/nested paths are allowed. Reader-created articles use their initial status mapping, falling back to the article capture folder. Subscriptions are unaffected.
- Observed manual/native/synced YAML transitions also move mapped articles, after exact durable-byte checks. Initial indexing/creates, body-only edits, same-status choices and path-only moves do not organize existing notes. Missing → explicit valid status is a transition. Dirty/uncertain editors defer bounded session-local work until a safe editor/workspace event; file lanes serialize busy writes. Superseding status, rename, deletion, settings changes or unload invalidate pending work. Permanent move failures are reported, not retried indefinitely; status/contents are not rolled back. No startup or settings-apply sweep, note schema change or migration.
- Moves recheck identity, bytes, editor safety and late collisions, preserve filenames where available and add a collision suffix rather than overwrite. Native rename can rewrite links, so Reader rereads the result. Cross-device Sync and native I/O are not atomic transactions; disabled native link updates cannot guarantee link repair.
- E-ink pagination is device-local. `bookmark` travels with the note through existing vault sync.

## Acceptance

Fast unit/component tests and guarded tooling tests; native synthetic-vault/device checks are separate. No automated E2E suite. DOM tests do not prove native desktop, iOS, Boox or Sync behavior. No personal-vault access, installed-vault update, release, or existing-note conversion is authorized by this implementation.
