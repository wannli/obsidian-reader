import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { ReaderController } from '../src/controller';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS, type HttpGet } from '../src/types';
import { streamCutoff } from '../src/stream-age';

const now = new Date('2026-03-31T12:34:56.789Z');
const old = 'Reading/Stream/Old.md';
const note = (date = '2026-02-28T12:34:56.788Z', body = '') => `---\ntype: article\nurl: https://example.test/old\npublished: ${date}\n---\n${body}`;
function setup(initial: Record<string, string> = { [old]: note() }) {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const store = new MemoryStore(initial), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  const get = vi.fn<HttpGet>().mockRejectedValue(new Error('Unexpected HTTP'));
  const eligibility = vi.fn(async () => {});
  const controller = new ReaderController(repo, get, DEFAULT_SETTINGS, eligibility);
  return { store, repo, get, controller, eligibility };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('uses the automatic calendar cutoff, reports counts and starts no network/scheduler work', async () => {
  const f = setup({ [old]: note(), 'Reading/Stream/Boundary.md': note('2026-02-28T12:34:56.789Z'), 'Reading/Stream/Protected.md': note(undefined, 'Authored'), 'Reading/Inbox/Saved.md': note() });
  await f.repo.createFeed('Enabled', 'https://example.test/rss');
  const prune = vi.spyOn(f.repo, 'cleanupStream'), schedule = vi.spyOn(f.controller, 'scheduleAcquisition');
  const changed = vi.fn(); f.controller.subscribe(changed);
  const report = await f.controller.cleanupStream();
  expect(prune).toHaveBeenCalledWith(streamCutoff(now), expect.any(Function));
  expect(report).toContain('deleted 1; retained 1'); expect(report).toContain('review them manually');
  expect(f.controller.message).toBe(report); expect(changed).toHaveBeenCalled(); expect(f.eligibility).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(schedule).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  expect(await f.store.exists(old)).toBe(false);
  expect(await f.store.exists('Reading/Stream/Boundary.md')).toBe(true);
  expect(await f.store.exists('Reading/Inbox/Saved.md')).toBe(true);
  await f.controller.shutdown();
});
it('reports expired annotated notes promoted to Inbox rather than silently moving them', async () => {
  const f = setup({ [old]: note(undefined, '==Annotated==') });
  const cleanup = vi.spyOn(f.repo, 'cleanupStream');
  expect(await f.controller.cleanupStream()).toBe('Stream cleanup: deleted 0; retained 0; promoted 1 to Inbox.');
  const result = await cleanup.mock.results[0].value;
  expect(result.promoted).toHaveLength(1);
  expect(result.promoted[0]).toMatch(/^Reading\/Inbox\//);
  expect(await f.store.read(result.promoted[0])).toContain('==Annotated==');
  expect(await f.store.exists(old)).toBe(false);
  expect(f.get).not.toHaveBeenCalled();
  await f.controller.shutdown();
});
it('reports an empty cleanup and propagates fatal failures for the command notice', async () => {
  const f = setup({});
  expect(await f.controller.cleanupStream()).toBe('Stream cleanup: deleted 0; retained 0; promoted 0 to Inbox.');
  vi.spyOn(f.repo, 'cleanupStream').mockRejectedValueOnce(new Error('Cannot enumerate notes'));
  await expect(f.controller.cleanupStream()).rejects.toThrow('Cannot enumerate notes');
  await f.controller.shutdown();
  await expect(f.controller.cleanupStream()).rejects.toThrow('Reader is closing');
});
it('keeps references and failed removals, while continuing other deletions', async () => {
  const f = setup({ [old]: note(), 'Reading/Stream/Referenced.md': note(), 'Reading/Stream/Other.md': note(), 'Journal.md': '[[Referenced]]' });
  vi.spyOn(f.store, 'trash').mockRejectedValueOnce(new Error('Trash unavailable'));
  expect(await f.controller.cleanupStream()).toContain('deleted 1; retained 2');
  expect(await f.store.exists('Reading/Stream/Referenced.md')).toBe(true);
  await f.controller.shutdown();
});
it.each([false, true])('protects pending extraction (manual=%s) and shutdown waits for cleanup', async manual => {
  const f = setup(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.eligibility.mockImplementationOnce(() => gate);
  const extraction = manual ? f.controller.fetchFullText(old) : f.controller.acquire(old);
  const report = await f.controller.cleanupStream();
  expect(report).toContain('deleted 0; retained 1'); expect(await f.store.exists(old)).toBe(true);
  const stopped = f.controller.shutdown(); release(); await stopped; await extraction.catch(() => {});
  expect(f.get).not.toHaveBeenCalled();
});
it('tracks cleanup for shutdown', async () => {
  const f = setup(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const trash = f.store.trash.bind(f.store);
  vi.spyOn(f.store, 'trash').mockImplementation(async (path, options) => { await gate; await trash(path, options); });
  const pending = f.controller.cleanupStream();
  await vi.waitFor(() => expect(f.store.trash).toHaveBeenCalled());
  const shutdownDone = vi.fn(); const shutdown = f.controller.shutdown().then(shutdownDone);
  await Promise.resolve(); expect(shutdownDone).not.toHaveBeenCalled();
  release(); await pending; await shutdown; expect(shutdownDone).toHaveBeenCalled();
});
it('registers the native Clean up Stream command and notices success and errors', async () => {
  const text = readFileSync('src/main.ts', 'utf8');
  const source = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true);
  let registration: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'addCommand') {
      const arg = node.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg) && arg.getText(source).includes("'clean-up-stream'")) registration = arg;
    }
    ts.forEachChild(node, visit);
  };
  visit(source); expect(registration).toBeDefined();
  const cleanupStream = vi.fn().mockResolvedValue('Stream cleanup: deleted 2; retained 1.');
  const notices: string[] = [];
  const make = new Function('Notice', `return (${registration!.getText(source)});`);
  const command = make.call({ controller: { cleanupStream } }, class { constructor(message: string) { notices.push(message); } });
  expect(command.name).toBe('Clean up Stream'); command.callback();
  await vi.waitFor(() => expect(notices).toEqual(['Stream cleanup: deleted 2; retained 1.']));
  cleanupStream.mockRejectedValueOnce(new Error('Cleanup unavailable')); command.callback();
  await vi.waitFor(() => expect(notices.at(-1)).toBe('Error: Cleanup unavailable'));
  expect(cleanupStream).toHaveBeenCalledTimes(2);
});
