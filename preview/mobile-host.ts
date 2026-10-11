import { createAnchor } from '../src/highlights/selectors';
import { parseInlineMarkdown } from '../src/inline';
declare global { interface Window { readerMobileHost: MobileHostFixture; } }
/** Synthetic host chrome using selectors/variables verified in Obsidian 1.14.4 CSS. NOT iOS evidence. */
export class MobileHostFixture {
  readonly root = document.querySelector<HTMLElement>('.r2-app')!;
  readonly navbar = document.createElement('nav');
  readonly keyboardBar = document.createElement('div');
  readonly header = document.createElement('div');
  private css = document.createElement('style');
  private oldClass = document.body.className;
  private oldStyle = document.body.style.cssText;
  private clicks = 0;
  constructor() {
    document.body.classList.add('theme-dark', 'is-mobile', 'is-phone', 'is-floating-nav');
    for (const [key, value] of Object.entries({ '--background-primary': '#000000', '--background-secondary': '#171717', '--text-normal': '#e5e5e5', '--text-muted': '#aaaaaa', '--navbar-height': '52px', '--navbar-bottom-offset': '24px', '--keyboard-height': '0px', '--mobile-toolbar-height': '44px' })) document.body.style.setProperty(key, value);
    this.css.textContent = `
      .r2-test-native-header { height: 52px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; color: #eee; background: #000; font: 15px system-ui; }
      .r2-test-native-nav { position: fixed; bottom: calc(var(--navbar-bottom-offset) - var(--keyboard-height)); left: 30px; right: 30px; height: var(--navbar-height); display: flex; justify-content: space-around; align-items: center; border-radius: 99px; background: #303030; z-index: 500; color: #eee; }
      .r2-test-native-nav button { min-height: 44px; min-width: 44px; background: transparent; color: #eee; border: 0; font-size: 20px; }
      .r2-test-keyboard-toolbar { position: fixed; top: calc(100vh - var(--keyboard-height) - var(--mobile-toolbar-height)); left: 0; right: 0; height: var(--mobile-toolbar-height); display: none; background: #303030; color: #eee; z-index: 500; text-align: center; font: 14px/44px system-ui; }
    `;
    this.header.className = 'r2-test-native-header'; this.header.textContent = '☰                         Reader                         •••';
    this.navbar.className = 'mobile-navbar r2-test-native-nav'; this.navbar.setAttribute('aria-label', 'Simulated native navigation');
    for (const [index, label] of ['‹', '›', '⌕', '+', '▣', '☰'].entries()) {
      const control = document.createElement('button'); control.textContent = label; control.setAttribute('aria-label', 'Native control ' + index);
      control.onclick = () => { this.clicks++; }; this.navbar.append(control);
    }
    this.keyboardBar.className = 'mobile-toolbar r2-test-keyboard-toolbar'; this.keyboardBar.textContent = 'Simulated host editing toolbar';
    document.head.append(this.css); document.body.insertBefore(this.header, document.querySelector('#app')); document.body.append(this.navbar, this.keyboardBar);
  }
  state(mode: 'visible' | 'hidden' | 'keyboard' | 'reserved') {
    this.navbar.style.display = mode === 'hidden' || mode === 'keyboard' ? 'none' : 'flex';
    this.keyboardBar.style.display = mode === 'keyboard' ? 'block' : 'none';
    document.body.style.setProperty('--keyboard-height', mode === 'keyboard' ? '310px' : '0px');
    document.querySelector<HTMLElement>('#app')!.style.marginBottom = mode === 'reserved' ? '80px' : '';
  }
  async highlights() {
    const controller = window.reader.controller;
    const article = window.reader.app.getArticle();
    if (!article) throw new Error('Open an article before adding fixture highlights');
    const body = document.querySelector<HTMLElement>('.r2-article-body')!;
    for (const [index, paragraph] of [...body.querySelectorAll('p')].slice(0, 2).entries()) {
      const current = await controller.repository.getArticle(article.path);
      const version = parseInlineMarkdown(current.body, { stripTitle: current.title }).revision;
      const range = document.createRange(); range.selectNodeContents(paragraph); const anchor = createAnchor(body, range, version);
      const saved = await controller.highlight(article.path, anchor.quote.exact, { ...anchor.position, prefix: anchor.quote.prefix, suffix: anchor.quote.suffix, version });
      if (index === 1) await controller.linkHighlight(article.path, saved.highlights.find(item => item.quote === anchor.quote.exact)!.id, 'https://example.org/linked');
    }
    await window.reader.app.open(article.path);
  }
  metrics() {
    // Finish controls scroll with the article; there is no persistent Reader toolbar.
    const viewport = this.root.querySelector<HTMLElement>('.r2-reader-scroll') ?? this.root, rect = viewport.getBoundingClientRect();
    const activeOverlay = this.keyboardBar.style.display === 'block' ? this.keyboardBar : this.navbar;
    const overlay = activeOverlay.getBoundingClientRect(), rootRect = this.root.getBoundingClientRect();
    const buttons = [...this.root.querySelectorAll<HTMLButtonElement>('.r2-article-end button')].flatMap(button => {
      const r = button.getBoundingClientRect();
      // Offscreen in-flow actions are not expected to be reachable from the top of an article.
      if (!r.width || !r.height || r.bottom <= rootRect.top || r.top >= rootRect.bottom || r.right <= rootRect.left || r.left >= rootRect.right) return [];
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return [{ height: r.height, reachable: !!hit && (hit === button || button.contains(hit)) }];
    });
    const body = this.root.querySelector<HTMLElement>('.r2-article-body')!, style = getComputedStyle(body);
    const contrast = (background: string) => {
      const rgb = (value: string) => value.trim().startsWith('#') ? value.trim().slice(1).match(/.{2}/g)!.map(v => parseInt(v, 16)) : value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      const lum = (value: string) => rgb(value).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
      return (Math.max(lum(style.color), lum(background)) + .05) / (Math.min(lum(style.color), lum(background)) + .05);
    };
    const yellow = style.getPropertyValue('--r2-highlight-yellow'), blue = style.getPropertyValue('--r2-highlight-blue');
    const popup = document.querySelector<HTMLElement>('.r2-highlight-menu,dialog[open]');
    return { bottom: rect.bottom, overlayTop: overlay.top, parentBottom: this.root.parentElement!.getBoundingClientRect().bottom, rootBottom: this.root.getBoundingClientRect().bottom,
      buttons, minContrast: Math.min(contrast(yellow), contrast(blue)), distinct: yellow !== blue, popupBottom: popup?.getBoundingClientRect().bottom ?? 0,
      hostClicks: this.clicks, hostStyle: this.navbar.getAttribute('style'), rootStyle: this.root.style.cssText };
  }
  restore() {
    this.navbar.remove(); this.keyboardBar.remove(); this.header.remove(); this.css.remove();
    document.querySelector<HTMLElement>('#app')!.style.marginBottom = ''; document.body.className = this.oldClass; document.body.style.cssText = this.oldStyle;
  }
}
export function installMobileHostFixture() { window.readerMobileHost = new MobileHostFixture(); return window.readerMobileHost; }
