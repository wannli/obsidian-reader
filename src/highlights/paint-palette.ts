import type { HighlightColour } from './types';

export type HighlightPalette = Record<HighlightColour, string>;
const LIGHT: HighlightPalette = {
  orange: '#efad6880', red: '#ef777780', yellow: '#f8e6a3', blue: '#c4e1f5', green: '#7acb8b80', pink: '#f49bb780', purple: '#bda1ef80',
};
const DARK: HighlightPalette = { ...LIGHT, yellow: '#584315', blue: '#183f59' };

/** Resolve in the article's scope, never in the external overlay or ::highlight. */
export function resolveHighlightPalette(root: HTMLElement): HighlightPalette {
  const document = root.ownerDocument;
  const window = document.defaultView;
  const theme = root.closest('.theme-dark, .theme-light');
  const dark = theme ? theme.classList.contains('theme-dark')
    : window?.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const defaults = dark ? DARK : LIGHT;
  if (!window) return { ...defaults };
  const style = window.getComputedStyle(root);
  const probe = document.createElement('span');
  probe.setAttribute('data-reader-ui', 'highlight-color-probe');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'all:initial;position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;';
  probe.style.color = style.color;
  probe.style.colorScheme = style.colorScheme;
  (document.body ?? document.documentElement).append(probe);
  const palette = { ...defaults };
  try {
    for (const colour of Object.keys(defaults) as HighlightColour[]) {
      const token = style.getPropertyValue(`--r2-highlight-${colour}`).trim();
      probe.style.backgroundColor = '';
      if (token) probe.style.backgroundColor = token;
      if (!probe.style.backgroundColor) probe.style.backgroundColor = defaults[colour];
      palette[colour] = window.getComputedStyle(probe).backgroundColor || defaults[colour];
    }
  } finally {
    probe.remove();
  }
  return palette;
}
