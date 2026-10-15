import { afterEach, expect, it, vi } from 'vitest';
import { runtimeFixture } from './helpers/folder-runtime';
import { gate } from './helpers/memory-vault';
import { Plugin } from 'obsidian';

let plugin: any;
afterEach(() => {
  plugin?.onunload();
  plugin = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture() {
  const dom = new Map<string, () => void>();
  vi.spyOn(Plugin.prototype, 'registerDomEvent').mockImplementation((_target, event, callback) => {
    dom.set(event, callback as () => void);
  });
  const commands = vi.spyOn(Plugin.prototype, 'addCommand');
  const f = await runtimeFixture();
  plugin = f.plugin;
  f.app.workspace.getMostRecentLeaf = () => undefined;
  f.app.vault = { getMarkdownFiles: () => [...f.app.notes.values()].map((note) => note.file) };
  f.app.metadataCache.getFileCache = (file: { path: string }) => ({
    frontmatter: f.app.notes.get(file.path)?.properties ?? {},
    sections: [{ type: 'yaml' }],
  });
  const expire = vi.spyOn(f.plugin.store, 'expire').mockResolvedValue(undefined);
  const flushViews = vi.spyOn(f.plugin, 'flushViews').mockImplementation(() => {});
  const settle = async () => {
    // Lifecycle callbacks intentionally launch async work without returning it.
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  return {
    ...f,
    commands,
    expire,
    flushViews,
    async ready() {
      f.app.workspace.onLayoutReady.mock.calls[0][0]();
      await settle();
    },
    async event(name: string) {
      expect(dom.has(name)).toBe(true);
      dom.get(name)!();
      await settle();
    },
    async interval() {
      (vi.mocked(window.setInterval).mock.calls[0][0] as () => void)();
      await settle();
    },
    async sync() {
      commands.mock.calls.find(([command]) => command.id === 'refresh-feeds')![0].callback!();
      await settle();
    },
    async metadata(name: string, file?: unknown) {
      f.app.metadataCache.on.mock.calls.find(([event]: [string]) => event === name)![1](file);
      await settle();
    },
  };
}

it('never polls feeds on startup, four-hour timers, online or visible events; expiry still runs', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const f = await fixture();
  await f.ready();
  expect(f.expire).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 3; i++) {
    now += 4 * 60 * 60 * 1000;
    await f.interval();
  }
  expect(f.expire).toHaveBeenCalledTimes(4);
  await f.event('online');
  expect(f.expire).toHaveBeenCalledTimes(5); // Preserve immediate online housekeeping.
  await f.event('visibilitychange');
  expect(f.expire).toHaveBeenCalledTimes(5);
  expect(f.plugin.ingestion.refreshAll).not.toHaveBeenCalled();
});

it.each(['startup', 'online', 'timer'])(
  'honors the actual Refresh feeds command while %s expiry is pending',
  async (trigger) => {
    const f = await fixture(),
      release = gate();
    f.expire.mockImplementation(() => release.promise);
    try {
      if (trigger === 'startup') await f.ready();
      else if (trigger === 'online') await f.event('online');
      else await f.interval();
      expect(f.plugin.refreshing).toBe(true);
      await f.sync();
      expect(f.plugin.ingestion.refreshAll).toHaveBeenCalledOnce();
      expect(f.expire).toHaveBeenCalledOnce();
      expect(f.plugin.refreshing).toBe(true);
      await f.interval();
      expect(f.plugin.ingestion.refreshAll).toHaveBeenCalledOnce();
      expect(f.expire).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
    }
    await f.event('visibilitychange');
    expect(f.plugin.refreshing).toBe(false);
  },
);

it('does not report or alter a replacement generation after a busy manual sync retires', async () => {
  const f = await fixture(),
    expiry = gate(),
    sync = gate();
  f.expire.mockImplementation(() => expiry.promise);
  f.plugin.ingestion.refreshAll.mockImplementation(async () => {
    await sync.promise;
    throw new Error('Retired sync failed');
  });
  const notice = vi.spyOn(f.plugin, 'notice');
  await f.ready();
  await f.sync();
  expect(f.plugin.ingestion.refreshAll).toHaveBeenCalledOnce();
  await f.plugin.applyFolders({
    articles: 'Capture',
    feeds: 'Subscriptions',
  });
  f.plugin.refreshing = true;
  sync.resolve();
  expiry.resolve();
  await f.event('visibilitychange');
  expect(f.plugin.refreshing).toBe(true);
  expect(f.plugin.ingestion.refreshAll).not.toHaveBeenCalled();
  expect(notice).not.toHaveBeenCalled();
});

it('Refresh feeds is explicit and is never throttled by the housekeeping interval', async () => {
  const f = await fixture();
  await f.ready();
  await f.sync();
  await f.sync();
  expect(f.plugin.ingestion.refreshAll).toHaveBeenCalledTimes(2);
  expect(f.expire).toHaveBeenCalledTimes(3);
});

it('recovers an offline URL capture online without refreshing subscriptions', async () => {
  const f = await fixture();
  const file = { path: 'Reading/Articles/Captured.md' };
  const properties = {
    type: 'article',
    status: 'inbox',
    url: 'https://example.com/article',
    title: 'Captured',
  };
  f.app.notes.set(file.path, { file, properties });
  f.plugin.store.catalog.update(file.path, properties);
  vi.stubGlobal('navigator', { onLine: false });
  await f.ready();
  expect(f.plugin.ingestion.acquire).not.toHaveBeenCalled();
  vi.stubGlobal('navigator', { onLine: true });
  await f.event('online');
  expect(f.plugin.ingestion.acquire).toHaveBeenCalledExactlyOnceWith(file.path);
  expect(f.plugin.ingestion.refreshAll).not.toHaveBeenCalled();
});

it.each(['startup', 'foreground', 'metadata'])(
  'still acquires pending article captures on %s without importing feeds',
  async (trigger) => {
    const f = await fixture();
    const file = { path: 'Reading/Articles/Pending.md' };
    const properties = {
      type: 'article',
      status: 'inbox',
      url: 'https://example.com/pending',
      title: 'Pending',
    };
    f.app.notes.set(file.path, { file, properties });
    f.plugin.store.catalog.update(file.path, properties);
    if (trigger === 'startup') await f.ready();
    else if (trigger === 'foreground') await f.event('visibilitychange');
    else f.runtime.watchers[0].changed({ path: file.path });
    expect(f.plugin.ingestion.acquire).toHaveBeenCalledExactlyOnceWith(file.path);
    expect(f.plugin.ingestion.refreshAll).not.toHaveBeenCalled();
  },
);

it('omits native capture setup while retaining explicit article re-download', async () => {
  const f = await fixture();
  const commands = f.commands.mock.calls.map(([command]) => command);
  expect(commands.some((command) => command.id === 'setup-ios-read-later')).toBe(false);
  expect(commands).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'redownload-article',
        name: 'Download article again (replace content)',
        checkCallback: expect.any(Function),
      }),
    ]),
  );
  expect(f.plugin.ingestion.acquire).not.toHaveBeenCalled();
  expect(f.plugin.ingestion.refreshAll).not.toHaveBeenCalled();
});

