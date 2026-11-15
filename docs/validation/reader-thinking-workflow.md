---
created: 2026-11-15
updated: 2026-11-15
status: automated-validated-native-gates-open
---

# Reader thinking workflow: implementation evidence

Implementation is isolated on `feat/reader-thinking-workflow`. The default branch is unchanged. The approved scope and 46 acceptance scenarios are in [the acceptance companion](../../specs/features/reader-thinking-acceptance.md); [issue #107](https://github.com/wannli/obsidian-reader/issues/107) tracks delivery.

## Boundary

This report distinguishes source/unit/DOM evidence from native acceptance. No personal vault, plugin installation, migration, repair, release, native device, or Sync operation was performed. Obsidian remains the only Sync transport. AI/MCP work remains in [#98](https://github.com/wannli/obsidian-reader/issues/98).

## Capability and evidence matrix

“Covered” below means the named automated seams exercise the capability, not that every physical-device condition in that scenario has passed.

| Capability / scenarios                                                   | Automated evidence                                                                                                                                                                                                         | Remaining evidence                                                                                                   |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Standalone Keep, setup, rich source mapping, legacy safety (1–7)         | `thinking-core*.test.ts`, `thinking-reader-ui-{actions,selection,setup}.test.ts`, existing hosted/selection suites. Real Markdown writes and unchanged source bodies; provider setup/cancel and guarded actions.           | Installed Fileclass setup, native selection and plugin-disabled inspection.                                          |
| Comments, native edits, typed creation, connections (8–14, 39–40, 45–46) | Record/parser safety and writing tests; actual browser actions; provider reload/uncertain creation; native-link reverse display; fresh target/source guards.                                                               | Real provider reload/validation, native Markdown editor behavior and accessibility.                                  |
| Explorations and shared articles (15–18)                                 | Real-core browser inclusion/prose/reorder tests; overlapping membership/no copies; explicit Add and session-only recent choices; shared source action route.                                                               | Native reading/editing across leaves and devices.                                                                    |
| Transient context return (19–20)                                         | `surface.test.ts`, source/context and Reader UI tests. Continue restores original position; explicit adoption and layout-changing decorations use the existing reading surface.                                            | Native paged reflow, immediate close/reopen and physical e-ink behavior.                                             |
| Search, overview and visible entry points (21–23, 44)                    | Core discovery/authored-prose/connection-writing search and browser tests; literal/link evidence, bounded work, stale result discard, overlapping/Unassigned lenses, correct document routing and Back/query preservation. | Native keyboard/software-keyboard and large real-device libraries.                                                   |
| Retention, deletion and references (24–26, 42)                           | Store retention/expiry and protection tests. Unknown coverage retains; incoming references archive; final native-trash witness revokes stale authority; no cascade or individual-record deletion action.                   | Native metadata ordering, recoverable container deletion in Obsidian, Sync conflicts.                                |
| URL uniqueness and read-only audit (27–30)                               | URL/ingestion/audit suites plus existing capture/feed tests; managed local lane, normalized URL conflicts, fresh candidate bytes, bounded evidence and no repair writes.                                                   | Independent offline/native duplicate receipt and user-led recovery.                                                  |
| Mutation/failure/lifetime safety (31–33, 41)                             | Core source-witness/retention/retry/results tests; real writer candidate recovery; existing folder/runtime/editor tests, including both native-adapter lifetimes.                                                          | Real dirty editors, uncancellable native settlement and abrupt process termination.                                  |
| Gap writing (9, 43)                                                      | Reader paragraph-menu/Save/Cancel tests; exact anchored/rich paragraph placement, ambiguous Unplaced fallback, unchanged source bytes.                                                                                     | Actual native secondary menus, touch and paging.                                                                     |
| Diagnostics (36)                                                         | Diagnostics/settings tests; whitelisted scalar events, 200-entry memory ring, disable/unload clearing, no content/path/URL fields or synchronized file.                                                                    | Native local-storage lifecycle on each supported device.                                                             |
| Restart and Sync (34–35)                                                 | Reconstruction from saved synthetic Markdown is covered at the module seam only.                                                                                                                                           | Immediate native close/reopen, unsaved-draft loss, actual Sync receipt/conflicts; no fsync or remote-delivery claim. |
| MCP separation (37–38)                                                   | Source review: no AI/MCP dependency, alternate transport, disclosure projection, or personal-content export added.                                                                                                         | Full MCP security/prototype acceptance belongs to its separate effort.                                               |

## Checks

- Final validated code revision: `cd61b86414a606ac5418fdffafe90aac56d2b10c`. Subsequent documentation does not change runtime code.
- Unit/component run: **2,765 passed across 110 files**, with `mise exec -- npm test -- --maxWorkers=4`; **30.95s**.
- Formatting, metadata and both TypeScript projects: passed at that revision.
- Guarded tooling tests: **95 passed** in **8.05s**; release-shaped build passed. This is not publication or vault installation.
- Final check ran every `npm run check` stage sequentially, with the unit command above replacing unrestricted `npm test`. The unmodified default command is not claimed green.
- The local under-ten-second unit-suite goal is **not met**. Worker limits address reproducible contention without changing assertions/timeouts; test-runner/module-evaluation performance needs separate follow-up.
- Earlier unrestricted `npm run check` at `8248338` passed formatting/metadata/types, then stopped on seven missing native-SDK test mocks and one existing 5-second feed-parser timeout. The five fixture-only changes preserve existing assertions and add secondary-adapter lifetime coverage.
- The two known timeout cases both pass together with `--maxWorkers=2`: 53 tests, 2.91s. No assertion, test timeout, production limit, or coverage was weakened.

## Independent review

Fresh Standards and Spec reviewers compared `f223d66...8248338` independently. Standards reported three documented-rule violations and one resolver-duplication finding; Spec reported one P1 and five P2 findings. One reverse-link finding overlapped.

The fixes cover retention-phase evidence, native relationship resolution, authored-prose/connection search, correct exploration search routing, effective picker search/session recents, source-paint work limits, layout-safe decoration, exact paragraph-gap placement, and visible uncertain-comment recovery. Final re-review at `cd61b86` accepts all four Standards findings and all seven Spec findings, including the additional entry-time projection invalidation race. No confirmed finding remains in the reviewed source paths.

The entry-race regression accepts either inline writing or honest incomplete coverage during revision churn; a subsequent stable reopen asserts inline writing. It does not prove completion through perpetual native changes. Source review and synthetic DOM tests do not certify native layout or Sync.

## Open gates / handoff

- Separately authorize marked synthetic-vault installation and native desktop/Fileclass acceptance before runtime inspection.
- Record iPhone/iPad touch/software-keyboard, Android/BOOX page-key/reflow, keyboard-only accessibility and supported build identifiers separately.
- Separately authorize and record cross-device Sync, simultaneous notebook edits, source moves and duplicate conflicts.
- No one-time repair is approved. Any repair requires a separate preservation, preview and recovery plan.
- Keep parent/integration issues open for outstanding native acceptance and human-led integration. Wannes alone manages releases.
