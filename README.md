# Reader

A small Markdown-first article and RSS reader for Obsidian desktop, iPhone/iPad, and Android/e-ink. Requires Obsidian **1.8.0 or newer**.

## Read and keep

- **Add URL** saves a note immediately, including offline; available article text is acquired while Reader is active and online. Clicking a web link offers **Save to Inbox**, **Open link** or **Cancel**; saving keeps the current article open and reuses existing-URL deduplication.
- **Add feed** saves an RSS/Atom subscription without importing articles, so you can edit its parameters first. **Sync feeds explicitly** when ready; startup and periodic timers do not refresh feeds. Each Sync considers at most the **latest 20 entries**, before age filtering and deduplication. There is no backlog/history service.
- Browse **Inbox, Later and Stream** in a flat, titles-only list; use **Open Treasury** and **Manage feeds** commands for those views. Search through native Obsidian rather than an embedded search bar. Source URLs remain stored in the notes.
- Right-side indicators show **Opened before** from an existing saved reading position and **Has highlights** from Markdown. No extra metadata, completion flag or persisted history is added.
- Select text to highlight it. Link passages to existing notes, add topic links, or use the optional public **Nodes API v2** integration for Fileclass-aware note selection/creation.
- Both views use compact, leaf-owned **floating bottom controls**, accessible labels and 44px targets. Articles use the pane width, one title and scrollbar/final-text clearance. **Previous, Next, Read later, Save to Treasury, Delete, List** have no action divider. Read later (clock) moves to Later and keeps the article open; Save to Treasury (bookmark) and recoverable Delete advance within the original browsing context.
- Exact `type: article` notes open in Reader; **Open Markdown** preserves an explicit native-editor escape, and dirty editors are protected. **Topics** and **Move article** remain commands. Reading position travels with the note; pagination is device-local.
- Obsidian’s separate floating mobile navigation bar hides only while Reader is active. At article boundaries, **Up/PageUp** opens the previous article and **Down/PageDown** the next, without held-key skipping or interfering with editing. Every article entry still resumes its own saved position.
- **Open reading list** forces the library. On iPhone, **Copy reading-list link** supplies a vault-aware `obsidian://obsidian-reader` URL for a Shortcuts **URL → Open URLs → Add to Home Screen** shortcut; no extra plugin is needed.

The combined Nodes/Fileclass integration requires Obsidian **1.12.7 or newer**. Nodes v2 exposes class membership and icons, not schema colors; Reader keeps its ordinary highlight appearance. Linked creation uses the public callback-before-required-completion API when available. Failed/cancelled creation or linking can leave a note: Reader never prunes it. Older Nodes APIs are not silently accepted; ordinary note links remain available without Nodes.

Markdown is the only article store. Reader preserves authored text, unknown YAML, and existing links; it does not maintain sidecars, copied highlights, custom sync, or migration code. Images remain remote; inline images fit the reading area and open a larger view when clicked or tapped.

**Stream is disposable:** annotations and vault links promote articles to Inbox; unprotected entries older than one clamped UTC calendar month go to vault-local recoverable trash. Unknown-age and in-use notes are retained. See the [approved storage contract](docs/storage-contract.md).

## Markdown structure

The default layout below is only a starting point: all five folders can live independently anywhere in the vault. A note's folder determines its queue; there is no queue property.

```text
Reading/
  Inbox/     # captured and protected articles
  Stream/    # disposable feed articles
  Later/     # articles saved for later
  Treasury/  # retained articles
  Wires/     # feed-subscription notes
```

An article such as `Reading/Inbox/261014 A useful article.md`:

```markdown
---
type: article
url: https://example.com/article
title: A useful article
published: 2026-10-14T08:00
feed: '[[Reading/Wires/Example feed.md]]'
topics:
  - '[[Topics/Reading.md]]'
reading_position: An important passage remains ordinary Markdown
---

An ==important passage== remains ordinary Markdown.

A ==[[Notes/A useful idea.md|linked passage]]== links directly to a note.
```

`type: article` identifies the note. Capture/acquisition uses `url`; local articles can be read without it. `title`, `published`, `feed`, `topics` and `reading_position` are optional; `error` can describe an acquisition failure. The position is a text anchor, not a page number or completion flag. Inline highlights and passage links live in the body; feed and topic links are frontmatter properties.

New captures write `published` as an unquoted **local wall-clock minute** in Obsidian’s `YYYY-MM-DDTHH:mm` format, without seconds or a timezone suffix. Zone-free values follow the current device’s timezone and native date/DST interpretation; they do not preserve a unique instant across timezones or repeated DST hours. Existing date-only, offset and full ISO values remain readable and are not rewritten or migrated. UTC filename dates still come from the original parsed publication instant, before local formatting.

