# Reader

![Illustration of the Reader plugin](assets/reader.png)

Reader is a Markdown-first reader for Obsidian. Save articles, follow RSS and
Atom feeds, highlight passages, and connect what you read to the rest of your vault.

## Features

- A focused reading view for Obsidian on desktop and mobile
- Inbox, Later, Stream, and Treasury reading queues
- Built-in URL capture and RSS/Atom subscriptions
- Inline highlights stored as ordinary Markdown
- Links from passages to notes in your vault
- Topics stored as frontmatter links
- Reading-position persistence across sessions
- Optional paginated reading for Boox and other Android e-ink devices

## Reading and capture

Reader organizes reading through folders in your vault:

| Folder | Purpose |
| --- | --- |
| `Reading/Inbox` | Newly saved articles |
| `Reading/Later` | Articles set aside for later |
| `Reading/Stream` | Articles imported from feeds |
| `Reading/Treasury` | Articles you want to keep |
| `Reading/Wires` | RSS and Atom subscriptions |

Use **Add URL** to save an article directly. Feed entries arrive in Stream. Move an
article between folders as its place in your reading workflow changes.

Articles open in Reader by default. Use **Open Markdown** whenever you want to
edit the source note directly. QuickAdd can also be used for richer capture flows
with optional titles and comments.

**Delete & next** at the article end sends the current article to recoverable vault trash, then advances (or returns to the list). Failed or unfinished saves block this action.

In Stream only, **Delete newer articles…** targets Stream entries with publication dates strictly newer than the current article, keeping current and older entries open/untouched; unknown dates and ties are excluded. A native confirmation previews eligible/skipped counts; Cancel deletes nothing. The sequential batch rechecks identity, content, navigation and backlinks, skips highlights/topics/authors/comments/protected text and unknown or retired metadata, and reports deleted/skipped counts and failures. New arrivals are excluded. A valid operational `reading_position` alone does not protect an otherwise disposable entry. Automatic expiry and bulk cleanup also treat full-text RSS-linked Stream bodies and publisher footers as disposable: unmarked manual body edits may be deleted. Explicit comments, annotations, authored layouts and incoming links remain protected. All deletion uses recoverable trash, never permanent removal.

## Markdown files

Reader stores articles and feed subscriptions as normal Markdown notes. Folder
location determines an article's queue, while frontmatter describes the source and
reading state. New article notes omit `id`, `guid`, `pullmanFormat`, `content`,
`extractor`, `sourceHash`, and `sourceLength`; feed IDs remain. Unknown nonempty
article text is protected from automatic replacement unless its current bytes
independently prove it is a replaceable sample or excerpt. Historical article IDs,
extraction stamps, and conversion metadata are preserved as unknown properties,
not interpreted or migrated. Legacy sidecars are left untouched and ignored.

### Articles

A typical article looks like this:

```md
---
type: article
title: A useful article
url: https://example.com/article
published: 2026-10-11
feed: "[[Reading/Wires/Example Feed]]"
topics:
  - "[[Topics/Design]]"
reading_position: "the paragraph where I stopped"
---

Article text lives here.

An ==important passage== remains in its original context.

This idea connects to [[Another note]].

## Comments

Your own notes can live alongside the article.
```

Only `type: article` identifies the note as an article. Other properties appear
when relevant: manually saved articles may have no `feed` or `published` value,
and `topics` and `reading_position` are optional.

### Feeds

Feed subscriptions live in `Reading/Wires`:

```md
---
type: feed
title: Example Feed
url: https://example.com/feed.xml
prefix: Example
enabled: true
---
```

The `prefix` is used in filenames for imported entries. Set `enabled` to `false`
to pause a subscription while keeping it in the vault.

