import type { ReaderController } from '../controller';
import type { ArticleStatus } from '../types';
import { queueLabel } from '../reading-layout';
import type { ReaderApp } from './app';
import { StaleArticleWriteError } from '../storage/preconditions';
export interface ReaderCommand { id: string; name: string; icon: string; available(reader?: ReaderApp): boolean; run(reader?: ReaderApp): void | Promise<void>; }
export interface CommandHost {
  active(): ReaderApp | undefined;
  ensure(): Promise<ReaderApp>;
  addUrl(): void;
  feeds(): void;
  topics(reader: ReaderApp): void;
  authors?(reader: ReaderApp): void;
  queue(reader: ReaderApp): void;
  external(url: string): void;
  notice(message: string): () => void;
}
/** One action catalog for native commands, pane menus and the preview harness. */
export function readerCommands(controller: ReaderController, host: CommandHost): ReaderCommand[] {
  const article = (reader?: ReaderApp) => !!reader?.getArticle();
  const commands: ReaderCommand[] = [
    { id: 'open-reader', name: 'Open Reader', icon: 'book-open', available: () => true, run: async () => { await host.ensure(); } },
    { id: 'reading-list', name: 'Reading list', icon: 'list', available: () => true, run: async reader => { await (reader ?? await host.ensure()).openLibrary(); } },
    { id: 'switch-queue', name: 'Switch queue', icon: 'list-filter', available: () => true, run: async reader => host.queue(reader ?? await host.ensure()) },
    { id: 'previous', name: 'Previous', icon: 'arrow-left', available: reader => reader?.canNavigate(-1) ?? false, run: reader => reader?.navigate(-1) },
    { id: 'next', name: 'Next', icon: 'arrow-right', available: reader => reader?.canNavigate(1) ?? false, run: reader => reader?.navigate(1) },
    { id: 'open-markdown', name: 'Open Markdown', icon: 'file-pen-line', available: reader => reader?.canOpenMarkdown() ?? false, run: reader => reader?.openMarkdown() },
    { id: 'original', name: 'Original', icon: 'external-link', available: reader => /^https?:\/\//i.test(reader?.getArticle()?.url ?? ''), run: reader => { const url = reader?.getArticle()?.url; if (url) host.external(url); } },
    { id: 'assign-topics', name: 'Assign topics', icon: 'tags', available: article, run: reader => { if (reader) host.topics(reader); } },
    { id: 'assign-authors', name: 'Assign authors', icon: 'users', available: reader => article(reader) && !!host.authors, run: reader => { if (reader) host.authors?.(reader); } },
    { id: 'capture-url', name: 'Add URL', icon: 'plus', available: () => true, run: () => host.addUrl() },
    { id: 'rss-feeds', name: 'RSS feeds', icon: 'rss', available: () => true, run: () => host.feeds() },
  ];
  for (const status of ['inbox', 'later', 'archive'] as ArticleStatus[]) commands.push({
    id: 'move-to-' + status, name: 'Move to ' + queueLabel(status), icon: status === 'archive' ? 'archive' : status === 'later' ? 'clock' : 'inbox',
    available: reader => article(reader) && !!reader!.getArticle()!.status && reader!.getArticle()!.status !== status, run: reader => reader?.move(status),
  });
  commands.push({ id: 'fetch-full-text', name: 'Fetch full text with Defuddle', icon: 'download',
    available: reader => article(reader) && !!reader!.getArticle()!.url && !controller.isFetchingFullText(reader!.getArticle()!.path),
    run: async reader => {
      const path = reader?.getArticle()?.path; if (!path) return;
      const hide = host.notice('Fetching full text with Defuddle…');
      const current = () => host.active() === reader && reader?.getState().file === path;
      try {
        const saved = await controller.fetchFullText(path);
        reader?.remapPath(path, saved.path);
        if (host.active() === reader && reader?.getState().file === saved.path) host.notice(saved.content === 'partial' ? 'Fetched partial text; review the article warning.' : 'Full text fetched with Defuddle.');
      }
      catch (error) { if (current()) host.notice(error instanceof StaleArticleWriteError ? 'Article changed; no changes saved.' : error instanceof Error ? error.message : String(error)); }
      finally { hide(); }
    },
  });
  return commands;
}
