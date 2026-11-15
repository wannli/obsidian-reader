---
created: 2026-11-15
updated: 2026-11-15
status: approved-for-implementation
---

# Acceptance and delivery: Reader thinking workflow

This companion defines completion for the [workflow spec](reader-thinking-workflow.md). The [persistence contract](reader-thinking-persistence.md), record grammar and test seams were approved in [the implementation mandate](https://github.com/wannli/obsidian-reader/issues/107#issuecomment-6899314991). No changed test fixture may quietly introduce a different production schema.

## Proposed test seams

- **Primary:** the Thinking module's public interface with the existing in-memory vault adapter. Use real Markdown transforms and observable saved bytes/results. Inject the clock, provider adapter and explicit lifecycle guards only where behavior varies.
- **Interaction:** the existing Reader view fixtures, with the real module beneath them. Test actions, displayed snapshots, selection/focus guards, navigation and failure feedback, not a mocked success-only presenter.
- **Native adapter:** existing vault/editor guard fixtures for final source-byte checks, dirty editors, file identity, delayed writes and runtime replacement.
- These are a proposal for review, not a test-layout mandate. Keep focused tests below five seconds and the full local suite below ten seconds; investigate regressions rather than hiding them with skipped tests.

## Observable acceptance scenarios

### Passage keeping and legacy safety

1. Keep a rich selection with no class, comment, semantic destination or new per-item note. Read back a saved snapshot/citation; the article body is byte-identical.
2. Setup occurs once, visibly and through Fileclass where creating a container. Later Keep does not open a type/destination picker. Missing or invalid setup produces an actionable error, not a hidden fallback.
3. Keep selected words containing links, emphasis, inline code and non-Latin text. Preserve visible words and safe formatting; reject unmappable or unsupported cross-block selections before writing.
4. Identical words in two paragraphs do not silently share an occurrence. Repeated clicks on the same verified selection while saving produce one item; ambiguous restart retry opens existing candidates.
5. Cancel before save and verify no new item. If note creation already settled before provider cancellation, preserve the created note and report the real outcome without blocking navigation.
6. Open existing highlights, their reference pills, node links and edited quotation snapshots. Keep them readable and retain existing explicit maintenance actions; no startup conversion, stripping or duplication occurs.
7. Disable Reader and inspect kept snapshots/citations with native Obsidian Markdown. They remain meaningful without a cache, daemon or opaque graph.

### Comments, notes and connections

8. Comment on a selection and reopen its saved passage/comment. No semantic type prompt or source-body write occurs; source and personal authorship are visually distinct.
9. Add independent writing between paragraphs, then reopen it from the article and its notebook. A changed/ambiguous gap shows the writing unplaced rather than under a guessed paragraph.
10. Edit a comment natively and then from Reader. Preserve authored text outside the exact edit; a stale or structurally changed record fails closed.
11. Keep an unclassified passage/comment indefinitely. Deliberate Create structured note still uses Fileclass types, schemas and validation; untyped standalone structured destinations are not offered.
12. Connect two saved entries explicitly, optionally label the connection, and reopen it from either side. Persist one owned link, not an inverse duplicate. Typing names, @ text or negation alone asserts no edge.
13. Confirmed identical endpoint+label addition is a no-op. A changed label requires an explicit edit. External endpoint moves resolve through native links or show unresolved state when native links were not updated.
14. Disable/reload Fileclass during creation or field validation. Preserve completed work, reject stale-provider writes and keep existing material readable. Container-body editing follows the approved provider rule only.

### Explorations, return, search and overview

15. Create an exploration explicitly through the approved typed-container flow. Add sources, existing passages/comments and unfinished prose; reopen from ordinary Obsidian files.
16. Include one saved item in two explorations. Editing its original updates the presented original, not independent copies. Repeated inclusion in one exploration is a no-op.
17. Remove an inclusion or reorder selected items. Preserve original items, other explorations and surrounding authored prose. Ambiguous native edits block automated removal.
18. Open an article directly and through an exploration. Selection, keep, comment and connection actions follow one interaction contract, with the same keyboard and native Markdown escape.
19. Back to source enters transient inspection; reveal, scroll/page, resize/reflow, close, switch and reconfigure leave the persisted bookmark unchanged. Continue reading restores it; only explicit Read from here adopts the inspected position. Inspection alone does not promote the source.
20. Move/rename/edit/re-download a source. Preserve original snapshot words. Repeated/missing matches show the saved snapshot and article-level return; no automatic source write or retarget occurs.
21. Search saved material that has never been opened/highlighted and material with no classification. Identify literal/source-link evidence; do not create Person/Topic records, inferred connections or remote AI requests.
22. Change queries or close/reconfigure views during search. Bound reads, discard stale results and do not persist extra activity/completeness flags.
23. Open Overview from saved material, filter by overlapping existing exploration memberships or Unassigned, and reopen an item. Explain saved-date coverage; no arbitrary Domain convention, inferred development, file-mtime history or activity counts.

### Retention, deletion and URL uniqueness

24. Keep a passage, save a comment or explicitly include a Feed article in an exploration. Protect the source through Later retention before publishing the new work; do not alter its body.
25. Remove the final thinking reference. Do not demote/trash the source or prune old quotation snapshots. Reader Delete archives protected sources; incomplete reference knowledge fails closed.
26. Delete a target/source externally. Retain readable saved quotations and unresolved links. Reader-initiated container-file deletion warns and uses recoverable trash without cascading writes. Reader offers no individual shared-notebook record deletion; native block edits remain subject to Obsidian's normal history/Undo limits.
27. Capture the same normalized URL through manual, bulk, feed, clicked-link and future capture adapter routes. Reader-managed local races reuse the same article and preserve each route's browsing behavior.
28. Preserve meaningful query parameters, reject URL credentials and ignore fragments under the proposed equivalence. Do not merge by equal title, text, redirects or guessed tracking-parameter rules.
29. Observe native or cross-device duplicate files. Report a duplicate group, preserve both authored bodies and refuse ambiguous automatic reuse/merge. A local lane is not a cross-device transaction.
30. Run the read-only audit on marked synthetic fixtures. Separate URL duplicate groups from uncertain legacy anchors; identify evidence without choosing a canonical file or writing repairs. A later repair operation needs a separate approved preview/preservation/recovery plan. Never sweep or rewrite legacy marks automatically.

### Failure, lifetime, diagnostics and MCP

31. Change source bytes, target bytes, file identity or editor dirtiness between preview and commit. Reject unsafe writes; unknown frontmatter, comments and other authored regions survive byte-for-byte outside approved mutations.
32. Fail after Feed retention, after item save and during exploration inclusion separately. Each result identifies saved phases. Retry does not undo retention, duplicate proven items or repeat completed removals.
33. Close/reconfigure/unload while a native write is dispatched. Drain/track settlement in its occupied slot, reject new work from the old generation and never reopen/acquire/promote articles as a settings side effect.
34. Save successfully, immediately close and reopen Obsidian on the same synthetic device. Verify saved work reconstructs from files. Separately document unsaved-draft loss; do not call it a successful save or claim filesystem fsync guarantees.
35. Save offline, then use ordinary Obsidian Sync to another owned synthetic device. Record actual receipt/conflict results without adding another transport or claiming that local Saved means remotely delivered.
36. Enable/disable debug logging. Verify fixed metadata-only events, a 200-entry in-memory ceiling, clear-on-disable/unload, no synchronized log file and no private text/path/URL leakage. Ordinary save failures remain visible when debugging is off.
37. Run all local flows with MCP unavailable. No action waits for a remote service. Verify reading/search/overview do not implicitly call AI or grant disclosure from classification, linking or exploration membership.
38. Check the MCP handoff against its own map: article-level links and public-source capture remain its initial scope; new personal content does not enter projections/logs/errors by proximity. Full MCP security/prototype acceptance remains owned there.

39. Parse full passage, attached-comment, gap-comment and free-comment specimens from the grammar companion. Golden cases cover nested callouts/fences, metadata-looking prose, body lists, missing/duplicate anchors, malformed terminal sections and fresh anchor collisions. Preserve unknown text; unsupported records are read-only.
40. Create a structured note from a saved passage whose article has no block anchor. Verify the new note's origin points to the notebook entry, source bytes remain unchanged and existing origins are preserved. If creation succeeds but backlink/cancellation fails, preserve the note and report partial success without a duplicate quotation.
41. Settle a native write, then inject readback rejection, target rename and intervening native edit separately. Show Possibly saved with the completed phase, allow navigation, preserve all work and never blindly re-append on retry.
42. Add a reference, remove its container's type, corrupt its record, rename it or revoke metadata coverage during an expiry check. Revoke negative protection authority immediately; changed coverage revision at final trash dispatch aborts deletion. Unknown coverage preserves the source rather than treating the entry as absent.
43. Use a paragraph secondary menu to choose Add comment here, preview the next gap, Save and Cancel. Reopen unplaced writing without relocating it; keep paging/keyboard guards and a usable empty state.
44. Open saved material through both the command palette and reading-list control. Revisit an unassigned passage/comment, search unread material, open Overview and return to the same list/filter. No entry depends on discovering a hidden context menu.
45. Open Connect from a saved entry. The list starts without a keyboard, excludes self and explains unresolved/read-only candidates. Search opens on request; Confirm saves only the selected explicit target/label and Cancel saves nothing.
46. Change the body of one of several records natively, including deleting its anchor. Other entries and notebook prose remain byte-identical through later Reader operations; unresolved links stay visible and no whole-notebook trash or automatic block repair occurs.

## Manual device gates

- Use only marked repository-owned synthetic vaults after checking ownership, host guidance, native-input holds and installed renderer. Installation/Sync/companion-setting changes require separate permission.
- Desktop: real native selection, keyboard navigation, native Markdown edits, dirty-editor rejection, immediate-close/reopen, Fileclass reload/cancel, and source/context return.
- iPhone/iPad: actual touch selection, software keyboard behavior, bottom controls, comments/exploration edits, navigation during slow providers and saved-work reopen. Record platform/build separately.
- Android/e-ink: actual BOOX/page-key selection, aligned columns, content clearance, touch targets and reflow with inline comments. Browser/Android emulator results do not certify BOOX.
- Accessibility: keyboard-only operation, visible focus, accessible names and status announcements; do not communicate saved/uncertain/error states by color alone. Controls retain at least 44px targets.
- Cross-device Sync: separately record successful receipt, simultaneous notebook edits, source moves and duplicate article conflicts. Failures must remain visible in native files; no “passed” claim from one device's local save.
- Source/DOM tests may land before hardware checks, but broad native/device acceptance remains explicitly outstanding. Do not retire platforms or claim a completed supported-device experience from desktop-only proof.

## Delivery order and gates

1. **Approve the spec:** settle the concrete persistence proposal and native record grammar, record-reference/origin exception, provider rule, URL-equivalence limitations and proposed test seams. This is the only schema-approval gate, not permission to touch existing vaults.
2. **Durable first slice:** implement keep → readback → reopen with source-body preservation, provider setup, Feed retention and guarded failure results. Test this end to end before UI expansion.
3. **Writing slice:** implement attached and independent comments, safe native edits and explicit structured-note creation. Preserve legacy collection behavior as compatibility, not the default new passage action.
4. **Thinking slice:** implement explicit connections, exploration inclusion/writing/reorder and contextual return using the same saved objects and reading surface.
5. **Discovery slice:** implement bounded saved-material search and a conservative saved-evidence overview. Optional domain filtering does not introduce a new Domain schema or activity trail.
6. **Integrity slice:** extend local URL uniqueness across capture routes, duplicate-conflict reporting and a read-only audit. Produce a separate concrete proposal before any one-time manual repair; this spec does not approve repair writes.
7. **Operational slice:** implement delegated device-local diagnostics, runtime cancellation/draining and full failure regression coverage. Add diagnostics with each prior slice rather than postponing fault visibility.
8. **Acceptance:** run pinned checks and explicitly authorised native/synthetic device gates. Produce a capability/evidence matrix, unresolved limitations and a production handoff. Wannes alone handles releases.

Create self-contained implementation tickets only after gate 1. Use native blockers between dependent slices; each ticket includes accepted examples, preserved behavior and observable validation. Explorations are in the implementation scope even if delivered after the passage slice.

## W inventory coverage

- W01–W08: narrow native record references, unclassified capture, ordinary-file recovery and no imported graph/exchange/migration engine.
- W09–W16: optional reasoning, explicit owned connections, preserved authorship, source-context safety, host-native selection/return and existing paging.
- W17–W24: legacy acquisition/quotation safety, free writing, explorations now, independent passage keeping and no replacement class/catalog system.
- W25–W29: shared reader, rediscovery, saved-evidence overview, no activity tracking and no separate highlight requirement.
- W30–W36: MCP-owned disclosure/research, intentional keeping, local independence, no parallel Sync and honest native/device evidence.
- W37–W42: Reader-owned selective reuse, coherent implementation scope, plain/truthful presentation, justified integrations and URL uniqueness with explicit native/offline conflict limits.

General identity graphs, formal discourse tooling, automated association/inference, arbitrary multi-class systems, encounter/location tracking and wider formats/integrations remain deferred until a concrete approved journey needs them. This spec does not turn advisory inventory mechanisms into human approvals.
