---
created: 2026-11-20
updated: 2026-11-20
status: implementation-authorized-native-validation-pending
issue: https://github.com/wannli/obsidian-reader/issues/117
---

# Clipping capture: implementation brief

A clipping is a saved quotation you can think around, not a synchronised extract.

**Wannes authorised the bounded additive implementation after reviewing this brief.**
Existing files remain untouched; native/device acceptance and any vault installation remain separate.

## Agreed model

- Keep creates one ordinary Fileclass-typed Markdown note per passage.
- Choose the default card type once, not during every capture.
- Topic assignment is optional. Keep never asks for a topic; the user can add one later.
- Use the passage's opening words as the filename. Shorten safely and suffix collisions.
- Store metadata in YAML. Keep the quotation and personal writing in the body.
- The clipping points to the source through `origin`. Store no reverse link in the article.
- Keep may add a native paragraph block reference, but never changes source words or adds clipping metadata there.
- Assume the quotation stays as captured. Personal writing grows around it.
- Reader never rewrites the quotation or stores a hidden original selection.
- Users can edit any Markdown. An edited quotation need not retain exact source matching.
- Renaming, moving or developing a clipping does not require updating its article.
- Deleting either file does not automatically delete the other.
- If source wording changes, the clipping survives. Exact highlighting may be lost.
- Existing explicit typed collection remains separate and available.

This direction replaces the shared-notebook proposal **for new Keep captures**.
The older Thinking documents and branch remain historical evidence, not this implementation brief.
Do not migrate their records or integrate their comments, explorations or browser.

## Small first delivery

1. Configure one default Fileclass card type.
2. Select an eligible article passage and press Keep.
3. Create the clipping with its quotation and source reference, then continue reading.
4. Derive source decoration from discovered clippings when the match is unique.
5. Open a matching clipping as an ordinary Obsidian note through the passage action.

Do not add a clippings browser, custom card editor, managed Move, AI titles or processing statuses.
Developing or retyping clippings into ideas is outside this brief. Do not design recognition after such retyping now.
Ordinary user edits remain possible; no clipping-to-idea workflow or type-independent recognition rule is approved.
Do not change existing highlight/collection behaviour or automatically convert old annotations.
No personal-vault installation, migration, version bump or release is included.

## File contract

The names `Clipping` and `fileClass` below illustrate a selected Fileclass and its binding property.
Use the provider's actual type and binding alias; do not hard-code a new `type: clipping` property.
`origin` is the existing new-note provenance property, not a new identity field.

```markdown
---
fileClass: Clipping
origin: '[[Articles/The city is a set of invitations#^streets]]'
---

> Streets shape the choices we make.

My thoughts can grow here, with [[connections]] to other notes.
```

The first top-level blockquote is the captured quotation; fenced code and Obsidian comments are excluded.
It can contain rich, multiline Markdown. Quote blank lines explicitly with `>`.
Other blocks belong to the user. A title heading is not required to identify the quotation.
Parse Markdown structurally, not with the prototype's first-line regular expression.
Preserve emphasis, publisher links and selected words through the existing safe source projection.
Reject unsupported selections before writes. Do not copy Reader controls or decorations.

Do not add clipping IDs, timestamps, context copies, selection offsets, hashes or acquisition metadata.
Fileclass-required properties remain provider-owned metadata; do not silently omit required fields.
A saved card is authoritative Markdown, not a mirror of the article or a generated index.

## Setup and creation

- Reuse the configured typed-note creation folder. No separate clipping-folder setting is proposed.
- Add one optional default-card-type preference; preserve all unrelated settings.
- Obtain the binding property from Fileclass, using the existing explicit fallback where necessary.
- Do not require a notebook, exploration type or destination selection.
- Without setup, Keep saves nothing and offers configuration. Do not silently replay the selection.
- Fileclass must be available for new cards. Existing cards remain ordinary readable notes without it.
- Do not install types, change Fileclass settings or create an untyped fallback.
- The clipping schema must allow an absent topic. Do not populate a placeholder or add a required-topic prompt.
- If the selected schema requires a topic, explain its incompatibility; never bypass validation or change the schema automatically.
- Later topic assignment uses supported Fileclass fields and writes. Do not invent a compulsory topic property.
- Sanitise and bound automatic filenames. Handle collisions without a naming dialog or overwrite.
- A filename collision is not evidence that the passage was already captured.
- Disable repeated dispatch while that capture is pending. Cancellation must not block navigation.
- Never delete a provider-created note on cancellation or a later failure.

## Source matching and repeated Keep

Discover eligible cards by configured Fileclass membership, not filename or capture-folder membership.
Resolve `origin` relative to the clipping. A moved card remains discoverable if its type and link resolve.
Reuse the selected paragraph's existing unique native block reference when available.
Otherwise, allocate a native reference, collision-check the fresh source and guard its insertion.
Several clippings from one paragraph share that reference. Duplicate authored references block capture rather than being repaired.
Store the paragraph link in `origin`; it is an address, not a reverse link or clipping identity.
Within that paragraph, match the quotation's visible words through parser-proven projection.
Multiple occurrences, duplicate anchors or malformed quotations are ambiguous, not a first-match success.
Do not fuzzy-retarget a clipping after source edits. Preserve it and report an unresolved exact match.

Repeat rule: reuse a uniquely proven existing clipping instead of creating another.
Source identity and quotation must agree; identical text alone does not prove the same occurrence.
Moving the card or adding personal writing must not prevent a proven match.
If evidence is ambiguous, show candidates or an actionable uncertainty state; do not silently deduplicate.
Do not promise cross-device uniqueness. Concurrent offline captures can create separate cards.

