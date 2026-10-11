# Optional QuickAdd article templates

QuickAdd owns this rich capture workflow. Reader has **no QuickAdd dependency**.
Existing Pullman choices, template files, and Shortcuts are not renamed or removed
automatically. Applying these new assets requires separate vault approval; update
the choice IDs/names, template paths, and vault-scoped Shortcut URIs together.

These are native QuickAdd configuration/templates, not a Reader template engine,
macro, script, URI handler, or settings panel.

## Version and evidence

Researched official QuickAdd **2.32.0**, MIT license, `isDesktopOnly: false`,
minimum Obsidian **1.13.0**. Configuration and URI syntax were checked against
that release's documentation and TypeScript, not guessed from another plugin.
Actual Desktop and physical iOS acceptance must be recorded separately.
`release.json` records the official GitHub release asset SHA256 digests. No
executable plugin artifact is bundled or installed by these assets.

Pinned sources:
- [Release](https://github.com/chhoumann/quickadd/releases/tag/2.32.0)
- [URI documentation](https://github.com/chhoumann/quickadd/blob/2.32.0/docs/src/content/docs/docs/Advanced/ObsidianUri.md)
- [URI implementation](https://github.com/chhoumann/quickadd/blob/2.32.0/src/uri/registerQuickAddUri.ts)
- [Template documentation](https://github.com/chhoumann/quickadd/blob/2.32.0/docs/src/content/docs/docs/Choices/TemplateChoice.md)
- [Format documentation](https://github.com/chhoumann/quickadd/blob/2.32.0/docs/src/content/docs/docs/FormatSyntax.md)
- [Quoted-scalar tests](https://github.com/chhoumann/quickadd/blob/2.32.0/src/formatters/formatter-quoted-scalar.test.ts)
- [Input remains data](https://github.com/chhoumann/quickadd/blob/2.32.0/src/formatters/helpers/userText.ts)
- [Configuration types](https://github.com/chhoumann/quickadd/blob/2.32.0/src/types/choices/ITemplateChoice.ts)
- [Verified opening-mode enum](https://github.com/chhoumann/quickadd/blob/2.32.0/src/types/fileOpening.ts): `default` leaves ordinary file opening to Obsidian.

## Configure in QuickAdd

1. Install QuickAdd through Obsidian's Community Plugins UI only in an explicitly
   approved project test vault. The default `Reader2 Test Vault` is quarantined;
   these instructions do not release it or authorize a reset. Never use a personal vault.
2. Copy `Article.md` and `Article-quick.md` to `Templates/Reader/` in the vault.
   Keep templates outside the Reader article folder.
3. Create a **Template** choice named **Reader article**, using
   `Templates/Reader/Article.md`.
4. Enable filename format: `{{DATE:YYMMDD}} Article {{DATE:HH-mm-ss-SSS}}`.
   Native date tokens use the local capture/addition date, not publication date.
   Leave the date origin at now. Shared input never controls paths or filenames.
5. Choose fixed destination `Reading/Inbox`. The folder determines the Inbox
   queue; the templates omit YAML `status`. Folder/template selection belongs to QuickAdd.
6. Enable **Open**, **New tab**, **Default** view mode, **Focus new pane**.
   Reader routes the created `type: article` note into Reader automatically.
   Without Reader enabled, it opens as an ordinary native Markdown note.
   Use Reader's explicit **Open Markdown** action when editing is wanted.
7. For existing filenames choose **Create another file → Append duplicate
   suffix**. Never choose overwrite or keep-existing for a capture with comments.
8. Enable **Add to command palette** (lightning bolt) and one-page input.
9. Optionally create **Reader article quick**, same settings but template
   `Templates/Reader/Article-quick.md`: URL only, no title/comments prompts.
   This quick variant does not consume shared title/comments; use the full
   choice whenever those values need preserving.

`choices.json` is a **choice-array fixture**, not a whole `data.json`, package,
or supported QuickAdd import file. Test-tooling may merge these two entries
into the isolated test vault's QuickAdd choices. Do not replace live settings.
Its keys match the pinned release; use the UI instructions for ordinary setup.
The delivered choices use fresh Reader IDs `reader-article-template` and
`reader-article-quick-template`; old Reader choices/Shortcuts are not migrated.
Setup is create-only and refuses differing installed choices/templates;
changing repository assets alone does not update installed settings. Tooling owns
any explicitly approved dummy-vault setup/reset, preserving unrelated settings.
No cursor token or post-open script assumes the routed leaf is a Markdown editor.

The project is pre-production until the user says otherwise; that assumption
never extends to personal vaults or other projects. Canonical article folders
`Reading/{Inbox,Later,Stream,Treasury}` determine queues ahead of old YAML status;
supported legacy notes outside those folders still use status fallback.
`Reading/Wires` holds feed definitions, not articles. RSS naming belongs to Reader,
not QuickAdd: UTC publication day (addition date if missing), feed YAML `prefix`
(default/fallback: feed title), then ` - Title.md`, e.g. `261009 Wired - Title.md`.
The addition-date fallback does not invent `published` metadata.

The full template uses native `|optional`: Skip or submitting blank resolves
that value to empty; Escape cancels the entire run. These semantics are verified
in the pinned [optional formatter tests](https://github.com/chhoumann/quickadd/blob/2.32.0/src/formatters/formatter-optional.test.ts)
and Format Syntax documentation. An empty title keeps the timestamp filename
as Reader's sensible display-title fallback. Supplied named URI values fill
those fields; absent values are prompted by QuickAdd. A cancelled prompt must
create nothing. Turning a particular prompt off is a template
configuration change: remove that VALUE placeholder; removing a placeholder
also means that input is not captured. There is no Reader capture preference.

## Share Sheet Shortcut contract

Use iOS/macOS Shortcuts **Show in Share Sheet**, receiving URLs. Select one URL,
reject empty input and non-HTTP(S) schemes, and optionally ask for a title and
comments. Do not fetch the page. Encode **each parameter value once**, then
assemble this text and use **Open URLs**:

```text
obsidian://quickadd?vault=ENCODED_VAULT&choice=Reader%20article&value-url=ENCODED_URL
```

Optional parameters: `&value-articleTitle=ENCODED_TITLE` and
`&value-comments=ENCODED_COMMENTS`. The title variable is deliberately named
`articleTitle`; the resulting YAML property is `title`. Use the exact unique
choice name, and always include `vault`. No callback parameter is needed.
`uri-examples.json` contains complete examples and their decoded values. Its
historical test-vault name illustrates encoding, not permission to use the held vault;
substitute only the exact explicitly approved target vault name.

Do not URL-encode the assembled URI again, decode values again in scripts, or
use shared text as executable code. Obsidian decodes query values before
QuickAdd assigns `value-*` entries. An article URL containing `%25` therefore
contains `%2525` in the outer URI and returns to `%25` in the note.

This opens Obsidian visibly. It is not a native share extension or invisible
background capture. Confirm the target vault/plugin is available and wait for
sync before sharing. Same-process filename collision safety is not a promise
of conflict-free multi-device sync. Physical iOS and real sync: **NOT RUN**.

## Note and security boundaries

- Ordinary `type: article`, `url` YAML; no generated `created-by` or `status`
  or opaque regions. The full template preserves its optional quoted `title`.
  Canonical `Reading/Inbox` supplies the queue; do not interpolate title into paths.
- Quoted VALUE tokens rely on QuickAdd 2.32.0's serializer-aware escaping;
  quotes, newlines, colons and template-like shared text remain data.
- `## Highlights` sits above the empty `## Article`; acquisition owns Article only.
  No `## Comments` heading is generated or required. The full template keeps
  optional comments as plain text after Highlights and before Article, outside
  the Article source region; Highlights is the first body heading;
  existing notes' Comments sections remain untouched.
- No cursor token, editor-position request,
  or hidden HTML marker is used. Opening the note does not wait for extraction;
  Reader owns routing and the reading interface remains highlight-only.
- Capture is immediate/offline and does not fetch the page or call an extraction
  API. Reader automatically observes the new/changed article note and fills an
  unfinished `## Article` while Obsidian is online and active: no separate
  command and no need to manually open Reader view. Offline capture still saves
  immediately; acquisition pauses even in dummy mode and resumes on reconnect. Nonempty Comments or a feed summary do not count as
  completed full text. **Use dummy article content** defaults ON, producing
  clearly labeled deterministic sample text with no article network fetch;
  switch it OFF in Reader settings for real extraction. Already-complete real
  text is skipped; authored/highlighted snapshots and personal Comments must
  remain protected. QuickAdd contains no duplicate fetch implementation.
- No clipboard read is configured. Manual paste is an explicit user action.
- Native Template validates required input presence, **not HTTP(S) syntax**.
  Shortcut validation is required; Reader must reject unsupported URLs safely.
- Native QuickAdd collision handling is filename-based, **not URL deduplication**.
  Repeated URLs may create separate intact notes. Do not claim open-existing
  URL deduplication or automatic comment merge; that needs separately approved
  integration. Reader RSS/import deduplication is separate. These fixtures never
  overwrite a previous note or drop comments
  through a keep-existing collision policy.

`tests/quickadd-assets.test.ts` checks fixture contracts, not QuickAdd execution.
Desktop validator should test hostile YAML input, inert template-like input,
Cancel, collisions, automatic Reader routing, native opening without Reader,
and extraction preserving Comments using the actual pinned plugin before
claiming runtime acceptance. No Source-editor or cursor-placement expectation
applies to new captures.

## Older quick-capture repository lessons

Read-only inspection found no local AGENTS.md. It is a Raycast daily-note
extension using Node filesystem APIs, not a mobile Obsidian URI integration.
Keep its useful explicit-submit/configurable-section ideas, not its Node APIs,
whole-file replacement, or assumptions about desktop filesystem access.
