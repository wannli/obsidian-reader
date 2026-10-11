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

## Highlights and connections

Selecting a passage creates an inline Markdown highlight:

```md
This is an ==important passage== in the article.
```

A highlighted passage can link to another note using ordinary wiki-link syntax:

```md
This is an ==[[Design notes|important passage]]== in the article.
```

Removing a highlight or link keeps the original words. Assigning topics updates
the article's `topics` frontmatter with links to topic notes already in the vault.

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
build. There is no standalone browser preview or browser simulation suite.
Playwright remains a development dependency for native Obsidian sandbox automation.

`npm run dev` builds for Obsidian hot reload. Native testing uses only the
repository's marked synthetic vaults under `.sandbox`; never use a personal vault.
Use `npm run vault:setup`, `npm run vault:open`, and `npm run test:obsidian` for
that separate acceptance workflow. Synthetic checks do not prove native iOS,
e-ink hardware, or cross-device sync behavior.

Release Please owns version and changelog updates. Releases are published by
merging its PR, not by authoring separate release notes or manually creating tags.
