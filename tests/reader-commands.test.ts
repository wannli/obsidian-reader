import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { readerCommands } from '../src/ui/commands';
import { queueLabel } from '../src/reading-layout';
import { StaleArticleWriteError } from '../src/storage/preconditions';
it('registers no custom capture protocol while retaining the native Add URL command', async () => {
  const source = ts.createSourceFile('main.ts', readFileSync('src/main.ts', 'utf8'), ts.ScriptTarget.Latest, true), handlers: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => { if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'registerObsidianProtocolHandler') handlers.push(node); ts.forEachChild(node, visit); };
  visit(source); expect(handlers).toEqual([]);
  const addUrl = vi.fn(), command = readerCommands({} as never, { addUrl } as never).find(command => command.id === 'capture-url')!;
  expect(command.name).toBe('Add URL'); expect(command.available()).toBe(true); await command.run(); expect(addUrl).toHaveBeenCalledTimes(1);
});
it('uses Treasury and Stream labels without changing persisted command/status IDs', async () => {
  const move = vi.fn(), reader = { getArticle: () => ({ status: 'feed' }), move }, commands = readerCommands({} as never, {} as never);
  const treasury = commands.find(command => command.id === 'move-to-archive')!;
  expect(queueLabel('feed')).toBe('Stream'); expect(queueLabel('archive')).toBe('Treasury');
  expect(treasury.name).toBe('Move to Treasury'); expect(treasury.available(reader as never)).toBe(true);
  await treasury.run(reader as never); expect(move).toHaveBeenCalledWith('archive');
  expect(commands.find(command => command.id === 'move-to-inbox')?.name).toBe('Move to Inbox');
  expect(commands.find(command => command.id === 'move-to-later')?.name).toBe('Move to Later');
});
for (const stayCurrent of [true, false]) it('successful fetch remaps the saved path without taking over another selection: ' + stayCurrent, async () => {
  let resolve!: (article: unknown) => void, path = 'Reading/Stream/Selected.md';
  const original = path, saved = { path: 'Reading/Inbox/Selected.md', content: 'ready' };
  const controller = { fetchFullText: vi.fn(() => new Promise(done => resolve = done)) };
  const reader = { getArticle: () => ({ path }), getState: () => ({ file: path }), remapPath: vi.fn((from, to) => { if (path === from) path = to; }) };
  const hide = vi.fn(), notice = vi.fn(() => hide), host = { active: () => reader, notice };
  const command = readerCommands(controller as never, host as never).find(command => command.id === 'fetch-full-text')!;
  const pending = command.run(reader as never); if (!stayCurrent) path = 'Reading/Stream/Other.md'; resolve(saved); await pending;
  expect(reader.remapPath).toHaveBeenCalledWith(original, saved.path);
  expect(path).toBe(stayCurrent ? saved.path : 'Reading/Stream/Other.md');
  expect(notice).toHaveBeenCalledTimes(stayCurrent ? 2 : 1); expect(hide).toHaveBeenCalledTimes(1);
});
for (const stayCurrent of [true, false]) it('stale manual fetch notification respects selected leaf/path: ' + stayCurrent, async () => {
  let reject!: (error: Error) => void, path = 'Reading/Articles/Original.md';
  const controller = { fetchFullText: vi.fn(() => new Promise((_resolve, fail) => reject = fail)) }, reader = { getArticle: () => ({ path }), getState: () => ({ file: path }) };
  const hide = vi.fn(), notice = vi.fn(() => hide), host = { active: () => reader, notice };
  const command = readerCommands(controller as never, host as never).find(command => command.id === 'fetch-full-text')!;
  const pending = command.run(reader as never); if (!stayCurrent) path = 'Reading/Articles/Other.md'; reject(new StaleArticleWriteError()); await pending;
  expect(hide).toHaveBeenCalledTimes(1); expect(notice).toHaveBeenCalledTimes(stayCurrent ? 2 : 1);
  if (stayCurrent) expect(notice).toHaveBeenLastCalledWith('Article changed; no changes saved.');
});
