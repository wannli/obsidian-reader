import { TFile, type App } from 'obsidian';
import { ClippingStore } from '../core/clipping-store';
import { clippingMember, clippingOrigin } from '../core/clippings';
import { readDocument } from '../core/document';
import { linkPath, excludedReaderPath, type Properties } from '../core/model';
import type { ArticleStore } from '../core/store';
import type { ReaderNodes } from './fileclass/reader-nodes';

/** Generation-owned adapter. No authoritative index or note rewrites. */
export class ReaderClippings extends ClippingStore<TFile> {
  constructor(app: App, store: ArticleStore<TFile>, nodes: ReaderNodes, signal: AbortSignal) {
    let revision = 0,
      settingsKey = JSON.stringify(nodes.settingsSnapshot());
    const currentRevision = () => {
      const key = JSON.stringify(nodes.settingsSnapshot());
      if (key !== settingsKey) {
        settingsKey = key;
        revision++;
      }
      return revision;
    };
    const dirty = new Set<TFile>();
    const observed = new Map<TFile, Properties>();
    const bindings = () => nodes.settingsSnapshot().clippingBindings ?? [];
    super(store, {
      bindings,
      revision: currentRevision,
      candidates: (source) =>
        app.vault
          .getMarkdownFiles()
          .filter((file) => {
            if (excludedReaderPath(file.path)) return false;
            const properties =
              observed.get(file) ?? app.metadataCache.getFileCache(file)?.frontmatter;
            if (dirty.has(file) || !properties) return true;
            const origin =
              clippingOrigin(properties.origin)?.path ??
              (typeof properties.origin === 'string' ? linkPath(properties.origin) : undefined);
            if (origin) {
              const target = store.vault.resolveLink?.(origin, file.path);
              if (target) return target === source.file;
              // A broken fully qualified link to another source cannot refer to this article.
              return (
                !origin.includes('/') ||
                origin.replace(/\.md$/iu, '') === source.path.replace(/\.md$/iu, '')
              );
            }
            return clippingMember(properties, bindings());
          })
          .map((file) => ({ file, path: file.path, bytes: file.stat.size })),
      observed: (candidate, raw) => {
        try {
          observed.set(
            candidate.file,
            /^(?:\uFEFF)?---\r?\n/u.test(raw) ? readDocument(raw).properties : {},
          );
          dirty.delete(candidate.file);
        } catch {
          /* Invalid metadata remains uncertain until a deliberate edit. */
        }
      },
      prepare: async (request) => {
        if (signal.aborted) throw new Error('Reader has stopped.');
        return nodes.prepareClipping(request);
      },
    });
    const refs = ['create', 'modify', 'rename', 'delete'].map((event) =>
      app.vault.on(event as 'modify', (file) => {
        if (!(file instanceof TFile)) {
          // A folder move can change relative-link resolution without per-child events.
          if (event === 'rename' || event === 'delete') {
            revision++;
            observed.clear();
          }
          return;
        }
        if (!file.path.endsWith('.md') && event !== 'rename' && event !== 'delete') return;
        revision++;
        observed.delete(file);
        if (event === 'delete' || !file.path.endsWith('.md')) dirty.delete(file);
        else dirty.add(file);
      }),
    );
    const metadata = app.metadataCache.on('changed', () => revision++);
    const dispose = () => {
      for (const ref of refs) app.vault.offref(ref);
      app.metadataCache.offref(metadata);
      dirty.clear();
      observed.clear();
    };
    if (signal.aborted) dispose();
    else signal.addEventListener('abort', dispose, { once: true });
  }
}
