// Pure, offline manual fixtures and reset planning. Importing this module writes nothing.
import { createHash } from 'node:crypto';

export const fixtureRoot = 'Hosted Highlights E2E';
export const classRoot = 'Topic Filter E2E/Classes';
export const createdRoot = 'Topic Filter E2E/Created';
export const e2eIdentity = Object.freeze({
  repository: '/Users/wannli/code/obsidian-reader',
  vault: '/Users/wannli/code/obsidian-reader/.sandbox/e2e',
  vaultId: 'b1e7a3f24d42d331',
  markerSha256: '706ad1f874ec1e049fb34751b64d67cc8398045c297736d5cc9bc9de460b6fe9',
});
export const fixtureHash = (bytes) => createHash('sha256').update(bytes).digest('hex');

const legacyArticleNames = [
  'E2E 01 Explicit assignment',
  'E2E 02 AURORA POLICY in title',
  'E2E 03 Body match',
  'E2E 04 Alias phrase',
  'E2E 05 Short alias',
  'E2E 06 Substring negative',
  'E2E 07 Unrelated',
  'E2E 08 Free-text phrase',
  'E2E 09 Free-text substring',
  'E2E 10 Later queue',
  'E2E 11 Feed queue',
];
// A reviewed file allowlist, not a recursive deletion rule. Additional notes remain untouched.
export const legacyResetPaths = Object.freeze([
  ...legacyArticleNames.map((name) => `Topic Filter E2E/Articles/${name}.md`),
  ...[
    'Reader synthetic archive item',
    'Reader synthetic later item',
    'Synthetic - A paper lantern — Reader synthetic feed item',
    'The quiet library — Reader synthetic seed',
  ].map((name) => `Reading/Articles/261016 ${name}.md`),
  'Reading/Feeds/Reader synthetic feed.md',
  'Topic Filter E2E/Topics/Aurora policy.md',
  'Topic Filter E2E/START HERE.md',
  'Topic Filter E2E/START HERE - Topic creation.md',
  'Reader selection diagnostic 1792151381948-t0aaqixy.md',
  'Governance.md',
  'Untitled.md',
  `${createdRoot}/hello.md`,
  `${createdRoot}/test.md`,
]);

function markdown(fields, body) {
  const yaml = Object.entries(fields).map(([key, value]) => {
    if (Array.isArray(value))
      return `${key}:\n${value.map((item) => `  - ${JSON.stringify(item)}`).join('\n')}`;
    return `${key}: ${key === 'published' ? value : JSON.stringify(value)}`;
  });
  return `---\n${yaml.join('\n')}\n---\n\n${body.trim()}\n`;
}
const wiki = (path) => `[[${path.replace(/\.md$/, '')}]]`;