it.each(['foreground', 'changed', 'resolve', 'resolved'])(
  'shortlists a native single source-link capture after %s without body scans',
  async (trigger) => {
    const f = await fixture();
    const file = { path: 'Reading/Inbox/Source link.md', extension: 'md' };
    const properties = {
      type: 'article',
      url: 'https://example.com/native',
      status: 'inbox',
      bookmark: 'Native title',
    };
    f.app.notes.set(file.path, { file, properties });
    f.plugin.store.catalog.update(file.path, properties);
    f.app.metadataCache.getFileCache = () => ({
      frontmatter: properties,
      sections: [{ type: 'yaml' }, { type: 'paragraph' }],
      links: [{ link: properties.url }],
    });
    if (trigger === 'foreground') await f.event('visibilitychange');
    else if (trigger === 'changed') f.runtime.watchers[0].changed({ path: file.path });
    else await f.metadata(trigger, file);
    expect(f.plugin.ingestion.acquire).toHaveBeenCalledExactlyOnceWith(file.path);
    await f.metadata('resolve', file);
    expect(f.plugin.ingestion.acquire).toHaveBeenCalledOnce();
    expect(f.plugin.ingestion.refreshAll).not.toHaveBeenCalled();
  },
);

it.each([
  { sections: ['paragraph'], links: [] },
  { sections: ['paragraph'], links: ['https://example.com/different'] },
  { sections: ['paragraph'], links: ['https://example.com/native#different'] },
  { sections: ['paragraph'], links: ['https://example.com/native', 'https://example.com/native'] },
  { sections: ['heading', 'paragraph'], links: ['https://example.com/native'] },
  { sections: ['paragraph', 'paragraph'], links: ['https://example.com/native'] },
  { sections: ['paragraph', 'comment'], links: ['https://example.com/native'] },
])('does not enqueue body reads for metadata non-candidates %j', async ({ sections, links }) => {
  const f = await fixture();
  const file = { path: 'Reading/Inbox/Protected.md', extension: 'md' };
  const properties = { type: 'article', status: 'inbox', url: 'https://example.com/native' };
  f.app.notes.set(file.path, { file, properties });
  f.plugin.store.catalog.update(file.path, properties);
  f.app.metadataCache.getFileCache = () => ({
    frontmatter: properties,
    sections: [{ type: 'yaml' }, ...sections.map((type) => ({ type }))],
    links: links.map((link) => ({ link })),
  });
  await f.event('visibilitychange');
  await f.metadata('resolve', file);
  expect(f.plugin.ingestion.acquire).not.toHaveBeenCalled();
});

