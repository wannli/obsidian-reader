# Reader

A small Markdown-first article and RSS reader for Obsidian desktop, iPhone/iPad, and Android/e-ink. Requires Obsidian **1.8.0 or newer**.

## Read and keep

- **Add URL** saves a note immediately, including offline; available article text is acquired while Reader is active and online. Clicking a web link offers **Save to Inbox**, **Open link** or **Cancel**; saving keeps the current article open and reuses existing-URL deduplication.
- **Download article again (replace content)** re-fetches the current article after a destructive-action confirmation. It replaces the body, including highlights and inline links, but preserves unknown frontmatter and explicit titles. A download/extraction failure leaves the existing body intact; concurrent edits and dirty editors remain protected. Use it in Reader or native Reading view; source/live-preview editors stay protected. Ordinary Retry never overrides authored text.
- **Add feed** saves an RSS/Atom subscription without importing articles, so you can edit its parameters first. **Sync feeds explicitly** when ready; startup and periodic timers do not refresh feeds. Each Sync considers at most the **latest 20 entries**, before age filtering and deduplication. There is no backlog/history service.
- Browse **Inbox, Later and Stream** in a flat, titles-only list; use **Open Treasury** and **Manage feeds** commands for those views. Search through native Obsidian rather than an embedded search bar. Source URLs remain stored in the notes.
- Right-side indicators show **Opened before** from an existing saved reading position and **Has highlights** from Markdown. No extra metadata, completion flag or persisted history is added.
- Select text to highlight it or add topic links. Link/Change and Create note use Fileclass Inline’s shared picker for existing notes or inline creation through the optional public **Nodes API v2** integration.
- Both views use compact, leaf-owned **floating bottom controls**, accessible labels and 44px targets. Articles use the pane width, one title and scrollbar/final-text clearance. **Previous, Next, Read later, Save to Treasury, Delete, List** have no action divider. Read later (clock) moves to Later and keeps the article open; Save to Treasury (bookmark) and recoverable Delete advance within the original browsing context.
- Exact `type: article` notes open in Reader; **Open Markdown** preserves an explicit native-editor escape, and dirty editors are protected. **Topics** and **Move article** remain commands. Reading position travels with the note; pagination is device-local.
- Obsidian’s separate floating mobile navigation bar hides only while Reader is active. At article boundaries, **Up/PageUp** opens the previous article and **Down/PageDown** the next, without held-key skipping or interfering with editing. Every article entry still resumes its own saved position.
- **Open reading list** forces the library. On iPhone, **Copy reading-list link** supplies a vault-aware `obsidian://obsidian-reader` URL for a Shortcuts **URL → Open URLs → Add to Home Screen** shortcut; no extra plugin is needed.

The combined integration requires Obsidian **1.12.7 or newer** and `fileclass-inline.api` v2 with `pickNodeForLink`. Both note actions open the shared picker seeded with the passage title; Reader commits the guarded source link before required-field completion. There is no All notes route or standalone creation fallback. Missing/older APIs or v2 without this capability leave linking/creation unavailable; highlights, opening existing links and unlinking still work. Failed/cancelled linking can leave a note: Reader never prunes it. V2 supplies class membership/icons, not schema colors. Reader does not use the old `obsidian-nodes` ID or migrate plugin settings/data.

Markdown is the only article store. Reader preserves authored text, unknown YAML, and existing links; it does not maintain sidecars, copied highlights, custom sync, or migration code. Images remain remote; inline images fit the reading area and open a larger view when clicked or tapped.

**Stream is disposable:** annotations and vault links promote articles to Inbox; unprotected entries older than one clamped UTC calendar month go to vault-local recoverable trash. Unknown-age and in-use notes are retained. See the [approved storage contract](docs/storage-contract.md).

## Native iOS capture

Configure capture locations, templates and shortcuts directly in [Obsidian](https://help.obsidian.md/mobile/ios); Reader does not install templates or provide a setup command. Existing vault templates are left untouched.

Native captures in Inbox use the existing `type: article` and `url` properties. Reader starts Defuddle while Obsidian is active and online when the body is empty or contains only a single Markdown source link matching that URL. Extra text, annotations and native Full Text captures remain protected; a plain URL body is not a supported placeholder. Offline captures retain their URL for foreground recovery.

Native capture keeps its own filenames and creates a note per capture, without Reader’s deduplication. Use **Add URL** when those features are needed. Physical-device acceptance remains manual.

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

Release Please remains the only release/version path. Wannes merges its release PR to authorize publication. The serialized Release workflow builds and validates the **exact existing release-tag commit**, not the commit that triggered the workflow. It uploads only `main.js`, `manifest.json`, and `styles.css`, verifies the complete remote asset set, then publishes the existing draft without changing its tag or notes.

Failed or partial publication can safely retry: matching assets are reused; conflicting bytes fail without overwriting. The workflow also recovers an existing current-version draft when Release Please reports no newly created release. To recover a specific existing draft without running Release Please:

```sh
gh workflow run release.yml --ref main -f existing_tag=0.7.1
```

Recovery never creates or moves a tag, creates another release, or changes version metadata. Published releases are not overwritten.
