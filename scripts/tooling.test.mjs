import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { fixture, snapshot } from './tooling-fixture.mjs';
import { verifyVaultPage } from './cdp.mjs';
import { cdpPort, ownership, vaultPath } from './sandbox.mjs';
import { startRuntimeFixture } from './runtime-fixture.mjs';
import { isControlledURL, unsafeLiveArticles } from './runtime-scope.mjs';
import { assertInlineWrite, assertMarked, assertPositionWrite, expectPositionRestore, verifyPositionRestore, rememberReaderPositions, parseMarkdown, positionDelta, remapPositionEvidence, replacementBody } from './runtime-storage.mjs';
import { captureReaderFlush, expectedReadingPosition } from './runtime-position.mjs';
import { fixtureLinkSyntax } from './runtime-actions.mjs';

function succeeds(result) { assert.equal(result.status, 0, result.output); }
function refuses(result, reason) { assert.notEqual(result.status, 0, result.output); assert.match(result.output, reason); }

test('setup is create-only, preserves all existing bytes/mtimes, and seeds clean Markdown', async t => {
  const f = await fixture(t);
  succeeds(f.run());
  const welcome = join(f.vault, 'Welcome.md');
  await writeFile(welcome, (await readFile(welcome, 'utf8')) + '\nUnrelated user content.\n');
  const before = await snapshot(f.vault);
  await f.build('v2');
  succeeds(f.run());
  assert.deepEqual(await snapshot(f.vault), before);
  for (const [name, entry] of Object.entries(before).filter(([name]) => name.endsWith('.md'))) {
    const text = Buffer.from(entry.bytes, 'base64').toString();
    if (/^Reading\/(?:Inbox|Later|Stream|Treasury|Wires)\//.test(name)) {
      const { metadata, body } = parseMarkdown(text);
      assert.equal(Object.hasOwn(metadata, 'created-by'), false, name);
      if (name.startsWith('Reading/Wires/')) {
        assert.equal(metadata.type, 'feed', name);
        assert.equal(metadata.pullmanFormat, 'inline-v1', name); assert.ok(metadata.id, name);
      } else {
        assert.equal(metadata.type, 'article', name); assert.ok(body.trim(), name);
        for (const key of ['id', 'guid', 'pullmanFormat', 'content', 'extractor', 'sourceHash', 'sourceLength'])
          assert.equal(Object.hasOwn(metadata, key), false, `${name}: ${key}`);
      }
      for (const key of ['highlights', 'queueMove']) assert.equal(Object.hasOwn(metadata, key), false, name);
      assert.doesNotMatch(body, /^## (?:Highlights|Article|Comments)$/m, name);
    } else assert.doesNotMatch(text, /^created-by:/m, name);
    assert.ok(!text.includes('<!--'), name);
  }
  assert.deepEqual(JSON.parse(await readFile(join(f.vault, '.obsidian', 'community-plugins.json'))), ['obsidian-reader']);
});

test('explicit update backs up exactly three plugin files, changing nothing else', async t => {
  const f = await fixture(t);
  succeeds(f.run());
  const before = await snapshot(f.vault);
  const replacement = await f.build('v2');
  succeeds(f.run('setup-vault.mjs', ['--update-plugin']));
  const after = await snapshot(f.vault);
  const backups = join(f.root, '.sandbox', 'backups');
  const directories = await readdir(backups);
  assert.equal(directories.length, 1);
  const backup = join(backups, directories[0]);
  assert.deepEqual((await readdir(backup)).sort(), ['main.js', 'manifest.json', 'styles.css']);
  for (const name of Object.keys(before)) {
    const file = name.split('/').pop();
    if (name.startsWith('.obsidian/plugins/obsidian-reader/') && Object.hasOwn(replacement, file)) {
      assert.equal(Buffer.from(after[name].bytes, 'base64').toString(), replacement[file]);
      assert.equal((await readFile(join(backup, file))).toString('base64'), before[name].bytes);
    } else assert.deepEqual(after[name], before[name], name);
  }
});

test('unmarked nonempty vault is never adopted', async t => {
  const f = await fixture(t);
  await mkdir(f.vault, { recursive: true });
  await writeFile(join(f.vault, 'Personal.md'), 'do not touch');
  const before = await snapshot(f.vault);
  refuses(f.run(), /unmarked, nonempty vault/);
  assert.deepEqual(await snapshot(f.vault), before);
});

test('ownership marker is checked on repeated setup and update', async t => {
  const f = await fixture(t);
  succeeds(f.run());
  await writeFile(join(f.vault, '.reader2-test-vault.json'), '{"schemaVersion":1,"purpose":"not owned"}');
  const before = await snapshot(f.vault);
  refuses(f.run(), /ownership marker/);
  refuses(f.run('setup-vault.mjs', ['--update-plugin']), /ownership marker/);
  assert.deepEqual(await snapshot(f.vault), before);
});

test('symlinked sandbox or vault is rejected without touching its target', async t => {
  for (const location of ['.sandbox', '.sandbox/Reader2 Test Vault']) {
    const f = await fixture(t);
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'Personal.md'), 'unchanged');
    if (location.includes('/')) await mkdir(join(f.root, '.sandbox'));
    await symlink(outside, join(f.root, location), 'dir');
    refuses(f.run(), /symlink/);
    assert.deepEqual(await readdir(outside), ['Personal.md']);
    assert.equal(await readFile(join(outside, 'Personal.md'), 'utf8'), 'unchanged');
  }
});