it.each(['foreground', 'changed', 'resolve', 'resolved'])(
  'recovers an externally created empty native capture after %s without polling feeds',
  async (trigger) => {
    const f = await fixture();
    const file = { path: 'Reading/Inbox/Native capture.md' };
    const properties = {
      type: 'article',
      status: 'inbox',
      url: 'https://example.com/native?x=1&y=2',
    };
    f.app.notes.set(file.path, { file, properties });
    f.plugin.store.catalog.update(file.path, properties);
    const cache = f.app.metadataCache.getFileCache(file);
    f.app.metadataCache.getFileCache = () => ({ ...cache, sections: undefined });
    f.runtime.watchers[0].changed({ path: file.path });
    expect(f.plugin.ingestion.acquire).not.toHaveBeenCalled();
    f.app.metadataCache.getFileCache = () => cache;
    if (trigger === 'foreground') await f.event('visibilitychange');
    else if (trigger === 'changed') f.runtime.watchers[0].changed({ path: file.path });
    else await f.metadata(trigger, file);
    expect(f.plugin.ingestion.acquire).toHaveBeenCalledExactlyOnceWith(file.path);
    // Repeated native cache events cannot create a recovery loop.
    f.runtime.watchers[0].changed({ path: file.path });
    await f.metadata('resolve', file);
    await f.event('visibilitychange');
    expect(f.plugin.ingestion.acquire).toHaveBeenCalledOnce();
    expect(f.plugin.ingestion.refreshAll).not.toHaveBeenCalled();
  },
);

