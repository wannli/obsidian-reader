import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { seedFiles, seedSidecarPath, seedBody, seedTitle, seedArticleId } from './seed.mjs';
import { fixture, snapshot } from './tooling-fixture.mjs';

function parsed(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  assert.ok(match);
  const doc = parseDocument(match[1], { uniqueKeys: true });
  assert.deepEqual(doc.errors, []); assert.deepEqual(doc.warnings, []);
  return { metadata: doc.toJS(), body: raw.slice(match[0].length) };
}
const day = '2026-10-09';
test('seed library emits YAML-backed inline Markdown without active sidecars', () => {
  const files = seedFiles(day);
  const notes = Object.entries(files).filter(([path]) => /^Reading\/.*\.md$/.test(path));
  assert.equal(notes.length, 5);
  assert.equal(Object.keys(files).filter(path => /^Reading\/(?:Metadata|Pullman Metadata)\//.test(path)).length, 0);
  for (const [path, raw] of notes) {
    const { metadata, body } = parsed(raw);
    assert.equal(Object.hasOwn(metadata, 'created-by'), false);
    for (const key of ['highlights', 'queueMove']) assert.equal(Object.hasOwn(metadata, key), false);
    assert.doesNotMatch(body, /^## (?:Comments|Highlights|Article)$/m);
    assert.doesNotMatch(raw, /<!--/);
    if (path.includes('/Wires/')) {
      assert.equal(metadata.type, 'feed'); assert.equal(metadata.id, 'feed-reader-synthetic-seed');
      assert.equal(metadata.pullmanFormat, 'inline-v1');
      assert.equal(metadata.enabled, false); assert.equal(metadata.prefix, 'Synthetic');
    } else {
      assert.equal(metadata.type, 'article'); assert.ok(body.trim());
      for (const key of ['id', 'guid', 'pullmanFormat', 'content', 'extractor', 'sourceHash', 'sourceLength'])
        assert.equal(Object.hasOwn(metadata, key), false, `${path}: ${key}`);
    }
  }
  const path = `Reading/Inbox/261009 ${seedTitle}.md`;
  assert.ok(files[path].endsWith(seedBody));
  assert.equal(parsed(files[path]).metadata.url, 'https://example.invalid/reader/quiet-library');
  assert.equal(parsed(files[path]).metadata['test-note'], 'Preserve this unknown property');
  assert.doesNotMatch(files['Welcome.md'], /^created-by:/m);
  assert.equal(Object.hasOwn(parsed(files[`Daily/${day}.md`]).metadata, 'created-by'), false);
  assert.equal(Object.hasOwn(JSON.parse(files['.obsidian/plugins/obsidian-reader/data.json']), 'logToDailyJournal'), false);
  assert.deepEqual(seedFiles(day), files);
});

for (const folder of ['Reading/Metadata', 'Reading/Pullman Metadata']) {
  for (const missing of ['sidecar', 'note']) {
    test(`repeated setup preserves a legacy ${folder} pair with missing ${missing}`, async t => {
      const f = await fixture(t);
      const first = f.run(); assert.equal(first.status, 0, first.output);
      const before = await snapshot(f.vault);
      const notePath = Object.keys(before).find(path => /^Reading\/Inbox\/.*\.md$/.test(path));
      assert.ok(notePath);
      const sidecarPath = seedSidecarPath(notePath).replace('Reading/Metadata', folder);
      await mkdir(dirname(join(f.vault, sidecarPath)), { recursive: true });
      await writeFile(join(f.vault, notePath), '---\ntype: article\ncustom: keep\n---\nAuthored legacy source; never reseed this note.\n');
      await writeFile(join(f.vault, sidecarPath), JSON.stringify({ schema: 1, path: notePath,
        metadata: { id: seedArticleId, content: 'ready', extractor: 'manual' } }));
      await rm(join(f.vault, missing === 'sidecar' ? sidecarPath : notePath));
      const protectedFiles = await snapshot(f.vault);
      const second = f.run(); assert.equal(second.status, 0, second.output);
      assert.deepEqual(await snapshot(f.vault), protectedFiles);
    });
  }
}
