/// <reference types="vite/client" />
import '../styles.css';
import './preview.css';
import { ReaderRepository } from '../src/storage/repository';
import { ReaderController } from '../src/controller';
import { DEFAULT_SETTINGS } from '../src/types';
import { ReaderApp } from '../src/ui/app';
import { BrowserStore } from './store';
import { fixtureGet, sampleBody } from './fixtures';
import { button, element } from '../src/ui/dom';
import { PreviewNativeUI } from './native-host';
import { readEinkDevice, writeEinkDevice, einkEnabled } from '../src/eink-device';
declare global { interface Window { reader: { store: BrowserStore; controller: ReaderController; app: ReaderApp; ui: PreviewNativeUI; showNote(path: string): void; setEinkForDevice(enabled: boolean, reverseButtons?: boolean): void };  } }
async function main() {
  const store = new BrowserStore(), settings = { ...DEFAULT_SETTINGS };
  const isAndroid = /Android/i.test(navigator.userAgent), einkListeners = new Set<() => void>();
  let einkDevice = readEinkDevice(window);
  const repository = new ReaderRepository(store, settings);
  const prepared = await repository.prepareStorage();
  if (prepared.errors.length) throw new Error(prepared.errors.join('\n'));
  if (!(await store.list()).length) {
    await repository.createArticle({ title: 'A little room to read', url: 'https://example.org/room-to-read', status: 'inbox', body: sampleBody });
    await repository.createArticle({ title: 'The value of paying attention', url: 'https://example.org/attention', status: 'inbox', body: sampleBody.replace('One thing at a time', 'Attention is a practice') });
    await repository.createArticle({ title: 'Notes on a slower morning', url: 'https://example.org/morning', status: 'later', body: sampleBody });
    await repository.createArticle({ title: 'What we choose to keep', url: 'https://example.org/keep', status: 'archive', body: sampleBody });
    await repository.createArticle({ title: 'A smaller reading practice', url: 'https://reader.test/article', status: 'feed' });
  }
  const controller = new ReaderController(repository, fixtureGet, settings);
  async function showNote(path: string) {
    const content = await store.read(path);
    const shade = element('div', 'preview-inspector'); const panel = element('div', 'preview-note-panel'); const pre = element('pre', '', content);
    const close = button('Close Markdown', () => shade.remove()); panel.append(element('h2', '', path), close, pre); shade.append(panel); document.body.append(shade); close.focus();
    shade.addEventListener('keydown', e => { if (e.key === 'Escape') shade.remove(); });
  }
  async function openNote(link: string, source?: string) {
    if (!source) return showNote(link);
    const target = decodeURIComponent(link.split('#')[0]);
    if (!target) return showNote(source);
    const wanted = target.replace(/\.md$/i, '') + '.md', paths = await store.list();
    const relative = source.split('/').slice(0, -1).concat(wanted).join('/');
    const exact = paths.find(path => path === wanted || path === relative);
    const matches = exact ? [exact] : paths.filter(path => path.endsWith('/' + wanted));
    if (matches.length !== 1) { ui.notice(matches.length ? 'This note link is ambiguous.' : 'Note not found. Linking does not create a note.'); return; }
    return showNote(matches[0]);
  }
  const ui: PreviewNativeUI = new PreviewNativeUI(controller, (): ReaderApp => app, store);
  const app: ReaderApp = new ReaderApp(document.querySelector('#app')!, controller, {
    openNote, openMarkdown: showNote, pickLinkTarget: ui.pickLinkTarget, shouldFocus: () => ui.active,
    isMobile: new URLSearchParams(location.search).get('mobile') === '1' || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent),
    einkEnabled: () => einkEnabled(isAndroid, einkDevice), reversePageButtons: () => einkDevice.reverseButtons,
    onEinkChange: callback => { einkListeners.add(callback); return () => { einkListeners.delete(callback); }; },
    pickArticle: ui.pickArticle, highlightMenu: ui.highlightMenu, notify: message => { ui.notice(message); },
    visibleOverlays: () => [...document.querySelectorAll<HTMLElement>('.mobile-navbar, .mobile-toolbar')],
  });
  const palette = button('Command palette', ui.more); palette.className = 'preview-palette'; document.querySelector('#preview-note')?.append(palette);
  const setEinkForDevice = (enabled: boolean, reverseButtons = false) => {
    if (document.getSelection()?.isCollapsed === false) throw new Error('Clear selection before changing reading mode');
    einkDevice = { enabled, reverseButtons }; writeEinkDevice(window, einkDevice); for (const changed of einkListeners) changed();
  };
  Object.assign(window, { reader: { store, controller, app, ui, showNote, setEinkForDevice } });
  if (prepared.warnings.length) ui.notice(prepared.warnings.join('\n'));
  const foreground = () => { controller.setOnline(navigator.onLine); controller.setActive(!document.hidden); };
  const connection = () => controller.setOnline(navigator.onLine);
  document.addEventListener('visibilitychange', foreground); window.addEventListener('online', connection); window.addEventListener('offline', connection); foreground();
  if (import.meta.hot) import.meta.hot.dispose(async () => { document.removeEventListener('visibilitychange', foreground); window.removeEventListener('online', connection); window.removeEventListener('offline', connection); palette.remove(); ui.dispose(); await app.destroy(); await controller.shutdown(); });
}
void main().catch(error => { document.querySelector('#app')!.textContent = 'Reader could not start: ' + String(error); console.error(error); });
