import type { HighlightPalette } from './paint-palette';
import type { HighlightColour, ResolvedHighlight } from './types';

type Registry = { set(name: string, value: unknown): unknown; delete(name: string): unknown };
type HighlightWindow = Window & {
  CSS?: { highlights?: Registry };
  Highlight?: new (...ranges: Range[]) => unknown;
};
export interface NativePaint {
  update(highlights: readonly ResolvedHighlight[], palette: HighlightPalette): boolean;
  dispose(): void;
}
let nextPaint = 0;

/** Reusable native groups for ordinary native paint and background-occluded fragments. */
export function createNativePaint(root: HTMLElement): NativePaint | null {
  const document = root.ownerDocument;
  const window = document.defaultView as HighlightWindow | null;
  const registry = window?.CSS?.highlights;
  const Highlight = window?.Highlight;
  if (!registry || typeof registry.set !== 'function' || typeof registry.delete !== 'function' ||
      typeof Highlight !== 'function') return null;
  const style = document.createElement('style');
  style.setAttribute('data-reader-ui', 'highlight-styles');
  const paintId = ++nextPaint;
  const previous = new Map<HighlightColour, Range[]>();
  const names = new Set<string>();
  let disposed = false;
  const cleanup = () => {
    style.remove();
    for (const name of names) {
      try { registry.delete(name); } catch { /* A broken API must not prevent other cleanup. */ }
    }
    names.clear();
    previous.clear();
  };
  return {
    update(highlights, palette) {
      if (disposed) return false;
      try {
        const rules: string[] = [];
        // Pale fills can disappear on monochrome displays. Only the opted-in
        // e-ink Reader adds a non-colour cue; never change the source's glyphs.
        const eink = root.closest('.r2-reader.r2-eink') !== null;
        for (const colour of ['yellow', 'green', 'blue', 'pink', 'purple'] as const) {
          const ranges = highlights.filter((item) => item.colour === colour).map((item) => item.range);
          const name = `readerhl-${paintId}-${colour}`;
          if (!ranges.length) {
            if (names.has(name)) { registry.delete(name); names.delete(name); }
            previous.delete(colour);
            continue;
          }
          const old = previous.get(colour);
          const unchanged = old?.length === ranges.length && ranges.every((range, i) => {
            const prior = old[i]!;
            return range.startContainer === prior.startContainer && range.startOffset === prior.startOffset &&
              range.endContainer === prior.endContainer && range.endOffset === prior.endOffset;
          });
          if (!unchanged) {
            names.add(name); // Also roll back a registry that mutates and then throws.
            registry.set(name, new Highlight(...ranges));
            previous.set(colour, ranges);
          }
          const decoration = eink ? `text-decoration: underline ${colour === 'blue' ? 'double' : 'solid'}; text-decoration-thickness: 2px;` : '';
          rules.push(`::highlight(${name}) { background-color: ${palette[colour]}; ${decoration} }`);
        }
        const css = rules.join('\n');
        if (style.textContent !== css) style.textContent = css;
        if (css && !style.isConnected) (document.head ?? document.documentElement).append(style);
        if (!css) style.remove();
        return true;
      } catch {
        cleanup();
        disposed = true;
        return false;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cleanup();
    },
  };
}