it.each([
  { path: 'Native capture.md', properties: { type: 'article', url: 'https://example.com/a' } },
  {
    path: 'Feed capture.md',
    properties: { type: 'article', status: 'feed', url: 'https://example.com/a' },
  },
  {
    path: 'Invalid status.md',
    properties: { type: 'article', status: 'invalid', url: 'https://example.com/a' },
  },
  {
    path: 'Reading/Inbox/Invalid.md',
    properties: { type: 'article', status: 'inbox', url: '{{content}}' },
  },
  { path: 'Reading/Inbox/Note.md', properties: { url: 'https://example.com/a' } },
  {
    path: 'Reading/Inbox/Body.md',
    properties: { type: 'article', status: 'inbox', url: 'https://example.com/a' },
    body: true,
  },
])('does not recover ineligible native capture $path', async ({ path, properties, body }) => {
  const f = await fixture();
  const file = { path };
  f.app.notes.set(path, { file, properties });
  f.plugin.store.catalog.update(path, properties);
  if (body)
    f.app.metadataCache.getFileCache = () => ({
      frontmatter: properties,
      sections: [{ type: 'yaml' }, { type: 'paragraph' }],
    });
  f.runtime.watchers[0].changed({ path });
  await f.metadata('resolve', file);
  await f.event('visibilitychange');
  expect(f.plugin.ingestion.acquire).not.toHaveBeenCalled();
  expect(f.plugin.ingestion.refreshAll).not.toHaveBeenCalled();
});

it('does not recover native captures while hidden or after generation retirement', async () => {
  const f = await fixture();
  const file = { path: 'Reading/Inbox/Native.md' };
  const properties = { type: 'article', status: 'inbox', url: 'https://example.com/a' };
  f.app.notes.set(file.path, { file, properties });
  f.plugin.store.catalog.update(file.path, properties);
  vi.stubGlobal('document', {
    visibilityState: 'hidden',
    body: { classList: { remove: vi.fn() } },
  });
  await f.metadata('resolve', file);
  expect(f.plugin.ingestion.acquire).not.toHaveBeenCalled();
  f.plugin.stopFolders();
  await f.event('visibilitychange');
  await f.metadata('resolve', file);
  expect(f.plugin.ingestion.acquire).not.toHaveBeenCalled();
});

it.each(['resolve', 'resolved'])(
  'indexes native capture missing startup frontmatter when %s arrives',
  async (event) => {
    const f = await fixture();
    const file = { path: 'Reading/Inbox/Late native.md', extension: 'md' };
    const properties = { type: 'article', status: 'inbox', url: 'https://example.com/late-native' };
    f.app.notes.set(file.path, { file, properties });
    let ready = false;
    f.app.metadataCache.getFileCache = () =>
      ready ? { frontmatter: properties, sections: [{ type: 'yaml' }] } : undefined;
    await f.ready();
    expect(f.plugin.store.catalog.article(file.path)).toBeUndefined();
    expect(f.plugin.ingestion.acquire).not.toHaveBeenCalled();
    ready = true;
    await f.metadata(event, file);
    expect(f.plugin.store.catalog.article(file.path)?.url).toBe(properties.url);
    expect(f.plugin.ingestion.acquire).toHaveBeenCalledExactlyOnceWith(file.path);
    await f.metadata(event, file);
    expect(f.plugin.ingestion.acquire).toHaveBeenCalledOnce();
  },
);

it('does not treat resolved after folder Apply as startup capture recovery', async () => {
  const f = await fixture();
  const file = { path: 'Capture/Native.md', extension: 'md' };
  const properties = { type: 'article', status: 'inbox', url: 'https://example.com/configured' };
  f.app.notes.set(file.path, { file, properties });
  // Also cover Apply before startup metadata ever became complete.
  await f.plugin.applyFolders({
    articles: 'Capture',
    feeds: 'Subscriptions',
  });
  expect(f.plugin.store.catalog.article(file.path)?.queue).toBe('Inbox');
  await f.metadata('resolved');
  await f.metadata('resolved');
  await f.metadata('resolve', file);
  f.runtime.watchers.at(-1).changed({ path: file.path });
  expect(f.plugin.ingestion.acquire).not.toHaveBeenCalled();
  expect(f.plugin.ingestion.refreshAll).not.toHaveBeenCalled();
  const fresh = { path: 'Capture/New native.md', extension: 'md' };
  const freshProperties = {
    type: 'article',
    status: 'inbox',
    url: 'https://example.com/new-native',
  };
  f.app.notes.set(fresh.path, { file: fresh, properties: freshProperties });
  await f.metadata('resolve', fresh);
  expect(f.plugin.ingestion.acquire).toHaveBeenCalledExactlyOnceWith(fresh.path);
  f.plugin.ingestion.acquire.mockClear();
  // Normal explicit foreground recovery still works in the new generation.
  await f.event('visibilitychange');
  expect(f.plugin.ingestion.acquire).toHaveBeenCalledExactlyOnceWith(file.path);
});

