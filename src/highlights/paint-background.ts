/** Per-refresh cache, bounded to the selected text's ancestors inside the article. */
export function backgroundOccludesHighlight(root: HTMLElement): (range: Range) => boolean {
  const window = root.ownerDocument.defaultView;
  const cache = new Map<HTMLElement, boolean>();
  function occludes(element: HTMLElement): boolean {
    if (!window) return false;
    if (cache.has(element)) return cache.get(element)!;
    const style = window.getComputedStyle(element);
    const colour = style.backgroundColor;
    const transparent = !colour || colour === 'transparent' ||
      /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/u.test(colour) ||
      /\/\s*0(?:\.0+)?%?\s*\)$/u.test(colour);
    const ownBackground = style.display !== 'contents' &&
      (!transparent || Boolean(style.backgroundImage && style.backgroundImage !== 'none'));
    // The host/app background is behind the underlay; do not inspect beyond root.
    const covered = ownBackground || (element !== root && element.parentElement !== null &&
      occludes(element.parentElement));
    cache.set(element, covered);
    return covered;
  }
  return (range) => {
    const parent = range.startContainer.parentElement;
    return Boolean(parent && root.contains(parent) && occludes(parent));
  };
}
