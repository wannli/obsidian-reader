import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/reader/styles.css', import.meta.url), 'utf8');
const rule = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  if (!match) throw new Error(`Missing Reader CSS rule: ${selector}`);
  return match[1]!;
};

describe('leaf-owned bottom toolbar alignment contract', () => {
  it('compensates list controls for the padding around article controls', () => {
    const leaf = rule('.reader-view');
    expect(leaf).toContain('--reader-pane-padding: 12px;');
    expect(leaf).toContain('padding: var(--reader-pane-padding);');
    expect(leaf).toContain('--reader-controls-bottom: max(8px, env(safe-area-inset-bottom, 0px));');
    expect(rule('.reader-view .reader-bottom-controls')).toContain(
      'bottom: var(--reader-controls-bottom);',
    );
    expect(rule('.reader-view > .reader-toolbar')).toContain(
      'bottom: calc(var(--reader-pane-padding) + var(--reader-controls-bottom));',
    );
    expect(rule('.reader-article')).toContain('position: relative;');
  });

  it('keeps both four- and six-button groups centered without shrinking touch targets', () => {
    const controls = rule('.reader-view .reader-bottom-controls');
    expect(controls).toContain('position: absolute;');
    expect(controls).toContain('left: 50%;');
    expect(controls).toContain('transform: translateX(-50%);');
    expect(rule('.reader-toolbar')).toContain('repeat(4, 44px)');
    expect(rule('.reader-actions')).toContain('repeat(6, 44px)');
    const button = rule('.reader-view button.reader-icon-button');
    expect(button).toContain('min-width: 44px !important;');
    expect(button).toContain('min-height: 44px !important;');
  });

  it('shares safe-area-aware clearance with scrolling and paged content', () => {
    expect(rule('.reader-view')).toContain(
      '--reader-controls-clearance: calc(60px + var(--reader-controls-bottom));',
    );
    expect(rule('.reader-viewport')).toContain(
      'scroll-padding-block-end: var(--reader-controls-clearance);',
    );
    expect(rule('.reader-paged')).toContain('margin-block-end: var(--reader-controls-clearance);');
  });
});
