import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const scripts = dirname(fileURLToPath(import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'reader-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  for (const file of ['reader-mcp.mjs', 'sandbox.mjs', 'safety-hold.mjs'])
    await cp(join(scripts, file), join(root, 'scripts', file));
  await symlink(join(scripts, '../node_modules'), join(root, 'node_modules'));
  const module = await import(pathToFileURL(join(root, 'scripts/reader-mcp.mjs')).href);
  await module.setup();
  return { ...module, root };
}

const capture = { url: 'https://example.com/reader-mcp/capture' };
const unavailable = { outcome: 'Unavailable' };

test('default disabled; selected public projection never includes adjacent private text', async (t) => {
  const f = await fixture(t);
  const disabled = await f.createSession();
  assert.deepEqual(await disabled.call('search_sources', { query: '' }), unavailable);
  assert.deepEqual(await disabled.call('capture_url', capture), unavailable);
  const session = await f.createSession({ read: true });
  const { matches } = await session.call('search_sources', { query: '' });
  assert.equal(matches.length, 2);
  const source = await session.call('get_source', { handle: matches[0].handle });
  assert.match(source.text, /shared growing space/);
  assert.match(source.returnLink, /^obsidian:\/\/open\?vault=Reader%20MCP%20Sandbox&file=/);
  assert.doesNotMatch(JSON.stringify({ matches, source }), /PRIVATE_MCP_CANARY|Private synthetic/);
  assert.deepEqual(await session.call('search_sources', { query: 'PRIVATE_MCP_CANARY' }), {
    matches: [],
  });
  assert.deepEqual(await session.call('capture_url', capture), unavailable);
});

test('argument bounds and forged permissions fail closed', async (t) => {
  const f = await fixture(t);
  const session = await f.createSession({ read: true, capture: true });
  for (const [name, args] of [
    ['search_sources', { query: 'x'.repeat(501) }],
    ['search_sources', { query: '', grant: true }],
    ['get_source', { handle: '../../private' }],
    ['capture_url', { ...capture, path: '/tmp/escape.md' }],
    ['capture_url', { url: 'https://user:password@example.com/reader-mcp/capture' }],
    ['capture_url', { url: 'http://127.0.0.1/private' }],
    ['capture_url', { url: capture.url + '?private=1' }],
    ['capture_url', { url: 'x'.repeat(2049) }],
    ['shell', { command: 'whoami' }],
  ])
    assert.deepEqual(await session.call(name, args), unavailable);
});

test('capture is URL-only, normalized, deduplicated, and does not expand read scope', async (t) => {
  const f = await fixture(t);
  const session = await f.createSession({ read: true, capture: true });
  const inbox = join(f.vault, 'Reading/Inbox');
  const before = await readdir(inbox);
  const originals = await Promise.all(before.map((name) => readFile(join(inbox, name), 'utf8')));
  assert.equal(
    (await session.call('capture_url', { url: capture.url + '#section' })).outcome,
    'Saved',
  );
  const added = (await readdir(inbox)).filter((name) => !before.includes(name));
  assert.equal(added.length, 1);
  assert.equal(
    await readFile(join(inbox, added[0]), 'utf8'),
    `---\ntype: article\nstatus: inbox\nurl: "${capture.url}"\n---\n`,
  );
  assert.deepEqual(await session.call('capture_url', capture), unavailable);
  assert.deepEqual(
    await Promise.all(before.map((name) => readFile(join(inbox, name), 'utf8'))),
    originals,
  );
  assert.equal((await session.call('search_sources', { query: '' })).matches.length, 2);
});

test('private duplicate outside Inbox produces the same unavailable result', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.vault, 'Private.md'),
    `---\ntype: article\nurl: '${capture.url}'\n---\nPRIVATE_MCP_CANARY`,
  );
  const session = await f.createSession({ capture: true });
  assert.deepEqual(await session.call('capture_url', capture), unavailable);
  assert.equal((await readdir(join(f.vault, 'Reading/Inbox'))).length, 2);
});