Read-only discovery must be bounded, cancellable and current after edits, moves and deletes.
Incomplete coverage cannot prove there is no clipping or no incoming reference.
Do not persist index-completeness, highlight or processing flags into notes.
Changing the default type affects future creation only; it cannot authorise hiding or deleting old material.

## Writes, retention and failures

The only permitted source-body edit is adding the selected paragraph's native block reference.
Preserve all other source bytes. Never add clipping links, quotation copies or metadata to the article body.
Preflight valid selection, setup and provider eligibility before any write.
Retain an explicit Feed article as Later, ensure its paragraph reference, then commit the clipping.
Feed retention changes YAML only; do not move the article file.
Recheck source identity, bytes, generation and dirty-editor safety at mutation boundaries.
Create with no-overwrite semantics. Never use an existing filename as a destination for replacement.
Preserve provider output and unknown YAML/body content during any guarded completion write.

Source updates and card creation are not atomic. A failed capture may leave Later status or an unused paragraph reference.
Preserve those successful writes; report progress rather than attempting automatic rollback or anchor cleanup.
Reconcile a possibly saved reference before retrying, and reuse it when proven unique.
A provider-created but incomplete card must remain recoverable and be reported accurately.
Verify saved contents before claiming success. Uncertain settlement means possibly saved, not safe to retry blindly.
Reconcile available evidence before retrying. Do not overwrite an edited card or manufacture a second one on uncertainty.

Source expiry/Delete protection must account for incoming clipping references, including YAML `origin` links.
Keep conservative native-reference safety when cards are moved, malformed or no longer have the selected type.
Missing read coverage must not authorise deletion. Viewing, indexing and decorating never promote articles.

## Bounded implementation choices

- Preflight public Fileclass schemas, including ancestors. Extra required fields make a type incompatible; no form or placeholder is inserted into Keep. Verify provider recognition and required-field status after creation.
- `nodes.clippingType` stores the default; `nodes.clippingBindings` retains previously selected type/binding pairs for discovery. These are plugin settings, not note properties or identities.
- A changed provider binding requires setup to be reapplied before new capture; old notes are never rewritten.
- Scan source-relevant notes and uncertain/stale metadata candidates: at most 200 notes, 200 KB per note and 1 MB total. Show incomplete coverage and refuse new capture when absence cannot be established.
- Vault events invalidate observed metadata; current raw reads can supersede stale native caches. Reads and decorations never write notes.
- Incoming `origin` links protect sources independently of clipping type or quotation validity. Incomplete coverage protects conservatively; recheck negative coverage at trash dispatch.
- The approved paragraph references replace the earlier proposed article-level fallback. There is no temporary format or follow-up migration.

## Acceptance checks for the approved implementation

- Setup selects a real provider type. Missing/reloaded Fileclass or a lost type never causes fallback creation.
- Keep creates the expected YAML and rich quotation, with no destination/title prompt in the agreed compatible case.
- Keep succeeds without a topic or topic prompt. Later topic assignment preserves the quotation and origin.
- A schema requiring a topic is explained as incompatible, not silently weakened or completed with invented values.
- Invalid selections and cancelled setup leave source and vault unchanged.
- The source body changes only to add a missing native paragraph reference; all other source bytes are preserved.
- Existing references are reused; new references are collision-checked; duplicate references block capture safely.
- Failed card creation can leave a retained source and unused reference; retry does not allocate another reference blindly.
- Opening words produce safe bounded filenames; collisions never overwrite notes or force title entry.
- Repeat capture uses proven evidence, including after card renames, moves and added personal writing.
- Repeated source words and multiple same-paragraph selections never produce false exact-location claims.
- Source replacement, deleted anchors, edited quotations and broken origins preserve cards without hidden repairs.
- Deleting a card leaves the article alone; deleting an article never cascades to cards.
- Required-field failure, cancellation, partial writes and uncertain readback preserve created notes and report progress.
- Incoming references protect sources even with incomplete discovery, stale metadata or changed type bindings.
- Existing hosted collection, touch controls, URL safety, YAML queues and reading positions keep their regression coverage.

Use focused Node tests for storage/matching and DOM tests only for interactions.
Run the repository's complete check before publishing runtime changes.
Native mobile, e-ink, Fileclass and Sync acceptance require separately authorised synthetic-vault checks.
Prototype browser checks do not establish those results.

## Implementation and remaining acceptance

The implementation is additive: `src/core/{clippings,clipping-store}.ts` own the contract and guarded capture; `src/host/clippings.ts` owns generation-bound discovery; the Fileclass bridge owns compatibility checks. Existing hosted anchor allocation is reused without its highlight markup or reverse citations.
Native selections offer Keep or explicit collection; the separate Keep tap mode does not replace Highlight/Create node tools. Source marks are render-only, and opening a clipping never creates a missing note.
Automated coverage includes storage/matching, host/Fileclass integration and real-surface Reader interaction, including cancellation and legacy regressions. No personal or synthetic vault was installed into for this implementation.

Prototype evidence remains [on the prototype branch](https://github.com/wannli/obsidian-reader/tree/prototype/117-clipping-cards/src/reader). It predates paragraph-reference approval and is not runtime evidence.
Next: separately authorised native Fileclass, mobile/e-ink and Sync acceptance. No release action is included.
