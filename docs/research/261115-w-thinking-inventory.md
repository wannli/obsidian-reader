---
created: 2026-11-15
---

# W’s thinking and decision provenance — inventory checkpoint

**Incomplete: leave [Inventory W’s thinking and its decision provenance](https://github.com/wannli/obsidian-reader/issues/95) unresolved.** This session enumerated the available corpus and reviewed selected evidence, not every idea in it. The corpus is too large for an honest full-content assessment in this burst. The theme index below is a starting point, not a complete adoption checklist.

Scope: factual input to [Assess whether W’s thinking belongs in Obsidian Reader](https://github.com/wannli/obsidian-reader/issues/94). No Reader adoption, rejection, schema, feature or human decision is made here. W decisions remain evidence about W, not Reader requirements.

## Snapshot and authority

- GitHub/API and local reads: 2026-11-15, approximately 12:34–12:40 UTC. Latest issue/comment modification in the fetched W corpus: 2026-11-14T20:31:34Z. GitHub issue bodies/comments are mutable; timestamps identify this observation, not an immutable archive.
- Published W main still equals the map’s pinned [`11ca64fb5e6a36bbf506f52e9570fe77e6e29c1b`](https://github.com/wannli/W/tree/11ca64fb5e6a36bbf506f52e9570fe77e6e29c1b).
- Local `/home/whl/code/w` main is `9c8f76b7de1e86299854bfe37f5c13ce44021394`: 59 reachable commits ahead of published main, including consolidation/history-preservation commits. Its net diff changes 31 paths. This local integration is **not published main**.
- Reader research clone starts at the map’s pinned [`92b5d7507143a52ef949d6d92d852614846bbabf`](https://github.com/wannli/obsidian-reader/tree/92b5d7507143a52ef949d6d92d852614846bbabf). This is not the older Reader baseline used by W’s research.
- All 365 fetched comments are under GitHub login `wannli`, including agent-attributed minutes. A login alone does not prove direct human authorship. “Human choice” below means a choice explicitly recorded in those minutes; original conversations were not independently inspected.
- **Enumerated** means source identity/count/path was checked. **Read** means content was inspected. **Reported validation** means a source describes a check; this session did not repeat it. Neither closure nor a passing browser test proves a production/device outcome.

## Source and coverage ledger

REST pagination enumerated all 79 numbered W issues, all 365 comments, all 18 branch heads, zero PRs and zero PR review comments. Every issue’s advertised comment count matched the fetched comments. No numbered issue was missing between 1 and 79; 21 were open. This proves enumeration consistency, not semantic completeness or access to deleted material.

| Issue family, with entry point | Issues / comments | Content coverage in this burst |
| --- | --- | --- |
| [Chart the first W research workflow](https://github.com/wannli/W/issues/1), identity foundation through its round-trip milestone | 22 / 62 | Map read; selected latest schema/milestone comments read. Earlier discussions not fully read. |
| [Chart W’s discourse graph workflow](https://github.com/wannli/W/issues/23), scenario through bounded proof | 5 / 64 | Map and latest design/proof conclusions read; full schema discussion not read. |
| [Chart W’s editor and touch interface](https://github.com/wannli/W/issues/28), native-cue research | 2 / 20 | Map and prototype documentation read; full discussion not read. |
| [Chart W’s automatic draft sealing and laptop processing](https://github.com/wannli/W/issues/30), editor/anchor/device work interleaved | 13 / 49 | Map and selected touch/automation/anchor conclusions read; intermediate discussion not fully read. |
| [Chart Reader–W integration and parity](https://github.com/wannli/W/issues/43), touch specification and delivery slices | 8 / 21 | Map and touch-spec closure read; integration-comment history not fully read. |
| [Specify automatic W draft submission and laptop processing](https://github.com/wannli/W/issues/51), superseded work and current delivery/acceptance | 12 / 25 | Latest automation implementation and desktop/iPad acceptance updates read. |
| [Reassess W as a private knowledge workbench](https://github.com/wannli/W/issues/63), outcomes/privacy/release scope | 5 / 27 | Map, everyday-journey resolution, privacy resolution/selected clarifications, and all release-scope comments read. |
| [Prototype the temporal and domain overview](https://github.com/wannli/W/issues/68), [Prototype bringing research findings into an exploration](https://github.com/wannli/W/issues/69) | 2 / 45 | All comments read; latest unpublished overview source read. Large exploration HTML not fully audited. |
| [Review the flow-first W rebuild spec](https://github.com/wannli/W/issues/70), integration/host/later-research/architecture | 6 / 28 | Full inline outcome spec, resolution, host resolution, research resolutions and all first-research-journey comments read; other comments selective. |
| [Define a coherent visual design system for ω](https://github.com/wannli/W/issues/76), vocabulary and comment proof | 4 / 24 | All visual/comment-proof comments and canonical vocabulary/wording-fix resolutions read; vocabulary rounds sampled. |

Reproduce enumeration with paginated `repos/wannli/W/issues?state=all&per_page=100`, `issues/comments?per_page=100`, `pulls?state=all&per_page=100`, `pulls/comments?per_page=100` and `branches?per_page=100` via `gh api`. PR-level reviews need no separate fetch because no PRs exist in this snapshot. Events, edit histories, deleted discussions, private conversations and unreachable Git objects were not audited.

### Repository documents and history

Local main has 89 tracked paths, including 26 Markdown files. Path inventory and the reachable history were enumerated; most content below remains unreviewed. Its 103 reachable commits across local refs are not 103 independently reviewed changes.

| Source class | Available primary artifacts | Coverage / authority |
| --- | --- | --- |
| Foundational model | [`GLOSSARY.md`](https://github.com/wannli/W/blob/11ca64fb5e6a36bbf506f52e9570fe77e6e29c1b/GLOSSARY.md); [`personal-knowledge-graph-design-and-next-steps.md`](https://github.com/wannli/W/blob/11ca64fb5e6a36bbf506f52e9570fe77e6e29c1b/docs/design/personal-knowledge-graph-design-and-next-steps.md) | Glossary read; long design heading inventory only. Background proposals must not be promoted wholesale. |
| Operational guidance | `AGENTS.md`, three `docs/agents/*.md`, four `docs/coordination/wiki/*.md`, `wgraph/README.md` | AGENTS and wiki index read; other contents not fully read. Wiki explicitly records dated snapshots, not live status. |
| Earlier research | `261108-{device-exchange,device-harness,editor-hooks,obsidian-native-action-cues,passage-anchors,pglite-vs-sqlite,reader-entrypoints}.md`; `261109-reader-integration-baseline.md` | Eight reports enumerated, not fully read here. Most have published research branches listed below; baseline is on pinned main. |
| Cross-project outcomes | [`261110-workbench-outcomes-review.md`](https://github.com/wannli/W/blob/b42bd3a29ea2950ef65b193777293740a5f44be3/docs/research/261110-workbench-outcomes-review.md) | Read. Earlier research evidence, not a fresh audit of Contacts or current Reader. |
| Integration feasibility | [`261112-reader-integration-feasibility.md`](https://github.com/wannli/W/blob/6e505781ca55a7eeb8c93892bf48580e4e9c805e/docs/research/261112-reader-integration-feasibility.md) | Enumerated; resolution read. |
| Architecture feasibility | [`261114-minimal-first-release-architecture.md`](https://github.com/wannli/W/blob/43b8abfe109f62decbf6df99448d22a9b27a05a2/docs/research/261114-minimal-first-release-architecture.md) | Read. Assessment/recommendations, not selected Reader changes. |
| Host and YAML options | `261112-host-options-test-loop.md`, `261114-obsidian-mcp-scheduled-research-feasibility.md`, `072-yaml-contract-options.md` | Available on local main and `docs/072-host-options`; enumerated, YAML headings inspected, content not fully read. Draft options, not approved contracts. |
| Accepted outcome spec | [W outcome spec v1.0](https://github.com/wannli/W/issues/70#issuecomment-6784967144) | Full text read. Lives in an issue comment, not a missing `specs/` file. Later host/release decisions supersede its still-open-status passages. |
| Accepted vocabulary | [ω user-facing vocabulary v1.0](https://github.com/wannli/W/issues/77#issuecomment-6882474288) | Full resolution read; supersedes technical glossary as ordinary UI language, not internal IDs. |
| Visual reference | Local `docs/design/076-visual-system.v0.1.md` at `04f756ab973ae79381929aa561db0a5d5650da2f` | Read in visual-system worktree; accepted baseline, unpublished, not production acceptance. |
| Prototypes | `identity-assignment-prototype.html`; `043-editor-actions`, `076-visual-system`, `identity-cues`, `reader-exploration-flow`, `research-exploration` `.prototype.html`; `evidence-to-question.html`, `garden-overview.prototype.html`; `native-cues/` source/image | Paths enumerated, history/README and selected discussion read; not a full artifact/source/image audit. |
| New overview | Local `developing-overview.prototype.html` at `20efe814b6f0a668d67cdf804e8ffa2b41eb3e9f` | Full source read. Static fictional comparisons and page-only filtering; no durable model or live synthesis. |
| Implementations/tests | `main.ts`, `src/`, `test/`, `tests/`, `wgraph/`, build/guard scripts | Paths enumerated. Only `src/inline-comments.ts` and `src/inline-comments-view.ts` fully read for a concrete implementation check. No exhaustive code/test audit or execution. |

### Branch and local-artifact ledger

All 18 GitHub branch tips were available in local Git and ancestors of local main. This establishes availability/integration ancestry, not content review. Capture these published tips rather than treating mutable branch names as permanent evidence:

| Published branch | Observed tip |
| --- | --- |
| `main` | `11ca64fb5e6a36bbf506f52e9570fe77e6e29c1b` |
| `feat/078-inline-comments` | `925d4521ff9dc028356147a2a5988bf5fbad0a53` |
| `prototype/043-editor-actions` | `bb002f7e4cfd5251077bacd319fb25402bae6470` |
| `prototype/068-garden-overview` | `cd950e4e00b52424f500000a7429f40f638a997d` |
| `prototype/069-research-exploration` | `90f7205d9cd5f1872de037c5de6a719f57241ad3` |
| `prototype/evidence-to-question` | `5e6d2b0e5d5b8cc573f2cc6b3c63e67e52c0af77` |
| `prototype/identity-action` | `9c3f0b2d142fdad3d163590decff7999bc675638` |
| `prototype/identity-cues-28-20261109` | `25185c1aeaf853e362737019d8dd24283cc2b351` |
| `research/064-workbench-spec-review` | `b42bd3a29ea2950ef65b193777293740a5f44be3` |
| `research/071-reader-feasibility` | `6e505781ca55a7eeb8c93892bf48580e4e9c805e` |
| `research/075-minimal-architecture` | `43b8abfe109f62decbf6df99448d22a9b27a05a2` |
| `research/device-exchange` | `2b46a1b36369a84468331b661639855511bfaa2a` |
| `research/device-harness` | `294c4189c54ad711a02b8992783caf8ce3239831` |
| `research/editor-hooks` | `e448ad623e17d3de875b70bebcbbee8164edd18d` |
| `research/passage-anchors` | `7fe5fd2d20c45ce26b456508ab36abd42182b35b` |
| `research/pglite-sqlite` | `1e555077882d692ccb94722093d35dc20f698084` |
| `research/reader-entrypoints` | `a44122f5b03a0c2f84ed8f06b2bf3169db3292bb` |
| `spike/native-editor-capture` | `ecc59e5d453ab2e5f610ab8c7b667f637b876f73` |

Eight registered worktrees were clean, with no ordinary untracked files reported. Paths below are under `/home/whl/worktrees/W/` except the first. No ignored build/dependency/vault contents were opened.

| Worktree | Branch / HEAD | Publication distinction |
| --- | --- | --- |
| `/home/whl/code/w` | `main` / `9c8f76b7de1e86299854bfe37f5c13ce44021394` | Local integration only; not GitHub main. |
| `068-developing-overview` | `prototype/068-developing-overview` / `20efe814b6f0a668d67cdf804e8ffa2b41eb3e9f` | Unpublished; adds newer overview absent from local main. |
| `069-research-exploration` | `prototype/069-research-exploration` / `90f7205d9cd5f1872de037c5de6a719f57241ad3` | Published branch; also consolidated locally. |
| `072-host-options` | `docs/072-host-options` / `a5c6d5ca6722dc05364d1c89106d87a72a1b09a9` | Unpublished branch; drafts now committed, unlike earlier issue minutes. |
| `075-minimal-architecture` | `research/075-minimal-architecture` / `43b8abfe109f62decbf6df99448d22a9b27a05a2` | Published research branch. |
| `076-visual-system` | `prototype/076-visual-system` / `04f756ab973ae79381929aa561db0a5d5650da2f` | Unpublished accepted reference, newer than local main. |
| `078-inline-comments` | `feat/078-inline-comments` / `925d4521ff9dc028356147a2a5988bf5fbad0a53` | Published proof branch, not published main. |
| `079-vocabulary` | `fix/079-vocabulary` / `366eff01f094ea978b942380d41859f6df79941e` | Unpublished branch, consolidated into local main. |

Unpublished citations are deliberately local paths plus full commits, not fabricated working GitHub blob links. Content fingerprints: visual reference SHA-256 `3e639cca76769f0f0566731b02dedd5121b594a77079a4df4f34ee144cd170d0`; newer overview `28c0d3a2641d9e239932fb6c475b1f384a1fe9bbd248015dfa53bc5e3bdc8148`. Neither artifact was copied or published by this report.

## Preliminary theme index and changes of direction

| Distinct outcome or idea | Provenance and current evidence category |
| --- | --- |
| Stable knowledge identity independent of a file; selectable occurrences distinct from reusable people/topics | Historical [identity map](https://github.com/wannli/W/issues/1) and glossary. Human-approved trial model, not automatically the files-first rebuild model. |
| Conservative source matching; ambiguity remains unresolved | Historical [identity/locator decision](https://github.com/wannli/W/issues/14); current proof source rejects nonunique paragraph/selection matches. Quote uniqueness now cannot prove historical occurrence identity after arbitrary edits. |
| Offline drafts, immutable batches, idempotent acceptance and replaceable validated caches | [Graph ingestion contract](https://github.com/wannli/W/issues/7), [exchange format](https://github.com/wannli/W/issues/19). Historical SQLite mechanisms; files holding pending operations are not equivalent to meaningful work being files-authoritative. |
| Lightweight discourse: source grounds for a claim; optional reasoning | [Discourse map](https://github.com/wannli/W/issues/23), [minimum design resolution](https://github.com/wannli/W/issues/26#issuecomment-6733656287). Trial explicitly removed Claim attribution; broader outcome spec still requires semantic source/human/AI distinction. Do not infer an approved asserter schema. |
| Manual classification versus optional later structure | Early identity slice required explicit class actions. [Everyday journeys](https://github.com/wannli/W/issues/65#issuecomment-6779159675) make unclassified reading/thought complete interactions. Neither cancels all older scoped trials. |
| Source-first reading, lightweight personal writing and unfinished explorations | [Source-first feedback](https://github.com/wannli/W/issues/69#issuecomment-6839620020), [loose-writing clarification](https://github.com/wannli/W/issues/69#issuecomment-6839665752). Notebook-first was overkill, not a ban on long writing. |
| Shared reading/authoring behavior across direct and exploration entry | [Shared-reader choice](https://github.com/wannli/W/issues/69#issuecomment-6867756592). Implemented in an in-memory prototype, not durable/native acceptance. |
| Inline selected-passage comments and loose writing between paragraphs | [Placement choice](https://github.com/wannli/W/issues/69#issuecomment-6865019739), [minimal proof format](https://github.com/wannli/W/issues/67#issuecomment-6882474446). Source unchanged; separate ordinary notes approved only for the scoped proof. |
| Explicit connections, optional multiple classes, reusable labels, contextual source return | [UI-linking revision](https://github.com/wannli/W/issues/69#issuecomment-6865339921), [multi-class choice](https://github.com/wannli/W/issues/69#issuecomment-6868202872), [label reuse](https://github.com/wannli/W/issues/69#issuecomment-6877008103). Backslash relationship syntax was tried then rejected. No prose edit should silently assert an edge. |
| Overview of developing interests and thinking, not activity totals | [Latest overview direction](https://github.com/wannli/W/issues/68#issuecomment-6883781016): themes or woven account above development-on-demand. A versus B remains open. Earlier reading-table artifact was not approved. |
| Intentional context versus comprehensive activity/location tracking | [No automatic activity trail](https://github.com/wannli/W/issues/68#issuecomment-6834567449); [fictional encounter sketch](https://github.com/wannli/W/issues/69#issuecomment-6876579171) later explores personal time/place. This is not permission to record every visit or collect live coordinates. |
| Native touch reading, two-tap targeting, independent pagination | [Touch contract](https://github.com/wannli/W/issues/32#issuecomment-6741216898). Specification accepted; [touch-spec closure](https://github.com/wannli/W/issues/44#issuecomment-6742023796) explicitly does not mean implementation. |
| Quiet transport, actionable recovery, truthful local versus delivered state | [Automation map](https://github.com/wannli/W/issues/30), [canonical vocabulary](https://github.com/wannli/W/issues/77#issuecomment-6882474288). Automatic submission has no initial Undo promise; foreign graph lineage fails closed rather than silently migrating. |
| Files-first local capture; trusted host separate from external AI | [Host allocation](https://github.com/wannli/W/issues/72#issuecomment-6878459386): Obsidian/Sync device interfaces, trusted bwd headless/direct-file processing, privacy-enforcing MCP, independent scheduling, ChatGPT conversational access. No deployment/security guarantee. |
| Public-source AI with request-scoped private exceptions and explicit authorship | [Privacy resolution](https://github.com/wannli/W/issues/66#issuecomment-6836843205). Uncertain/private context excluded by default; encrypted copies do not grant readable processing access. Persistent chat transcripts remain an unresolved enforcement tension. |
| Bounded Connect/Recommend/Explore; curated suggestions, not another feed | [Privacy resolution](https://github.com/wannli/W/issues/66#issuecomment-6836843205), [first later-research journey](https://github.com/wannli/W/issues/74#issuecomment-6882891191). Explore is request-driven first; Connect/Recommend and automatic research remain later. Findings are not automatic saved sources or beliefs. |
| Preserve Reader use without making full replacement parity the initial release gate | [Older consolidation map](https://github.com/wannli/W/issues/43) versus [new parity boundary](https://github.com/wannli/W/issues/67#issuecomment-6881976899). Research later; desktop+iPhone explicitly saved-work durability first, not every unfinished draft or initial iPad/BOOX acceptance. |
| Reuse useful core, but do not inherit Reader’s interaction/write side effects | [Architecture assessment](https://github.com/wannli/W/issues/75#issuecomment-6881936742) recommended bounded reuse; [later view-ownership choice](https://github.com/wannli/W/issues/67#issuecomment-6882530978) explicitly superseded the Reader-extension recommendation. No supported external handoff was demonstrated. |
| Plain activity-led vocabulary and quiet native-notebook visuals | [Vocabulary baseline](https://github.com/wannli/W/issues/77#issuecomment-6882474288), [visual acceptance](https://github.com/wannli/W/issues/76#issuecomment-6883663406). Comment replaces scribble in UI; regular system fonts supersede custom typefaces; fixed neutral palette supersedes arbitrary theme inheritance. |
| Wider life/format integrations without compulsory processing | [Outcome spec](https://github.com/wannli/W/issues/70#issuecomment-6784967144) includes RSS, YouTube, PDF/books/Kindle, people/contacts, calendar and private reMarkable journals. These are destination ambitions, not verified integrations or automatic first-release commitments. |

## Implementation and validation boundaries

- [First identity milestone](https://github.com/wannli/W/issues/22#issuecomment-6732102419) records accepted desktop+iPad real-Sync evidence. [Small manual discourse proof](https://github.com/wannli/W/issues/27#issuecomment-6733691459) records real iPad/desktop actions and unchanged Markdown. These are reported historical bounded passes, not grounds to claim all W devices/workflows untested—or fully validated.
- [Automatic submission](https://github.com/wannli/W/issues/57#issuecomment-6743073851), [interruption recovery](https://github.com/wannli/W/issues/58#issuecomment-6745224890), [cache adoption](https://github.com/wannli/W/issues/59#issuecomment-6745366273) and [action-needed alerts](https://github.com/wannli/W/issues/60#issuecomment-6745559004) report synthetic tests; the alert ticket also reports a narrow installed-desktop probe. [Desktop acceptance](https://github.com/wannli/W/issues/62#issuecomment-6774644741) and [real automatic iPad Sync acceptance](https://github.com/wannli/W/issues/61) remain open. Do not substitute the older manual round trip for these gates.
- [Comment proof](https://github.com/wannli/W/issues/78#issuecomment-6882727190) is implemented at published `925d452`, with files-only explicit save/readback and reconstruction. Source inspection confirms this narrow shape. Its [native check is blocked](https://github.com/wannli/W/issues/78#issuecomment-6882794154); host-double tests are not real rendering/restart/iPhone/Sync proof.
- Visual acceptance covers a baseline and browser specimens, not full accessibility, installed layout or BOOX. The encounter and overview examples are fictional; no tracking, inference or durable synthesis was proved.

## Limits and exact continuation

1. **Do not close the research ticket yet.** Roughly 621,000 characters of issue/comment text were fetched. Only the content coverage explicitly marked above was read; full historical decision extraction and deduplication remain unfinished. Enumeration is not a complete inventory of ideas.
2. Read the remaining historical discussions and foundational design before claiming all assessable ideas are accounted for. Review the eleven research reports not fully read here, prototype versions and relevant source/history differences. Preserve proposals, reversals and slice-specific choices separately.
3. A decision record referenced by the [discourse map](https://github.com/wannli/W/issues/23), `docs/decisions/0001-reuse-w-primitives-for-discourse.md` on `docs/discourse-primitives`, was not found in registered worktrees, current branches or reachable path history. Its content/provenance is unavailable here; do not invent it. Related issue decisions remain available.
4. Earlier comments describe host/YAML artifacts and wording fixes as uncommitted/unintegrated. Current local Git shows they are committed/consolidated. Preserve both dated observations; neither implies publication to GitHub main. Some old commit identities were corrected, so follow later correction comments before treating a hash as authoritative.
5. Reader’s requested `GLOSSARY.md` and `docs/adr/` are absent in the inspected active checkout. Its README/guide and selected model/document/main source were read only for orientation. Current Reader compatibility/adoption comparison belongs to the separate baseline and human-decision tickets, not this report.
6. No subagents, servers, vaults, devices, installations, AI calls or runtime tests were used. Active sessions and both active checkouts were preserved. The only authored repository change is this note in a temporary isolated Reader clone. Publish this research branch only; no PR, merge or main push.
7. Resume this same claimed inventory with the ledger above, refresh GitHub/local drift first, then finish the unread sources and missing-record disposition. Only a complete cited inventory can support an attributed resolution, ticket closure and a linked gist in the map’s Decisions so far. Until then the map must not index this checkpoint as a resolved answer.
