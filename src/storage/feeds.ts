import type { Feed } from '../types';
import { StorageContext } from './context';
import { newNote, noteType, writeNote } from './markdown';
import { feedFrom } from './models';
import { normalizeUrl, notePath, sameUrl } from './safety';
import { WIRES_FOLDER } from '../reading-layout';
import { INLINE_FORMAT } from './legacy-import';
import { capturePathGenerations, pathGeneration } from './path-generation';
import { StaleArticleWriteError } from './preconditions';

export async function listFeeds(context: StorageContext): Promise<Feed[]> {
  return (await context.scan()).filter(item => noteType(item.note) === 'feed').map(item => feedFrom(item.note, item.path));
}

export async function createFeed(context: StorageContext, title: string, value: string, generationAtRequest = capturePathGenerations(context.store)): Promise<Feed> {
  const url = normalizeUrl(value), existing = (await listFeeds(context)).find(feed => sameUrl(feed.url, url));
  if (existing) {
    await context.mutate(existing.path, 'feed', () => false);
    return feedFrom(await context.read(existing.path), existing.path);
  }
  const name = title.trim() || new URL(url).hostname;
  const path = notePath(context.settings.feedsFolder || WIRES_FOLDER, name, await context.store.list());
  const note = newNote({ type: 'feed', pullmanFormat: INLINE_FORMAT, id: await context.freshId('feed'), title: name, prefix: name, url, enabled: false });
  const ownershipRevision = await context.assertWritable(path);
  await context.store.create(path, writeNote(note), { guard: () => {
    context.assertOwnershipRevision(path, ownershipRevision);
    context.assertWritableNow(path);
    if (pathGeneration(context.store, path) !== generationAtRequest(path)) throw new StaleArticleWriteError();
  } });
  return feedFrom(note, path);
}

export async function updateFeed(context: StorageContext, path: string, patch: Partial<Feed>): Promise<void> {
  if (patch.path !== undefined && patch.path !== path) throw new Error('Feed paths are immutable');
  const notes = await listFeeds(context);
  const url = patch.url === undefined ? undefined : normalizeUrl(patch.url);
  if (url && notes.some(feed => feed.path !== path && sameUrl(feed.url, url))) throw new Error('Duplicate feed URL');
  await context.mutate(path, 'feed', note => {
    const feed = feedFrom(note, path);
    if (patch.id !== undefined && patch.id !== feed.id) throw new Error('Feed IDs are immutable');
    for (const key of ['title', 'prefix', 'enabled', 'checked', 'etag', 'modified', 'error'] as const) {
      if (patch[key] === undefined) continue;
      if (typeof patch[key] !== (key === 'enabled' ? 'boolean' : 'string')) throw new Error('Invalid feed ' + key);
      note.doc.set(key, patch[key]);
    }
    if (url !== undefined) note.doc.set('url', url);
  });
}
