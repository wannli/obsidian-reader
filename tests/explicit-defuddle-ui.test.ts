import { afterEach, expect, it, vi } from 'vitest';
import { ReaderApp } from '../src/ui/app';
import { readerCommands } from '../src/ui/commands';
import { ReaderController } from '../src/controller';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS, type HttpGet } from '../src/types';
import * as ingestion from '../src/ingest/extract';

vi.mock('../src/ui/reader', () => ({ mountReader: (pane: HTMLElement) => {
  const view = document.createElement('div'); view.className = 'r2-reader'; pane.replaceChildren(view); return () => view.remove();
} }));
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });
for (const nativeRename of [false, true]) it('follows successful Defuddle to the Inbox path/queue; native rename=' + nativeRename, async () => {
  vi.spyOn(ingestion, 'extractArticle').mockResolvedValue({ title: 'Live', markdown: 'Real text.', status: 'ready', extractor: 'defuddle' });
  const settings = { ...DEFAULT_SETTINGS }, repo = new ReaderRepository(new MemoryStore(), settings);
  const controller = new ReaderController(repo, vi.fn<HttpGet>(), settings);
  const selected = await repo.createArticle({ title: 'Selected', url: 'https://example.com/selected', status: 'feed', body: '' });
  const root = document.createElement('div'); document.body.append(root);
  const reader = new ReaderApp(root, controller, { openNote: async () => {}, autoOpen: false } as never);
  try {
    await reader.open(selected.path);
    if (nativeRename) {
      const move = repo.setStatus.bind(repo);
      vi.spyOn(repo, 'setStatus').mockImplementation(async (path, status) => {
        const saved = await move(path, status); reader.remapPath(path, saved.path); return saved;
      });
    }
    const notice = vi.fn(() => () => {});
    const command = readerCommands(controller, { active: () => reader, notice } as never).find(command => command.id === 'fetch-full-text')!;
    await command.run(reader);
    await vi.waitFor(() => {
      expect(reader.getState().file).toMatch(/^Reading\/Inbox\//); expect(reader.getState().queue).toBe('inbox');
      expect(reader.getArticle()?.body).toBe('Real text.');
    });
    expect(notice).toHaveBeenLastCalledWith('Full text fetched with Defuddle.');
  } finally { reader.destroy(); await controller.shutdown(); }
});
