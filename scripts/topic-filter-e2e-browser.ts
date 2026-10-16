import { TFile } from 'obsidian';
import { syntheticTopicProvider } from './topic-filter-e2e-provider';
import { ReaderView } from '../src/reader/view';
import { ArticleStore } from '../src/core/store';
import { createDocument, readDocument } from '../src/core/document';
import { MemoryVault } from '../tests/helpers/memory-vault';

const vault = new MemoryVault();
const store = new ArticleStore(vault);
const writes: string[] = [];
const acquisitions: unknown[] = [];
const reads: string[] = [];
const read = vault.read.bind(vault);
vault.read = async (file) => {
  reads.push(file.path);
  return read(file);
};
const process = vault.process.bind(vault);
let nextProcessFailure: { path: string; message: string } | null = null;
vault.process = async (file, update) => {
  if (nextProcessFailure?.path === file.path) {
    const { message } = nextProcessFailure;
    nextProcessFailure = null;
    throw new Error(message);
  }
  const result = await process(file, update);
  writes.push(file.path);
  file.stat.mtime++;
  file.stat.size = result.length;
  store.catalog.update(file.path, readDocument(result).properties);
  return result;
};
async function note(path, properties, body = '') {
  const file = await vault.create(path, createDocument(properties, body));
  Object.setPrototypeOf(file, TFile.prototype);
  file.stat = { mtime: 1, ctime: 1, size: vault.bytes.get(file).length };
  store.catalog.update(path, properties);
  return file;
}
await note('Topics/Climate change.md', { type: 'topic', aliases: ['Global warming', 'CC'] });
await note('Topics/Art.md', { type: 'topic', aliases: ['Painting'] });
await note('Notes/Not a topic.md', { type: 'note', aliases: ['Climate change'] });
const articles = [
  ['Explicit mapping', 'inbox', 'Unrelated body.', ['[[Topics/Climate change]]']],
  ['CLIMATE CHANGE report', 'inbox', 'A title-only match.'],
  ['Body phrase', 'inbox', 'We study climate change today.'],
  ['Alias phrase', 'inbox', 'GLOBAL WARMING is discussed.'],
  ['Short alias', 'inbox', 'The CC report.'],
  ['Substring rejection', 'inbox', 'climate changes; global warmingly; account.'],
  ['Unrelated', 'inbox', 'Nothing relevant here.'],
  ['Free term body', 'inbox', 'A quasar orchard appears here.'],
  ['Free term substring', 'inbox', 'A quasar orchards appears here.'],
  ['Other queue match', 'later', 'Climate change'],
  ['Archived match', 'archive', 'Climate change'],
  ['Feed match', 'feed', 'Climate change'],
  ['Word boundary negative', 'inbox', 'partial cartography departing.'],
  ['Word boundary positive', 'inbox', 'ART and painting.'],
];
for (const [title, status, body, topics] of articles)
  await note(
    `Articles/${title}.md`,
    { type: 'article', title, status, ...(topics ? { topics } : {}) },
    body,
  );
const resolve = (path) =>
  vault.file(path) ??
  vault.file(path + '.md') ??
  [...vault.files.values()].find((f) => f.basename === path);
const app = {
  vault: {
    getMarkdownFiles: () => [...vault.files.values()],
    getAbstractFileByPath: (path) => vault.file(path),
    cachedRead: (file) => vault.read(file),
    read: (file) => vault.read(file),
  },
  metadataCache: {
    getFileCache: (file) => ({ frontmatter: readDocument(vault.bytes.get(file)).properties }),
    getFirstLinkpathDest: resolve,
  },
  workspace: {
    requestSaveLayout() {},
    getActiveViewOfType() {
      return view;
    },
    getLeaf() {
      return { async openFile() {} };
    },
  },
};
const provider = syntheticTopicProvider(app, vault, note);
app.plugins = {
  getPlugin: (id) =>
    id === 'fileclass-inline' && provider.enabled ? { api: provider.api } : undefined,
};
const header = document.createElement('header');
header.className = 'view-header';
header.setAttribute('aria-label', 'Synthetic native view title');
header.style.cssText = 'padding:8px 16px;border-bottom:1px solid #ccc';
document.querySelector('#reader').prepend(header);
const host = {
  app,
  store,
  signal: new AbortController().signal,
  paged: false,
  ingestion: {
    async acquire(...args) {
      acquisitions.push(args);
    },
  },
  capture() {},
  feeds() {},
  async edit() {},
  async refreshPresentation(current, valid) {
    if (valid()) header.textContent = current.getDisplayText();
  },
};
const leaf = { app };
const view = new ReaderView(leaf as any, host as any);
leaf.view = view;
await view.onOpen();
await view.setState({ queue: 'Inbox' }, {} as any);
header.textContent = view.getDisplayText();
view.contentEl.style.height = 'calc(100% - 40px)';
window.topicE2E = {
  view,
  provider,
  store,
  vault,
  writes,
  articles,
  acquisitions,
  reads,
  // Fail exactly one write before changing bytes. Set this immediately before Save;
  // do not open/navigate an article between arming and the intended save.
  failNextProcess(path: string, message = 'Synthetic save failure') {
    const file = vault.file(path);
    if (!file || readDocument(vault.bytes.get(file)).properties.type !== 'article')
      throw new Error('Expected an existing synthetic source article: ' + path);
    nextProcessFailure = { path: file.path, message };
  },
  clearProcessFailure() {
    nextProcessFailure = null;
  },
  resetCounters() {
    writes.length = 0;
    acquisitions.length = 0;
    reads.length = 0;
  },
  async seedMany(count = 65) {
    for (let i = 0; i < count; i++) {
      const title = `Scale ${String(i).padStart(3, '0')}`;
      await note(
        `Scale/${title}.md`,
        { type: 'article', status: 'inbox', title },
        'A pagination probe.',
      );
    }
    await view.changed({ path: 'Scale/Scale 000.md', metadataChanged: true });
  },
  async mutate(path, { body, properties } = {}) {
    const file = vault.file(path);
    if (!file) throw new Error('Unknown synthetic file: ' + path);
    const before = readDocument(vault.bytes.get(file));
    const raw = createDocument({ ...before.properties, ...properties }, body ?? before.body);
    // External edit setup: not counted as a Reader write; emit the production change entrypoint.
    vault.bytes.set(file, raw);
    file.stat.mtime++;
    file.stat.size = raw.length;
    store.catalog.update(path, readDocument(raw).properties);
    await view.changed({ path, metadataChanged: !!properties });
  },
  dump: () => [...vault.bytes].map(([file, raw]) => ({ path: file.path, raw })),
};
document.querySelector('#status').textContent =
  'Ready — production Reader view/store/surface; synthetic Obsidian host. No native proof.';