test('revocation and changed/replaced sources invalidate handles', async (t) => {
  const f = await fixture(t);
  const session = await f.createSession({ read: true, capture: true });
  const { matches } = await session.call('search_sources', { query: '' });
  const path = join(f.vault, 'Reading/Inbox/Synthetic gardens.md');
  const original = await readFile(path);
  await writeFile(path, 'PRIVATE_CHANGED_CANARY');
  assert.deepEqual(await session.call('get_source', { handle: matches[0].handle }), unavailable);
  await rm(path);
  await writeFile(path, original);
  assert.deepEqual(await session.call('get_source', { handle: matches[0].handle }), unavailable);
  session.disable();
  assert.deepEqual(await session.call('get_source', { handle: matches[1].handle }), unavailable);
  assert.deepEqual(await session.call('capture_url', capture), unavailable);
  const next = await f.createSession({ read: true });
  assert.deepEqual(await next.call('get_source', { handle: matches[1].handle }), unavailable);
});

test('ownership mismatch and symlinked destinations block access', async (t) => {
  const f = await fixture(t);
  const session = await f.createSession({ read: true, capture: true });
  await symlink(tmpdir(), join(f.vault, 'escape'));
  assert.deepEqual(await session.call('capture_url', capture), unavailable);
  await rm(join(f.vault, 'escape'));
  await writeFile(join(f.vault, '.reader-mcp-synthetic.json'), '{}');
  assert.deepEqual(await session.call('search_sources', { query: '' }), unavailable);
  await assert.rejects(f.createSession());
  await assert.rejects(f.setup());
});

test('stdio initialize/list/call, generic errors and no unsolicited stdout', async (t) => {
  const f = await fixture(t);
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'search_sources', arguments: { query: '' } },
    },
    { jsonrpc: '2.0', id: 4, method: 'private-canary' },
  ];
  const result = spawnSync(
    process.execPath,
    [join(f.root, 'scripts/reader-mcp.mjs'), 'serve', '--enable-read'],
    { input: messages.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 3000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const replies = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(replies.length, 4);
  assert.equal(replies[0].result.protocolVersion, '2024-11-05');
  assert.deepEqual(
    replies[1].result.tools.map((tool) => tool.name),
    ['search_sources', 'get_source', 'capture_url'],
  );
  assert.equal(JSON.parse(replies[2].result.content[0].text).matches.length, 2);
  assert.equal(replies[3].error.code, -32601);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_MCP_CANARY|private-canary/);
});

test('queued cancellation prevents capture, oversized input shuts down safely', async (t) => {
  const f = await fixture(t);
  const run = (input) =>
    spawnSync(
      process.execPath,
      [join(f.root, 'scripts/reader-mcp.mjs'), 'serve', '--enable-capture'],
      { input, encoding: 'utf8', timeout: 3000 },
    );
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'capture_url', arguments: capture },
    },
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } },
  ];
  const result = run(messages.map(JSON.stringify).join('\n') + '\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim().split('\n')[1]).error.code, -32800);
  assert.equal((await readdir(join(f.vault, 'Reading/Inbox'))).length, 2);
  const oversized = run('x'.repeat(70_000));
  assert.equal(oversized.status, 1);
  assert.doesNotMatch(oversized.stderr, /x{20}/);
});

test('sync wrapper validates ownership and pins Headless to the synthetic vault', async (t) => {
  const f = await fixture(t);
  const bin = join(f.root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'ob'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
  const run = () =>
    spawnSync(process.execPath, [join(f.root, 'scripts/reader-mcp.mjs'), 'sync'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
      timeout: 3000,
    });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), ['sync', '--path', f.vault]);
  await writeFile(join(f.vault, '.reader-mcp-synthetic.json'), '{}');
  const invalid = run();
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
});