export function buildHostedHighlightFixtures(day) {
  const date = new Date(day);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== day
  )
    throw new Error('A real YYYY-MM-DD fixture day is required');
  const stamp = day.replaceAll('-', '').slice(2);
  const hosts = {
    governance: `${fixtureRoot}/Hosts/Topic/Governance.md`,
    trust: `${fixtureRoot}/Hosts/Concept/Institutional trust.md`,
    person: `${fixtureRoot}/Hosts/Person/Marisol Quinn.md`,
    layout: `${fixtureRoot}/Hosts/Concept/Policy coordination.md`,
    ambiguous: `${fixtureRoot}/Hosts/Concept/Governance.md`,
    untyped: `${fixtureRoot}/Untyped/Institutional trust.md`,
    unknown: `${fixtureRoot}/Untyped/Unknown class.md`,
  };
  const feed = 'Reading/Feeds/Hosted highlights offline feed.md';
  const rows = [
    [
      'inbox',
      'One host',
      [hosts.governance],
      'Clear rules help people review decisions. A second sentence offers another short selection.',
    ],
    [
      'inbox',
      'No host',
      [],
      'Open inquiry makes better decisions possible. Cancel the host picker once before choosing a typed note.',
    ],
    [
      'inbox',
      'Multiple hosts',
      [hosts.governance, hosts.trust],
      'Shared confidence depends on clear review. Choose a host explicitly; do not silently use the first remembered note.',
    ],
    [
      'inbox',
      'Formatting and URLs',
      [hosts.trust],
      'Before **bold review rules** after, then *careful public reasoning* continues.\n\nRead the [public review policy and trust report](https://example.invalid/report?q=review#trust) before deciding.\n\nCompare [clear **public rules** and *shared trust* today](https://example.invalid/second-report). Select two separate fragments inside this one URL label.',
    ],
    [
      'inbox',
      'Repeated words',
      [hosts.governance],
      'Careful review builds trust. Careful review builds trust again in the same paragraph.\n\nCareful review builds trust in a different paragraph. Select this last occurrence, not the first.',
    ],
    [
      'inbox',
      'Shared paragraph',
      [hosts.governance, hosts.trust],
      `==Clear rules== (※ ${wiki(hosts.governance)}) support ==shared confidence== (※ ${wiki(hosts.trust)}) during public review. ^reader-hh6`,
    ],
    [
      'inbox',
      'Collection gestures',
      [],
      `==First source excerpt== (※ ${wiki(hosts.governance)}) stays the source of a two-click collection. ^reader-hh7a\n\n==Destination selector only== (※ ${wiki(hosts.trust)}) must stay unchanged when clicked as the destination. ^reader-hh7b\n\n==Several destinations== (※ ${wiki(hosts.governance)}, ${wiki(hosts.trust)}) requires a choice. ^reader-hh7c\n\nA typed person link ${wiki(hosts.person)} and an untyped decoy ${wiki(hosts.untyped)} test exact link targets. Ordinary links open normally outside collection.`,
    ],
    [
      'inbox',
      'Conversion and legacy',
      [hosts.governance],
      `Institutions build institutional trust through an adaptive review pact. Convert one phrase only through explicit intent.\n\nA ==plain old highlight== and ==[[${hosts.trust.replace(/\.md$/, '')}|legacy wrapped passage]]== remain readable without automatic migration.\n\nA ==[**formatted legacy passage**](/${hosts.governance.replaceAll(' ', '%20')})== retains its words.\n\nDo not discard this [publisher trust label](https://example.invalid/legacy) during node-only conversion.`,
    ],
    [
      'feed',
      'Feed retention',
      [],
      'The retained source paragraph must keep its bookmark and use its actual Later path in quotations and new origins.',
    ],
    [
      'feed',
      'Feed folder YAML mismatch',
      [],
      'Folder membership wins: this physical Feed article has inbox YAML but highlighting still retains it in Later.',
    ],
    [
      'later',
      'Later folder feed YAML',
      [hosts.layout],
      'This article is already physically Later despite feed YAML. Highlighting must not treat it as a Feed-folder promotion.',
    ],
    [
      'archive',
      'Snapshot ownership',
      [hosts.governance],
      'An archived source can collect a durable quotation. Edit, remove or convert the source later; the destination snapshot must remain user-owned.',
    ],
  ];
  const folders = { inbox: 'Inbox', feed: 'Stream', later: 'Later', archive: 'Treasury' };
  const articles = rows.map(([queue, label], index) => ({
    path: `Reading/${folders[queue]}/${stamp} HH ${String(index + 1).padStart(2, '0')} ${label}.md`,
    title: `HH ${String(index + 1).padStart(2, '0')} ${label}`,
    queue,
  }));
  // Native backlinks retain Feed articles at startup; guide entries must not create them.
  const guideEntry = (article) =>
    article.queue === 'feed' ? '`' + article.path + '`' : wiki(article.path);
  const citation = (index, id) =>
    `[[${articles[index].path.replace(/\.md$/, '')}#^${id}|${articles[index].title}]]`;
  const files = {};
  rows.forEach(([queue, , defaults, body], index) => {
    const fields = {
      type: 'article',
      status: index === 9 ? 'inbox' : index === 10 ? 'feed' : queue,
      title: articles[index].title,
      published: `${day}T12:00`,
      'fixture-note': 'Synthetic manual acceptance; preserve unrelated authored properties.',
      ...(defaults.length ? { topics: defaults.map(wiki) } : {}),
      ...(queue === 'feed' ? { feed: wiki(feed), bookmark: body.split('. ')[0] } : {}),
    };
    files[articles[index].path] = markdown(fields, body);
  });
  files[hosts.governance] = markdown(
    {
      type: 'topic',
      aliases: ['Decision rules', 'Rules of review'],
      origin: 'Authored seed: leave exactly this value.',
      'owner-note': 'Preserve this unknown property',
    },
    `# Governance\n\nAuthored introduction remains intact.\n\n## Highlights\n\n> Clear rules (※ ${citation(5, 'reader-hh6')})\n\n> First source excerpt (※ ${citation(6, 'reader-hh7a')})\n\n## Journal\n\nKeep this authored journal and <!-- synthetic comment --> unchanged.`,
  );
  files[hosts.trust] = markdown(
    { type: 'concept', aliases: ['Shared confidence', 'Public confidence'] },
    `# Institutional trust\n\nThis reused node deliberately has no origin.\n\n## Highlights\n\n> shared confidence (※ ${citation(5, 'reader-hh6')})\n\n> Destination selector only (※ ${citation(6, 'reader-hh7b')})`,
  );
  files[hosts.person] = markdown(
    { type: 'person', aliases: ['Mara', 'M Quinn'], origin: '' },
    '# Marisol Quinn\n\nAn authored empty origin must remain empty when this existing person is reused.',
  );
  files[hosts.layout] = markdown(
    { type: 'concept', aliases: ['Review architecture'] },
    '# Policy coordination\n\nAuthored preface.\n\n## Highlights\n\n> An authored older quotation must never be overwritten.\n\n### Questions\n\nKeep this subsection after new quotations.\n\n## Journal\n\nKeep this separate section and <!-- authored boundary -->.',
  );
  files[hosts.ambiguous] = markdown(
    { type: 'concept' },
    '# Governance\n\nThis duplicate basename has different class/path context.\n\n## Highlights\n\nFirst authored section.\n\n## Highlights\n\nSecond authored section: filing must refuse this ambiguity.',
  );
  files[hosts.untyped] =
    '# Institutional trust\n\nUntyped matching-title decoy. It must never become an eligible host.\n';
  files[hosts.unknown] = markdown(
    { type: 'not-a-fileclass', aliases: ['Governance'] },
    'An arbitrary type string is not proof of Fileclass membership.',
  );
  // Actual Fileclass 0.2.15 format, matching the preserved topic definition; no invented fields.
  files[`${classRoot}/concept.md`] = '---\nicon: lightbulb\nversion: "2.0"\nfields: []\n---\n';
  files[`${classRoot}/person.md`] = '---\nicon: user\nversion: "2.0"\nfields: []\n---\n';
  files[feed] = markdown(
    {
      type: 'feed',
      title: 'Hosted highlights offline feed',
      url: 'https://example.invalid/hosted-highlights/feed.xml',
      enabled: false,
    },
    'Disabled synthetic subscription. Articles contain authored local prose and deliberately have no URL; no acquisition or feed refresh is needed.',
  );
  files[`${fixtureRoot}/START HERE.md`] =
    `# Hosted highlights — manual acceptance\n\nSynthetic pack dated ${day}. Native/device acceptance is pending, not implied by this pack. Use desktop → iPhone → Boox and stop on the first unexpected result. Record device/Obsidian/plugin builds and before/after Markdown outside Sync.\n\n## Start\n\nOpen Reader's Inbox. The HH articles are in physical queue folders; YAML status alone does not assign a queue. This pack never changes settings, enablement, Welcome, Daily or the existing topic schema. Companion creation still uses ${createdRoot}. No network refresh is required. Feed entries below are code paths, not native backlinks; find HH 09 and HH 10 in Reader's Feed list. They must stay there until the manual highlighting action.\n\n${articles.map((article, i) => `${i + 1}. ${guideEntry(article)} — ${article.queue}`).join('\n')}\n\n## Checks\n\n- **01 / one default:** select a fragment. Inherit Governance without a picker; inspect reference, paragraph ID, quotation and source link. Override a later highlight without moving the earlier snapshot.\n- **02 / zero defaults:** cancel the picker before dispatch: no highlight or quote. Repeat with an explicit host.\n- **03 / multiple defaults:** require a choice, never silently select the first.\n- **Typed selection:** exact Governance shows path/class context; Decision rules matches its alias; fuzzy query plcycrd should offer Policy coordination for explicit selection. Untyped Institutional trust and Unknown class never appear. Filter topic/concept/person and All types.\n- **Creation / origins:** create concept Adaptive review pact and person New reviewer from a source passage. Check chosen class and actual paragraph origin. Existing Governance's authored origin, Marisol Quinn's empty origin and Institutional trust's missing origin must all remain unchanged when reused. Cancel creation/completion without pruning any saved note.\n- **04 / formatting:** select inside a URL label, across plain/bold/link text, outside-to-inside bold and inside-to-outside emphasis. Then highlight two distinct fragments inside the SAME second URL label. Keep exact selected words, balanced formatting and publisher URLs in source and quotation.\n- **05 / occurrence:** select the final repeated phrase, reopen and inspect only that occurrence. Reference text/block IDs must not enter tap words or bookmarks.\n- **06 / paragraph:** two highlights already share reader-hh6. Retry each to its existing host without duplicate snapshots; different excerpts from the paragraph remain separate. Add another highlight and retain the one paragraph anchor.\n- **07 / two clicks:** arm collection from First source excerpt, then click Destination selector only. File the FIRST quote/citation into Institutional trust and leave the second passage unchanged. Repeat with Several destinations, a specific reference pill and the Marisol Quinn inline link. Untyped target refuses; Cancel files nothing. Repeat unchanged to check deduplication.\n- **08 / conversion:** open legacy highlights without migration. Explicitly convert institutional trust to the existing concept and adaptive review pact to a new typed note. Preserve wording/alias; no quote of the node's own name, redundant pill or dropped publisher URL.\n- **Destination layouts:** file into Policy coordination: preserve YAML, preface, Questions subsection, Journal and comments. Filing into the concept Governance with TWO Highlights headings must refuse ambiguity; do not silently choose one.\n- **09–11 / queues:** HH 09 and HH 10 start with zero remembered destinations: the first highlight opens Reader's host picker. Choose an existing typed host or create a concept/person to check a new origin. Cancel before dispatch first and confirm the article stays in Feed without a highlight or quote. On successful highlighting, retain to Reading/Later before annotation; cite the ACTUAL postmove path in quotations/new origin and preserve bookmark. HH 10 has inbox YAML but lives in Feed; HH 11 has feed YAML but already lives in Later. Do not add incoming native links to the Feed fixtures before this check or alter native link-update preferences.\n- **12 / ownership:** remove/edit/convert a collected source and change remembered topics. Existing target snapshots and incoming paragraph anchors remain; Undo is source-local and never reverses retention.\n- **Safety / lifecycle:** test dirty source and destination editors separately, source/target rename, stale provider, double-send, a failed destination append after source save, cancel/close/navigation during picker/creation. Refuse stale writes; report partial success accurately and retry without duplicates. Never prune a created note.\n- **Devices:** tap Sentence/Paragraph, Done/Escape, six-second Undo, drag selection, scroll/paging, image/link opening, topic filter, dog-ear and position resume. Reopen ordinary Markdown and test real Sync only in the approved window; Synced alone is not conflict acceptance.\n\n## Honest limitations\n\nThe fixture schemas have fields: []: they do not exercise required-field completion. A separately approved real required-field schema is needed for that check. Multi-class binding syntax is not invented here: mark membership filtering unrun until the companion owner supplies a supported fixture. Deferred batch, last-used destination, node-first collection and evidence roles are outside scope.\n`;
  return {
    schemaVersion: 1,
    day,
    root: fixtureRoot,
    classRoot,
    createdRoot,
    hosts,
    articles,
    files,
  };
}