test('symlinked plugin files and unrelated symlinks are rejected, not skipped', async t => {
  for (const location of ['.obsidian/plugins/obsidian-reader/main.js', 'Unrelated.md']) {
    const f = await fixture(t);
    succeeds(f.run());
    const target = join(f.vault, location), outside = join(f.root, 'outside.txt');
    await writeFile(outside, 'unchanged');
    await rm(target, { force: true });
    await symlink(outside, target);
    refuses(f.run(), /symlink/);
    refuses(f.run('setup-vault.mjs', ['--update-plugin']), /symlink/);
    assert.equal(await readFile(outside, 'utf8'), 'unchanged');
  }
});

test('bad distribution identity fails before vault mutation; arbitrary path arguments fail closed', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'dist', 'main.js'), 'tampered');
  refuses(f.run(), /does not match build-meta/);
  await assert.rejects(readdir(f.vault), { code: 'ENOENT' });
  refuses(f.run('setup-vault.mjs', ['--vault', '/personal']), /path is fixed/);
  refuses(f.run('setup-vault.mjs', ['--update-plugin', '/personal']), /path is fixed/);
});

test('browser bundle permits only obsidian external, carries identity, and rejects builtins', async t => {
  const f = await fixture(t);
  await f.enableBuild();
  await writeFile(join(f.root, 'src', 'type.ts'), 'export class Model {}\n');
  await writeFile(join(f.root, 'src', 'main.ts'), "import { Plugin } from 'obsidian'; import { Model } from './type'; export default class Reader extends Plugin { declare model: Model; }\n");
  succeeds(f.run('build.mjs'));
  const meta = JSON.parse(await readFile(join(f.root, 'dist', 'build-meta.json')));
  assert.deepEqual(meta.external, ['obsidian']);
  assert.equal(meta.platform, 'browser');
  assert.match(await readFile(join(f.root, 'dist', 'main.js'), 'utf8'), /__readerBuildId/);
  const before = await snapshot(join(f.root, 'dist'));
  for (const name of ['node:fs', 'fs/promises', 'electron', 'node:test']) {
    await writeFile(join(f.root, 'src', 'main.ts'), `import runtime from ${JSON.stringify(name)}; console.log(runtime);\n`);
    refuses(f.run('build.mjs'), /Node\/Electron import is forbidden/);
    assert.deepEqual(await snapshot(join(f.root, 'dist')), before);
  }
});

test('CDP guard checks exact absolute vault path before reading even the marker', async () => {
  assert.equal(cdpPort, 19224);
  for (const path of ['/different/Reader2 Test Vault', vaultPath + '-copy', undefined]) {
    let reads = 0;
    const page = { waitForFunction: async () => {}, evaluate: async () => { reads++; return path; } };
    await assert.rejects(verifyVaultPage(page), /REFUSING unexpected vault/);
    assert.equal(reads, 1, 'No further renderer access is permitted after a path mismatch');
  }
});

