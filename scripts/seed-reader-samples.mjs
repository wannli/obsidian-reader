// Create-only sample notes through the existing isolated Obsidian Vault API.
// No navigation, settings changes, article/feed HTTP, or extraction calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { connectToTestVault, assertRuntimeVault } from './cdp.mjs';
import { assertOwnedVault, localDay, runtimeTarget, vaultPath } from './sandbox.mjs';

const target = vaultPath;
const queueFolders = { inbox: 'Reading/Inbox', later: 'Reading/Later', feed: 'Reading/Stream', archive: 'Reading/Treasury' };
const addedDay = localDay().replaceAll('-', '').slice(2);
const hash = text => createHash('sha256').update(text).digest('hex');
const normalize = value => { try { const url = new URL(value); url.hash = ''; return url.href; } catch { return undefined; } };
const metadata = text => { const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text); return match ? parse(match[1]) ?? {} : {}; };
const feeds = [
  { type: 'feed', title: 'WIRED — AI', prefix: 'Wired', url: 'https://www.wired.com/feed/tag/ai/latest/rss', enabled: false },
  { type: 'feed', title: 'Simon Willison — Everything', prefix: 'Simon', url: 'https://simonwillison.net/atom/everything/', enabled: false },
];
const articles = [
  ['Summary of Kierkegaard’s Either/Or', 'https://philonotes.com/2023/04/summary-of-kierkegaards-either-or', 'inbox', 'A fictional reader weighs two possible ways to spend an afternoon: following a sudden curiosity or keeping a promise to a friend. The exercise invites careful attention to choices without claiming to summarize a philosopher’s argument.'],
  ['The Serviceberry', 'https://emergencemagazine.org/essay/the-serviceberry/', 'inbox', 'In this invented scene, neighbors gather beside a small garden and decide how to share a basket of fruit. One offers time, another brings a bowl, and a third proposes saving a portion for someone who cannot attend.'],
  ['David Whyte on Being at the Frontier of Your Identity', 'https://www.dailygood.org/story/699/david-whyte-on-being-at-the-frontier-of-your-identity-tami-simon/', 'inbox', 'A fictional traveler reaches an unfamiliar intersection and pauses before choosing a road. Naming what feels uncertain makes the next small step easier to consider, even though the destination remains unknown.'],
  ['Rain and the Rhinoceros — Thomas Merton', 'https://thevalueofsparrows.wordpress.com/2014/07/12/saturday-reading-rain-and-the-rhinoceros-by-thomas-merton/', 'later', 'An invented observer listens to rain against a window while a quiet room slowly darkens. Ordinary sounds become noticeable when the observer sets aside a task and attends to the changing rhythm.'],
  ['Dummy AI Reading Table', 'https://example.test/reader/dummy-ai-reading-table', 'feed', 'At an imaginary reading table, volunteers compare two toy sorting rules using colored cards. They record where the rules disagree and leave room for a human explanation beside each result.', 0],
  ['Dummy Tool Notebook', 'https://example.test/reader/dummy-tool-notebook', 'feed', 'A fictional maker keeps a notebook of small experiments with an imaginary text tool. Each entry separates an observation from a guess so another reader can understand what remains untested.', 1],
].map(([title, url, status, paragraph, feedIndex]) => ({ type: 'article', title, url, status, paragraph, feedIndex }));

