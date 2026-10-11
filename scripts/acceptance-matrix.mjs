// Canonical user scope. Evidence is case-specific; compilation or an owner
// handoff never substitutes for actual native workflows on the final bundle.
export const acceptanceRequirements = [
  { id: 'native-ui', implementation: 'Awaiting coherent owner/audit handoff', cases: [
    'registered commands and native Menu/pickers/Modal/Setting', 'article-only typography without branding/raw URL/selection hint',
    'mobile Previous/Next/More clears host chrome without hiding it',
  ] },
  { id: 'queues', implementation: 'Awaiting coherent owner/audit handoff', cases: [
    'same-queue Previous/Next, boundaries and empty queues', 'independent reading context in two leaves',
    'j/k active Reader only; editors/dialogs/menus/IME/modifiers ignored; accepted highlight writes survive navigation and saved native selection does not permanently disable keys',
    'Stream to Inbox/Later/Treasury and Later to Treasury rename into the destination folder, retain origin queue and advance',
    'filtering never moves files; explicit moves preserve source/highlights and retarget owned daily block links without duplicate copies',
  ] },
  { id: 'routing', implementation: 'Routing owner reports READY/frozen; shared classifier and live configuration getters wired. Actual native provider/bootstrap zero-write proof still required',
    reportedCheckpoint: { routingTests: 50, routingTypecheck: 'reported PASS', unchangedFormerP0Cases: 3,
      controllerZeroTemplateWriteTests: 21, provenance: 'Owner reports; not coherent-build/native acquisition proof' }, cases: [
    'file list/search/links/fresh QuickAdd route to intended Reader leaf', 'new tabs, restored state, history and block links',
    'explicit Open Markdown remains editable through metadata events',
    'valid URL note in configured nonempty article folder; explicit nonarticle/topic and normal notes stay native',
    'actual native config/provider/bootstrap excludes literal-URL template files/folders with component boundaries and live config changes; zero template writes',
    'configured/template-placeholder assets remain byte-identical through startup/reconnect/dummy/live work; forensic versions preserved, no silent repair',
  ] },
  { id: 'highlights-links', implementation: 'Awaiting coherent owner/audit handoff', cases: [
    'settled selection auto-saves without a button', 'safe primary Link immediately stores bare wikilink without creating a note',
    'native existing-file Link to picker preserves alias; duplicate-basename canonical-path disambiguation/cancel/no file creation',
    'invalid/long/multiline primary targets fall back safely with exact quote retained; explicit HTTP(S) links remain supported',
    'j/k typed into a native picker/input do not navigate Reader',
    'Delete and daily-copy persistence/repair/conflicts preserve source and unrelated user text',
  ], hardware: 'Native handle drag/reselection NOT RUN' },
  { id: 'topics', implementation: 'Approved optional FRONTMATTER topics contract; implementation present, current-candidate native proof pending. Obsolete body-section request cancelled',
    reportedCheckpoint: { tests: 'tests/native-topics-picker.test.ts', passed: 15, typecheck: 'reported PASS',
      provenance: 'Topic helper report; non-frozen, not rerun here', currentBuildProof: false,
      nativeEscapeFocusTouchVaultProof: false, templateSafetyProof: false }, cases: [
    'all and only type: topic notes; native searchable multiselect/preselection/add/remove/cancel',
    'duplicate-basename canonical-path disambiguation; topic notes remain ordinary Markdown, including inside the articles folder',
    'optional frontmatter topics list of quoted wikilinks; canonical .md paths through APIs; no automatic target-note creation',
    'reload/backlinks; empty/cancel unchanged; queue position unchanged',
    'entire article body/source hash, Comments, Highlights, daily copies, unrelated properties and concurrent user writing preserved',
    'authored body ## Topics stays byte-identical; no body-section insertion or migration; malformed existing topics not silently destroyed',
    'mobile-accessible controls; j/k disabled while picker/input is active',
  ] },
  { id: 'manual-defuddle', implementation: 'Awaiting coherent owner/audit handoff', cases: [
    'selected path only, global dummy setting unchanged', 'busy/repeat/per-path concurrency and offline retry without durable force-live work',
    'authored/protected/highlighted source and Comments preserved; late protection/error veto',
  ] },
  { id: 'rss', implementation: 'Parser/storage/consumer reports require one coherent integration sweep', cases: [
    'RSS description and rich Atom summary remain readable excerpts, not full by length',
    'content:encoded/Atom content separately prove full feed extraction origin and no automatic reacquisition',
    'publisher title and real Markdown retained; no dummy overwrite; excerpt remains full-live eligible',
    'feed HTTP allowed independently of forbidden automatic article HTTP in dummy mode',
    'RSS filenames use UTC publication day then configured feed prefix; missing dates use added day without invented published',
    'subscription definitions default to Reading/Wires; real feed evidence remains separate from synthetic fixture results',
  ] },
  { id: 'capture-worker', implementation: 'v5 native percent-URL capture/routing passes, but native dummy acquisition overwrites already-typed Comments. P0 reproduced with per-keystroke/vault-write trace; QA Reader paused', cases: [
    'Add URL and in-article Save as article immediately persist offline and URL-deduplicate without resetting state',
    'official native QuickAdd command/handler: escaping/optional inputs/cancel/collisions/distinct duplicate URLs',
    'default QuickAdd opens Reader; explicit Open Markdown only; no cursor token/custom capture engine',
    'blank Article with populated Comments is pending; native editor keystrokes bracket actual worker insertion',
    'Inbox/Later priority; recovery on restart/foreground/reconnect; success clears error/retry metadata',
    'default dummy ON/no article HTTP; authored/custom/highlighted regions preserved',
  ] },
  { id: 'metadata', implementation: 'Pre-production folder queues; current-build validation pending. No bulk migration or upgrade workflow', cases: [
    'Reading/Inbox, Later, Stream, Treasury determine internal inbox/later/feed/archive status; new article YAML omits status',
    'filename titles/body RSS; manual filenames start with added YYMMDD; known-only published; preserve optional topics and operational metadata',
    'reset only the explicitly designated project dummy vault; never personal/other project data, no migration promises',
    'preserve existing user properties/notes; no destructive stripping or blanket metadata deletion',
    'statusless canonical-folder fixtures, not only rich legacy fixtures, prove source/highlight/daily-copy protection under the approved contract',
    'preserve protected-at-commit and late-error protections',
  ] },
  { id: 'delivery', implementation: 'v5 main 701e8b6ab922a7a1b496df6ca7e2244a33266d13a15ae4de477ab83bf91fa2ea built/installed in Acceptance only, NOT release-ready: native editor typing loss. Default held; repairs unapplied', cases: [
    'coherent source freeze, typecheck/unit/tooling/browser/build and exact installed/runtime identity',
    'test-vault-only reload preserves notes/settings/editors/current leaf; personal sessions untouched',
    'samples and native QuickAdd Shortcut guide match delivered contract',
  ], hardware: 'OS URI/Shortcut delivery, physical iOS gestures and real Sync NOT RUN; registered handler is not OS proof' },
];

export function acceptanceMatrix() {
  return acceptanceRequirements.map(requirement => ({ ...requirement,
    cases: requirement.cases.map(name => ({ name, currentBuildNativeEvidence: 'NOT YET RECORDED' })) }));
}
