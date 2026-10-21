import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'yaml';
import {
  assertFixtureApplyClearance,
  assertFixturePath,
  assertFixtureRevision,
  buildHostedHighlightFixtures,
  classRoot,
  createdRoot,
  e2eIdentity,
  fixtureHash,
  fixtureRoot,
  legacyResetPaths,
  planHostedFixtureReset,
} from './hosted-highlights-fixtures.mjs';

const pack = buildHostedHighlightFixtures('2026-10-20');
const fields = (text) => parse(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '');
const inventory = (path, content = 'old authored bytes\n') => ({
  path,
  sha256: fixtureHash(content),
  bytes: Buffer.byteLength(content),
  identity: { dev: 1, ino: 2, size: Buffer.byteLength(content), mtimeMs: 3, ctimeMs: 4, nlink: 1 },
});

test('fixture pack is deterministic, requires a real day, and never needs acquisition', () => {
  assert.deepEqual(buildHostedHighlightFixtures('2026-10-20'), pack);
  for (const day of [undefined, '', '2026-1-2', '2026-13-01', '2026-02-30', '2025-02-29'])
    assert.throws(() => buildHostedHighlightFixtures(day), /real YYYY-MM-DD/);
  assert.equal(buildHostedHighlightFixtures('2028-02-29').day, '2028-02-29');
  assert.equal(pack.articles.length, 12);
  for (const article of pack.articles) {
    const yaml = fields(pack.files[article.path]);
    assert.equal(yaml.type, 'article');
    assert.equal(yaml.published, '2026-10-20T12:00');
    assert.equal(yaml.url, undefined);
    assert.match(article.path, /\/261020 HH \d{2} /);
  }
  const feed = fields(pack.files['Reading/Feeds/Hosted highlights offline feed.md']);
  assert.equal(feed.type, 'feed');
  assert.equal(feed.enabled, false);
  assert.match(feed.url, /^https:\/\/example\.invalid\//);
});

test('physical queue roles include both directions of YAML mismatch', () => {
  const byNumber = (number) => pack.articles[number - 1];
  assert.match(byNumber(9).path, /^Reading\/Stream\//);
  assert.equal(fields(pack.files[byNumber(9).path]).status, 'feed');
  assert.ok(fields(pack.files[byNumber(9).path]).bookmark);
  assert.match(byNumber(10).path, /^Reading\/Stream\//);
  assert.equal(fields(pack.files[byNumber(10).path]).status, 'inbox');
  assert.match(byNumber(11).path, /^Reading\/Later\//);
  assert.equal(fields(pack.files[byNumber(11).path]).status, 'feed');
  assert.match(byNumber(12).path, /^Reading\/Treasury\//);
});

test('physical Feed fixtures have zero defaults or other authored frontmatter relationships', () => {
  const allowed = new Set([
    'type',
    'status',
    'title',
    'published',
    'fixture-note',
    'feed',
    'bookmark',
  ]);
  for (const article of pack.articles.filter((item) => item.queue === 'feed')) {
    const yaml = fields(pack.files[article.path]);
    assert.equal(yaml.topics, undefined, article.title + ' must open the host picker');
    assert.ok(
      Object.keys(yaml).every((key) => allowed.has(key)),
      article.title,
    );
    assert.equal(yaml.feed, '[[Reading/Feeds/Hosted highlights offline feed]]');
    assert.equal(typeof yaml.bookmark, 'string');
    for (const [key, value] of Object.entries(yaml))
      if (key !== 'feed')
        assert.doesNotMatch(String(value), /\[\[|\]\(/, article.title + ': ' + key);
  }
});

test('physical Feed prose starts without highlights, native links, references or block markers', () => {
  for (const article of pack.articles.filter((item) => item.queue === 'feed')) {
    const body = pack.files[article.path].replace(/^---\n[\s\S]*?\n---\n/, '');
    assert.ok(body.trim());
    assert.doesNotMatch(
      body,
      /==|\[\[|\(※|<mark\b|\[[^\]]*\]\([^)]*\)|(?:^|\s)\^[\w-]+(?:\s|$)/i,
      article.title,
    );
  }
});

test('no staged guide, host snapshot or origin creates an incoming native link to Feed', () => {
  const feed = pack.articles.filter((article) => article.queue === 'feed');
  const key = (target) =>
    decodeURIComponent(target.trim().replace(/^<|>$/g, '').split(/[|#]/, 1)[0])
      .replace(/^\//, '')
      .replace(/\.md$/i, '')
      .normalize('NFC')
      .toLowerCase();
  const identifiers = new Set(
    feed.flatMap((article) => [
      key(article.path),
      key(article.path.split('/').at(-1)),
      key(article.title),
    ]),
  );
  for (const [path, text] of Object.entries(pack.files)) {
    const targets = [
      ...text.matchAll(/\[\[([^\]\n]+)\]\]/g),
      ...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g),
    ];
    for (const match of targets) {
      const target = key(match[1]);
      assert.ok(
        !identifiers.has(target) && !identifiers.has(target.split('/').at(-1)),
        'Premature Feed backlink in ' + path,
      );
    }
  }
  const guide = pack.files[`${fixtureRoot}/START HERE.md`];
  assert.match(
    guide,
    /HH 09 and HH 10 start with zero remembered destinations: the first highlight opens Reader's host picker/,
  );
  assert.match(guide, /Cancel before dispatch first and confirm the article stays in Feed/);
  for (const article of feed)
    assert.ok(guide.includes('`' + article.path + '`'), 'Feed guide entry must be a code path');
});

test('one, zero and multiple remembered destinations are ordinary topics relations', () => {
  assert.equal(fields(pack.files[pack.articles[0].path]).topics.length, 1);
  assert.equal(fields(pack.files[pack.articles[1].path]).topics, undefined);
  assert.equal(fields(pack.files[pack.articles[2].path]).topics.length, 2);
  assert.notEqual(pack.hosts.governance, pack.hosts.ambiguous);
  assert.equal(pack.hosts.governance.split('/').at(-1), pack.hosts.ambiguous.split('/').at(-1));
  assert.deepEqual(fields(pack.files[pack.hosts.governance]).aliases, [
    'Decision rules',
    'Rules of review',
  ]);
  assert.equal(fields(pack.files[pack.hosts.untyped]), null);
  assert.equal(fields(pack.files[pack.hosts.unknown]).type, 'not-a-fileclass');
});

test('schemas use documented empty Fileclass fields and preserve the old topic definition', () => {
  assert.equal(pack.classRoot, classRoot);
  assert.equal(pack.createdRoot, createdRoot);
  assert.equal(pack.files[`${classRoot}/topic.md`], undefined);
  for (const name of ['concept', 'person']) {
    const schema = fields(pack.files[`${classRoot}/${name}.md`]);
    assert.equal(schema.version, '2.0');
    assert.deepEqual(schema.fields, []);
    assert.equal(typeof schema.icon, 'string');
  }
  const guide = pack.files[`${fixtureRoot}/START HERE.md`];
  assert.match(guide, /Multi-class binding syntax is not invented/);
  assert.match(guide, /do not exercise required-field completion/);
});

test('existing origins remain authored, empty or absent, with no fake multiclass flags', () => {
  assert.equal(
    fields(pack.files[pack.hosts.governance]).origin,
    'Authored seed: leave exactly this value.',
  );
  assert.equal(fields(pack.files[pack.hosts.person]).origin, '');
  assert.equal(fields(pack.files[pack.hosts.trust]).origin, undefined);
  assert.equal(fields(pack.files[pack.hosts.ambiguous]).type, 'concept');
  for (const text of Object.values(pack.files)) {
    const yaml = fields(text);
    assert.equal(yaml?.classes, undefined);
    assert.equal(yaml?.['created-by'], undefined);
  }
});

test('formatting, two fragments in one URL, repeated words and legacy readability are staged', () => {
  const rich = pack.files[pack.articles[3].path];
  assert.match(rich, /Before \*\*bold review rules\*\* after/);
  assert.match(
    rich,
    /\[clear \*\*public rules\*\* and \*shared trust\* today\]\(https:\/\/example\.invalid\/second-report\)/,
  );
  assert.match(
    pack.files[pack.articles[4].path],
    /Careful review builds trust[\s\S]*Careful review builds trust[\s\S]*Careful review builds trust/,
  );
  assert.match(pack.files[pack.articles[7].path], /==plain old highlight==/);
  assert.match(pack.files[pack.articles[7].path], /==\[\[.*\|legacy wrapped passage\]\]==/);
  assert.match(pack.files[pack.articles[7].path], /==\[\*\*formatted legacy passage\*\*\]/);
});

test('preseeded paragraph anchors and quotation citations form a consistent retry baseline', () => {
  const source = pack.files[pack.articles[5].path];
  assert.equal((source.match(/\^reader-hh6/g) ?? []).length, 1);
  assert.equal((source.match(/\(※ /g) ?? []).length, 2);
  assert.match(
    pack.files[pack.hosts.governance],
    /^> Clear rules \(※ \[\[Reading\/Inbox\/.*#\^reader-hh6\|/m,
  );
  assert.match(
    pack.files[pack.hosts.trust],
    /^> shared confidence \(※ \[\[Reading\/Inbox\/.*#\^reader-hh6\|/m,
  );
  assert.equal((pack.files[pack.hosts.ambiguous].match(/^## Highlights$/gm) ?? []).length, 2);
  assert.match(pack.files[pack.hosts.layout], /### Questions[\s\S]*## Journal/);
  const paths = new Set(Object.keys(pack.files).map((path) => path.replace(/\.md$/, '')));
  for (const text of Object.values(pack.files)) {
    for (const match of text.matchAll(/\[\[([^\]#|]+)(?:#[^\]|]+)?(?:\|[^\]]*)?\]\]/g))
      assert.ok(paths.has(match[1].replace(/\.md$/, '')), 'Missing fixture link: ' + match[1]);
  }
});

test('reset plan retires only the reviewed old note allowlist, including trial additions', () => {
  const existing = legacyResetPaths.map((path) => inventory(path));
  const before = JSON.stringify(existing);
  const plan = planHostedFixtureReset(existing, pack.files);
  assert.equal(
    plan.operations.filter((op) => op.action === 'retire').length,
    legacyResetPaths.length,
  );
  for (const path of [
    'Governance.md',
    'Untitled.md',
    `${createdRoot}/hello.md`,
    `${createdRoot}/test.md`,
  ])
    assert.equal(plan.operations.find((op) => op.path === path)?.action, 'retire');
  assert.equal(JSON.stringify(existing), before);
  assert.equal(
    plan.operations.filter((op) => op.action === 'create').length,
    Object.keys(pack.files).length,
  );
});

test('unknown notes, Welcome, Daily, settings, marker and companion definitions are preserved', () => {
  const paths = [
    'Welcome.md',
    'Daily/2026-10-16.md',
    '.obsidian/app.json',
    '.reader2-test-vault.json',
    `${classRoot}/topic.md`,
    `${createdRoot}/new-human-note.md`,
    'Reading/Inbox/Unexpected.md',
    'Untitled 2.md',
  ];
  const plan = planHostedFixtureReset(
    paths.map((path) => inventory(path)),
    pack.files,
  );
  for (const path of paths) assert.ok(plan.preserved.includes(path));
  assert.deepEqual(
    plan.unrecognized,
    [`${createdRoot}/new-human-note.md`, 'Reading/Inbox/Unexpected.md', 'Untitled 2.md'].sort(),
  );
  assert.ok(plan.operations.every((op) => op.path.endsWith('.md')));
});

test('existing class definitions are create-only or exactly preserved, never overwritten', () => {
  const path = `${classRoot}/concept.md`;
  assert.throws(
    () => planHostedFixtureReset([inventory(path)], pack.files),
    /class definition differs/,
  );
  const existing = Object.entries(pack.files).map(([path, content]) => inventory(path, content));
  const plan = planHostedFixtureReset(existing, pack.files);
  assert.deepEqual(plan.operations, []);
  assert.equal(plan.preserved.length, existing.length);
  assert.throws(
    () => planHostedFixtureReset([inventory('a.md'), inventory('a.md')], {}),
    /Duplicate/,
  );
});

test('fixture destination validation rejects traversal, settings and out-of-scope writes', () => {
  for (const path of [
    '/tmp/note.md',
    '../note.md',
    'a/../note.md',
    'a\\note.md',
    'a//note.md',
    'a\0.md',
  ])
    assert.throws(() => assertFixturePath(path), /Unsafe/);
  for (const path of [
    'Welcome.md',
    'Daily/new.md',
    '.obsidian/unsafe.md',
    `${classRoot}/topic.md`,
    'Personal.md',
    `${fixtureRoot}/metadata.json`,
  ])
    assert.throws(
      () => planHostedFixtureReset([], { [path]: 'do not write' }),
      /Protected or unapproved/,
    );
});

test('case and Unicode-normalization collisions block preparation before any retirement', () => {
  assert.throws(
    () => planHostedFixtureReset([inventory('note.md'), inventory('NOTE.md')], {}),
    /Duplicate/,
  );
  assert.throws(
    () => planHostedFixtureReset([inventory('Café.md'), inventory('Cafe\u0301.md')], {}),
    /Duplicate/,
  );
  const path = pack.hosts.trust;
  assert.throws(
    () => planHostedFixtureReset([inventory(path.toLowerCase())], pack.files),
    /case\/normalization collision/,
  );
  assert.throws(
    () => planHostedFixtureReset([], { [path]: 'one', [path.toLowerCase()]: 'two' }),
    /case\/normalization collision/,
  );
});

test('every mutation requires exact bytes, current file identity and single-link ownership', () => {
  const expected = inventory('Governance.md');
  assert.doesNotThrow(() => assertFixtureRevision(expected, structuredClone(expected)));
  assert.doesNotThrow(() => assertFixtureRevision(null, null));
  assert.throws(() => assertFixtureRevision(null, expected), /changed/);
  assert.throws(() => assertFixtureRevision(expected, null), /changed/);
  for (const key of ['path', 'sha256', 'bytes']) {
    const changed = structuredClone(expected);
    changed[key] = key === 'bytes' ? expected.bytes + 1 : 'different';
    assert.throws(() => assertFixtureRevision(expected, changed), /changed/);
  }
  for (const key of Object.keys(expected.identity)) {
    const changed = structuredClone(expected);
    changed.identity[key]++;
    assert.throws(() => assertFixtureRevision(expected, changed), /changed/);
  }
});

test('apply requires a fresh plan-bound quiescent E2E lease and a passed full check', () => {
  const now = Date.parse('2026-10-20T18:00:00Z');
  const digest = 'a'.repeat(64);
  const clearance = {
    owner: 'Wannes',
    ...e2eIdentity,
    operation: 'apply-hosted-highlights-fixtures',
    planSha256: digest,
    nativeInputPaused: false,
    quiescent: true,
    fullCheckPassed: true,
    authorizedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  assert.doesNotThrow(() => assertFixtureApplyClearance(clearance, digest, now));
  for (const patch of [
    { owner: 'someone else' },
    { vault: '/tmp/other-vault' },
    { vaultId: 'other' },
    { operation: 'reload-reader' },
    { planSha256: 'b'.repeat(64) },
    { nativeInputPaused: true },
    { quiescent: false },
    { fullCheckPassed: false },
    { authorizedAt: 'invalid' },
    { authorizedAt: new Date(now + 1).toISOString() },
    { expiresAt: new Date(now).toISOString() },
    { expiresAt: new Date(now + 16 * 60_000).toISOString() },
  ])
    assert.throws(
      () => assertFixtureApplyClearance({ ...clearance, ...patch }, digest, now),
      /Fresh E2E-only/,
    );
  assert.throws(() => assertFixtureApplyClearance(null, digest, now), /Fresh E2E-only/);
  assert.throws(
    () => assertFixtureApplyClearance(clearance, 'not-a-digest', now),
    /Fresh E2E-only/,
  );
  assert.throws(() => assertFixtureApplyClearance(clearance, digest, NaN), /Fresh E2E-only/);
});