if (process.argv.length !== 2) throw new Error('No arguments accepted; vault and CDP endpoint are fixed');
assert.equal(runtimeTarget, 'acceptance', 'Sample seeding is restricted to the confirmed Acceptance target');
assert.equal(vaultPath, target); await assertOwnedVault();
const { browser, page, verifiedVault } = await connectToTestVault();
try {
  assert.equal(verifiedVault, target);
  const runtime = await page.evaluate(() => {
    const p = window.app.plugins.plugins['obsidian-reader'];
    return { buildId: p?.constructor.__readerBuildId, version: p?.manifest.version,
      dummy: p?.settings.useDummyContent, repository: typeof p?.controller.repository.getArticle === 'function' };
  });
  assert.equal(runtime.dummy, true, 'Refusing to seed when runtime dummy mode is not enabled');
  assert.equal(runtime.repository, true);
  const snapshot = async () => {
    await assertRuntimeVault(page);
    return page.evaluate(async expected => {
      if (window.app.vault.adapter.getBasePath() !== expected) throw new Error('Wrong vault');
      return Object.fromEntries(await Promise.all(window.app.vault.getMarkdownFiles().map(async f => [f.path, await window.app.vault.read(f)])));
    }, target);
  };
  const before = await snapshot();
  const known = Object.entries(before).map(([path, text]) => ({ path, ...metadata(text) }));
  const created = [], skipped = [], expectedTexts = new Map(), feedPaths = [], feedPrefixes = [];
  for (const item of [...feeds, ...articles]) {
    const existing = known.find(note => ['article', 'feed'].includes(note.type) && typeof note.url === 'string' && normalize(note.url) === normalize(item.url));
    if (existing) {
      assert.equal(existing.type, item.type, 'Existing URL has a different Reader type; refusing');
      skipped.push({ path: existing.path, title: existing.title, status: existing.status, enabled: existing.enabled, url: existing.url });
      if (item.type === 'feed') { feedPaths.push(existing.path); feedPrefixes.push(typeof existing.prefix === 'string' ? existing.prefix.trim() : ''); }
      continue;
    }
    const folder = item.type === 'feed' ? 'Reading/Wires' : queueFolders[item.status];
    const prefix = item.feedIndex === undefined ? '' : feedPrefixes[item.feedIndex];
    // Fictional RSS samples have no publication date: use added day without inventing published.
    const filename = item.type === 'feed' ? item.title : `${addedDay} ${prefix ? prefix + ' - ' : ''}${item.title}`;
    const name = filename.replace(/[\\/:*?"<>|]/g, ' ');
    let path = `${folder}/${name}.md`, suffix = 2;
    while (await page.evaluate(path => !!window.app.vault.getAbstractFileByPath(path), path)) path = `${folder}/${name} ${suffix++}.md`;
    const properties = item.type === 'feed'
      ? { pullmanFormat: 'inline-v1', type: item.type, id: `${item.type}-sample-${hash(item.url).slice(0, 16)}`, url: item.url }
      : { type: item.type, url: item.url };
    let body;
    if (item.type === 'feed') {
      Object.assign(properties, { title: item.title, prefix: item.prefix, enabled: false });
      body = `# ${item.title}\n\nDUMMY testing feed note. This subscription starts PAUSED (enabled: false). No feed was fetched; linked Dummy entries are fictional test content, not publisher articles.\n`;
    } else {
      const sample = `DUMMY testing content — fictional sample, not the original article, a summary, or a quotation from its author. No publisher text was fetched.\n\n${item.paragraph}\n\nThis paragraph is also synthetic. Select a sentence or extend a selection across this paragraph to try the reading interface. No highlights or personal annotations have been pre-created.`;
      body = '# ' + item.title + '\n\n' + sample + '\n';
      if (item.feedIndex !== undefined) properties.feed = '[[' + feedPaths[item.feedIndex].replace(/\.md$/, '') + ']]';
    }
    const text = '---\n' + stringify(properties, { lineWidth: 0 }) + '---\n' + body;
    await assertRuntimeVault(page);
    await page.evaluate(async ({ expected, folder, path, text }) => {
      const vault = window.app.vault;
      if (vault.adapter.getBasePath() !== expected) throw new Error('Wrong vault');
      const parts = folder.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        if (!vault.getAbstractFileByPath(dir)) await vault.createFolder(dir);
      }
      if (vault.getAbstractFileByPath(path)) throw new Error('Concurrent path collision; refusing overwrite');
      await vault.create(path, text);
    }, { expected: target, folder, path, text });
    known.push({ path, ...properties }); expectedTexts.set(path, text);
    created.push({ path, title: item.title, status: item.status, enabled: properties.enabled, url: item.url, type: item.type });
    if (item.type === 'feed') { feedPaths.push(path); feedPrefixes.push(item.prefix); }
  }
  await new Promise(resolve => setTimeout(resolve, 1200));
  const after = await snapshot();
  for (const [path, text] of Object.entries(before)) assert.equal(after[path], text, `Existing note changed: ${path}`);
  for (const item of created) {
    const text = after[item.path], fm = metadata(text);
    assert.equal(text, expectedTexts.get(item.path));
    assert.equal(fm.type, item.type); assert.equal(fm.url, item.url); assert.equal(Object.hasOwn(fm, 'created-by'), false);
    assert.equal(Object.hasOwn(fm, 'highlights'), false);
    assert.doesNotMatch(text, /^## (?:Highlights|Article|Comments)$/m);
    assert.ok(text.includes('DUMMY')); assert.ok(!text.includes('<!--'));
    if (item.type === 'feed') {
      assert.equal(fm.enabled, false); assert.ok(fm.id); assert.equal(fm.pullmanFormat, 'inline-v1');
    } else {
      for (const key of ['id', 'guid', 'pullmanFormat', 'content', 'extractor', 'sourceHash', 'sourceLength'])
        assert.equal(Object.hasOwn(fm, key), false, `${item.path}: ${key}`);
      assert.equal(Object.hasOwn(fm, 'status'), false);
      assert.equal(Object.hasOwn(fm, 'published'), false);
      assert.ok(item.path.startsWith(queueFolders[item.status] + '/' + addedDay + ' '));
      assert.match(text, /DUMMY testing content/);
    }
  }
  await assertRuntimeVault(page);
  const records = await page.evaluate(async ({ expected, created }) => {
    if (window.app.vault.adapter.getBasePath() !== expected) throw new Error('Wrong vault');
    const repo = window.app.plugins.plugins['obsidian-reader'].controller.repository;
    const feeds = await repo.listFeeds();
    return Promise.all(created.map(item => item.type === 'feed' ? feeds.find(f => f.path === item.path) : repo.getArticle(item.path)));
  }, { expected: target, created });
  for (const [index, record] of records.entries()) {
    const item = created[index]; assert.equal(record.url, item.url);
    if (item.type === 'feed') assert.equal(record.enabled, false);
    else { assert.equal(record.status, item.status); assert.ok(record.body.includes('DUMMY')); assert.equal(record.highlights.length, 0); }
  }
  const queues = Object.fromEntries(['inbox', 'later', 'feed', 'archive'].map(status => [status, created.filter(item => item.status === status).length]));
  console.log(JSON.stringify({ vault: target, runtime, created, skipped, queuesCreatedOnly: queues, existingNotesBytePreserved: Object.keys(before).length, blockedURLs: [], articleOrFeedHTTPInvoked: false, settingsChanged: false }, null, 2));
} finally { await browser.close(); }