test('CDP guard additionally requires the matching repository ownership marker', async () => {
  for (const marker of [{ ...ownership, repository: '/different' }, ownership]) {
    let reads = 0;
    const page = { waitForFunction: async () => {}, evaluate: async () => ++reads === 1 ? vaultPath : marker };
    if (marker === ownership) await verifyVaultPage(page);
    else await assert.rejects(verifyVaultPage(page), /REFUSING invalid runtime ownership marker/);
    assert.equal(reads, 2);
  }
});

test('runtime helper modules resolve without opening an application or writing a vault', async () => {
  const names = (await readdir(new URL('.', import.meta.url))).filter(name => /^(runtime-|quickadd-).*\.mjs$/.test(name));
  for (const name of names) await import(new URL(name, import.meta.url));
});

test('controlled loopback fixture gates real responses and records status/retry/query requests', async () => {
  const fixture = await startRuntimeFixture({ gateArticle: true });
  try {
    const response = fetch(fixture.articleURL + '?safe=100%25');
    for (let i = 0; i < 100 && !fixture.evidence().pendingArticleResponses; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fixture.evidence().pendingArticleResponses, 1);
    assert.equal(fixture.evidence().requests[0].responseAt, undefined);
    fixture.releaseArticle();
    assert.ok((await (await response).text()).includes(fixture.quote));
    assert.ok(fixture.evidence().requests[0].responseAt);
    fixture.setArticleStatus(503);
    assert.equal((await fetch(fixture.articleURL)).status, 503);
    fixture.setArticleStatus(200);
    assert.equal((await fetch(fixture.articleURL)).status, 200);
    const feed = await fetch(fixture.feedURL), etag = feed.headers.get('etag');
    const rss = await feed.text();
    assert.ok(fixture.feedExcerpt.length > 0);
    assert.ok(rss.includes(`<description>${fixture.feedExcerpt}</description>`), 'The pipeline fixture must supply a nonempty RSS summary');
    assert.ok(!rss.includes(fixture.quote), 'The RSS summary must not contain the full-text quote');
    assert.equal((await fetch(fixture.feedURL, { headers: { 'If-None-Match': etag } })).status, 304);
    assert.equal(fixture.evidence().requests.length, 5);
  } finally { await fixture.stop(); }
});

test('live-mode safety refuses public unfinished/dummy notes but leaves protected/manual/full notes alone', () => {
  const base = { path: 'sample.md', url: 'https://example.com/article', extractor: 'dummy', content: 'ready', highlights: [] };
  assert.deepEqual(unsafeLiveArticles([base]), [base]);
  for (const extractor of ['pending', 'summary']) assert.equal(unsafeLiveArticles([{ ...base, extractor }]).length, 1);
  for (const extractor of ['manual', 'defuddle']) assert.equal(unsafeLiveArticles([{ ...base, extractor }]).length, 0);
  assert.equal(unsafeLiveArticles([{ ...base, content: 'protected' }, { ...base, highlights: [{ id: 'hl-fixture' }] }]).length, 0);
  assert.equal(isControlledURL('http://127.0.0.1:49155/reader-runtime/unique/article'), true);
  assert.equal(isControlledURL('http://127.0.0.1:19222/'), false);
  assert.equal(isControlledURL('http://127.0.0.1.evil.example/reader-runtime/unique/article'), false);
});


