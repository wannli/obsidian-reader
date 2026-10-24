// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderBody } from '../src/reader/render';
import { VisibleText } from '../src/reader/text';

const body =
  '==Clear **rules** build [trust](https://example.com/report).== (※ [[Notes/Institutional trust|Trust]]) ^reader-icons';
const disposers: (() => void)[] = [];

function article() {
  const root = document.createElement('article');
  document.body.append(root);
  return root;
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

describe('native-sized Fileclass reference tags', () => {
  it('passes the decoded native note target to the host painter without replacing the authored label', () => {
    const root = article();
    const paint = vi.fn((target: string, element: HTMLElement) => {
      expect(target).toBe('Notes/Institutional trust');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = 'Fileclass-resolved icon';
      svg.append(title);
      element.append(svg);
    });
    disposers.push(renderBody(body, root, '', paint));
    expect(paint).toHaveBeenCalledTimes(1);
    const link = root.querySelector<HTMLAnchorElement>('.reader-reference-pill')!;
    expect(link.querySelector('.reader-reference-label')?.textContent).toBe('Trust');
    expect(link.querySelector('.reader-reference-icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(link.querySelector('.reader-reference-icon svg')).not.toBeNull();
    expect(link.querySelector('.reader-reference-prefix')).toBeNull();
    const icon = link.querySelector('.reader-reference-icon')!;
    expect(link.firstElementChild).toBe(icon);
    expect(icon.nextElementSibling).toBe(link.querySelector('.reader-reference-label'));
    expect(link.title).toBe('Edit highlight notes · Trust (Enter when focused)');
    expect(link.closest('[data-reader-decoration]')?.getAttribute('data-reader-decoration')).toBe(
      'reference',
    );
  });

  it('excludes icon metadata, labels and native paragraph IDs from article prose', () => {
    const root = article();
    disposers.push(
      renderBody(body, root, '', (_target, element) => {
        element.textContent = 'This is icon metadata, not quotation text';
      }),
    );
    expect(new VisibleText(root).text).toBe('Clear rules build trust. ');
    expect(root.querySelector('mark')?.getAttribute('data-reader-passage')).toBe('0');
    expect(root.querySelector('.reader-reference-group')?.getAttribute('data-reader-passage')).toBe(
      '0',
    );
    expect(
      root.querySelector('[data-reader-paragraph]')?.getAttribute('data-reader-paragraph'),
    ).toBe('reader-icons');
    expect(root.querySelector('a[href="https://example.com/report"]')?.textContent).toBe('trust');
  });

  it('never associates icon-owned mark elements with saved source highlights', () => {
    const root = article();
    disposers.push(
      renderBody(
        '[==First excerpt.==](Notes/Concept.md) (※ [[Notes/Concept]]) ^native-first',
        root,
        '',
        (_target, icon) => {
          const metadata = document.createElement('mark');
          metadata.textContent = 'Icon metadata';
          icon.append(metadata);
        },
      ),
    );
    expect(root.querySelector('a.internal-link > mark')?.getAttribute('data-reader-passage')).toBe(
      '0',
    );
    expect(root.querySelector('.reader-reference-group')?.getAttribute('data-reader-passage')).toBe(
      '0',
    );
    expect(root.querySelector('.reader-node-icon mark')?.hasAttribute('data-reader-passage')).toBe(
      false,
    );
    expect(new VisibleText(root).text).toBe('First excerpt. ');
  });

  it('keeps readable references when no provider or no resolved icon is available', () => {
    for (const paint of [undefined, () => {}]) {
      const root = article();
      disposers.push(renderBody(body, root, '', paint));
      expect(root.querySelector('.reader-reference-label')?.textContent).toBe('Trust');
      expect(root.querySelector('.reader-reference-icon')).toBeNull();
      expect(new VisibleText(root).text).toBe('Clear rules build trust. ');
    }
  });

  it('does not hide an article/reference when its provider disappears during icon painting', () => {
    const root = article();
    disposers.push(
      renderBody(body, root, '', (_target, element) => {
        element.textContent = 'Incomplete icon';
        throw new Error('Provider unloaded');
      }),
    );
    expect(root.querySelector('.reader-reference-icon')).toBeNull();
    expect(root.querySelector('.reader-reference-label')?.textContent).toBe('Trust');
    expect(new VisibleText(root).text).toBe('Clear rules build trust. ');
  });

  it('leaves untyped links plain and never sends publisher URLs to the note-icon painter', () => {
    const root = article();
    const paint = vi.fn();
    disposers.push(
      renderBody(
        'An [[Notes/Trust|ordinary note]] and [publisher](https://example.com).',
        root,
        '',
        paint,
      ),
    );
    expect(paint).toHaveBeenCalledTimes(1);
    expect(paint.mock.calls[0][0]).toBe('Notes/Trust');
    expect(new VisibleText(root).text).toBe('An ordinary note and publisher. ');
    expect(root.querySelector('.reader-reference-icon')).toBeNull();
  });

  it('paints typed note links in ordinary prose without treating their labels as decorations', () => {
    const root = article();
    disposers.push(
      renderBody(
        'An [[Notes/Trust|ordinary note]] and [publisher](https://example.com).',
        root,
        '',
        (target, icon) => {
          if (target === 'Notes/Trust') icon.textContent = 'Public Fileclass icon';
        },
      ),
    );
    const link = root.querySelector<HTMLAnchorElement>('a.reader-typed-link')!;
    const icon = link.querySelector<HTMLElement>('.reader-node-icon')!;
    expect(icon.dataset.readerDecoration).toBe('reference');
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(link.hasAttribute('data-reader-decoration')).toBe(false);
    expect(new VisibleText(root).text).toBe('An ordinary note and publisher. ');
    expect(root.querySelector('a[href="https://example.com"] .reader-node-icon')).toBeNull();
  });

  it('groups destinations in one pill with only public Fileclass icons and no generic marker', () => {
    const root = article();
    disposers.push(
      renderBody(
        '==Quoted **words**.== (※ [[Notes/A|Alpha]], [[Notes/B|Beta]]) ^reader-pill\n\nAn [[Notes/A|ordinary note]] and [[Untyped/Legacy|plain note]] plus [publisher](https://example.com).',
        root,
        '',
        (target, icon) => {
          if (!target.startsWith('Notes/')) return;
          icon.append(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
        },
      ),
    );
    const pills = [...root.querySelectorAll<HTMLAnchorElement>('.reader-reference-pill')];
    expect(pills).toHaveLength(2);
    expect(root.querySelectorAll('.reader-reference-group')).toHaveLength(1);
    for (const pill of pills) {
      expect(pill.querySelector('.reader-reference-prefix')).toBeNull();
      expect(pill.querySelectorAll('.reader-reference-icon svg')).toHaveLength(1);
    }
    expect(root.querySelector('.reader-reference-prefix')).toBeNull();
    expect(root.querySelector('.reader-reference-marker')).toBeNull();
    expect(root.querySelector('.reader-reference-group')?.textContent).toBe('Alpha Beta');
    for (const link of [...root.querySelectorAll<HTMLAnchorElement>('p:last-child a')]) {
      expect(link.classList.contains('reader-reference-pill')).toBe(false);
      expect(link.querySelector('.reader-reference-prefix')).toBeNull();
    }
    expect(
      root.querySelector('p:last-child a.reader-typed-link .reader-node-icon svg'),
    ).not.toBeNull();
    expect(root.querySelector('a[href="Untyped/Legacy"] .reader-node-icon')).toBeNull();
    expect(root.querySelector('a[href="https://example.com"] .reader-node-icon')).toBeNull();
    const prose = new VisibleText(root).text;
    expect(prose).toContain('Quoted words.');
    expect(prose).toContain('ordinary note and plain note plus publisher.');
    expect(prose).not.toMatch(/※|Alpha|Beta/);
  });

  it('keeps independent inline references separated and preserves full long labels without tag-search classes', () => {
    const root = article(),
      label = 'A very long complete note title ' + 'UnbrokenName'.repeat(20);
    disposers.push(
      renderBody(
        `==Quoted words.== (※ [[Notes/A|${label}]], [[Notes/B|Beta]]) ^reader-flow`,
        root,
        '',
      ),
    );
    const group = root.querySelector<HTMLElement>('.reader-reference-group')!,
      pills = [...group.querySelectorAll<HTMLAnchorElement>('a')];
    expect(pills).toHaveLength(2);
    expect(pills[0].nextSibling?.nodeType).toBe(Node.TEXT_NODE);
    expect(pills[0].nextSibling?.textContent).toBe(' ');
    expect(pills[0].nextSibling?.nextSibling).toBe(pills[1]);
    expect(pills[0].querySelector('.reader-reference-label')?.textContent).toBe(label);
    expect(pills[0].title).toBe(`Edit highlight notes · ${label} (Enter when focused)`);
    for (const pill of pills) {
      expect(pill.classList.contains('internal-link')).toBe(true);
      expect(pill.classList.contains('tag')).toBe(false);
      expect(pill.getAttribute('href')).toMatch(/^Notes\//);
    }
    expect(new VisibleText(root).text).toBe('Quoted words. ');
  });

  it('paints one native-sized group pill with separate transparent destination links', () => {
    const css = readFileSync(process.cwd() + '/src/reader/styles.css', 'utf8');
    const group = /\.reader-reference-group \{([^}]+)\}/.exec(css)![1];
    expect(group).toContain('display: inline-block');
    expect(group).toContain('max-width: 100%');
    expect(group).toContain('box-sizing: border-box');
    expect(group).toContain('line-height: 1');
    expect(group).not.toMatch(/inline-flex|44px|color-mix|isolation|min-height|min-width/);
    const reference =
      /\.reader-view :is\(\.reader-document, \.reader-article-topics\) a\.reader-reference-pill \{([^}]+)\}/.exec(
        css,
      )![1];
    for (const token of [
      'background',
      'border-width',
      'border-color',
      'radius',
      'corner-shape',
      'color',
      'size',
      'weight',
      'decoration',
      'padding-y',
      'padding-x',
    ]) {
      expect(group).toContain('var(--tag-' + token + ')');
    }
    expect(reference).toContain('display: inline-block');
    expect(reference).toContain('max-width: 100%');
    expect(reference).toContain('box-sizing: border-box');
    expect(reference).toContain('background: transparent');
    expect(reference).toContain('border: 0');
    expect(reference).toContain('padding: 0');
    expect(reference).toContain('font-size: inherit');
    expect(reference).toContain('line-height: 1');
    expect(reference).toContain('white-space: nowrap');
    expect(reference).toContain('overflow-wrap: anywhere');
    expect(reference).not.toContain('inline-flex');
    expect(reference).not.toMatch(/44px|color-mix|isolation|min-height|min-width/);
    expect(reference).not.toMatch(/(?:^|[;\n])\s*(?:height|width|position)\s*:/);
    expect(css).not.toMatch(/a\.reader-reference-pill::(?:before|after)/);
    const hover = /\.reader-reference-group:hover \{([^}]+)\}/.exec(css)![1];
    for (const token of ['background-hover', 'border-color-hover', 'color-hover']) {
      expect(hover).toContain('var(--tag-' + token + ')');
    }
    const linkHover = /a\.reader-reference-pill:hover \{([^}]+)\}/.exec(css)![1];
    expect(linkHover).toContain('var(--tag-decoration-hover)');
    const label = /\.reader-reference-label \{([^}]+)\}/.exec(css)![1];
    expect(label).toContain('white-space: normal');
    expect(label).toContain('overflow-wrap: anywhere');
    expect(label).not.toMatch(/line-clamp|text-overflow|overflow: hidden/);
    const toolbar = /\.reader-view button\.reader-icon-button \{([^}]+)\}/.exec(css)![1];
    expect(toolbar).toContain('min-height: 44px');
    expect(toolbar).toContain('min-width: 44px');
  });

  it('scopes quiet native-suggestion resets to result buttons while preserving action targets', () => {
    const css = readFileSync(process.cwd() + '/src/reader/styles.css', 'utf8');
    const row = /\.reader-highlight-picker button\.reader-highlight-picker-result \{([^}]+)\}/.exec(
      css,
    )![1];
    for (const property of [
      'background: transparent',
      'box-shadow: none',
      'height: auto',
      'min-height: 44px',
      'font-size: var(--font-ui-medium)',
      'padding: var(--size-2-3) var(--size-4-3)',
      'align-items: baseline',
      'white-space: pre-wrap',
    ]) {
      expect(row).toContain(property);
    }
    const search = /\.reader-highlight-picker-search-wrap \{([^}]+)\}/.exec(css)![1];
    expect(search).toContain('width: 100%');
    expect(search).toContain('min-width: 0');
    const filter =
      /\.reader-highlight-picker \.reader-highlight-picker-type-filter \{([^}]+)\}/.exec(css)![1];
    expect(filter).toContain('width: auto');
    expect(filter).toContain('max-width: 100%');
    const metadata =
      /\.reader-highlight-picker \.reader-highlight-picker-result-meta \{([^}]+)\}/.exec(css)![1];
    expect(metadata).toContain('display: flex');
    expect(metadata).toContain('gap: var(--size-2-1) var(--size-4-2)');
    expect(metadata).toContain('color: var(--text-muted)');
    const create =
      /button\.reader-highlight-picker-create-row\s+\.reader-highlight-picker-result-content\s*\{([^}]+)\}/.exec(
        css,
      )![1];
    expect(create).toContain('flex-direction: row');
    const createTitle =
      /button\.reader-highlight-picker-create-row\s+\.reader-highlight-picker-result-title\s*\{([^}]+)\}/.exec(
        css,
      )![1];
    expect(createTitle).toContain('flex: 1 1 auto');
    expect(createTitle).toContain('text-overflow: ellipsis');
    const title =
      /\.reader-highlight-picker \.reader-highlight-picker-result-title \{([^}]+)\}/.exec(css)![1];
    expect(title).toContain('min-width: 0');
    const createMetadata =
      /button\.reader-highlight-picker-create-row\s+\.reader-highlight-picker-result-meta\s*\{([^}]+)\}/.exec(
        css,
      )![1];
    expect(createMetadata).toContain('flex: 0 0 auto');
    expect(createMetadata).toContain('max-width: none');
    const createType =
      /button\.reader-highlight-picker-create-row\s+\.reader-highlight-picker-type-badge\s*\{([^}]+)\}/.exec(
        css,
      )![1];
    expect(createType).toMatch(/flex:\s*(?:none|0 0 auto)\s*;/);
    expect(createType).toContain('max-width: none');
    expect(createType).toContain('overflow: visible');
    expect(createType).toContain('text-overflow: clip');
    expect(css).toContain("button.reader-highlight-picker-result[aria-checked='true']");
    expect(css).toContain('button.reader-highlight-picker-result:focus-visible');
    const actions = /\.reader-highlight-picker-footer button \{([^}]+)\}/.exec(css)![1];
    expect(actions).toContain('min-height: 44px');
    expect(actions).not.toMatch(/background|box-shadow/);
    const modal = /\.reader-highlight-picker-modal\.prompt \{([^}]+)\}/.exec(css)![1];
    expect(modal).toContain('position: relative');
    expect(modal).toContain('top: auto');
  });
});