export function assertFixturePath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.includes('\\') ||
    /[\x00-\x1f:*?<>|]/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Unsafe fixture path: ' + path);
  return path;
}
function preserved(path) {
  const key = path.toLowerCase();
  return (
    key === 'welcome.md' ||
    key.startsWith('daily/') ||
    key === '.reader2-test-vault.json' ||
    key.startsWith('.obsidian/') ||
    key.startsWith(classRoot.toLowerCase() + '/')
  );
}
export function planHostedFixtureReset(existing, files) {
  const byPath = new Map(),
    spellings = new Map();
  const portableKey = (path) => path.normalize('NFC').toLowerCase();
  for (const entry of existing) {
    assertFixturePath(entry.path);
    if (spellings.has(portableKey(entry.path))) throw new Error('Duplicate inventory path');
    spellings.set(portableKey(entry.path), entry.path);
    byPath.set(entry.path, entry);
  }
  const operations = [],
    preservedPaths = [],
    unrecognized = [];
  const desiredSpellings = new Set();
  for (const [path, content] of Object.entries(files)) {
    assertFixturePath(path);
    const key = portableKey(path);
    if (desiredSpellings.has(key) || (spellings.has(key) && spellings.get(key) !== path))
      throw new Error('Fixture case/normalization collision: ' + path);
    desiredSpellings.add(key);
    const schema = [`${classRoot}/concept.md`, `${classRoot}/person.md`].includes(path);
    const owned =
      schema ||
      path.startsWith(fixtureRoot + '/') ||
      path === 'Reading/Feeds/Hosted highlights offline feed.md' ||
      /^Reading\/(Inbox|Stream|Later|Treasury)\/\d{6} HH \d{2} [^/]+\.md$/.test(path);
    if (!path.endsWith('.md') || (preserved(path) && !schema) || !owned)
      throw new Error('Protected or unapproved fixture destination: ' + path);
    const before = byPath.get(path) ?? null;
    const after = { sha256: fixtureHash(content), bytes: Buffer.byteLength(content) };
    if (schema && before && before.sha256 !== after.sha256)
      throw new Error('Existing class definition differs: ' + path);
    if (before?.sha256 === after.sha256) preservedPaths.push(path);
    else operations.push({ path, action: before ? 'replace' : 'create', before, after });
  }
  for (const entry of existing) {
    if (Object.hasOwn(files, entry.path)) continue;
    if (
      !preserved(entry.path) &&
      entry.path.endsWith('.md') &&
      legacyResetPaths.includes(entry.path)
    )
      operations.push({ path: entry.path, action: 'retire', before: entry, after: null });
    else {
      preservedPaths.push(entry.path);
      if (!preserved(entry.path)) unrecognized.push(entry.path);
    }
  }
  return {
    operations: operations.sort((a, b) => a.path.localeCompare(b.path)),
    preserved: preservedPaths.sort(),
    unrecognized: unrecognized.sort(),
  };
}