function inlineFixture(body, patch = {}) {
  const metadata = { type: 'article', id: 'article-pure-fixture', pullmanFormat: 'inline-v1',
    'created-by': 'ai', content: 'ready', extractor: 'manual', sourceHash: 'original-owner', sourceLength: body.length,
    reading_position: { paragraph: 'keep', offset: 2 }, custom: { keep: ['all', 'values'] }, ...patch };
  return '---\n' + Object.entries(metadata).map(([key, value]) => key + ': ' + JSON.stringify(value)).join('\n') + '\n---\n' + body;
}
function annotationResult(before, body, patch = {}) {
  const metadata = { ...parseMarkdown(before).metadata, content: 'protected', ...patch };
  delete metadata.retryAfter;
  return inlineFixture(body, metadata);
}
test('inline verifier checks the precise repeated-text occurrence, Unicode and CRLF without quote search', () => {
  const originalBody = '😀 Keep this.\r\n\r\nKeep this. Tail **stays**.\r\n', quote = 'Keep this';
  const start = originalBody.lastIndexOf(quote), body = originalBody.slice(0, start) + '==' + quote + '==' + originalBody.slice(start + quote.length);
  const before = inlineFixture(originalBody, { retryAfter: '2026-10-10T00:00:00Z' }), after = annotationResult(before, body);
  const highlight = { id: 'inline-v1-fixture:highlight:' + start, quote, source: { start, end: start + quote.length + 4 }, anchor: { version: 'inline-v1-fixture' } };
  const article = { body, highlights: [highlight] };
  assert.equal(assertMarked(before, after, article, quote), highlight);
  assert.throws(() => assertMarked(before, annotationResult(before, body.replace('Tail', 'Lost')), article, quote));
  assert.throws(() => assertMarked(before, after, { ...article, highlights: [{ ...highlight, source: { start: 0, end: 4 } }] }, quote));
  assert.throws(() => assertMarked(before, after, { ...article, highlights: [{ ...highlight, id: 'stale:highlight' }] }, quote));
});
test('inline verification preserves ownership/custom YAML and keeps protection after unmark/unlink', () => {
  const before = inlineFixture('Before ==words== after.\n', { content: 'protected' });
  const body = replacementBody(parseMarkdown(before).body, { start: 7, end: 16 }, '==words==', 'words');
  assertInlineWrite(before, annotationResult(before, body), body);
  for (const patch of [{ content: 'ready' }, { sourceHash: 'restamped' }, { sourceLength: body.length },
    { reading_position: null }, { custom: 'lost' }, { highlights: [] }, { queueMove: {} }, { pullmanFormat: 'old' }]) {
    assert.throws(() => assertInlineWrite(before, annotationResult(before, body, patch), body));
  }
  assert.throws(() => replacementBody('same same', { start: 1, end: 5 }, 'same', '==same=='));
  assert.throws(() => replacementBody('same', { start: -1, end: 4 }, 'same', '==same=='));
});
test('native fixture expectations distinguish bare wiki, aliased wiki and preserved Markdown link syntax', () => {
  assert.equal(fixtureLinkSyntax('selected words', 'selected words'), '[[selected words]]');
  assert.equal(fixtureLinkSyntax('selected words', 'Chosen note'), '[[Chosen note|selected words]]');
  const external = fixtureLinkSyntax('selected words', 'https://example.invalid/article');
  assert.equal(external, '[selected words](https://example.invalid/article)');
  assert.equal(fixtureLinkSyntax('selected words', 'Chosen-note', 'markdown'), '[selected words](Chosen-note)');
  const original = 'Prefix ' + external + ' suffix\r\n';
  assert.equal(replacementBody(original, { start: 7, end: 7 + external.length }, external, 'selected words'), 'Prefix selected words suffix\r\n');
  assert.throws(() => fixtureLinkSyntax('**formatted**', 'Target'), /plain-label/);
  assert.throws(() => fixtureLinkSyntax('words', 'https://example.invalid/?a=1&b=2'), /simple fixture URL/);
});

