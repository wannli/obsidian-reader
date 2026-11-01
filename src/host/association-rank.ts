import { parseLinktext, TFile, type App } from 'obsidian';
import { isAnnotationProperty } from '../core/annotations';
import { excludedReaderPath } from '../core/model';
import type { AssociationRank } from '../core/association-rank';
import { nativeLinkPath } from './note-links';

/** Metadata-only display hint. Never treats publisher URLs, source fields or missing caches as links. */
export function associationRanks(
  app: App,
  articles: Iterable<{ path: string }>,
): Map<string, AssociationRank> {
  const ranks = new Map<string, AssociationRank>();
  for (const article of articles) {
    if (excludedReaderPath(article.path)) continue;
    const file = app.vault.getAbstractFileByPath(article.path);
    if (!(file instanceof TFile) || file.path !== article.path) continue;
    const cache = app.metadataCache.getFileCache(file);
    if (cache?.frontmatter?.type !== 'article') continue;
    const targets = new Set<string>();
    for (const link of [
      ...(cache.links ?? []),
      ...(cache.frontmatterLinks ?? []).filter((link) =>
        isAnnotationProperty(cache.frontmatter ?? {}, link.key),
      ),
    ]) {
      const wiki = /^!?\[\[/.test(link.original ?? '');
      const decoded = nativeLinkPath(link.link, !wiki);
      if (!decoded) continue;
      const path = parseLinktext(decoded).path;
      if (!path) continue;
      const target = app.metadataCache.getFirstLinkpathDest(path, article.path);
      if (target instanceof TFile && app.vault.getAbstractFileByPath(target.path) === target)
        targets.add(target.path);
    }
    for (const path of targets) {
      const previous = ranks.get(path);
      ranks.set(path, {
        count: (previous?.count ?? 0) + 1,
        edited: Math.max(previous?.edited ?? 0, file.stat.mtime || 0),
      });
    }
  }
  return ranks;
}
