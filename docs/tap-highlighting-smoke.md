# Tap highlighting — joint device walkthrough

## Status and boundary

Source implementation and automated checks are separate from native acceptance. A Chromium component check is not proof of desktop Obsidian, iOS, Boox, or Sync behavior. Full cross-device acceptance is not yet recorded.

Icon-only E2E installation/reload verified on 2026-10-19: Reader 0.12.0, actual loaded constructor build `eca8e4b9c684ca380b03592bdbe8a3c8af02e0133a088e170620059ac8aacf16`. Only the three Reader artifacts were replaced; protected Reader settings, enablement and companion files were unchanged. Backup/evidence: `.sandbox/backups/tap-highlighting-icons-e2e-2026-10-19T20-11-29.028Z-784026` outside Sync. The scoped native-input lease is closed. Wannes gave positive desktop feedback on the preceding `582c987d…` build and requested icons/no explainer; Wannes subsequently reported basic Boox highlighting working, but the post-highlight popup menu failing. The device loaded build was not independently verified; iPhone acceptance is unrecorded. The follow-up is not installed.

Follow-up candidate `c95b332be8690bbd555ab50af8941557efec1dde5b5105e52732ab4beffc99e6` adds same-bar passage actions and compact Topics assignment. Full check: **1,939 tests + 75 tooling checks**, formatting, typecheck and production build passed. Browser-only checks covered 320px, 390px/short viewport and desktop: icon geometry, balanced rows, save/selected-highlight actions, unlink/remove, and a fixed Topics footer with scrolling results. These do not establish native activation or acceptance. Shared Nodes-picker UI compaction awaits companion-change approval.

Wannes requested the order **desktop → iPhone → Boox**, using only the repository-owned **E2E vault** (`.sandbox/e2e` in the authoritative repository). Do not use a personal vault or the older default test vault. Verify the E2E ownership marker, registered vault ID, actual renderer path, current installed build and input-hold clearance before native work. Pin CLI commands to that ID. Installation/reload must not replace newer parallel work.

Build/backup evidence and any diagnostic tooling stay outside the Sync payload. Stage only the verified Reader artifacts after authorization; reload Reader only. Do not change Sync settings, plugin enablement, companion plugins, or install Hot Reload/watchers/instrumentation.

## Desktop first

Use a small disposable article with two sentences in one paragraph, another paragraph containing emphasis, and repeated words in distinct paragraphs. Record Obsidian version and the loaded Reader build ID.

1. Tap/click the **highlighter** in the existing bottom bar. Confirm the same bar shows icon-only **Sentence** (text selection), **Paragraph** (¶), and **Done** (checkmark), with Sentence/Paragraph initially disabled and no explainer above the bar. Check tooltips/accessibility labels; Undo uses a back-arrow icon.
2. Tap a word in the second sentence. Only that word gets a transient outline; no highlight is saved. Choose **Sentence**: only the second sentence, including punctuation, is highlighted promptly.
3. Choose **Undo** within six seconds: that highlight disappears. Repeat with **Paragraph**: both sentences are highlighted. Confirm emphasis/wording survive.
4. Tap a first and last word for a fragment; repeat in reverse order and with the same word twice. Repeated text must affect the tapped occurrence, not the first matching text elsewhere.
5. Stage a first word and scroll/page. Scrolling must not become an endpoint tap. **Done** cancels/exits in one press; **Escape** clears the endpoint, then exits on a second press. Leaving the article never saves an unfinished first tap.
6. After tap-save, the same bar shows Link/Create note when supported, Remove highlight, brief Undo and Done. Tap an unhighlighted word to start the next selection; tap an existing highlight with no pending endpoint to show its actions. Linked highlights retain Open/Change/Create/Remove link. Remove keeps the text and linked note; unlink keeps the highlight. Confirm Undo expires and Done restores the normal bar. Native drag highlighting remains available outside the mode.
7. On a disposable Feed article, highlight then Undo. The highlight is removed but the article remains Later. If the source changes externally, discard the pending endpoint/Undo instead of modifying new text.
8. Confirm all controls stay within the leaf at a narrow pane width, remain at least 44px targets, and the final article text scrolls/pages above the bar without reserving space for a removed hint. Check for errors and distracting repositioning.

9. Open Article topics: search, selected topics and Add topic/Cancel/Save stay visible while results scroll. Rows/actions stay ≥44px, names stay compact and only ambiguous names show paths. Check immediate creation linking, retained drafts on failure and Cancel semantics without a permanent explainer. Shared Nodes picker UI is companion-owned and requires separate change/install approval.

## Then iPhone, then Boox

Repeat steps 1–9 on the actual devices, recording model, OS, Obsidian version, loaded build, article size, and any observed latency or failure. Verify the installed plugin has actually loaded after artifact sync; Sync completion alone does not prove this.

- iPhone: short taps versus scroll swipes, long press, pinch/multitouch, safe area, portrait/landscape, background/resume. No native selection handles or callouts should appear in Highlight mode.
- Boox: discrete taps with e-ink latency, device-button paging while armed, no unintended article handoff, and readable pending/saved feedback without relying on animation or colour alone.
- Both: open the same-bar actions from an existing highlight in and outside Highlight mode; exit to open ordinary links/images. Confirm saved inline Markdown and bookmarks survive reopen/sync without extra persisted annotation state.

Stop at the first unexpected result and fix/recheck that case before moving to the next device. Never label unrun devices as passed.