test('position evidence permits only the exact captured YAML map during inline edits', () => {
  const before = inlineFixture('Before words after.\r\n', { retryAfter: '2030-01-01T00:00:00Z' });
  const body = 'Before ==words== after.\r\n';
  const position = { offset: 7, exact: 'words after.', paragraph: 'Before words after.', paragraphOffset: 7 };
  const after = annotationResult(before, body, { reading_position: position });
  assertInlineWrite(before, after, body, position);
  assert.throws(() => assertInlineWrite(before, after, body), /unrelated YAML/);
  assert.throws(() => assertInlineWrite(before, after, body, { ...position, offset: 8 }));
  for (const patch of [{ content: 'ready' }, { sourceHash: 'restamped' }, { sourceLength: 1 },
    { custom: { keep: ['lost'] } }, { extractor: 'defuddle' }, { error: 'Hidden failure' },
    { highlights: [] }, { queueMove: {} }, { id: 'replacement' }, { pullmanFormat: 'old' }]) {
    assert.throws(() => assertInlineWrite(before, annotationResult(before, body, { reading_position: position, ...patch }), body, position));
  }
  assert.throws(() => assertInlineWrite(before, annotationResult(before, body.replace('words', 'lost'), { reading_position: position }), body, position));
});

test('position-only checks preserve body, protected state, custom YAML and all ownership fields', () => {
  const before = inlineFixture('==words== [label](https://example.invalid)\r\n', { content: 'protected', error: 'Keep diagnostic', retryAfter: '2030-01-01T00:00:00Z' });
  const position = { offset: 4, paragraphOffset: 4, paragraph: 'words label', exact: 's label', start: false };
  const note = parseMarkdown(before), after = inlineFixture(note.body, { ...note.metadata, reading_position: position });
  assertPositionWrite(before, after, position);
  assertPositionWrite(after, after); // No evidence still means byte-identical, not ignored YAML.
  assert.throws(() => assertPositionWrite(before, after), /explicit expected-position evidence/);
  for (const patch of [{ content: 'ready' }, { error: '' }, { retryAfter: '' }, { custom: {} },
    { sourceHash: 'restamped' }, { sourceLength: 0 }, { extractor: 'dummy' }, { id: 'different' }]) {
    assert.throws(() => assertPositionWrite(before, inlineFixture(note.body, { ...note.metadata, reading_position: position, ...patch }), position));
  }
  assert.throws(() => assertPositionWrite(before, inlineFixture(note.body + 'Lost boundary', { ...note.metadata, reading_position: position }), position));
  assert.throws(() => assertPositionWrite(before, inlineFixture(note.body, { ...note.metadata, reading_position: null }), position));
});

test('position-only default does not silently authorize native first-write identity allocation', () => {
  const before = '---\ntype: article\ncustom: keep\n---\nNative body\n';
  const after = '---\ntype: article\ncustom: keep\nid: article-new-native\npullmanFormat: inline-v1\nreading_position: {offset: 3}\n---\nNative body\n';
  assert.throws(() => assertPositionWrite(before, after, { offset: 3 }), /unrelated YAML/);
});

test('position evidence fails closed on malformed, oversized or unexpected state', () => {
  for (const value of [null, [], {}, { offset: -1 }, { offset: 0.5 }, { offset: NaN },
    { offset: 100_000_001 }, { offset: 0, exact: 'x'.repeat(65) }, { offset: 0, start: 1 },
    { offset: 0, paragraph: 'x'.repeat(257) }, { offset: 0, paragraphOffset: -1 },
    { offset: 0, unknown: true }, { offset: 0, paragraph: undefined }]) {
    assert.throws(() => expectedReadingPosition(value));
  }
  assert.deepEqual(expectedReadingPosition({ offset: 0, start: true }), { offset: 0, start: true });
});

test('position restore rejects a self-consistent wrong reopened anchor across epochs', async () => {
  const path = 'Reading/Inbox/restore-fixture.md', outgoing = { offset: 9 }, wrong = { offset: 0, start: true };
  let position = outgoing;
  const page = positionPage([{ getState: () => ({ file: path, readingPosition: position }), flushPosition: async () => {} }]);
  const before = inlineFixture('Same body\n', { reading_position: outgoing });
  const after = inlineFixture('Same body\n', { reading_position: wrong });
  await flushReaderPositions(page);
  const expected = expectPositionRestore(page, path, before);
  position = wrong;
  await assert.rejects(flushReaderPositions(page), /differs from outgoing anchor/);
  assert.throws(() => verifyPositionRestore(page, expected, after, [{ path, position: wrong }]), /differs from outgoing anchor/);
  // The original outgoing ledger must remain intact after the rejected new epoch.
  assert.throws(() => positionDelta(page, path, before, after), /differs from captured/);
  position = outgoing;
  const restored = await flushReaderPositions(page);
  assert.equal(verifyPositionRestore(page, expected, before, restored), before);
});

