---
created: 2026-11-02
---

# Reader sync risks and improvements

Reader has two different sync paths. Obsidian Sync moves the Markdown notes between devices; Reader does not provide a separate cross-device sync engine. The **Sync** button in Manage feeds fetches RSS/Atom articles. This is a code review and a list of risks, not a report of reproduced device failures.

## Where problems could occur

- **Two devices edit the same article.** Reader checks the current local bytes before saving, but that check cannot coordinate devices. Bookmarks, highlights, and status changes may conflict after Obsidian Sync transfers them. See `src/core/store.ts` (`commit`, `position`) and `src/host/vault.ts` (`process`).
- **An action changes several notes.** Filing a highlight saves the article and then its destination notes. Reader reports partial progress if a later write fails, but the writes cannot arrive together on another device. See `src/core/store.ts` (`collectHighlightMany`).
- **A deleted feed entry returns.** Reader first adds the URL to the subscription's `deleted_urls` and then trashes the article. A second device may see the deletion before that record and import the URL again. This timing limit is also documented in `README.md`. See `src/core/store.ts` (`trashNote`, `importFeed`).
- **Two articles carry the dog-ear marker.** Reader marks the new article before clearing old markers, one file at a time. An interrupted operation or concurrent opens on different devices can leave more than one marker. The shortcut picks the first indexed marker, not a guaranteed latest one. See `src/core/store.ts` (`dogEar`) and `src/main.ts` (`openDogEar`).
- **A feed misses a recent item.** Parsing considers only the first 500 entries before the refresh selects the latest 20. Missing publication dates also make the date sort unreliable. See `src/content/feed.ts` (`parseFeed`) and `src/host/ingestion.ts` (`refresh`).
- **Feed Sync gives limited feedback.** Per-feed failures are reported as notices, while the overall refresh resolves without a summary of imports, skips, and failures. See `src/host/ingestion.ts` (`refreshAll`) and `src/host/settings.ts` (`showFeeds`).

## Recommended next steps

1. Make feed selection deterministic when dates are missing. Handle the 500-entry cap explicitly rather than silently treating that subset as the whole feed.
2. Show imported, skipped, and failed counts after a feed refresh. Keep partial highlight results visible and offer a deliberate retry of only unfinished destinations.
3. When a note changes during an operation, show the newer version before offering to retry. Do not automatically overwrite a newer synced bookmark or replay a whole highlight operation.
4. Test the timing cases with synthetic vaults, then test important flows with two real Obsidian devices. Automated tests alone cannot verify Obsidian Sync behavior.
5. Document what cannot be atomic across devices. Stronger guarantees would need a separate, approved storage and recovery design; do not add a sidecar, migration, or startup cleanup as an incidental fix.

These are recommendations for investigation, not approved schema changes or decisions.
