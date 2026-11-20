---
created: 2026-11-15
updated: 2026-11-20
status: proposed
---

# Reader: passages, comments, connections and explorations

## Problem Statement

Reader currently couples new highlights to Fileclass-typed destinations and quotation collection. Wannes needs to keep a passage, write while reading, connect ideas and revisit an exploration without classifying each contribution or modifying the source article. Valuable W outcomes should enrich Reader without importing W's graph, transport system or replacement plan.

## Solution

Extend Reader's existing reading experience into **read → keep passage → comment/connect → explore/revisit**. A kept passage is a quotation snapshot with source context, not a separate highlight entity. Comments and explorations are first-class parts of this implementation scope. Meaningful work lives in ordinary Obsidian Markdown and native links; Obsidian alone owns Sync.

This is a full specification **draft**, tracked in [Specify Reader’s passage, comment and exploration workflow](https://github.com/wannli/obsidian-reader/issues/107), not permission to implement proposed persisted formats. The human direction is settled; the companion [persistence proposal](reader-thinking-persistence.md) requires approval. The [acceptance plan](reader-thinking-acceptance.md) defines observable completion gates. No migration, personal-vault access, installation or release is authorised.

## User Stories

1. As a reader, I want to keep selected source words without a destination or class, so that collecting does not interrupt reading.
2. As a reader, I want a passage to stand alone without a comment, so that attention does not require interpretation.
3. As a reader, I want formatting and publisher links preserved, so that the quotation retains its meaning.
4. As a reader, I want the original source link and selected context retained, so that I can check the passage later.
5. As a reader, I want keeping a passage to leave the source body unchanged, so that my annotations do not become publisher text.
6. As a reader, I want to comment on a passage without classifying my thought, so that writing remains lightweight.
7. As a reader, I want independent writing between source paragraphs, so that longer thoughts need not attach to selected words.
8. As a writer, I want to edit my comments as ordinary Markdown, so that Reader is not their only editor.
9. As a reader, I want to reuse a passage or comment without copying its identity, so that later edits do not diverge across explorations.
10. As a thinker, I want explicit connections between saved material, so that I can express relationships without a formal argument model.
11. As a thinker, I want ordinary typing not to assert relationships, so that mentions and negation remain my prose.
12. As a thinker, I want optional classification after capture, so that structure follows useful thinking.
13. As a thinker, I want deliberately created structured notes to remain Fileclass-typed, so that existing schemas keep their authority.
14. As a thinker, I want an exploration to gather sources, passages, comments and writing, so that a subject can develop over time.
15. As a thinker, I want one item in several explorations without duplicate saved copies, so that contexts can overlap.
16. As a thinker, I want removing exploration membership not to delete the original, so that organisation does not destroy work.
17. As a reader, I want direct article entry and exploration entry to share reading actions, so that I do not learn two readers.
18. As a reader, I want Back to source to reveal relevant context, so that I can verify my interpretation.
19. As a reader, I want Continue reading to preserve the article's bookmark, so that citations do not replace my reading progress.
20. As a reader, I want uncertain source matches to remain visibly uncertain, so that the interface never silently misquotes a source.
21. As a reader, I want search across saved material including unread sources, so that rediscovery does not require prior classification.
22. As a thinker, I want explicit references distinguished from suggested associations, so that search does not manufacture relationships.
23. As a thinker, I want an overview of saved thinking across time and overlapping domains, so that I can revisit developing interests.
24. As a thinker, I want unassigned material included, so that an overview does not demand filing everything first.
25. As a reader, I want one saved article per source URL, so that capture routes do not create a silent duplicate backlog.
26. As a reader, I want existing highlights and quotations preserved, so that the new workflow does not erase earlier work.
27. As a reader, I want explicitly saved work to survive immediate closure, so that a success message is trustworthy.
28. As a reader, I want local save distinguished from cross-device delivery, so that Reader does not make false Sync promises.
29. As a reader, I want offline reading and writing to work without MCP, so that a remote service cannot block thinking.
30. As a reader, I want partial failures to identify saved work, so that retry does not duplicate or undo it.
31. As a reader, I want keyboard, touch and e-ink actions to remain usable, so that the expanded workflow fits existing devices.
32. As a user, I want switchable debug logging without activity tracking or private text, so that faults can be diagnosed safely.
33. As a user, I want private comments and connections excluded from MCP by default, so that local context does not imply disclosure.
34. As a user, I want public-source discussion and explicit URL capture coordinated with the MCP effort, so that Reader gains no second research engine.
35. As a user, I want ordinary Obsidian files to retain meaning without Reader, so that my work outlives the plugin.

## Implementation Decisions

### Approved product constraints

- Reader remains the product. Preserve acquisition, feeds, YAML-status queues, native Markdown escape and article position behavior. Status changes must not move files; capture folders only select destinations for new files. Preserve the derived Needs attention list without persisting readiness flags. Do not port W's plugin packaging or general identity graph.
- Passages, attached and independent comments, explicit connections and explorations are in the current effort. No separate new highlight feature is required. Do not strip legacy source marks or remove quotation snapshots.
- Capture/reuse requires no semantic class or compulsory per-item note. Creating a standalone structured note still uses Fileclass public API v1, with no plugin-ID fallback or companion-settings migration.
- Meaningful work remains in ordinary Obsidian constructs. No authoritative database, synchronized mirror, sidecar collection or parallel draft/batch/receipt transport. Native links do not by themselves grant MCP access.
- Article URLs must not silently produce duplicate saved articles. General file-independent knowledge identity remains deferred.
- No automatic activity history. Debugging is opt-in. Personal writing, endorsements, publisher authorship and later AI suggestions remain distinguishable.

### Proposed module design

- Add a deep **Thinking module** at the existing guarded vault seam. Its small interface supports keep, save comment, connect, edit exploration, read context and search. Callers supply source snapshots and lifetime guards; the module owns parsing, preservation, validation and local operation results.
- Reuse the existing vault adapter, serial-write lanes, Markdown snapshot transforms, source selection projection and catalog observation. Do not call legacy hosted-highlight mutation to keep a new passage: that path writes source markup and files quotations.
- Keep article acquisition and queue changes in the ArticleStore module. Let the Thinking module request existing retention behavior without duplicating article-write rules. Do not nest one file's write lane inside another.
- Use one read-only Thinking projection for direct reading, exploration entry, contextual return and overview. Rendering adds passage/comment decorations without serializing them into article Markdown.
- Extend the existing Reader view rather than introduce a second article reader. Views remain leaf-owned and generation-bound. Cancelled/stale work cannot paint or publish into a new runtime.
- Reuse the Fileclass adapter for explicit notebook/exploration or structured-note creation. Keep provider validation and cancellation behavior; never delete a note merely because a provider operation was cancelled.
- The persistence companion recommends ordinary notebooks containing unclassified entries, not one new typed entity per passage. This recommendation is not an approved note schema.

### Interaction contract

- A valid text selection offers **Keep passage**, **Comment** and **Add to exploration**. Touch targeting previews the same selection before saving. No destination/type picker appears for normal passage capture after notebook setup.
- Replace primary new-highlight commands/modes with passage actions, updating visible labels and shortcut help together. Preserve legacy content inspection and explicit maintenance without silently rebinding an existing shortcut to destructive behavior.
- Comment on selection keeps the passage and comment together where a single-file commit permits. Independent comments use an explicit **Add comment here** action in a paragraph's secondary menu; it previews the gap after that paragraph, opens a Markdown editor with Save/Cancel, and leaves paging available outside the editor. Neither action changes article body text. At an uncertain gap, show the saved comment in an Unplaced section rather than inventing a new location.
- A kept passage is shown as saved attention, never agreement. Opening it exposes saved quotation, source and comments; connected items remain independently navigable.
- A quiet panel offers recent explorations plus search, explicit creation and **Add**. It shows existing membership. Adding again is a no-op; removing inclusion never deletes the original record.
- An exploration is an ordered set of native references interleaved with authored Markdown. Provide explicit add/remove/reorder and ordinary text editing. Deleting the exploration uses normal recoverable trash and does not delete referenced items.
- **Connect** from a saved-entry menu opens an initially keyboard-free list of eligible saved passages/comments, with Search on request, optional plain label, Confirm and Cancel. Exclude the current item; unresolved/read-only candidates explain why they cannot be chosen. Structured notes use their explicit Fileclass relation action, not a fabricated entry edge. Display directed labels only where explicitly written; no inferred edges, inverse duplicates or imported W relationship catalog.
- Existing typed-note actions remain available as explicit secondary actions. New note creation uses Reader's Fileclass flow; no automatic conversion of every passage into a structured note. A new structured note created from a saved entry gets an origin pointing to that notebook block, not a newly inserted article anchor; existing origins remain untouched. The persistence companion proposes this changed origin convention.
- **Back to source** enters transient context inspection after normal saved-position entry, revealing an exact unique context match when possible. Reflow, resize, paging, scrolling, closing, switching and generation replacement in inspection do not publish a new bookmark. A visible **Read from here** action explicitly adopts the displayed position; **Continue reading** exits inspection and resumes the original bookmark. Uncertain context shows the snapshot and article-level return. This requires a transient-position mode at the reading-surface interface; existing reveal/flush behavior alone is insufficient.
- Preserve destination bookmark entry, dog-ear behavior, explicit native Markdown routing and selection/modal/input guards. A return target does not overwrite a bookmark merely by revealing a citation.
- **Open saved material** is a command-palette action and reading-list control. Its default All view shows sources, kept passages and comments, including unassigned entries; empty state explains Keep/Comment. Open displays the saved item and native-file escape; Back returns to the same list/filter. Search spans saved article text and approved thinking documents, states exact text/link evidence and uses bounded cancellable reads, not startup body scans.
- The same screen's **Overview** view groups saved entries by explicit collection dates and offers existing exploration memberships as overlapping lenses. Include an Unassigned option and show coverage limits. Do not claim inferred intellectual progress or use file mtime as development evidence. Arbitrary Domain labels/fields are deferred until a concrete convention is approved; local free-text filtering requires no new entity or activity trail.

### Retention, source changes and article uniqueness

- Keeping a passage/comment or explicitly including an article in an exploration protects its source from Feed expiry before publication of the new work. Reuse Later promotion for Feed sources; source body preservation does not prohibit approved queue/status changes.
- Native related-note assignment retains its current behavior. Returning, searching or simply viewing a passage does not promote sources. Removing the last reference never automatically demotes or trashes an article.
- Reader Delete/expiry must account for incoming thinking references as well as legacy annotations. The final native trash guard consumes fresh protection/coverage revision authority; new references or revoked coverage abort deletion. Type loss, malformed known containers, stale metadata and renames invalidate cached negatives rather than making references disappear. If coverage cannot be proved, preserve the source. Explicit native file deletion remains possible; keep saved quotations readable with a missing-source indication.
- Snapshot words never silently change after source edits or re-download. Re-resolve native source links after rename; unique quote/context evidence may locate text, but similarity alone cannot retarget a saved occurrence.
- Apply existing content bounds, safe rendering and known processor-expression rejection when saving publisher snapshots/context into notebooks. Treat imported instructions as content, never commands. This is not a sandbox for arbitrary third-party Markdown processors; personal authored Markdown remains user-owned.
- First deliver only a read-only audit: separately list normalized-URL duplicate files and uncertain legacy passage links, with current evidence and no proposed canonical choice inferred from age/path. A later one-time manual repair requires its own concrete per-operation preservation/preview/recovery plan and permission. No repair mutation, startup sweep, mass merge, source-mark stripping or personal-vault operation follows from this spec.
- Proposed URL equivalence reuses current HTTP(S) normalization: strip fragments, reject credentials, retain query parameters. Do not assume redirects, tracking parameters or equal titles prove identity.
- Serialize Reader-managed creates by normalized URL across manual, bulk, feed, link and future MCP capture. Check current catalog and fresh source bytes before create/reuse; report existing ambiguous duplicates instead of choosing a file silently.
- Native tools and independently offline devices can create files outside this local lane. Detect resulting duplicate URL groups on observation, surface a conflict and require explicit reconciliation; do not claim a cross-device uniqueness transaction or silently delete external captures.

### Save, recovery and diagnostics

- Each save validates source evidence, file identity, dirty/uncertain editors, provider state where needed, and runtime lifetime at the mutation boundary. Re-read exact affected bytes before committing; preserve unknown or ambiguous regions.
- Show **Saved** only after native write settlement and verified readback. If settlement succeeds but readback fails, the target moves or bytes change before verification, show **Possibly saved — open notebook to check**, with the known native phase. Never roll back, overwrite or blindly retry the uncertain append. Navigation remains available; inspect current candidates before offering a proven-safe retry. Local Saved is not remote receipt, physical fsync under all host failures or preservation of unsaved text.
- Multi-file actions report which phases saved. If source retention succeeds and notebook save fails, retain the source and show retry. If an item saves but exploration inclusion fails, show the existing item and retry inclusion only.
- Duplicate-click protection is local/in-flight. Restart retries rely on proven native record/link evidence, not fresh operation IDs or an imported outbox. Ambiguous retry opens existing candidates instead of blindly creating another copy.
- Do not block navigation on an uncooperative provider. Already dispatched native writes retain their slots through settlement; a later callback cannot claim unverified success. New generation work waits for dispatched writes to drain as today.
- Implement a device-local **Debug logging** toggle, off by default. Log fixed event names, durations, counts and coarse failure categories to the developer console with a bounded in-memory ring. Do not log note names, paths, URLs, selected words, prose, DOM dumps, request payloads or secrets. Never synchronize/export logs automatically.
- Ordinary errors remain visible beside their failed action and in existing diagnostics. The debug toggle must not hide save failures or enable feed polling, tracking or a background service. Ring capacity is 200 entries; discard oldest entries and clear on disabling/unload.

### MCP coordination

- [The MCP wayfinder](https://github.com/wannli/obsidian-reader/issues/98) owns disclosure, tools, hosting/authentication and its synthetic prototype. This spec does not implement MCP or block local thinking on its availability.
- Its initial scope is permitted public article lookup/text, cited discussion/comparison and explicit URL capture. Private comments, connection metadata, notebook paths and explorations stay excluded; an article reference or public-looking URL cannot establish publisher provenance or disclose its notebook. Follow the MCP effort's selected synthetic source authority and independently verified publisher provenance, not folder membership or source-link appearance.
- No initial private-excerpt support, autonomous research, scheduling or collection-wide recommendation engine. Article-level MCP return links suffice; local passage precision is not a new MCP prototype requirement.

## Testing Decisions

- Prefer one primary seam: the Thinking module's caller-facing interface using the existing in-memory vault adapter and production transforms. Test observable Markdown, result phases and unchanged inputs, not private method calls or cache shapes.
- Extend existing view fixtures only for user-visible selection/actions, focus, navigation and stale-generation behavior. Reuse existing native vault adapter tests for final-byte/editor guards and write draining.
- Prior art includes the hosted Markdown contract, quotation ownership, view selection integration, queue/expiry, Fileclass cancellation and runtime-reconfiguration suites. Preserve them as legacy regression contracts rather than replacing their meaning with the new model.
- Parser golden cases and adapter tests cover native Markdown round trips, unknown content and edited/malformed records. URL-capture tests cover every entry route and ambiguous duplicate groups.
- The acceptance companion supplies numbered scenarios and device evidence gates. Tests run on pinned Node; DOM is used only for interaction. Synthetic native/device/Sync checks remain separate manual evidence, never inferred from browser simulation.

## Out of Scope

- Implementation before durable-format approval; automatic schema migration, personal-vault cleanup, plugin installation, deployment or release.
- A separate highlight entity, mandatory classification, untyped standalone structured-note destinations or replacing Fileclass's authority.
- General graph identities, RDF/SQL engines, sidecars, parallel Sync, activity/location histories, automated source retargeting or a recurring repair product.
- General journals/calendar/Contacts/Kindle/PDF/YouTube/reMarkable integrations, semantic inference and formal argument tooling. Revisit individually for a justified journey.
- MCP production implementation, private-excerpt disclosure, autonomous research and a findings store. W's research loop retains its own scope.

## Further Notes

- Authority: [assessment map](https://github.com/wannli/obsidian-reader/issues/94), [human decisions and 42-theme assessment](https://github.com/wannli/obsidian-reader/issues/97#issuecomment-6898421671), and the reports they link. Human amendments outrank W prototypes and advisory matrix mechanisms.
- Source check: Reader `bb5b92a`; runtime baseline remains `92b5d75`, with only the MCP planning questionnaire added afterward. No root glossary or ADR directory exists at this snapshot; terminology here is scoped to this draft, not a new approved domain model.
- Proposed refinements requiring review are explicitly called out in the persistence companion and acceptance plan. Approve them as a concrete spec review, not another broad product interview.
- After approval, split work into vertical tickets: durable keep/readback and retention; comments; connections/explorations; contextual return/search/overview; uniqueness/read-only audit; diagnostics and device acceptance. Each ticket states native blockers and preserves the complete end-to-end goal.
