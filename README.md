# Reader

**Save for later. Read in Obsidian. Keep what matters.**

[![Latest release](https://img.shields.io/github/v/release/wannli/obsidian-reader)](https://github.com/wannli/obsidian-reader/releases/latest)
[![Obsidian 1.8.0+](https://img.shields.io/badge/Obsidian-1.8.0%2B-7C3AED)](https://obsidian.md)
[![Markdown-first](https://img.shields.io/badge/storage-Markdown-blue)](#your-reading-library-is-just-markdown)

Reader brings your read-later list and RSS feeds into your Obsidian vault. Save an interesting article, settle into a clean reading view, and highlight the passages worth keeping—all without moving your reading into a separate app.

Your articles are ordinary Markdown notes. Your highlights stay in the text. Your reading position travels with your notes through your existing vault sync.

[Get started](#get-started) · [Reading workflow](#a-place-for-every-article) · [Feeds](#follow-feeds-without-the-backlog) · [Markdown format](#your-reading-library-is-just-markdown) · [Development](#development)

## Why Reader?

- **Save now, read when you have time.** Add a URL to your Inbox. Offline? Reader saves the URL immediately and can fetch the article when Obsidian is active and online again. Saving the same URL opens the existing article instead of making a duplicate.
- **Make room for focused reading.** A simple, titles-only list and a full-width article view keep the interface out of the way. Reader uses Obsidian’s typography and themes, with touch-friendly controls and a paged mode for e-ink reading.
- **Pick up where you left off.** Each article remembers your place, including when you move between articles. List indicators help you spot articles you’ve opened or highlighted.
- **Keep the good parts in context.** Highlight a passage and collect an attributed quotation in one or several typed notes—or create one for a new idea. Fileclass Inline supplies types and icons; Reader supplies the focused multiselect.
- **Keep your library yours.** Articles, references and collected quotations are ordinary Markdown. No separate annotation database or custom sync service. Read and edit them even without Reader.

Reader targets Obsidian desktop, iPhone/iPad, and Android/e-ink. Physical-device and cross-device acceptance checks are tracked separately in the [mobile smoke plan](docs/mobile-smoke.md); automated tests are not device certification.

## Get started

### Install

Requires **Obsidian 1.8.0 or newer**.

- **With BRAT:** add `wannli/obsidian-reader` as a beta plugin repository.
- **Manually:** download `main.js`, `manifest.json`, and `styles.css` from the same [release](https://github.com/wannli/obsidian-reader/releases), place them in `<vault>/.obsidian/plugins/obsidian-reader/`, and enable **Reader** in Community plugins.

This README describes the current source. An installed release may not include every change shown here; check its release notes.

### Save your first article

1. Open Obsidian’s command palette and run Reader’s **Add URL** command.
2. Paste an article URL. Reader saves it to **Inbox** and extracts readable text when online.
3. Use **Open reading list** to return to your library. Select text in an article to highlight it, choose **Read later** to keep it on your list, or **Archive** to set it aside.

To save several articles, run **Add articles from CSV** and choose a CSV file or paste URL-only rows separated by commas, semicolons or newlines. CSV with a `url` column header also works: quoted fields are supported and other columns are ignored. Reader checks all URLs before saving, deduplicates them and reuses existing articles. Cancelling or failing partway through leaves already saved articles in place.

Manual and browser-link captures go to `Reading/Inbox`; imported feed articles go to `Reading/Stream`. New native/QuickAdd notes with `type: article` and `status: inbox` are placed in Inbox when Reader observes their live creation. Configure the native capture tool to target Inbox too, especially for captures made while Reader is not running. Subscription notes default to `Reading/Feeds` (configurable). Reader can still read typed articles elsewhere, but they are not in a reading list.

## A place for every article

| List        | What belongs here                                    | Kept automatically?                         |
| ----------- | ---------------------------------------------------- | ------------------------------------------- |
| **Inbox**   | Articles you’ve saved and haven’t sorted yet         | Yes                                         |
| **Feed**    | New articles from your subscriptions                 | No—unprotected entries expire after a month |
| **Later**   | Articles you want to spend more time with            | Yes                                         |
| **Archive** | Articles you want to keep, but not on your next list | Yes                                         |

**Read later** keeps the article open. **Archive** and **Delete** advance to the next article in your original browsing list. Deletion uses recoverable Obsidian trash.

Highlighting or linking a passage in a Feed article moves it to Later before saving the annotation. **Simply opening or reading a Feed article does not keep it.** Choose Later or Archive if you want to retain it.

Only notes in the Feed folder with explicit `status: feed` can expire, one calendar month after their publication date (or filename date as a fallback)—not a month after import. Articles with topics, highlights or other annotations are archived rather than trashed by Reader. In-use and unknown-age notes are protected. A missing or conflicting YAML status never authorizes deletion. See the [storage contract](docs/storage-contract.md) for the full safety rules.

### Find your way around

- **Open reading list**, **Open Archive**, and **Manage feeds** are available from the command palette.
- Use **Previous / Next** to browse articles and **List** to return to where you started.
- Use native **Obsidian search** for general search, or filter a reading list by a **topic or phrase**. Topic filters include aliases, explicit topic assignments, and case-insensitive whole-word/phrase matches in article titles and saved bodies. Free text works without creating a topic note.
- An active topic filter uses Obsidian's accent colour and displays **Reading list: topic** in the list and above articles opened from it. Click the active filter button to clear it; click it when inactive to open the picker. From an article, return to **List** first. Switching queues retains the filter; Previous/Next follows the filtered list.
- Use **Open Markdown** to edit an article, or the bottom-bar **Related notes** multiselect to edit remembered typed destinations. Checked notes stay visible while searching; Apply confirms before closing. Creating a note delegates to compatible Fileclass Inline. Filtering is read-only; assigning related notes to a Feed article retains it in Later.
- On desktop, **j / k** navigate articles. At article boundaries, **Up / PageUp** and **Down / PageDown** move to the previous or next article, resuming its saved position.
- On Boox/e-ink, enable **pagination (this device)** in Reader settings to use single-chevron touch page buttons or hardware Up/Down and PageUp/PageDown. A separate Reader-wide **Show article navigation in paged mode** setting, off by default and shown only when pagination is on, adds double-chevron Previous/Next article buttons. Non-paged article arrows are unchanged.
- On iPhone, **Copy reading-list link** opens the library. **Copy dog-ear link** opens the last article you opened in Reader, or the first (newest) Inbox article if none is marked. Each gives you a vault-aware link for a Shortcuts **URL → Open URLs → Add to Home Screen** shortcut. You can also use **Open dog-eared article** from the command palette.

Lists follow the article's folder, not its YAML `status`. The four queue folders default to `Reading/Inbox`, `Reading/Stream` (Feed), `Reading/Later`, and `Reading/Treasury` (Archive), and can be changed in Reader settings. Folders must be distinct and cannot overlap. A folder move made outside Reader changes the list without rewriting YAML; a Reader status action updates YAML and moves the file. Applying settings does not move existing notes, and no automatic migration runs. `Templates/` and `.trash/` (including nested folders with those names) are excluded from Reader entirely. Moves respect Obsidian’s internal-link update preference; disabling it can leave links broken.

## Follow feeds without the backlog

Run **Add feed** with an RSS or Atom URL. Reader saves the subscription first, giving you time to edit its title and options. Then use **Sync** in **Manage feeds**, or the **Refresh feeds** command, to bring in articles.

- **You choose when to refresh.** No startup or scheduled feed polling.
- **Each refresh considers the latest 20 entries per feed**, before deduplication and age filtering. Reader is for recent reading, not a complete feed archive; busy feeds can have entries you miss between refreshes.
- **Available feed text is saved first.** Missing full text can be fetched when you open an article or move it to Inbox/Later.
- **Delete once through Reader.** The subscription remembers explicitly deleted article URLs so later refreshes skip them. This is per subscription: another feed or a device that hasn’t synced the deletion record can still import the URL. It does not cover external deletions or automatic expiry, and you can still save the URL manually.
- **Unsubscribe without losing saved articles.** Removing a subscription leaves its articles alone.

## Highlight and collect ideas

Every new highlight has at least one **typed host note**. Reader inherits one remembered destination automatically; with none or several, its initially empty native-style title/type/icon search lets you check several notes and **Add highlight** once. Creation is explicit with a Fileclass type. Untyped files are excluded.

Highlights preserve selected words, formatting and publisher URLs:

```markdown
==Clear **rules** build [trust](https://example.com/report).== (※ [[Governance]]) ^reader-k7m2
```

Each selected note receives a quotation under `## Highlights`, grouped by `### [[Article title]]`, with a precise paragraph citation and local collection-date link such as `[[2026-10-20]]`. Editing the source never silently changes the snapshot; an explicit removal from that highlight's notes can remove its uniquely matching, unedited copy.

- Drag to select text, or enter **Highlight** mode and tap the **first** and **last word**. Tap the same word twice for one word.
- Or tap a word, then **Sentence** or **Paragraph**. **Done** cancels an unfinished selection; **Escape** clears the first word, then exits.
- The passage bar offers **Add highlight to notes…** and explicit **Convert to note link**. With no highlight selected, clicking its reference edits that highlight’s checked notes. Unchecking removes the reference and exact saved copy; edited/ambiguous copies block removal. Source-only removal/brief Undo never deletes stored copies or reverses Feed → Later retention.
- **Convert to note link** makes an ordinary `[[Node|original words]]` mention, without highlighting or redundant references. Only a newly created note receives `origin: "[[Article#^paragraph]]"`; existing origins are preserved. No quotation of the node's own name is added.
- For direct collection, click a highlight and then a note reference: file the **first** quotation in that exact note without changing the destination-selecting text. **Choose from article…** remains a secondary shortcut for other targets; the first passage supplies the citation.

Scrolling and paging still work in Highlight mode; article-navigation shortcuts pause until exit. Each highlight’s references share one native-sized pill containing each note’s Fileclass icon and name, without a generic marker. Destinations remain independently clickable; ordinary typed-note links keep their icons. Existing article topics appear in the top reading header with the same styling. Decorations are not quotation text. Cancel before saving leaves no new highlight; provider cancellation can leave a created note, which Reader never deletes.

New hosted highlights require **Obsidian 1.12.7+** and public **Nodes API v2** at `fileclass-inline.api`; typed creation additionally needs `createNodeForLink`. Fileclass Inline owns schemas and required-field completion, not Reader's picker. Without it, existing articles/highlights/links remain readable, but new hosted highlights are unavailable.

The article’s **Related notes** multiselect manages future defaults, not previous quotations. Source/target saves are guarded but not atomic: partial failures report saved source and verified target progress. Filing retries deduplicate quote + paragraph citation without changing its date; completed removals are never blindly retried. Dirty/uncertain editors remain protected. See the [full contract](docs/hosted-highlights.md).

## Offline reading and capture

**Saved article text is available offline.** Text that hasn’t been fetched yet is not, and images remain remote rather than being downloaded for permanent offline access. Tap or click an image to open a larger view.

While reading, clicking a web link offers **Save to Inbox**, **Open link**, or **Cancel**. Saving keeps your current article open.

For native iOS/QuickAdd capture, configure the destination as `Reading/Inbox` (or your configured Inbox folder), along with templates and shortcuts, directly in [Obsidian](https://help.obsidian.md/mobile/ios). Give captured notes `type: article`, `status: inbox`, and a `url` property. Reader can fetch the article while active and online when the body is empty or contains only a Markdown source link matching that URL. A plain URL body is not a supported placeholder.

Reader leaves extra text, annotations, and native Full Text captures intact. Native captures keep their own filenames and do not use Reader’s URL deduplication; use **Add URL** when you want that behavior. Reader does not install templates or change your capture setup.

Reader sanitizes imported content, but is not a sandbox for third-party Markdown processors. Detected default Dataview/Templater expressions can block capture; custom processor configurations are outside that protection.

If extraction fails, the URL and available text remain, and you can retry. **Run Defuddle again (replace article content)** is a separate, confirmed action: it replaces the body, **including highlights and inline links**. A failed download leaves the current body intact. Ordinary Retry does not overwrite authored text.

## Your reading library is just Markdown

Reader identifies articles by `type: article` and subscriptions by `type: feed`, wherever you store them. You can move and rename the files yourself.

An article might look like this:

```markdown
---
type: article
status: inbox
url: https://example.com/article
title: A useful article
published: 2026-10-14T08:00
feed: '[[Reading/Feeds/Example feed.md]]'
topics:
  - '[[Topics/Reading.md]]'
bookmark: An important passage remains ordinary Markdown
dog_ear: true
---

An ==important passage== (※ [[Topics/Reading]]) remains ordinary Markdown. ^reader-k7m2

A node-only [[Notes/A useful idea|useful idea]] is an ordinary link.
```

`title`, `published`, `feed`, `topics`, `bookmark`, and `dog_ear` are optional. Local articles do not need a URL to be read. The bookmark is a text anchor, not a page number, completion flag, or reading history. Reader moves `dog_ear: true` when it opens another article; it does not replace any article's bookmark. Pagination preferences stay device-local.

A subscription might look like this:

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

Subscriptions need only `type: feed` and `url`; `enabled` defaults to true. Optional `deleted_urls` records Reader deletions; remove an entry to allow that URL to be imported again. An optional `error` property on either note type can describe a failed fetch.

Reader preserves unknown properties and user-authored content during normal updates. It adds no article/highlight IDs or sidecars, and does not migrate legacy settings or reading positions. Explicit quotation snapshots belong to you; they are not synchronized copies. New publication dates use Obsidian’s local `YYYY-MM-DDTHH:mm` format; existing dates are not rewritten. For exact capture, date, folder-move, and retention behavior, see the [storage contract](docs/storage-contract.md).

## Development

Use the pinned Node runtime and an isolated, repository-owned synthetic vault—never a personal vault.

```sh
mise install
mise exec -- npm ci
mise exec -- npm run check

# Optional: set up an isolated Obsidian development vault
mise exec -- npm run dev:setup
mise exec -- npm run dev
```

`dev:setup` bootstraps `.sandbox/Reader2 Test Vault` and installs pinned Hot Reload **0.3.1**. Open that folder as a vault in Obsidian and confirm Reader and Hot Reload are enabled. `dev` builds directly into it; `build` writes release-shaped artifacts to ignored `dist/` without installing or publishing them. `vault:update` backs up and replaces only the three plugin artifacts in the owned vault.

Keep Hot Reload and watchers out of the shared Sync acceptance profile. Ownership checks and native-input holds must be respected; never bypass a hold to force an update.

```sh
mise exec -- npm test -- tests/documents.test.ts # focused tests
mise exec -- npm test                          # unit/component tests
mise exec -- npm run test:tooling              # guarded tooling tests
mise exec -- npm run format                    # shared formatting
mise exec -- npm run check                     # format, metadata, types, tests, build
mise exec -- npm run benchmark:scale           # opt-in: 10k articles / 100 feeds
```

Targets are under 5 seconds for focused checks and under 10 seconds for the automated test suite locally. There is no general automated E2E suite; [topic-filter acceptance](docs/topic-filter.md) includes a local synthetic-host browser run, not native certification. Native touch, e-ink, and real sync behavior require separate manual checks. The scale benchmark retains synthetic files and measurements in the marked dummy vault, not a personal vault.

Start with the [codebase map](docs/map.md), [approved scope](docs/rebuild-spec.md), [storage contract](docs/storage-contract.md), and [mobile smoke plan](docs/mobile-smoke.md).
