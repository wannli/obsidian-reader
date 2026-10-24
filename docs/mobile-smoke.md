# Joint Reader / Nodes iPhone smoke test

One disposable vault, one Obsidian Sync remote, one short phone walkthrough. This is manual native acceptance, not an E2E suite or proof from DOM mocks.

The Mac results and settings below are a **14 October historical record**, not a current installation inventory. That build used folder queues and `reading_position`. Current source uses folder-authoritative queues, a YAML `status` mirror, `bookmark` and four queue folders; see the [storage contract](storage-contract.md). Reconfirm build identity and owner clearance before a future walkthrough; do not convert the old fixtures automatically.

## Safety and authorization

- Reader's owned target is `.sandbox/Reader2 Test Vault` in this repository. **The native lane is returned to Wannes, hold true; he can use the window now.** Agents must not access native Obsidian without fresh clearance, including read-only checks. Future authorized work still requires exact ownership/path verification.
- Wannes confirmed desktop navigation and authorized Sync. On 14 October he explicitly requested restoring the prior Mac Sync choices; restoration is complete and Sync now reports synced; those settings remain untouched. Do not pause it, change its categories, or request device-plugin disabling again without a new instruction.
- Do not use a personal vault, an unrelated remote, or a different local target without the necessary explicit authorization. Resolve Reader's own registered vault ID and put it before CLI commands; never reuse another project's ID.
- Do not access the Nodes dummy vault during its observer/key-release hold. Wait for the owner to confirm cleanup, final artifacts, compatibility and installation clearance.
- Do not copy an entire development vault or import its settings. Stage only verified plugin artifacts, owner-approved minimal settings and small synthetic fixtures.
- Hot Reload, `.hotreload`, `.native-smoke` instrumentation and benchmark corpora must stay outside the shared Sync payload. Merely disabling Hot Reload on the phone is insufficient.
- Keep development watchers stopped during shared acceptance. `dev:setup` installs Hot Reload and is not a clean Sync-profile setup command.
- Never commit, push, bump versions or release as part of this walkthrough.

## Completed Mac acceptance and handoff — do not repeat on the held lane

1. **Installed build:** `f4bf22574068b7605753cced90af11dc018602804b238c6dad71f53b2041224d`, Reader-only reloaded 2026-10-14T14:46:50.332Z. Recorded validation: 1042 unit + 72 tooling = 1114; test-only 8.258s, full check 12.361s. Watcher-ownership and retired queued-request issues were fixed and independently re-reviewed.
2. **Native Mac layout:** list rows flat/0 radius, no search, four floating 44px buttons, existing-position/highlight indicators, full 927px pane. Article: 903px inside that pane, no cap, 16px text padding PLUS 15px native scrollbar; five 44px buttons, one H1, visible highlight, last line above bar.
3. **Native navigation/routing:** trusted ArrowDown at article end advanced exactly one despite held repeat; destination resumed its stored marker at scrollTop 675. Open Markdown → Welcome native Markdown → the same article Reader passed in the SAME leaf after completed escape. OS URI using vault ID forced the reading list.
4. **Explicit folder Apply:** all five independent roles were applied at the SAME current locations under `Reading`; old generation aborted, fresh Reader list opened. All 43 Markdown/Base files were byte-identical ACROSS Apply. Unlike the initial no-write install, this explicit action DID persist the new five-role `folders` group in Reader `data.json`, preserving all three legacy keys/values. No automatic folder/note migration. Read means opened before, not finished; existing `reading_position` + Markdown highlights only, no new YAML/history.
5. **Final overall backup audit:** 43 → 43, no additions/deletions; only `reading_position` changed in two articles. Welcome unchanged. Companion/core/community enablement and data hashes unchanged; other plugins retained the same instances/enablement. Current Mac metadata had no duplicate-title notes; the earlier phone cause remains undiagnosed, with no deduplication/deletion.
6. **Window returned:** native lane belongs to Wannes / hold true. Sync reports synced on **Reader phone smoke 2026-10-14**, with restored settings untouched. Watcher STOPPED; Hot Reload/instrumentation remain outside Sync. Actual iPhone/Boox acceptance is still pending; production Surface browser tests at four fractional widths (uniform stride, no micro-page, clearance) are not device proof.

Recorded final evidence: `reader-redesign-audit.json`, `native-folder-apply.json`, `native-resume.json`, `routing.json`, `uri.json`. These are recorded native results, not checks rerun during this docs refresh. See the [report](rebuild-report.html) for historical cutover/scale and prior `709399…` evidence.

Earlier signed desktop Nodes API v2 capture/early-link, PhoneTask `false`/`0`, Atlas & Orbit project readback, visible highlight and Stream-protection checks succeeded. They do not prove full mobile capture, Date/cancellation or physical acceptance. Fileclass 0.2.15/public API 1.1 requires **Obsidian 1.12.7+** on both devices; API versions and plugin release versions differ. Preserve the verified project baseline (**Atlas & Orbit**, **Borealis research**, excluding **Should never show**) and legitimate added projects; never prune a created node or treat fallback/all-file candidates as Base-filter proof.