A subscription such as `Reading/Wires/Example feed.md`:

```yaml
---
type: feed
url: https://example.com/feed.xml
title: Example feed
prefix: Example
enabled: true
deleted_urls:
  - https://example.com/dismissed-article
---
```

Subscriptions need `type: feed` and a URL. `title`, `prefix` and `enabled` are optional; enabled defaults to true, and `error` may describe a failed refresh. Removing a subscription does not delete its articles. Optional `deleted_urls` remembers articles deleted through Reader so RSS Sync does not import them again. It syncs with the subscription note; remove a URL to allow importing it again. Past deletions, external deletions and automatic expiry are not recorded. Manual Add URL still works.

Reader adds no note IDs, ownership stamps, copied highlight collections or persisted read history. Unknown YAML and authored text are preserved. See the [storage contract](docs/storage-contract.md) for acquisition, promotion and expiry rules.

## Install a release

This checkout contains the rebuilt implementation; it has **not been published as a new release**.

For an available release, use BRAT with `wannli/obsidian-reader`, or download `main.js`, `manifest.json`, and `styles.css` from the same release into `<vault>/.obsidian/plugins/obsidian-reader/`, then enable Reader in Community plugins. Installing a released version does not install uncommitted work from this checkout.

Choose **Inbox, Stream, Later, Treasury and feed-subscription folders independently** in Reader settings. No shared parent is required; duplicate/overlapping paths are rejected. Defaults are `Reading/{Inbox,Stream,Later,Treasury,Wires}`. Applying the validated group returns Reader panes to the list without moving or rewriting notes; old root/flat setting keys remain inert.

## Develop safely

Use the pinned Node runtime. The setup/watcher commands below are for an isolated development profile—not the currently connected joint-test vault. In that shared vault, keep Hot Reload and the watcher stopped and use validated artifact-only updates.

```sh
mise install
mise exec -- npm ci
mise exec -- npm run check
mise exec -- npm run dev:setup
mise exec -- npm run dev
```

- `dev:setup` explicitly bootstraps the owned `.sandbox/Reader2 Test Vault` and installs pinned Hot Reload **0.3.1**. Existing vault files/settings are preserved.
- Open that folder using Obsidian’s **Open folder as vault**, then confirm Reader and Hot Reload are enabled. Setup does not register a vault in Obsidian’s global vault switcher; files on disk alone do not prove a native reload.
- `dev` watches source and builds directly into that vault's installed plugin. It does not seed files, enable plugins, download dependencies, or create a second development bundle.
- `build` creates release-shaped artifacts in ignored `dist/`; it does not install or publish them.
- `vault:update` backs up and replaces only the three plugin artifacts in the owned vault, publishing `main.js` last.
- Ownership, path/link checks, and safety holds fail closed. Never point tooling at a personal vault or remove a hold to force progress.
- `.sandbox`, installed plugins/configuration, `.hotreload`, `dist`, and dependency caches stay out of Git/releases.

## Checks and code

```sh
mise exec -- npm test -- tests/documents.test.ts  # focused
mise exec -- npm test                           # unit/component
mise exec -- npm run test:tooling                # guarded build/setup/release tests
mise exec -- npm run format                     # consistent source formatting
mise exec -- npm run check                      # all checks and release build
mise exec -- npm run benchmark:scale            # opt-in 10k articles / 100 feeds
```

Targets: focused checks under 5 seconds; the full automated **test suite** under 10 seconds locally. Typecheck, formatting and release building are additionally included in `check`. No automated E2E suite; DOM geometry tests are not hardware acceptance.

The opt-in scale benchmark generates real synthetic Markdown files in an isolated hidden subtree of the marked dummy vault, preserving existing notes. It retains its corpus and JSON measurements for inspection. Core/filesystem timings and fixture-network feed throughput are not native Obsidian startup, rendering, device or sync measurements. It is separate from the fast test suite.

Start with the [codebase map](docs/map.md), [approved scope](docs/rebuild-spec.md), [storage contract](docs/storage-contract.md), and [visual rebuild report](docs/rebuild-report.html).

The [joint iPhone smoke plan](docs/mobile-smoke.md) uses one disposable Sync vault for Reader, Nodes and Fileclass, excluding Hot Reload and instrumentation. Sync is connected and running with Wannes’s restored choices; do not change those settings or request device-plugin disabling. Native-input holds still govern shared installation/checks.

Native Hot Reload, touch selection, physical iOS/Boox pagination, and real sync need separate manual acceptance in synthetic vaults. They are not claimed as verified by automated tests. Local commits/merges do not authorize personal-vault installation, pushing, version changes or publication.

Release Please remains the only release/version path. It prepares the release PR and draft release; the existing workflow validates the build, checks exact tag/version equality, and uploads only plugin artifacts before publication.
