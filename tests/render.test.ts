import { describe, it, expect } from 'vitest';
import { renderArticle } from '../src/ui/render';
describe('safe reading surface', () => {
  it('does not execute or preserve active embedded content or unsafe links', () => {
    const root = document.createElement('div');
    renderArticle('[bad](javascript:alert(1)) <iframe src="https://evil.test"></iframe> <img src=x onerror="alert(1)"> <a id="oops" href="data:text/html,hi">data</a> <style>body{display:none}</style>', root);
    expect(root.querySelector('iframe,script,style,[onerror],[id]')).toBeNull();
    expect(root.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(root.querySelector('img')).toBeNull();
  });
  it('preserves ordinary formatting and safe external links', () => {
    const root = document.createElement('div'); renderArticle('## Heading\n\n**Bold** and [source](https://example.com).', root);
    expect(root.querySelector('h2')?.textContent).toBe('Heading'); expect(root.querySelector('strong')?.textContent).toBe('Bold');
    expect(root.querySelector('a')?.rel).toContain('noopener');
  });
});
