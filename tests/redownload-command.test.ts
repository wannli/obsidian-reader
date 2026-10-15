import { afterEach, expect, it, vi } from 'vitest';
import { runtimeFixture } from './helpers/folder-runtime';
import { Plugin } from 'obsidian';
import { MemoryVault } from './helpers/memory-vault';
import { ArticleStore } from '../src/core/store';
import { createDocument, patchProperties } from '../src/core/document';
import { confirmArticleReplacement } from '../src/host/dialogs';

let plugin: any;
afterEach(() => {
  plugin?.onunload();
  plugin = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(confirmArticleReplacement).mockClear();
});
async function fixture(native = false) {
  const commands = vi.spyOn(Plugin.prototype, 'addCommand');
  const f = await runtimeFixture();
  plugin = f.plugin;
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const raw = createDocument(
    { type: 'article', url: 'https://example.com/article' },
    'Authored ==highlight==',
  );
  const file = await vault.create('Reading/Inbox/Article.md', raw);
  store.catalog.update(file.path, { type: 'article', url: 'https://example.com/article' });
  plugin.store = store;
  const redownload = vi.fn(async (_snapshot: unknown, _signal: AbortSignal) => {});
  plugin.ingestion.redownload = redownload;
  const view = native ? f.native.view : f.reader.view;
  view.file = file;
  view.getMode = () => 'preview';
  view.flush = vi.fn(async () => {});
  if (native) f.reader.view = view;
  const command = commands.mock.calls.find(([command]) => command.id === 'redownload-article')![0];
  const settle = async () => {
    for (let i = 0; i < 15; i++) await Promise.resolve();
  };
  return { ...f, vault, file, raw, store, redownload, command, settle };
}

it.each([false, true])(
  'offers contextual replacement in Reader/native Markdown (%s), with side-effect-free checking',
  async (native) => {
    const f = await fixture(native);
    expect(f.command.name).toBe('Run Defuddle again (replace article content)');
    expect(f.command.checkCallback!(true)).toBe(true);
    expect(confirmArticleReplacement).not.toHaveBeenCalled();
    f.command.checkCallback!(false);
    await f.settle();
    expect(confirmArticleReplacement).toHaveBeenCalledOnce();
    expect(f.redownload).not.toHaveBeenCalled();
    const [, path, confirmed, signal] = vi.mocked(confirmArticleReplacement).mock.calls[0]!;
    expect(path).toBe(f.file.path);
    expect(signal.aborted).toBe(false);
    await confirmed(new AbortController().signal);
    expect(f.redownload).toHaveBeenCalledOnce();
    expect(f.redownload.mock.calls[0]![0]).toMatchObject({ file: f.file, raw: f.raw });
  },
);

it.each(['bookmark', 'reading_position'])(
  'binds confirmation before the modal, not to a later %s revision',
  async (key) => {
    const f = await fixture();
    f.command.checkCallback!(false);
    await f.settle();
    await f.vault.process(f.file, (raw) => patchProperties(raw, { [key]: 'New position' }));
    const [, , confirmed] = vi.mocked(confirmArticleReplacement).mock.calls[0]!;
    await confirmed(new AbortController().signal);
    expect(f.redownload.mock.calls[0]![0]).toMatchObject({ raw: f.raw });
  },
);

it('does not open a warning after generation retirement and rejects stale modal confirmation', async () => {
  const f = await fixture();
  f.command.checkCallback!(false);
  await f.settle();
  const [, , confirmed, signal] = vi.mocked(confirmArticleReplacement).mock.calls[0]!;
  f.plugin.stopFolders();
  expect(signal.aborted).toBe(true);
  await expect(confirmed(new AbortController().signal)).rejects.toThrow('stopped');
  expect(f.redownload).not.toHaveBeenCalled();
});

it('excludes native source/live-preview even if the buffer looks clean', async () => {
  const f = await fixture(true);
  f.reader.view.getMode = () => 'source';
  expect(f.command.checkCallback!(true)).toBe(false);
  expect(confirmArticleReplacement).not.toHaveBeenCalled();
});

it('hides the command for ordinary notes and aborts before confirmation for dirty articles', async () => {
  const f = await fixture(true);
  f.store.catalog.remove(f.file.path);
  expect(f.command.checkCallback!(true)).toBe(false);
  f.store.catalog.update(f.file.path, { type: 'article', url: 'https://example.com/article' });
  f.vault.dirty.add(f.file);
  f.command.checkCallback!(false);
  await f.settle();
  expect(confirmArticleReplacement).not.toHaveBeenCalled();
  expect(f.redownload).not.toHaveBeenCalled();
});