it('feed creation, enablement and metadata resolution never start imports', async () => {
  const f = await fixture();
  const file = { path: 'Reading/Feeds/Example.md' };
  for (const enabled of [false, true]) {
    const properties = { type: 'feed', url: 'https://example.com/feed', enabled };
    f.app.notes.set(file.path, { file, properties });
    f.plugin.store.catalog.update(file.path, properties);
    f.runtime.watchers[0].changed({ path: file.path });
    await f.metadata('changed', file);
    await f.metadata('resolve', file);
    await f.metadata('resolved');
  }
  expect(f.plugin.ingestion.acquire).not.toHaveBeenCalled();
  expect(f.plugin.ingestion.refreshAll).not.toHaveBeenCalled();
  expect(f.expire).toHaveBeenCalled();
});

it('Folder Apply reseeds metadata without acquiring articles or syncing old/new feeds', async () => {
  const f = await fixture();
  const old = f.plugin.ingestion;
  await f.plugin.applyFolders({
    articles: 'Capture',
    feeds: 'Subscriptions',
  });
  expect(old.refreshAll).not.toHaveBeenCalled();
  expect(f.plugin.ingestion.refreshAll).not.toHaveBeenCalled();
  expect(f.plugin.ingestion.acquire).not.toHaveBeenCalled();
});

it('preserves hidden/unloaded guards and hidden-view flushing', async () => {
  const f = await fixture();
  Object.assign(document, { visibilityState: 'hidden' });
  await f.event('visibilitychange');
  await f.interval();
  await f.sync();
  expect(f.flushViews).toHaveBeenCalledOnce();
  expect(f.expire).not.toHaveBeenCalled();
  Object.assign(document, { visibilityState: 'visible' });
  f.plugin.onunload();
  await f.interval();
  await f.sync();
  expect(f.plugin.ingestion.refreshAll).not.toHaveBeenCalled();
  expect(f.expire).not.toHaveBeenCalled();
});

it.each(['Root capture.md', 'Elsewhere/Nested/Capture.md'])(
  'recovers explicitly inbox native captures anywhere: %s',
  async (path) => {
    const f = await fixture();
    const file = { path, extension: 'md' };
    const properties = {
      type: 'article',
      status: 'inbox',
      url: 'https://example.com/native-anywhere',
    };
    f.app.notes.set(path, { file, properties });
    f.plugin.store.catalog.update(path, properties);
    await f.metadata('resolve', file);
    expect(f.plugin.ingestion.acquire).toHaveBeenCalledExactlyOnceWith(path);
    expect(f.plugin.ingestion.refreshAll).not.toHaveBeenCalled();
  },
);

it('does not acquire a missing-status native capture displayed in Feed', async () => {
  const f = await fixture();
  const file = { path: 'Reading/Articles/Missing status.md', extension: 'md' };
  const properties = { type: 'article', url: 'https://example.com/missing-status' };
  f.app.notes.set(file.path, { file, properties });
  f.plugin.store.catalog.update(file.path, properties);
  expect(f.plugin.store.catalog.article(file.path)?.queue).toBe('Feed');
  await f.metadata('resolve', file);
  await f.event('visibilitychange');
  expect(f.plugin.ingestion.acquire).not.toHaveBeenCalled();
});
