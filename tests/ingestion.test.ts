// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestUrl, type RequestUrlParam, type TFile } from 'obsidian';
import { extract } from '../src/content/extract';
import * as feeds from '../src/content/feed';
import { ChangedNote, createDocument, patchProperties, readDocument } from '../src/core/document';
import { vaultLink } from '../src/core/model';
import { ArticleStore, type VaultPort } from '../src/core/store';
import { Ingestion } from '../src/host/ingestion';
import { Network } from '../src/host/network';
import { MemoryVault } from './helpers/memory-vault';

// Obsidian ships declarations, not a resolvable browser entry. Use Vitest's
// server-side mock resolution with its public jsdom environment setup locally,
// without changing the shared config or adding a runtime Obsidian shim.
const dom = await vi.hoisted(async () => {
  const { builtinEnvironments } = await import('vitest/runtime');
  return builtinEnvironments.jsdom.setup(globalThis, {});
});
afterAll(() => dom.teardown(globalThis));
vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));
// Extraction/parsing quality has its own suite. Keep the real network, feed
// parsing/conversion, queues and guarded store, but make extraction deterministic.
vi.mock('../src/content/extract', () => ({ extract: vi.fn() }));

const FEED = 'https://example.com/feed.xml';
const HTML_ACCEPT = 'text/html, application/xhtml+xml';
const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml, text/xml';
const FULL = 'The complete article, fetched only after proving ownership.';
const NOW = new Date('2026-10-13T12:00:00Z');
const request = vi.mocked(requestUrl);
const extraction = vi.mocked(extract);
const running: Ingestion[] = [];
const networks: Network[] = [];
const stores: ArticleStore<TFile>[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error }),
  );
}
function response(text = FULL, status = 200) {
  return {
    text,
    status,
    headers: { 'content-type': 'text/html' },
    json: {},
    arrayBuffer: new ArrayBuffer(0),
  };
}
// Match Obsidian's awaitable response and its public body shortcut promises.
function serve(
  handler: (
    url: string,
    options: RequestUrlParam | string,
  ) => ReturnType<typeof response> | Promise<ReturnType<typeof response>>,
) {
  request.mockImplementation((options) => {
    const pending = Promise.resolve().then(() =>
      handler(typeof options === 'string' ? options : options.url, options),
    );
    const shortcuts = {
      arrayBuffer: pending.then((result) => result.arrayBuffer),
      json: pending.then((result) => result.json),
      text: pending.then((result) => result.text),
    };
    // Network awaits only the main promise; unused shortcuts must not produce
    // unhandled rejections when the mocked host request fails.
    Object.values(shortcuts).forEach((promise) => {
      void promise.catch(() => {});
    });
    return Object.assign(pending, shortcuts);
  });
}
function item(id: number, extra: Partial<feeds.FeedItem> = {}): feeds.FeedItem {
  return {
    url: `https://example.com/article-${id}`,
    title: `Article ${id}`,
    published: new Date(Date.UTC(2026, 9, 12, 0, id)).toISOString(),
    html: '<p>Publisher summary.</p>',
    excerpt: true,
    ...extra,
  };
}
function xml(items: feeds.FeedItem[]) {
  return `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Example</title>${items
    .map(
      (entry) =>
        `<item><title>${entry.title}</title><link>${entry.url}</link>${entry.published ? `<pubDate>${entry.published}</pubDate>` : ''}` +
        (entry.excerpt
          ? `<description><![CDATA[${entry.html}]]></description>`
          : `<content:encoded><![CDATA[${entry.html}]]></content:encoded>`) +
        '</item>',
    )
    .join('')}</channel></rss>`;
}
function host() {
  const vault = new MemoryVault();
  // The production boundary only needs file identity/path. No Obsidian internals
  // or real vault are involved; MemoryVault implements every public VaultPort op.
  const store = new ArticleStore(vault as unknown as VaultPort<TFile>);
  const notify = vi.fn();
  const ingestion = new Ingestion(store, notify);
  stores.push(store);
  running.push(ingestion);
  return { vault, store, notify, ingestion };
}
type Host = ReturnType<typeof host>;
function pausedSubscriptionCreate(h: Host) {
  const entered = deferred<void>(),
    release = deferred<void>(),
    create = h.store.vault.create.bind(h.store.vault);
  const creating = vi
    .spyOn(h.store.vault, 'create')
    .mockImplementationOnce(async (path, raw, guard) => {
      entered.resolve();
      await release.promise;
      await guard?.();
      return create(path, raw);
    });
  return { entered, release, creating };
}
async function seedFeed({ vault, store }: Host, url = FEED, path = 'Reading/Wires/Example.md') {
  const properties = { type: 'feed', title: 'Example', url, prefix: 'Example', enabled: true };
  await vault.create(path, createDocument(properties));
  store.catalog.update(path, properties);
  return store.catalog.feed(path)!;
}
async function seedExcerpt(h: Host, entry = item(1)) {
  const feed = await seedFeed(h);
  const file = await h.store.capture({
    url: entry.url,
    title: entry.title,
    body: await feeds.feedMarkdown(entry),
    queue: 'Stream',
    feed: vaultLink(feed.path),
    published: entry.published,
  });
  return { feed, file };
}
function urls(store: ArticleStore<TFile>) {
  return [...store.catalog.values()].map((article) => article.url).sort();
}
function network() {
  const result = new Network();
  networks.push(result);
  return result;
}
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  request.mockReset();
  extraction.mockReset();
  serve((url) => {
    throw new Error(`Unexpected request: ${url}`);
  });
  extraction.mockImplementation(async (url, get) => {
    const result = await get(url, HTML_ACCEPT);
    if (result.status < 200 || result.status >= 300)
      throw new Error(`Article returned HTTP ${result.status}.`);
    return { title: 'Extracted title', markdown: result.text };
  });
});
afterEach(() => {
  running.splice(0).forEach((ingestion) => ingestion.stop());
  stores.splice(0).forEach((store) => store.dispose());
  networks.splice(0).forEach((client) => client.stop());
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('subscription import contracts', () => {
  it('adds a subscription offline with editable hostname defaults and no network or imports', async () => {
    const h = host();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await h.ingestion.subscribe(` ${FEED}#fragment `);
    const feed = h.store.catalog.feeds()[0];
    expect(readDocument(await h.vault.read(h.vault.file(feed.path)!)).properties).toEqual({
      type: 'feed',
      title: 'example.com',
      url: FEED,
      prefix: 'example.com',
      enabled: true,
    });
    expect(request).not.toHaveBeenCalled();
    expect(extraction).not.toHaveBeenCalled();
    expect(urls(h.store)).toEqual([]);
  });

  it.each(['not a URL', 'file:///tmp/feed.xml', 'javascript:alert(1)'])(
    'rejects invalid feed URLs locally without requests or notes: %s',
    async (url) => {
      const h = host();
      await expect(h.ingestion.subscribe(url)).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
      expect(h.vault.files.size).toBe(0);
    },
  );

  it('honors the URL and prefix edited after Add and before the first explicit Sync', async () => {
    const h = host();
    await h.ingestion.subscribe(FEED);
    const feed = h.store.catalog.feeds()[0],
      file = h.vault.file(feed.path)!;
    const url = 'https://example.com/edited-feed.xml';
    await h.vault.process(file, (raw) =>
      patchProperties(raw, {
        url,
        title: 'Edited feed',
        prefix: 'Edited prefix',
      }),
    );
    h.store.catalog.update(file.path, readDocument(await h.vault.read(file)).properties);
    expect(request).not.toHaveBeenCalled();
    serve((requested) => {
      expect(requested).toBe(url);
      return response(xml([item(1)]));
    });
    await h.ingestion.refreshAll();
    expect(request).toHaveBeenCalledOnce();
    const article = h.store.catalog.findUrl(item(1).url)!;
    expect(article.path).toContain('Edited prefix');
    expect((await h.store.read(article.path)).properties.feed).toBe(vaultLink(feed.path));
    expect(h.store.catalog.feed(file.path)?.title).toBe('Edited feed');
  });

  it('neither disabling nor re-enabling imports; explicit Sync respects disabled feeds', async () => {
    const h = host();
    await h.ingestion.subscribe(FEED);
    const feed = h.store.catalog.feeds()[0];
    await h.ingestion.setFeed(feed, false);
    await h.ingestion.refreshAll();
    await h.ingestion.setFeed(feed, true);
    expect(request).not.toHaveBeenCalled();
    expect(urls(h.store)).toEqual([]);
    serve(() => response(xml([item(1)])));
    await h.ingestion.refreshAll();
    expect(request).toHaveBeenCalledOnce();
    expect(urls(h.store)).toEqual([item(1).url]);
  });

  it('adds locally, then imports exactly the latest 20 on explicit Sync regardless of feed order', async () => {
    const h = host(),
      entries = Array.from({ length: 25 }, (_, i) => item(i + 1));
    serve(() => response(xml(entries)));
    await h.ingestion.subscribe(FEED);
    expect(request).not.toHaveBeenCalled();
    expect(urls(h.store)).toEqual([]);
    await h.ingestion.refreshAll();
    expect(urls(h.store)).toEqual(
      entries
        .slice(5)
        .map((entry) => entry.url)
        .sort(),
    );
    const feed = h.store.catalog.feeds()[0];
    expect(h.store.catalog.list('Stream')).toHaveLength(20);
    const snapshot = await h.store.read(h.store.catalog.findUrl(item(25).url)!.path);
    const published = new Date(item(25).published!),
      pad = (part: number) => String(part).padStart(2, '0');
    const expectedPublished = `${published.getFullYear()}-${pad(published.getMonth() + 1)}-${pad(published.getDate())}T${pad(published.getHours())}:${pad(published.getMinutes())}`;
    expect(snapshot.body).toBe(await feeds.feedMarkdown(item(25)));
    expect(snapshot.properties).toMatchObject({
      feed: vaultLink(feed.path),
      published: expectedPublished,
    });
    expect(extraction).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'does not backfill entries outside the latest 20 on refresh (restart=%s)',
    async (restart) => {
      const h = host(),
        entries = Array.from({ length: 25 }, (_, i) => item(i + 1));
      let current = entries;
      serve(() => response(xml(current)));
      await h.ingestion.subscribe(FEED);
      await h.ingestion.refreshAll();
      let ingestion = h.ingestion;
      if (restart) {
        ingestion.stop();
        const rebuilt = new ArticleStore(h.vault as unknown as VaultPort<TFile>);
        for (const file of h.vault.files.values())
          rebuilt.catalog.update(file.path, readDocument(await h.vault.read(file)).properties);
        stores.push(rebuilt);
        ingestion = new Ingestion(rebuilt, h.notify);
        running.push(ingestion);
        h.store = rebuilt;
      }
      current = [item(26), ...entries];
      await ingestion.refreshAll();
      expect(urls(h.store)).toEqual(
        [...entries.slice(5), item(26)].map((entry) => entry.url).sort(),
      );
    },
  );

  it('limits a burst of more than 20 entries to the current window on repeated refreshes', async () => {
    const h = host(),
      burst = Array.from({ length: 25 }, (_, i) => item(i + 2));
    let current = [item(1)];
    serve(() => response(xml(current)));
    await h.ingestion.subscribe(FEED);
    await h.ingestion.refreshAll();
    const feedFile = h.vault.file(h.store.catalog.feeds()[0].path)!;
    const feedBefore = await h.vault.read(feedFile);
    const conversion = vi.spyOn(feeds, 'feedMarkdown');
    current = [item(1), ...burst];
    await h.ingestion.refreshAll();
    const expected = [item(1), ...burst.slice(5)].map((entry) => entry.url).sort();
    expect(urls(h.store)).toEqual(expected);
    expect(conversion).toHaveBeenCalledTimes(20);
    await h.ingestion.refreshAll();
    expect(urls(h.store)).toEqual(expected);
    expect(conversion).toHaveBeenCalledTimes(20);
    expect(await h.vault.read(feedFile)).toBe(feedBefore); // No cursor or import history is persisted.
  });

  it('recomputes the latest 20 by publication date when the listed entries are reordered', async () => {
    const h = host(),
      entries = Array.from({ length: 25 }, (_, i) => item(i + 1));
    let current = entries;
    serve(() => response(xml(current)));
    await h.ingestion.subscribe(FEED);
    await h.ingestion.refreshAll();
    current = [...entries].reverse();
    await h.ingestion.refreshAll();
    expect(urls(h.store)).toEqual(
      entries
        .slice(5)
        .map((entry) => entry.url)
        .sort(),
    );
    // The newest entry is last and older skipped entries are at the front.
    current = [
      ...entries.filter((_, i) => i % 2 === 0),
      ...entries.filter((_, i) => i % 2 === 1),
      item(26),
    ];
    await h.ingestion.refreshAll();
    expect(urls(h.store)).toEqual([...entries.slice(5), item(26)].map((entry) => entry.url).sort());
  });

  it('does not import expired entries, but accepts unknown dates and the exact cutoff', async () => {
    const h = host();
    const entries = [
      item(1, { published: '2026-09-13T11:59:59.999Z' }),
      item(2, { published: '2026-09-13T12:00:00.000Z' }),
      item(3, { published: undefined }),
    ];
    serve(() => response(xml(entries)));
    await h.ingestion.subscribe(FEED);
    await h.ingestion.refreshAll();
    expect(urls(h.store)).toEqual([item(2).url, item(3).url]);
  });

  it('deduplicates normalized URLs across feeds, simultaneous refreshes, and queue moves', async () => {
    const h = host(),
      entry = item(1);
    const file = await h.store.capture({ url: `${entry.url}#saved`, body: 'My existing article.' });
    await h.store.move(await h.store.read(file.path), 'Treasury');
    const before = await h.vault.read(file);
    await seedFeed(h);
    await seedFeed(h, 'https://example.com/second.xml', 'Reading/Wires/Second.md');
    serve(() => response(xml([entry, { ...entry, url: `${entry.url}#duplicate` }, item(2)])));
    await Promise.all([h.ingestion.refreshAll(), h.ingestion.refreshAll()]);
    expect(urls(h.store)).toEqual([entry.url, item(2).url]);
    expect(await h.vault.read(file)).toBe(before);
    expect(file.path).toContain('/Treasury/');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('recreates deleted listed entries only inside the current latest-20 window, without tombstones', async () => {
    const h = host(),
      entries = Array.from({ length: 25 }, (_, i) => item(i + 1));
    let current = entries.slice(0, 20);
    serve(() => response(xml(current)));
    await h.ingestion.subscribe(FEED);
    await h.ingestion.refreshAll();
    const outside = await h.store.read(h.store.catalog.findUrl(item(1).url)!.path);
    const inside = await h.store.read(h.store.catalog.findUrl(item(20).url)!.path);
    await h.store.trash(outside);
    await h.store.trash(inside);
    current = entries;
    await h.ingestion.refreshAll();
    expect(urls(h.store)).toEqual(
      entries
        .slice(1)
        .map((entry) => entry.url)
        .sort(),
    );
    expect(h.vault.file(outside.path)).toBeUndefined();
    expect(h.vault.file(inside.path)).toBeDefined();
    expect(h.vault.file(inside.path)).not.toBe(inside.file);
    // If newer entries disappear, an older listed entry can enter the window again.
    current = entries.slice(0, 20);
    await h.ingestion.refreshAll();
    expect(urls(h.store)).toEqual(entries.map((entry) => entry.url).sort());
    expect(h.vault.file(outside.path)).toBeDefined();
    expect(h.vault.file(outside.path)).not.toBe(outside.file);
  });

  it('treats a repeated subscription to the normalized URL as a no-op', async () => {
    const h = host();
    serve(() => response(xml([])));
    await h.ingestion.subscribe(FEED);
    const count = request.mock.calls.length;
    await h.ingestion.subscribe(` ${FEED}#fragment `);
    expect(h.store.catalog.feeds()).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(count);
  });

  it('deduplicates concurrent subscriptions before creating a feed note', async () => {
    const h = host();
    serve(() => response(xml([])));
    await Promise.all([h.ingestion.subscribe(FEED), h.ingestion.subscribe(`${FEED}#duplicate`)]);
    expect(h.store.catalog.feeds()).toHaveLength(1);
  });

  it('records a feed failure and clears it after a successful retry', async () => {
    const h = host(),
      feed = await seedFeed(h);
    serve(() => response('', 503));
    await h.ingestion.refreshAll();
    expect(h.store.catalog.feed(feed.path)?.error).toBe('Feed returned HTTP 503.');
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('Feed returned HTTP 503.'));
    serve(() => response(xml([])));
    await h.ingestion.refreshAll();
    expect(
      readDocument(await h.vault.read(h.vault.file(feed.path)!)).properties.error,
    ).toBeUndefined();
  });
});

describe('subscription filename allocation and external metadata', () => {
  it('serializes different concurrent feed URLs with the same hostname through local note creation', async () => {
    const h = host(),
      secondUrl = 'https://example.com/other-feed.xml';
    const entered = deferred<void>(),
      release = deferred<void>(),
      create = h.vault.create.bind(h.vault);
    const creating = vi.spyOn(h.vault, 'create').mockImplementationOnce(async (path, content) => {
      entered.resolve();
      await release.promise;
      return create(path, content);
    });
    serve((url) => response(xml([item(url === FEED ? 1 : 2)])));
    const results = [
      observe(h.ingestion.subscribe(FEED)),
      observe(h.ingestion.subscribe(secondUrl)),
    ];
    await entered.promise;
    try {
      await flush(); // Drain the other queued addition without sleeps; the first create is still blocked.
      expect(creating.mock.calls.map(([path]) => path)).toEqual(['Reading/Wires/example.com.md']);
    } finally {
      release.resolve();
    }
    expect((await Promise.all(results)).map((result) => result.error)).toEqual([
      undefined,
      undefined,
    ]);
    const subscriptions = h.store.catalog.feeds();
    expect(subscriptions.map((feed) => feed.path).sort()).toEqual([
      'Reading/Wires/example.com 2.md',
      'Reading/Wires/example.com.md',
    ]);
    expect(subscriptions.map((feed) => feed.url).sort()).toEqual([FEED, secondUrl].sort());
    expect(request).not.toHaveBeenCalled();
    expect(urls(h.store)).toEqual([]);
    await h.ingestion.refreshAll();
    for (const [url, id] of [
      [FEED, 1],
      [secondUrl, 2],
    ] as const) {
      const feed = subscriptions.find((feed) => feed.url === url)!;
      const persisted = readDocument(await h.vault.read(h.vault.file(feed.path)!));
      expect(persisted.properties).toMatchObject({
        type: 'feed',
        title: 'example.com',
        url,
        enabled: true,
      });
      const article = await h.store.read(h.store.catalog.findUrl(item(id).url)!.path);
      expect(article.properties.feed).toBe(vaultLink(feed.path));
      expect(article.body).toBe(await feeds.feedMarkdown(item(id)));
    }
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('uses vault.exists to skip a folder and a case-alias collision without touching either', async () => {
    const h = host(),
      folder = 'Reading/Wires/example.com.md';
    const alias = await h.vault.create(
      'Reading/Wires/EXAMPLE.COM 2.md',
      '# Existing user note\n\nPreserve me exactly.\n',
    );
    const before = await h.vault.read(alias);
    const exists = vi.fn(
      (path: string) =>
        path === folder ||
        [...h.vault.files.keys()].some((existing) => existing.toLowerCase() === path.toLowerCase()),
    );
    Object.assign(h.vault, { exists });
    const create = h.vault.create.bind(h.vault);
    const creating = vi.spyOn(h.vault, 'create').mockImplementation(async (path, content) => {
      if (path === folder || path.toLowerCase() === alias.path.toLowerCase())
        throw new Error('Native folder/case collision');
      return create(path, content);
    });
    serve(() => response(xml([])));
    await h.ingestion.subscribe(FEED);
    expect(exists.mock.calls.map(([path]) => path)).toEqual([
      'Reading/Wires/example.com.md',
      'Reading/Wires/example.com 2.md',
      'Reading/Wires/example.com 3.md',
    ]);
    expect(creating.mock.calls.map(([path]) => path)).toEqual(['Reading/Wires/example.com 3.md']);
    expect(h.store.catalog.feeds().map((feed) => feed.path)).toEqual([
      'Reading/Wires/example.com 3.md',
    ]);
    expect(await h.vault.read(alias)).toBe(before);
    expect(h.vault.file(folder)).toBeUndefined();
    expect(h.vault.files.size).toBe(2);
  });

  it('fails closed after 1000 occupied subscription names instead of looping or overwriting', async () => {
    const h = host(),
      exists = vi.fn(() => true);
    Object.assign(h.vault, { exists });
    const create = vi.spyOn(h.vault, 'create');
    serve(() => response(xml([])));
    await expect(h.ingestion.subscribe(FEED)).rejects.toThrow(
      'Too many subscriptions share this filename.',
    );
    expect(exists).toHaveBeenCalledTimes(1000);
    expect(exists).toHaveBeenLastCalledWith('Reading/Wires/example.com 1000.md');
    expect(create).not.toHaveBeenCalled();
    expect(h.vault.files.size).toBe(0);
    expect(h.store.catalog.feeds()).toEqual([]);
  });

  it.each([
    '<% tp.user.untrusted() %>',
    '`= this.file.name`',
    '`$= dv.current().file.name`',
    '```dataview\nLIST\n```',
  ])('never persists externally supplied feed titles on Add or Sync: %s', async (title) => {
    const h = host();
    const parse = vi.spyOn(feeds, 'parseFeed').mockReturnValue({ title, items: [] });
    serve(() => response(xml([])));
    await h.ingestion.subscribe(FEED);
    expect(request).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    const feed = h.store.catalog.feeds()[0],
      file = h.vault.file(feed.path)!;
    const before = await h.vault.read(file);
    expect(readDocument(before).properties.title).toBe('example.com');
    await h.ingestion.refreshAll();
    expect(parse).toHaveBeenCalledOnce();
    expect(await h.vault.read(file)).toBe(before);
    expect(h.vault.files.size).toBe(1);
    expect(urls(h.store)).toEqual([]);
  });
});

describe('subscription caller cancellation', () => {
  it('rejects an already-aborted caller without issuing a request or creating notes', async () => {
    const h = host(),
      controller = new AbortController();
    controller.abort();
    await expect(h.ingestion.subscribe(FEED, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(request).not.toHaveBeenCalled();
    expect(h.vault.files.size).toBe(0);
  });

  it.each([1, 2])(
    'cancels a pending local create after all %s joined callers close and permits retry',
    async (count) => {
      const h = host(),
        pending = pausedSubscriptionCreate(h);
      const controllers = Array.from({ length: count }, () => new AbortController());
      const results = controllers.map((controller) =>
        observe(h.ingestion.subscribe(FEED, controller.signal)),
      );
      await pending.entered.promise;
      controllers.forEach((controller) => controller.abort());
      expect(
        (await Promise.all(results)).every((result) => result.error?.name === 'AbortError'),
      ).toBe(true);
      pending.release.resolve();
      await flush();
      expect(h.vault.files.size).toBe(0);
      expect(h.store.catalog.feeds()).toEqual([]);
      await h.ingestion.subscribe(FEED);
      expect(h.store.catalog.feeds()).toHaveLength(1);
      expect(urls(h.store)).toEqual([]);
      expect(request).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
    },
  );

  it.each([0, 1])(
    'keeps shared normalized-URL creation alive when caller %s cancels',
    async (cancelled) => {
      const h = host(),
        pending = pausedSubscriptionCreate(h);
      const controllers = [new AbortController(), new AbortController()];
      const removed = controllers.map((controller) =>
        vi.spyOn(controller.signal, 'removeEventListener'),
      );
      const results = [observe(h.ingestion.subscribe(FEED, controllers[0].signal))];
      await pending.entered.promise;
      results.push(observe(h.ingestion.subscribe(` ${FEED}#joined `, controllers[1].signal)));
      controllers[cancelled].abort();
      expect((await results[cancelled]).error).toMatchObject({ name: 'AbortError' });
      pending.release.resolve();
      expect((await results[1 - cancelled]).error).toBeUndefined();
      expect(h.store.catalog.feeds()).toHaveLength(1);
      expect(urls(h.store)).toEqual([]);
      expect(request).not.toHaveBeenCalled();
      removed.forEach((remove) =>
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function)),
      );
      expect(h.notify).not.toHaveBeenCalled();
    },
  );

  it('removes caller listeners and shared tracking after a local failure so a live signal can retry', async () => {
    const h = host(),
      controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    vi.spyOn(h.store.vault, 'create').mockRejectedValueOnce(new Error('Disk unavailable.'));
    await expect(h.ingestion.subscribe(FEED, controller.signal)).rejects.toThrow(
      'Disk unavailable.',
    );
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(h.vault.files.size).toBe(0);
    await h.ingestion.subscribe(FEED, controller.signal);
    expect(h.store.catalog.feeds()).toHaveLength(1);
    expect(urls(h.store)).toEqual([]);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(request).not.toHaveBeenCalled();
  });

  it('allows a new live caller to join a pending local create after earlier callers closed', async () => {
    const h = host(),
      controller = new AbortController(),
      pending = pausedSubscriptionCreate(h);
    const cancelled = observe(h.ingestion.subscribe(FEED, controller.signal));
    await pending.entered.promise;
    controller.abort();
    expect((await cancelled).error).toMatchObject({ name: 'AbortError' });
    const live = h.ingestion.subscribe(FEED);
    pending.release.resolve();
    await live;
    expect(h.store.catalog.feeds()).toHaveLength(1);
    expect(urls(h.store)).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it('does not start queued subscription work after its caller cancels', async () => {
    const h = host(),
      controller = new AbortController();
    const files = await Promise.all([1, 2].map((id) => h.store.capture({ url: item(id).url })));
    const pending = deferred<ReturnType<typeof response>>();
    serve(() => pending.promise);
    const active = files.map((file) => h.ingestion.acquire(file.path));
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    const cancelled = observe(h.ingestion.subscribe(FEED, controller.signal));
    controller.abort();
    expect((await cancelled).error).toMatchObject({ name: 'AbortError' });
    pending.resolve(response());
    await Promise.all(active);
    await flush();
    expect(request.mock.calls.map(([options]) => (options as RequestUrlParam).url)).toEqual([
      item(1).url,
      item(2).url,
    ]);
    expect(h.store.catalog.feeds()).toEqual([]);
    expect(h.vault.files.size).toBe(2);
  });

  it.each(['abort', 'stop'] as const)(
    'guards feed creation after a folder await when callers %s',
    async (action) => {
      const h = host(),
        controller = new AbortController(),
        pending = pausedSubscriptionCreate(h);
      const result = observe(h.ingestion.subscribe(FEED, controller.signal));
      await pending.entered.promise;
      expect(pending.creating.mock.calls[0][2]).toBeTypeOf('function');
      if (action === 'abort') controller.abort();
      else h.ingestion.stop();
      pending.release.resolve();
      expect((await result).error).toMatchObject(
        action === 'abort' ? { name: 'AbortError' } : { message: 'Reader has stopped.' },
      );
      await flush();
      expect(h.vault.files.size).toBe(0);
      expect(h.store.catalog.feeds()).toEqual([]);
      expect(request).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
    },
  );

  it('allows feed creation after a folder await if another joined caller is still live', async () => {
    const h = host(),
      controller = new AbortController(),
      pending = pausedSubscriptionCreate(h);
    const cancelled = observe(h.ingestion.subscribe(FEED, controller.signal));
    await pending.entered.promise;
    const live = h.ingestion.subscribe(FEED);
    controller.abort();
    expect((await cancelled).error).toMatchObject({ name: 'AbortError' });
    pending.release.resolve();
    await live;
    expect(h.store.catalog.feeds()).toHaveLength(1);
    expect(urls(h.store)).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it('does not undo an already-dispatched subscription create when its caller closes', async () => {
    const h = host(),
      controller = new AbortController();
    const entered = deferred<void>(),
      release = deferred<void>(),
      create = h.store.vault.create.bind(h.store.vault);
    vi.spyOn(h.store.vault, 'create').mockImplementationOnce(async (path, raw, guard) => {
      await guard?.();
      const file = await create(path, raw);
      entered.resolve();
      await release.promise;
      return file;
    });
    const result = observe(h.ingestion.subscribe(FEED, controller.signal));
    await entered.promise;
    const file = [...h.vault.files.values()][0],
      before = await h.vault.read(file);
    controller.abort();
    expect((await result).error).toMatchObject({ name: 'AbortError' });
    release.resolve();
    await flush();
    expect(h.store.catalog.feeds()).toHaveLength(1);
    expect(urls(h.store)).toEqual([]);
    expect(h.vault.files.size).toBe(1);
    expect(await h.vault.read(file)).toBe(before);
    expect(request).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('does not bind a later explicit Sync to the completed Add caller lifetime', async () => {
    const h = host(),
      controller = new AbortController();
    await h.ingestion.subscribe(FEED, controller.signal);
    expect(request).not.toHaveBeenCalled();
    const folder = deferred<void>(),
      entered = deferred<void>(),
      create = h.store.vault.create.bind(h.store.vault);
    const creating = vi
      .spyOn(h.store.vault, 'create')
      .mockImplementationOnce(async (path, raw, guard) => {
        entered.resolve();
        await folder.promise;
        await guard?.();
        return create(path, raw);
      });
    serve(() => response(xml([item(1)])));
    const syncing = h.ingestion.refreshAll();
    await entered.promise;
    expect(creating.mock.calls[0][2]).toBeTypeOf('function');
    controller.abort();
    folder.resolve();
    await syncing;
    expect(h.store.catalog.feeds()).toHaveLength(1);
    expect(urls(h.store)).toEqual([item(1).url]);
    expect(h.store.catalog.feeds()[0].error).toBeUndefined();
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe('exact excerpt ownership and stale acquisition', () => {
  it.each([
    { related: '[[Topics/X.md]]' },
    { related: { nested: [{ title: '[[Topics/X.md]]' }] } },
  ])(
    'protects authored YAML links before any excerpt-proof or extraction request: %j',
    async (properties) => {
      const h = host(),
        { file } = await seedExcerpt(h);
      const before = await h.vault.process(file, (raw) => patchProperties(raw, properties));
      await h.ingestion.acquire(file.path);
      expect(request).not.toHaveBeenCalled();
      expect(extraction).not.toHaveBeenCalled();
      expect(await h.vault.read(file)).toBe(before);
    },
  );

  it('still acquires a feed excerpt with literal wiki syntax in native source/state fields', async () => {
    const h = host(),
      { file } = await seedExcerpt(h);
    await h.vault.process(file, (raw) =>
      patchProperties(raw, {
        reading_position: 'quote:[[Topics/X.md]]',
        title: '[[Literal publisher title]]',
      }),
    );
    serve((url) => response(url === FEED ? xml([item(1)]) : FULL));
    await h.ingestion.acquire(file.path);
    const saved = await h.store.read(file.path);
    expect(saved.body).toBe(`\n${FULL}\n`);
    expect(saved.properties.reading_position).toBe('quote:[[Topics/X.md]]');
    expect(saved.properties.title).toBe('[[Literal publisher title]]');
    expect(extraction).toHaveBeenCalledOnce();
  });

  it('acquires an empty URL capture, fills a missing title, and then protects the saved body', async () => {
    const h = host(),
      file = await h.store.capture({ url: item(1).url });
    serve(() => response());
    await h.ingestion.acquire(file.path);
    expect(await h.store.read(file.path)).toMatchObject({
      body: `\n${FULL}\n`,
      properties: { title: 'Extracted title' },
    });
    await h.ingestion.acquire(file.path);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('re-proves an exact excerpt outside the latest 20 after restart, preserving titles/unknown metadata', async () => {
    const h = host(),
      { file } = await seedExcerpt(h);
    await h.vault.process(file, (raw) =>
      patchProperties(raw, { title: 'My title', custom: { keep: true }, error: 'Old failure' }),
    );
    h.ingestion.stop();
    const ingestion = new Ingestion(h.store, h.notify);
    running.push(ingestion);
    serve((url) =>
      response(url === FEED ? xml(Array.from({ length: 25 }, (_, i) => item(i + 1))) : FULL),
    );
    await ingestion.acquire(file.path);
    const saved = await h.store.read(file.path);
    expect(saved.body).toBe(`\n${FULL}\n`);
    expect(saved.properties).toMatchObject({
      title: 'My title',
      custom: { keep: true },
      url: item(1).url,
    });
    expect(saved.properties.error).toBeUndefined();
    expect(request.mock.calls.map(([options]) => (options as RequestUrlParam).url)).toEqual([
      FEED,
      item(1).url,
    ]);
  });

  it.each([
    'trailing whitespace',
    'authored heading',
    'CRLF',
    'highlight',
    'topics',
    'full feed content',
    'missing entry',
    'missing feed',
  ] as const)('does not replace protected text: %s', async (kind) => {
    const h = host(),
      { file, feed } = await seedExcerpt(h);
    let entries = [item(1)];
    await h.vault.process(file, (raw) => {
      switch (kind) {
        case 'trailing whitespace':
          return raw + ' ';
        case 'authored heading':
          return raw + '\n## My notes\n';
        case 'CRLF':
          return raw.replace(/\n/g, '\r\n');
        case 'highlight':
          return raw.replace('Publisher summary.', '==Publisher summary.==');
        case 'topics':
          return patchProperties(raw, { topics: ['[[My topic]]'] });
        case 'full feed content':
          entries = [item(1, { excerpt: false })];
          return raw;
        case 'missing entry':
          entries = [item(2)];
          return raw;
        case 'missing feed':
          h.store.catalog.remove(feed.path);
          return raw;
      }
    });
    const before = await h.vault.read(file);
    serve(() => response(xml(entries)));
    await h.ingestion.acquire(file.path);
    expect(extraction).not.toHaveBeenCalled();
    expect(await h.vault.read(file)).toBe(before);
  });

  it('deduplicates concurrent acquisition of the same path including foreground requests', async () => {
    const h = host(),
      file = await h.store.capture({ url: item(1).url });
    const pending = deferred<ReturnType<typeof response>>(),
      entered = deferred<void>();
    serve(() => {
      entered.resolve();
      return pending.promise;
    });
    const first = h.ingestion.acquire(file.path);
    expect(h.ingestion.acquire(file.path, true)).toBe(first);
    await entered.promise;
    pending.resolve(response());
    await first;
    expect(extraction).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['body edit', 'property edit', 'move', 'replace', 'delete', 'dirty editor'] as const)(
    'rejects a late extraction after a %s without writing content or an error',
    async (change) => {
      const h = host(),
        file = await h.store.capture({ url: item(1).url });
      const pending = deferred<ReturnType<typeof response>>(),
        entered = deferred<void>();
      serve(() => {
        entered.resolve();
        return pending.promise;
      });
      const result = observe(h.ingestion.acquire(file.path));
      await entered.promise;
      const snapshot = await h.store.read(file.path);
      switch (change) {
        case 'body edit':
          await h.vault.process(file, (raw) => raw + '\nAuthored while fetching.\n');
          break;
        case 'property edit':
          await h.vault.process(file, (raw) => patchProperties(raw, { url: item(2).url }));
          break;
        case 'move':
          await h.store.move(snapshot, 'Later');
          break;
        case 'replace': {
          await h.vault.trash(file);
          await h.vault.create(file.path, snapshot.raw);
          break;
        }
        case 'delete':
          await h.store.trash(snapshot);
          break;
        case 'dirty editor':
          h.vault.dirty.add(file);
          break;
      }
      const before = new Map(h.vault.bytes);
      pending.resolve(response());
      const { error } = await result;
      if (change === 'dirty editor')
        expect(error).toMatchObject({ message: expect.stringContaining('unfinished edits') });
      else expect(error).toBeInstanceOf(ChangedNote);
      expect(h.vault.bytes).toEqual(before);
    },
  );

  it('rechecks fresh bytes inside the process callback, not just before scheduling the write', async () => {
    const h = host(),
      file = await h.store.capture({ url: item(1).url });
    const writing = deferred<void>(),
      entered = deferred<void>(),
      process = h.vault.process.bind(h.vault);
    vi.spyOn(h.vault, 'process').mockImplementationOnce(async (target, update) => {
      entered.resolve();
      await writing.promise;
      return process(target, update);
    });
    serve(() => response());
    const result = observe(h.ingestion.acquire(file.path));
    await entered.promise;
    const edited = await process(file, (raw) => raw + '\nChanged immediately before commit.\n');
    writing.resolve();
    expect((await result).error).toBeInstanceOf(ChangedNote);
    expect(await h.vault.read(file)).toBe(edited);
  });

  it('does not let a late extraction failure stamp newer note bytes', async () => {
    const h = host(),
      file = await h.store.capture({ url: item(1).url });
    const pending = deferred<ReturnType<typeof response>>(),
      entered = deferred<void>();
    serve(() => {
      entered.resolve();
      return pending.promise;
    });
    const result = observe(h.ingestion.acquire(file.path));
    await entered.promise;
    const edited = await h.vault.process(file, (raw) => raw + '\nMy new text.\n');
    pending.resolve(response('', 403));
    expect((await result).error).toMatchObject({ message: 'Article returned HTTP 403.' });
    expect(await h.vault.read(file)).toBe(edited);
  });

  it('preserves a proven excerpt on extraction failure and clears the error on retry', async () => {
    const h = host(),
      { file } = await seedExcerpt(h);
    const original = await h.store.read(file.path);
    let failed = true;
    serve((url) => (url === FEED ? response(xml([item(1)])) : response(FULL, failed ? 503 : 200)));
    await expect(h.ingestion.acquire(file.path)).rejects.toThrow('Article returned HTTP 503.');
    expect(await h.store.read(file.path)).toMatchObject({
      body: original.body,
      properties: { url: item(1).url, error: 'Article returned HTTP 503.' },
    });
    failed = false;
    await h.ingestion.acquire(file.path);
    expect((await h.store.read(file.path)).properties.error).toBeUndefined();
    expect((await h.store.read(file.path)).body).toBe(`\n${FULL}\n`);
    expect(
      request.mock.calls.filter(([options]) => (options as RequestUrlParam).url === FEED),
    ).toHaveLength(1);
  });

  it('records failures while fetching excerpt ownership proof, not only extraction failures', async () => {
    const h = host(),
      { file } = await seedExcerpt(h);
    const original = await h.store.read(file.path);
    serve(() => response('', 503));
    await expect(h.ingestion.acquire(file.path)).rejects.toThrow('Feed returned HTTP 503.');
    const saved = await h.store.read(file.path);
    expect(saved.body).toBe(original.body);
    expect(saved.properties.error).toBe('Feed returned HTTP 503.');
  });

  it('does not stamp a stale note when ownership-proof retrieval fails', async () => {
    const h = host(),
      { file } = await seedExcerpt(h);
    const pending = deferred<ReturnType<typeof response>>(),
      entered = deferred<void>();
    serve(() => {
      entered.resolve();
      return pending.promise;
    });
    const result = observe(h.ingestion.acquire(file.path));
    await entered.promise;
    const edited = await h.vault.process(file, (raw) => raw + '\nMy newer source text.\n');
    pending.resolve(response('', 503));
    expect((await result).error).toMatchObject({ message: 'Feed returned HTTP 503.' });
    expect(await h.vault.read(file)).toBe(edited);
    expect(extraction).not.toHaveBeenCalled();
  });

  it('records ownership-proof conversion failure without replacing the excerpt', async () => {
    const h = host(),
      { file } = await seedExcerpt(h);
    const original = await h.store.read(file.path);
    vi.spyOn(feeds, 'feedMarkdown').mockRejectedValueOnce(new Error('Conversion failed'));
    serve(() => response(xml([item(1)])));
    await expect(h.ingestion.acquire(file.path)).rejects.toThrow('Conversion failed');
    expect(await h.store.read(file.path)).toMatchObject({
      body: original.body,
      properties: { error: 'Conversion failed' },
    });
    expect(extraction).not.toHaveBeenCalled();
  });

  it('does not start requests while offline', async () => {
    const h = host(),
      file = await h.store.capture({ url: item(1).url });
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await h.ingestion.acquire(file.path);
    expect(request).not.toHaveBeenCalled();
    expect((await h.store.read(file.path)).body).toBe('');
  });
});

describe('external extraction commit boundary', () => {
  const unsafeResults = [
    { field: 'title', value: '<% tp.user.untrusted() %>' },
    { field: 'title', value: '`= this.file.name`' },
    { field: 'title', value: '`$= dv.current().file.name`' },
    { field: 'markdown', value: 'Publisher prose with <% tp.user.untrusted() %>.' },
    { field: 'markdown', value: 'Publisher prose with `= this.file.name`.' },
    { field: 'markdown', value: 'Publisher prose with `$= dv.current().file.name`.' },
    { field: 'markdown', value: '```dataviewjs\ndv.current()\n```' },
  ] as const;
  it.each(unsafeResults)(
    'rejects unsafe extracted $field without committing text/title: $value',
    async ({ field, value }) => {
      const h = host(),
        { file } = await seedExcerpt(h);
      await h.vault.process(file, (raw) =>
        patchProperties(raw, { custom: { preserve: 'user YAML' } }),
      );
      const before = await h.store.read(file.path),
        acquire = vi.spyOn(h.store, 'acquire');
      extraction.mockResolvedValue({
        title: 'Safe extracted title',
        markdown: FULL,
        [field]: value,
      });
      serve(() => response(xml([item(1)])));
      await expect(h.ingestion.acquire(file.path)).rejects.toThrow(
        'Cannot capture publisher content',
      );
      const saved = await h.store.read(file.path),
        { error, ...properties } = saved.properties;
      expect(acquire).not.toHaveBeenCalled();
      expect(extraction).toHaveBeenCalledOnce();
      expect(saved.body).toBe(before.body);
      expect(properties).toEqual(before.properties);
      expect(saved.path).toBe(before.path);
      expect(error).toEqual(expect.stringContaining('Cannot capture publisher content'));
      expect(saved.raw).not.toContain(value);
      expect(h.vault.trashed).toEqual([]);
    },
  );

  it('does not persist a malicious extraction title into an empty capture or rename its file', async () => {
    const h = host(),
      file = await h.store.capture({ url: item(1).url }),
      path = file.path;
    const move = vi.spyOn(h.vault, 'move'),
      acquire = vi.spyOn(h.store, 'acquire');
    extraction.mockResolvedValue({ title: '<% tp.user.untrusted() %>', markdown: FULL });
    await expect(h.ingestion.acquire(path)).rejects.toThrow('Cannot capture publisher content');
    const saved = await h.store.read(path);
    expect(saved.body).toBe('');
    expect(saved.properties.title).toBeUndefined();
    expect(saved.properties.url).toBe(item(1).url);
    expect(saved.raw).not.toContain('<%');
    expect(file.path).toBe(path);
    expect(acquire).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('unsubscribe and unload cancellation', () => {
  it.each(['unsubscribe', 'disable'] as const)(
    'stops a pending refresh after %s and preserves existing articles',
    async (action) => {
      const h = host(),
        feed = await seedFeed(h);
      const kept = await h.store.capture({
        url: item(1).url,
        body: 'Already saved.',
        feed: vaultLink(feed.path),
        queue: 'Stream',
      });
      const before = await h.vault.read(kept);
      const pending = deferred<ReturnType<typeof response>>(),
        entered = deferred<void>();
      serve(() => {
        entered.resolve();
        return pending.promise;
      });
      const refreshing = h.ingestion.refreshAll();
      await entered.promise;
      if (action === 'unsubscribe') await h.ingestion.unsubscribe(feed);
      else await h.ingestion.setFeed(feed, false);
      pending.resolve(response(xml([item(2)])));
      await refreshing;
      expect(urls(h.store)).toEqual([item(1).url]);
      expect(await h.vault.read(kept)).toBe(before);
      expect(h.notify).not.toHaveBeenCalled();
    },
  );

  it.each(['unsubscribe', 'disable'] as const)(
    'revalidates %s after asynchronous excerpt conversion, before capture',
    async (action) => {
      const h = host(),
        feed = await seedFeed(h);
      const conversion = deferred<void>(),
        entered = deferred<void>(),
        original = feeds.feedMarkdown;
      vi.spyOn(feeds, 'feedMarkdown').mockImplementationOnce(async (entry) => {
        entered.resolve();
        await conversion.promise;
        return original(entry);
      });
      serve(() => response(xml([item(1)])));
      const refreshing = h.ingestion.refreshAll();
      await entered.promise;
      if (action === 'unsubscribe') await h.ingestion.unsubscribe(feed);
      else await h.ingestion.setFeed(feed, false);
      conversion.resolve();
      await refreshing;
      expect(urls(h.store)).toEqual([]);
    },
  );

  it.each(['unsubscribe', 'disable'] as const)(
    'does not start a queued feed request after %s',
    async (action) => {
      const h = host();
      const feedUrls = [1, 2, 3].map((id) => `https://example.com/feed-${id}.xml`);
      const subscriptions = await Promise.all(
        feedUrls.map((url, i) => seedFeed(h, url, `Reading/Wires/Feed ${i}.md`)),
      );
      const pending = deferred<ReturnType<typeof response>>();
      serve(() => pending.promise);
      const refreshing = h.ingestion.refreshAll();
      await flush();
      expect(request).toHaveBeenCalledTimes(2);
      if (action === 'unsubscribe') await h.ingestion.unsubscribe(subscriptions[2]);
      else await h.ingestion.setFeed(subscriptions[2], false);
      pending.resolve(response(xml([])));
      await refreshing;
      expect(request.mock.calls.map(([options]) => (options as RequestUrlParam).url)).toEqual(
        feedUrls.slice(0, 2),
      );
    },
  );

  it('stops after asynchronous excerpt conversion without capturing an article', async () => {
    const h = host();
    await seedFeed(h);
    const conversion = deferred<void>(),
      entered = deferred<void>(),
      original = feeds.feedMarkdown;
    vi.spyOn(feeds, 'feedMarkdown').mockImplementationOnce(async (entry) => {
      entered.resolve();
      await conversion.promise;
      return original(entry);
    });
    serve(() => response(xml([item(1)])));
    const refreshing = h.ingestion.refreshAll();
    await entered.promise;
    h.ingestion.stop();
    conversion.resolve();
    await refreshing;
    expect(urls(h.store)).toEqual([]);
  });

  it.each(['unsubscribe', 'disable', 'source disable', 'replace', 'stop'] as const)(
    'revalidates %s inside a capture queued behind another create',
    async (action) => {
      const h = host(),
        feed = await seedFeed(h);
      const blocked = deferred<void>(),
        entered = deferred<void>(),
        queued = deferred<void>();
      const create = h.vault.create.bind(h.vault),
        capture = h.store.capture.bind(h.store);
      vi.spyOn(h.vault, 'create').mockImplementationOnce(async (path, raw) => {
        entered.resolve();
        await blocked.promise;
        return create(path, raw);
      });
      vi.spyOn(h.store, 'capture').mockImplementation((...args) => {
        const result = capture(...args);
        if (args[0].feed) queued.resolve();
        return result;
      });
      const other = h.store.capture({ url: 'https://example.com/manual' });
      await entered.promise;
      serve(() => response(xml([item(1)])));
      const refreshing = h.ingestion.refreshAll();
      await queued.promise;
      if (action === 'unsubscribe') await h.ingestion.unsubscribe(feed);
      else if (action === 'disable') await h.ingestion.setFeed(feed, false);
      else if (action === 'source disable') {
        // Simulate a source edit arriving before the metadata-cache event.
        await h.vault.process(h.vault.file(feed.path)!, (raw) =>
          patchProperties(raw, { enabled: false }),
        );
      } else if (action === 'replace') {
        const file = h.vault.file(feed.path)!,
          raw = await h.vault.read(file);
        await h.vault.trash(file);
        await h.vault.create(feed.path, raw);
      } else h.ingestion.stop();
      blocked.resolve();
      await other;
      await refreshing;
      expect(urls(h.store)).toEqual(['https://example.com/manual']);
      expect(h.notify).not.toHaveBeenCalled();
    },
  );

  it('does not revive an old refresh when a subscription is disabled then re-enabled', async () => {
    const h = host(),
      feed = await seedFeed(h);
    const pending = deferred<ReturnType<typeof response>>(),
      entered = deferred<void>();
    serve(() => {
      entered.resolve();
      return pending.promise;
    });
    const refreshing = h.ingestion.refreshAll();
    await entered.promise;
    await h.ingestion.setFeed(feed, false);
    await h.ingestion.setFeed(feed, true);
    pending.resolve(response(xml([item(1)])));
    await refreshing;
    expect(urls(h.store)).toEqual([]);
    expect(h.notify).not.toHaveBeenCalled();
    await h.ingestion.refreshAll();
    expect(urls(h.store)).toEqual([item(1).url]);
  });

  it.each(['unsubscribe', 'disable'] as const)(
    'guards %s at native request start when timed-out requests still hold both slots',
    async (action) => {
      const h = host(),
        subscriptions = [];
      for (let id = 1; id <= 3; id++)
        subscriptions.push(
          await seedFeed(h, `https://example.com/feed-${id}.xml`, `Reading/Wires/Feed ${id}.md`),
        );
      const pending = [
        deferred<ReturnType<typeof response>>(),
        deferred<ReturnType<typeof response>>(),
      ];
      let count = 0;
      serve(() => (count < 2 ? pending[count++].promise : response(xml([item(1)]))));
      const refreshing = h.ingestion.refreshAll();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(request).toHaveBeenCalledTimes(2);
      if (action === 'unsubscribe') await h.ingestion.unsubscribe(subscriptions[2]);
      else await h.ingestion.setFeed(subscriptions[2], false);
      pending.forEach((held) => held.resolve(response(xml([]))));
      await refreshing;
      expect(request).toHaveBeenCalledTimes(2);
      expect(urls(h.store)).toEqual([]);
      expect(h.notify).toHaveBeenCalledTimes(2); // Only the two real timeout failures.
      expect(h.store.catalog.feed(subscriptions[2].path)?.error).toBeUndefined();
    },
  );

  it('rejects stale unsubscribe/enable operations rather than touching a different subscription', async () => {
    const h = host(),
      feed = await seedFeed(h),
      file = h.vault.file(feed.path)!;
    const changed = await h.vault.process(file, (raw) =>
      patchProperties(raw, { url: 'https://example.com/replaced.xml' }),
    );
    await expect(h.ingestion.unsubscribe(feed)).rejects.toThrow('Subscription changed');
    await expect(h.ingestion.setFeed(feed, false)).rejects.toThrow('Subscription changed');
    expect(await h.vault.read(file)).toBe(changed);
    expect(h.vault.trashed).toEqual([]);
  });

  it('stops a pending subscription create without creating a feed or article', async () => {
    const h = host(),
      pending = pausedSubscriptionCreate(h);
    const result = observe(h.ingestion.subscribe(FEED));
    await pending.entered.promise;
    h.ingestion.stop();
    pending.release.resolve();
    expect((await result).error).toBeInstanceOf(Error);
    expect(request).not.toHaveBeenCalled();
    expect(h.vault.files.size).toBe(0);
  });

  it('cancels queued acquisition on unload and never delivers active requests into disposed notes', async () => {
    const h = host(),
      files = await Promise.all([1, 2, 3].map((id) => h.store.capture({ url: item(id).url })));
    const pending = [
      deferred<ReturnType<typeof response>>(),
      deferred<ReturnType<typeof response>>(),
    ];
    let count = 0;
    serve(() => pending[count++].promise);
    const results = files.map((file) => observe(h.ingestion.acquire(file.path)));
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    const before = new Map(h.vault.bytes);
    h.ingestion.stop();
    h.store.dispose();
    expect((await results[2]).error).toMatchObject({ message: 'Reader has stopped.' });
    pending.forEach((held) => held.resolve(response()));
    expect((await Promise.all(results)).every((result) => result.error instanceof Error)).toBe(
      true,
    );
    expect(h.vault.bytes).toEqual(before);
    expect(request).toHaveBeenCalledTimes(2);
    await expect(h.ingestion.acquire(files[0].path)).rejects.toThrow('Reader has stopped.');
  });
});

describe('bounded Obsidian requestUrl delivery', () => {
  it('coalesces only equal URL/Accept pairs and forwards non-2xx responses without host throwing', async () => {
    const client = network(),
      held = deferred<ReturnType<typeof response>>();
    serve(() => held.promise);
    const first = client.get(FEED, FEED_ACCEPT);
    expect(client.get(FEED, FEED_ACCEPT)).toBe(first);
    const html = client.get(FEED, HTML_ACCEPT);
    expect(html).not.toBe(first);
    await flush();
    expect(request.mock.calls).toEqual([
      [{ url: FEED, headers: { Accept: FEED_ACCEPT }, throw: false }],
      [{ url: FEED, headers: { Accept: HTML_ACCEPT }, throw: false }],
    ]);
    held.resolve(response('Unavailable', 503));
    expect(await first).toEqual({
      text: 'Unavailable',
      status: 503,
      headers: { 'content-type': 'text/html' },
    });
    await html;
    await flush();
    await client.get(FEED, FEED_ACCEPT);
    await flush();
    expect(request).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares a queued native request if any coalesced consumer remains valid', async () => {
    const client = network(),
      held = deferred<ReturnType<typeof response>>();
    serve((url) => (url === FEED ? response(xml([])) : held.promise));
    const active = [1, 2].map((id) => client.get(item(id).url, HTML_ACCEPT));
    const first = client.get(FEED, FEED_ACCEPT, () => {
      throw new Error('Consumer cancelled');
    });
    const second = client.get(FEED, FEED_ACCEPT, () => {});
    expect(second).toBe(first);
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    held.resolve(response());
    await Promise.all([...active, first, second]);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('holds at most two native slots and starts queued work only when one actually finishes', async () => {
    const client = network(),
      pending = Array.from({ length: 4 }, () => deferred<ReturnType<typeof response>>());
    let count = 0;
    serve(() => pending[count++].promise);
    const results = [1, 2, 3, 4].map((id) => client.get(item(id).url, HTML_ACCEPT));
    await flush();
    expect(count).toBe(2);
    pending[1].resolve(response('second'));
    await flush();
    expect(count).toBe(3);
    pending[0].resolve(response('first'));
    await flush();
    expect(count).toBe(4);
    pending[2].resolve(response('third'));
    pending[3].resolve(response('fourth'));
    expect((await Promise.all(results)).map((result) => result.text)).toEqual([
      'first',
      'second',
      'third',
      'fourth',
    ]);
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires delivery at exactly 20 seconds without freeing uncancellable native slots', async () => {
    const client = network(),
      pending = Array.from({ length: 3 }, () => deferred<ReturnType<typeof response>>());
    let count = 0;
    serve(() => pending[count++].promise);
    const first = client.get(item(1).url, HTML_ACCEPT),
      second = client.get(item(2).url, HTML_ACCEPT);
    let delivered = 0;
    const firstResult = observe(first).then((result) => {
      delivered++;
      return result;
    });
    const secondResult = observe(second).then((result) => {
      delivered++;
      return result;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const third = client.get(item(3).url, HTML_ACCEPT),
      thirdResult = observe(third);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(delivered).toBe(0);
    expect(count).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect((await firstResult).error).toMatchObject({
      message: expect.stringContaining('timed out'),
    });
    expect((await secondResult).error).toMatchObject({
      message: expect.stringContaining('timed out'),
    });
    expect(count).toBe(2);
    expect(client.get(item(1).url, HTML_ACCEPT)).toBe(first);
    pending[0].resolve(response('too late'));
    await flush();
    expect(count).toBe(3);
    pending[2].resolve(response('third succeeded'));
    expect((await thirdResult).value?.text).toBe('third succeeded');
    pending[1].resolve(response('also too late'));
    await flush();
    expect(delivered).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('includes queue wait in the deadline and never issues an already expired queued request', async () => {
    const client = network(),
      pending = [deferred<ReturnType<typeof response>>(), deferred<ReturnType<typeof response>>()];
    let count = 0;
    serve(() => pending[count++].promise);
    const results = [1, 2, 3].map((id) => observe(client.get(item(id).url, HTML_ACCEPT)));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(
      (await Promise.all(results)).every((result) => /timed out/.test(result.error?.message)),
    ).toBe(true);
    expect(count).toBe(2);
    pending.forEach((held) => held.resolve(response()));
    await flush();
    expect(count).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases failed requests for retry and clears their deadline timers', async () => {
    const client = network();
    serve(() => Promise.reject(new Error('Host is offline')));
    await expect(client.get(FEED, FEED_ACCEPT)).rejects.toThrow('Host is offline');
    expect(vi.getTimerCount()).toBe(0);
    serve(() => response(xml([])));
    await expect(client.get(FEED, FEED_ACCEPT)).resolves.toMatchObject({ status: 200 });
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects queued/new work on stop, suppresses late active delivery, and clears timers', async () => {
    const client = network(),
      pending = [deferred<ReturnType<typeof response>>(), deferred<ReturnType<typeof response>>()];
    let count = 0;
    serve(() => pending[count++].promise);
    const results = [1, 2, 3].map((id) => observe(client.get(item(id).url, HTML_ACCEPT)));
    await flush();
    client.stop();
    expect((await results[2]).error).toMatchObject({ message: 'Reader has stopped.' });
    await expect(client.get(item(4).url, HTML_ACCEPT)).rejects.toThrow('Reader has stopped.');
    pending.forEach((held) => held.resolve(response()));
    expect((await Promise.all(results)).every((result) => result.error instanceof Error)).toBe(
      true,
    );
    expect(count).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
