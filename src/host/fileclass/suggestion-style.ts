import { Platform, setIcon } from 'obsidian';

/** Keep native desktop density, without shrinking mobile or touch targets. */
export function styleSuggestionItem(el: HTMLElement, stacked = false): void {
  const touch =
    Platform.isMobile ||
    el.ownerDocument?.defaultView?.matchMedia?.('(any-pointer: coarse)').matches;
  el.style.minHeight = touch ? '44px' : '';
  el.style.boxSizing = 'border-box';
  el.style.display = 'flex';
  el.style.flexDirection = stacked ? 'column' : 'row';
  el.style.alignItems = stacked ? 'stretch' : 'center';
  el.style.justifyContent = stacked ? 'center' : '';
}

/** Use the supplied Fileclass glyph at native icon size, not the smaller badge font. */
export function renderClassIcon(parent: HTMLElement, name: string): HTMLElement {
  const icon = parent.createSpan({ attr: { 'aria-hidden': 'true' } });
  icon.style.display = 'inline-flex';
  icon.style.alignItems = 'center';
  icon.style.justifyContent = 'center';
  icon.style.flexShrink = '0';
  icon.style.lineHeight = '1';
  icon.style.setProperty('--icon-size', 'var(--icon-m, 18px)');
  setIcon(icon, name);
  return icon;
}