test('position restore rejects wrong UI even when reopened persistence is a no-op and YAML stays correct', async () => {
  const path = 'Reading/Inbox/restore-noop.md', outgoing = { offset: 19, exact: 'kept words' };
  let position = outgoing;
  const page = positionPage([{ getState: () => ({ file: path, readingPosition: position }), flushPosition: async () => {} }]);
  const before = inlineFixture('Same body\n', { reading_position: outgoing });
  await flushReaderPositions(page);
  const expected = expectPositionRestore(page, path, before);
  position = { offset: 0, start: true };
  await assert.rejects(flushReaderPositions(page), /differs from outgoing anchor/);
  assert.throws(() => verifyPositionRestore(page, expected, before, [{ path, position }]), /differs from outgoing anchor/);
  position = outgoing;
  const evidence = await flushReaderPositions(page);
  assert.throws(() => verifyPositionRestore(page, expected, before.replace('Same body', 'Lost body'), evidence), /Markdown\/position snapshot/);
  assert.throws(() => verifyPositionRestore(page, expected, inlineFixture('Same body\n', { reading_position: outgoing, custom: 'lost' }), evidence), /Markdown\/position snapshot/);
  assert.throws(() => verifyPositionRestore(page, expected, before, []), /expected article/);
  assert.equal(verifyPositionRestore(page, expected, before, evidence), before);
  assert.throws(() => verifyPositionRestore(page, expected, before, evidence), /restore expectation/);
  // Intentional later movement is a new epoch, only after the restore check passed.
  position = { offset: 25 }; await flushReaderPositions(page);
  const moved = inlineFixture('Same body\n', { reading_position: position });
  assertPositionWrite(before, moved, positionDelta(page, path, before, moved));
});

test('position restore permits an unchanged initial note without a persisted position field', async () => {
  const path = 'Reading/Inbox/restore-initial.md', position = { offset: 0, start: true };
  const page = positionPage([{ getState: () => ({ file: path, readingPosition: position }), flushPosition: async () => {} }]);
  const before = '---\ntype: article\ncustom: keep\n---\nInitial body\n';
  await flushReaderPositions(page);
  const expected = expectPositionRestore(page, path, before);
  assert.equal(verifyPositionRestore(page, expected, before, await flushReaderPositions(page)), before);
});

// Exercise the actual callback and evidence bookkeeping without the native wrapper's
// on-disk safety-hold check. No browser, CDP, real adapter, hold file or vault access.
async function flushReaderPositions(page) {
  const evidence = await page.evaluate(captureReaderFlush, vaultPath);
  rememberReaderPositions(page, evidence);
  return evidence;
}
function positionPage(readers, { errors = [], actualPath = vaultPath } = {}) {
  const life = { disconnected: false, cleared: false, deadline: undefined, observe: undefined };
  const context = {
    window: { app: { vault: { adapter: { getBasePath: () => actualPath } },
      workspace: { getLeavesOfType: () => readers.map(reader => ({ view: { getReader: () => reader } })) } } },
    document: { body: {}, querySelectorAll: () => errors.map(textContent => ({ textContent })) },
    MutationObserver: class {
      constructor(callback) { life.observe = callback; }
      observe() {}
      disconnect() { life.disconnected = true; }
    },
    setTimeout: callback => { life.deadline = callback; return 1; },
    clearTimeout: () => { life.cleared = true; },
  };
  return { life, evaluate: (callback, ...args) => runInNewContext('(' + callback.toString() + ')(...args)', { ...context, args }) };
}