export function assertFixtureRevision(expected, actual) {
  if (!expected && !actual) return;
  if (
    !expected ||
    !actual ||
    expected.path !== actual.path ||
    expected.sha256 !== actual.sha256 ||
    expected.bytes !== actual.bytes ||
    !expected.identity ||
    !actual.identity ||
    ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].some(
      (key) => expected.identity[key] !== actual.identity[key],
    ) ||
    actual.identity.nlink !== 1
  )
    throw new Error('Fixture bytes or identity changed: ' + (expected?.path ?? actual?.path));
}
export function assertFixtureApplyClearance(clearance, planSha256, now = Date.now()) {
  const issued = Date.parse(clearance?.authorizedAt),
    expires = Date.parse(clearance?.expiresAt);
  if (
    !/^[a-f0-9]{64}$/.test(planSha256 ?? '') ||
    !Number.isFinite(now) ||
    clearance?.owner !== 'Wannes' ||
    clearance.vault !== e2eIdentity.vault ||
    clearance.vaultId !== e2eIdentity.vaultId ||
    clearance.operation !== 'apply-hosted-highlights-fixtures' ||
    clearance.planSha256 !== planSha256 ||
    clearance.nativeInputPaused !== false ||
    clearance.quiescent !== true ||
    clearance.fullCheckPassed !== true ||
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    issued > now ||
    expires <= now ||
    expires <= issued ||
    expires - issued > 15 * 60_000
  )
    throw new Error(
      'Fresh E2E-only quiescent fixture-reset clearance and a passed full check are required',
    );
}
