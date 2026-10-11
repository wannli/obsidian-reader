import { expect, it, vi } from 'vitest';
import type { App, WorkspaceLeaf } from 'obsidian';
import { installArticleRouting } from '../src/routing';
import type { ArticleTemplateExclusions } from '../src/storage/classifier';

function fixture(path: string, text: string) {
  let exclusions: ArticleTemplateExclusions = {};
  const callbacks = new Map<string, () => void>();
  const leaf = {
    view: {}, getViewState: () => ({ type: 'markdown', state: { file: path } }),
    getEphemeralState: () => ({}),
  } as unknown as WorkspaceLeaf;
  const workspace = {
    iterateAllLeaves: (fn: (leaf: WorkspaceLeaf) => void) => fn(leaf),
    on: (event: string, callback: () => void) => { callbacks.set(event, callback); return {}; },
    offref: vi.fn(), onLayoutReady: (callback: () => void) => callbacks.set('ready', callback),
  };
  const vault = { getFileByPath: () => ({ path, extension: 'md' }), read: vi.fn(async () => text) };
  const metadataCache = {
    on: (_event: string, callback: () => void) => { callbacks.set('metadata', callback); return {}; },
    offref: vi.fn(), getFileCache: () => null,
  };
  const open = vi.fn();
  const routing = installArticleRouting({ app: { workspace, vault, metadataCache } as unknown as App,
    templateExclusions: () => exclusions, openReaderInLeaf: open });
  return { routing, open, leaf, vault, start: () => callbacks.get('ready')!(),
    setExclusions: (value: ArticleTemplateExclusions) => { exclusions = value; } };
}
async function settle() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
const minimal = '---\ntype: article\nurl: https://example.com/article\npublished: 2026-10-08\nstatus: inbox\ncreated-by: ai\n---\n';

it('routes explicitly typed QuickAdd articles in canonical queue folders', async () => {
  const s = fixture('Reading/Inbox/Capture.md', minimal); s.start(); await settle();
  expect(s.open).toHaveBeenCalledOnce(); expect(s.open.mock.calls[0][0]).toBe(s.leaf); s.routing.dispose();
});
it.each(['Other/URL.md', 'Reading/Inbox/URL.md', 'Reading/Articles/URL.md', 'Reading/Wires/URL.md', 'Reading/InboxExtra/URL.md'])(
  'does not infer untyped URL notes, even inside canonical queues: %s', async path => {
    const s = fixture(path, minimal.replace('type: article\n', '')); s.start(); await settle(); expect(s.open).not.toHaveBeenCalled(); s.routing.dispose();
  });
it.each(['topic', 'feed', 'project'])(
  'leaves explicit type %s native even with URL/published inside article folder', async type => {
    const s = fixture('Reading/Articles/Normal.md', minimal.replace('type: article\n', `type: ${type}\n`));
    s.start(); await settle(); expect(s.open).not.toHaveBeenCalled(); s.routing.dispose();
  });
it('routes typed URL-less manual articles outside canonical folders', async () => {
  const s = fixture('Manual/Article.md', '---\ntype: article\n---\nAuthored text.'); s.start(); await settle();
  expect(s.open).toHaveBeenCalledOnce(); s.routing.dispose();
});
it.each(['{{VALUE:URL}}', '{{VALUE:url}}', '<% tp.system.prompt("URL") %>'])(
  'leaves untyped capture template with unresolved URL native: %s', async url => {
    const s = fixture('Reading/Articles/Templates/Capture.md', '---\nurl: ' + JSON.stringify(url) + '\n---\n');
    s.start(); await settle(); expect(s.open).not.toHaveBeenCalled(); s.routing.dispose();
  });
it.each(['{{VALUE:URL}}', '{{VALUE:url}}', '<% tp.system.prompt("URL") %>'])(
  'leaves legacy typed capture template with unresolved URL native: %s', async url => {
    const s = fixture('Templates/Capture.md', '---\ntype: article\nurl: ' + JSON.stringify(url) + '\n---\n');
    s.start(); await settle(); expect(s.open).not.toHaveBeenCalled(); s.routing.dispose();
  });
it.each([
  ['Reading/Inbox/Templates/Literal.md', { folders: ['Reading/Inbox/Templates/'] }],
  ['Reading/Inbox/Reusable.md', { files: ['Reading/Inbox/Reusable.md'] }],
] as [string, ArticleTemplateExclusions][])('leaves configured literal-URL template native: %s', async (path, exclusions) => {
  for (const text of [minimal]) {
    const s = fixture(path, text); s.setExclusions(exclusions); s.start(); await settle();
    expect(s.open).not.toHaveBeenCalled(); s.routing.dispose();
  }
});
it('applies excluded folder component and file exact-match boundaries', async () => {
  for (const path of ['Reading/Inbox/TemplatesExtra/Capture.md', 'Reading/Inbox/Reusable.md-copy.md']) {
    const s = fixture(path, minimal); s.setExclusions({ folders: ['Reading/Inbox/Templates'], files: ['Reading/Inbox/Reusable.md'] });
    s.start(); await settle(); expect(s.open).toHaveBeenCalledOnce(); s.routing.dispose();
  }
});
it('reads the latest template-exclusion snapshot after the asynchronous vault read', async () => {
  const path = 'Reading/Inbox/Reusable.md', s = fixture(path, minimal); s.start();
  s.setExclusions({ files: [path] }); await settle(); expect(s.open).not.toHaveBeenCalled(); s.routing.dispose();
});
it('does not mutate article or template text during classification', async () => {
  const s = fixture('Reading/Inbox/Capture.md', minimal); s.start(); await settle();
  expect(await s.vault.read()).toBe(minimal); s.routing.dispose();
});