test('position flush captures public state before drain and uses only independent exact evidence', async () => {
  const position = { offset: 9, exact: 'words', paragraph: 'some words', paragraphOffset: 9 };
  const calls = [], path = 'Reading/Inbox/position-fixture.md';
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), flushing = new Promise(resolve => { started = resolve; });
  const reader = { getState: () => { calls.push('state'); return { file: path, readingPosition: position }; },
    flushPosition: async () => { calls.push('flush'); started(); await gate; calls.push('retired-drained'); } };
  const page = positionPage([reader]), pending = flushReaderPositions(page);
  await flushing;
  assert.deepEqual(calls, ['state', 'flush']);
  const before = inlineFixture('some words\n'), after = inlineFixture('some words\n', { reading_position: position });
  assert.throws(() => positionDelta(page, path, before, after), /independently captured/);
  release(); await pending;
  assert.deepEqual(calls, ['state', 'flush', 'retired-drained', 'state']);
  assert.deepEqual(positionDelta(page, path, before, after), position);
  assertPositionWrite(before, after, positionDelta(page, path, before, after));
  assert.throws(() => positionDelta(page, path, before, inlineFixture('some words\n', { reading_position: { offset: 10 } })), /differs from captured/);
  assert.throws(() => positionDelta(page, 'Reading/Inbox/wrong-note.md', before, after), /independently captured/);
  assert.throws(() => positionDelta({}, path, before, after), /independently captured/);
  assert.equal(positionDelta(page, path, before, before), undefined);
  assert.throws(() => rememberReaderPositions(page, [{ path, position: { offset: 10 } }, { path: 'invalid.md', position: { offset: -1 } }]));
  assert.deepEqual(positionDelta(page, path, before, after), position, 'Malformed evidence must not partially replace verified evidence');
  const moved = 'Reading/Later/position-fixture.md';
  remapPositionEvidence(page, path, moved);
  assert.deepEqual(positionDelta(page, moved, before, after), position);
  assert.throws(() => positionDelta(page, path, before, after), /independently captured/);
  assert.equal(page.life.disconnected, true); assert.equal(page.life.cleared, true);
});

test('position flush refuses visible save errors, unstable state, ambiguous leaves and missing API', async () => {
  const state = { file: 'Reading/Inbox/position-fixture.md', readingPosition: { offset: 9 } };
  const reader = () => ({ getState: () => state, flushPosition: async () => {} });
  const errors = [], failed = positionPage([{ ...reader(), flushPosition: async () => { errors.push('Could not save reading position: generation changed'); } }], { errors });
  await assert.rejects(flushReaderPositions(failed), /reported failure.*generation changed/);
  assert.equal(failed.life.disconnected, true);
  let retired;
  retired = positionPage([{ ...reader(), flushPosition: async () => {
    retired.life.observe([{ addedNodes: [], removedNodes: [{ textContent: 'Could not save reading position: retired mount failed' }] }]);
  } }]);
  await assert.rejects(flushReaderPositions(retired), /reported failure.*retired mount failed/);
  const moving = positionPage([{ ...reader(), flushPosition: async () => { state.readingPosition.offset = 10; } }]);
  await assert.rejects(flushReaderPositions(moving), /navigated or scrolled/);
  const conflict = positionPage([reader(), { ...reader(), getState: () => ({ ...state, readingPosition: { offset: 11 } }) }]);
  await assert.rejects(flushReaderPositions(conflict), /Conflicting Reader positions/);
  await assert.rejects(flushReaderPositions(positionPage([{ getState: () => state }])), /Public ReaderApp.flushPosition API required/);
  await assert.rejects(flushReaderPositions(positionPage([reader()], { actualPath: '/wrong-vault' })), /Vault changed before position flush/);
});

test('position flush deadlines fail closed without manufacturing a timed stability baseline', async () => {
  const reader = { getState: () => ({ file: 'Reading/Inbox/position-fixture.md', readingPosition: { offset: 0 } }),
    flushPosition: () => new Promise(() => {}) };
  const page = positionPage([reader]), pending = flushReaderPositions(page);
  // Only fake microtask turns to reach the injected deadline: no real sleep or I/O.
  for (let i = 0; i < 10 && !page.life.deadline; i++) await Promise.resolve();
  assert.equal(typeof page.life.deadline, 'function'); page.life.deadline();
  await assert.rejects(pending, /flush timed out/);
  assert.equal(page.life.disconnected, true); assert.equal(page.life.cleared, true);
});