Feeds refresh every **4 hours** by default while Obsidian is active; change the
interval in settings or refresh manually at any time. Poll timing is session-local:
reopening Reader allows an immediate check; suspended iOS cannot run checks.
Requests use no HTTP cache validators. Reader no longer reads or writes feed
`checked`, `modified`, or `etag`; existing properties remain untouched. Successful
checks do not rewrite feed notes unless clearing a previous error. Old unversioned
30-minute settings become 240 minutes in memory (explicit old 30-minute choices
cannot be distinguished); other custom intervals remain. A normal settings save
records the migration, so subsequently choosing 30 minutes remains supported.

## Highlights and connections

Selecting a passage creates an inline Markdown highlight:

```md
This is an ==important passage== in the article.
```

With **Nodes** enabled (public API version 1), choose **Link to node…** from
an existing highlight. Search starts with the selected words and matches names
and aliases. Results show schema/type and color badges. **Create new node…**
asks for a schema, then opens the Nodes form; long passages first ask for a short
title. Cancellation writes nothing to the article.

The original words remain unchanged. Schema colors come only from Nodes;
colorless schemas produce a plain highlighted link:

```md
This is an ==[[Design notes|important passage]]== in the article.
```

Linked highlights offer **Open node**, **Change linked node…**, **Unlink**
(keep highlight), and **Remove highlight** (keep words). Created nodes are never
removed on cancellation, stale-source rejection, unlinking, or failed linking.
If the article, target node, or schema changes while choosing/saving, reopen the
highlight and retry. A failed save can report a link already written.

Nodes is optional: ordinary highlights and **Link / Link to…** to another note
or URL still work without it. Reader has no independent type/color settings or
schema-free node creation for highlights. Old settings and Markdown are retained
without migration. Assigning topics updates
the article's `topics` frontmatter with links to topic notes already in the vault.

## Mobile reading controls

On mobile, scrolling down hides Obsidian's navigation bars and Reader's native
header/actions; scroll up to reveal them. **Show controls** remains available,
and Escape also reveals controls. Successful Boox next/previous page turns
hide/reveal controls respectively. Changes are immediate, without animations;
leaving Reader restores the host chrome. Article-end actions remain available.
Native iOS and Boox hardware verification is still pending.

## Boox and e-ink reading

On Android e-ink devices, enable **Boox / e-ink pagination (this device)** in
Reader settings. PageUp and PageDown turn pages, and the final page provides
the same next-article and queue actions as the scrolling reader. The preference is
stored per device so other devices can continue using the scrolling view.

## Installation with BRAT

1. Install and enable the **BRAT** community plugin in Obsidian.
2. Open the command palette and run **BRAT: Add a beta plugin for testing**.
3. Enter `wannli/obsidian-reader`.
4. Enable **Reader** under **Settings → Community plugins**.

Reader uses the `obsidian-reader` plugin ID. It is installed independently and
does not import settings or workspace state from another plugin.

BRAT can also check for and install future Reader updates.

## Development

Use the Node version pinned in `.mise.toml`:

```sh
mise exec -- npm ci
mise exec -- npm run check
```

`check` validates metadata, types, unit tests, tooling regressions, and the plugin
build. There is no browser preview, browser simulation suite, or native
automation harness.

`npm run dev` watches sources and rebuilds `dist/` only. It does not install the
plugin or install/enable Hot Reload. Use `npm run vault:setup` for initial setup
of an explicitly approved, marked synthetic vault under `.sandbox`; ownership
checks and safety holds still apply. Never use a personal vault or bypass a hold.

Native acceptance is manual. After rebuilding, close Obsidian or disable Reader,
then run `npm run vault:update` to explicitly install the rebuilt plugin in the
approved synthetic vault. Open that vault and enable/reload Reader before testing;
a rebuild alone does not update the installed plugin. Check capture, reading,
highlights, queue moves, and persistence after reopening. Record the host/version
and actual results separately. Automated checks do not prove native desktop/iOS,
e-ink hardware, or cross-device sync behavior.

Release Please owns version and changelog updates. Releases are published by
merging its PR, not by authoring separate release notes or manually creating tags.
