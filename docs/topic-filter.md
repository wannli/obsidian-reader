# Topic-filter acceptance scope

Approved by Wannes on 16 October 2026: filter the current reading queue by an existing topic (including aliases) or a free-text term; add an article-toolbar topic assignment button; use Obsidian's accent colour for the active filter. Test locally before sending to remote.

## Matching

- Only articles in the selected queue participate. Ordinary notes are topic candidates, not reading-list results.
- Selecting a topic matches either an explicit `topics` relation resolving to that note, or its name/aliases in an article title or body.
- Free text works without a topic note and never creates one. It matches the entered word/phrase in titles and bodies.
- Text matching is case-insensitive, literal, and whole-word/phrase, not substring matching. Markdown presentation should not hide matching visible words; link destinations and frontmatter are not article prose.
- Topic notes remain ordinary notes with exact `type: topic` and optional native `aliases`. No new persisted article schema, separate database, generated reverse links or personal-vault configuration changes.

## Interaction

- Choosing another queue retains the filter, scoped to that queue.
- Reader renders a compact in-content `Reading list: <topic>` heading for an active filtered list and context beside the article heading when entered from that filtered list; free-text phrases use the same format. This is not a separate banner, and article titles stay unchanged. `getDisplayText()` supplies the native tab title where Obsidian uses it, but the host-owned header beside navigation arrows may remain `Reading list`; no private native-header DOM manipulation.
- The active Filter by topic button uses accent colour and clears immediately when clicked; when inactive it opens the picker. From an article, use List then the same toggle to clear.
- Previous/Next uses the filtered browsing snapshot, including matches beyond the first rendered page. List returns to the filtered list.
- Assignment is separate from filtering: the bottom-bar Topics action is a mobile-friendly multiselect of existing topics, using the existing guarded write path. Full labeled rows must be tappable and keyboard accessible, with selected topics visible even while searching and ≥44px targets. Wannes additionally approved creating a new topic from this picker through Fileclass Inline's public abstraction.
- Existing assignment semantics remain: changing topics on Feed/missing-status articles promotes them to Later before saving. Filtering never writes, promotes, acquires content, changes bookmarks or creates notes.

## Topic creation

- Feature-detect API v2 `createNodeForLink` and an exact `topic` class. Fileclass Inline owns naming, destination, creation and required-field completion; Reader has no standalone file/form/schema fallback.
- The configured Fileclass binding must produce exact `type: topic`. Validate the new note and class membership before source linking; do not inspect private Fileclass settings or silently change its binding.
- The callback appends the created topic to the persisted article topics before required completion. Other unsaved multiselect changes remain draft until Save.
- Compact presentation approved 19 October: remove permanent explanatory paragraphs, use one footer and a bounded results region; retain ≥44px targets and visible selected topics. Convey immediate-link semantics through accessible action description/tooltip, not body copy: Cancel discards other draft changes but cannot undo the created note or committed link. Never prune the note on cancellation or failure; preserve search context and retain the new selected topic.
- Source/target identity, stale contents, editor safety, API lifetime and cancellation must be checked. A callback is single-use; wait for already-dispatched Reader writes, not an uncooperative provider. Never link a second time from the returned result.
- Missing integration/class leaves existing-topic assignment usable with a clear creation-unavailable explanation. No automatic companion installation or configuration changes.
- Save awaits the guarded article write before closing the multiselect. A failed write keeps the draft and shows an error; duplicate saves are disabled while pending. Creation/progress states remain visible, and Cancel stays available.

## Read bounds and lifecycle

- Only an active filter authorizes on-demand current-queue body reads. Keep Catalog metadata-only.
- Short-circuit explicit relation and title matches; use bounded concurrent body reads for the remainder.
- Cancel stale work when filter, queue, view or data changes. Never display a superseded result as the current filter.
- Body-only edits, topic aliases, renames and deletion must invalidate relevant results.
- Surface pending and read-failure states instead of silently calling incomplete results complete.

## Validation gates

- Pure matcher tests: explicit links, aliases, titles, bodies, casing, Unicode boundaries, punctuation, phrases, formatted text, substring rejection, and free text.
- View/service regressions: queue isolation, filtered navigation and pagination, clearing/switching filters, stale reads, body/alias edits, bounded concurrency, no writes/acquisition, assignment action and accessible accent state.
- Browser interaction acceptance uses the production Reader with a synthetic host. It does not prove native Obsidian integration, mobile touch, e-ink or Sync behavior.
- The native Obsidian lane remains held; do not access it without separate clearance. No personal vault testing or installation.
- Run focused checks, the full repository check, and browser acceptance before considering any remote push. Record actual evidence and limitations; do not treat a mocked host as native E2E.