For future authorized interoperability checks, creation’s chosen class may differ from discovery’s last bound class. Link/Change and Create note must use `fileclass-inline.api` v2 `pickNodeForLink`, committing the source before required completion. Without that capability, neither action is available; verify ordinary highlights still work. There is no All notes route or standalone fallback. Reject uncertain source writes, verify target visibility through the public API at Reader’s commit boundary, and never prune the target. Current Reader’s Feed-folder → Later promotion must not cancel required completion; Fileclass defaults/hooks must not alter Reader articles or retention.

## Fileclass safety profile — unchanged

Recorded Mac `fileclass/data.json` safety profile below remains unchanged; do not restage it or alter enablement. For any future authorized first-enable case, configuration arrival must be checked without assuming ordering was proved by Sync:

```json
{
  "classFilesPath": "Classes/",
  "fileClassAlias": "fileClass",
  "enableCanvasEngine": false,
  "enableSchemaLog": false,
  "insertFieldsOnBind": false,
  "reorderOnInsert": false,
  "openFieldsOnCreate": false,
  "globalFileClass": ""
}
```

Keep class definitions and Nodes capture outside `Reading/`, with matching `fileClass` aliases. Leave class `newNotes[].template` and legacy `fileClassNoteTemplate` unset; no global/folder/tag bindings for Reader. There is no per-folder write-deny switch: folder separation alone is not protection. Turning Canvas off after writes were queued is not a cancellation guarantee. Do not run explicit Fileclass write commands on Reader articles.

**Recorded Sync configuration (14 October):** preserve Wannes’s restored choices: configuration/enablement and installed-plugin/settings sync on; “Sync all other types” off. The Mac Fileclass safety profile is unchanged. The iPhone already synced an enabled Reader/Fileclass/Nodes list; mobile first-enable/config-arrival ordering is unverified, not grounds to silently reconfigure his devices. Verify Base arrival and record unrun mobile cases.

## Phone walkthrough — four steps, two feature interactions

1. **Use the existing disposable remote, Reader phone smoke 2026-10-14.** Do not create another remote or connect a personal vault. Authentication/encryption secrets stay with Wannes.
2. **During Wannes’s phone walkthrough, confirm downloads/build identity.** The last build recorded here is Mac Reader `f4bf…`; verify the actual Mac and phone builds rather than assuming that record is current. Actual phone acceptance is not established. Confirm Obsidian 1.12.7+, Bases and the three plugin builds without changing restored Sync settings. Record unknown startup ordering honestly; do not claim mobile readiness from desktop tests.
3. **Native `@` Person capture:** open the prepared ordinary Markdown scratch note, type the supplied `@` query and choose optional-only Person. Verify real iOS keyboard/touch selection, readable class icon, source/link preservation, and no optional completion form. A toolbar fallback is not proof that the `@` trigger worked.
4. **Reader → required PhoneTask:** select the prepared passage, then clear selection and tap its visible highlight → **Create note…** → PhoneTask. Enter the agreed summary, completed **False (`false`)**, estimate **`0`**, and choose **Atlas & Orbit** from the verified project list; leave optional details empty. Verify link-before-completion and Save/Close access with the keyboard present. Tap the linked highlight → **Open note** once after Sync; briefly background/resume and report “done” or the first unexpected result.

Use the exact owner fixture pack: standalone Person, Project and PhoneTask classes, `Working/Projects.base` / `Projects only`, display `note.projectTitle`; no Task/WorkItem inheritance or field defaults. Nodes uses `nodesFolder: Nodes`, `classProperty: fileClass`, `trigger: @`. Mac verifies exact typed YAML after both interactions. Record unrun iOS Date/cancellation cases; desktop component results do not cover them.

## Mac readback and evidence

The final Mac audit above is complete. The following phone readback cases remain a future checklist, not authorization to access the currently held native lane:

- For current source, verify the exact synced article Markdown, highlight/link destination and `bookmark`; Feed-folder annotations must save `status: later` before the annotation and move to Later. Legacy `reading_position` stays untouched/inert. Check the target's expected class membership and field values.
- Check that meaningful `false`/`0`, required text, Base-selected links and any tested Date survived with the expected types/values.
- Confirm a cancelled/failed linked creation never triggered target pruning or stale article writes.
- Record device model, OS/Obsidian versions, both plugin build identities, tested cases, skipped cases and observed errors. Sync completion alone does not prove plugin loading or interaction correctness.
- iPhone evidence does not establish iPad/Boox acceptance or native 10k/100 performance. Those remain separate checks.
