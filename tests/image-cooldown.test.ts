import { describe, expect, it } from 'vitest';
import { FailedImageCooldown, prepareArticleImages } from '../src/ui/image-cooldown';
import { renderArticle } from '../src/ui/render';

function article(html: string): HTMLElement {
  const doc = document.implementation.createHTMLDocument('');
  const root = doc.createElement('article');
  root.innerHTML = html;
  return root;
}

describe('displayed image cooldown', () => {
  it('expires without a retry timer and evicts oldest failures at capacity', () => {
    let now = 0;
    const cooldown = new FailedImageCooldown(100, 2, () => now);
    cooldown.fail('a'); cooldown.fail('b'); cooldown.fail('c');
    expect(cooldown.has('a')).toBe(false);
    expect(cooldown.has('b')).toBe(true);
    now = 100;
    expect(cooldown.has('b')).toBe(false);
    expect(cooldown.has('c')).toBe(false);
  });

  it('suppresses only failed URLs, keeps alt, and permits a later render after expiry', () => {
    let now = 0;
    const cooldown = new FailedImageCooldown(100, 2, () => now);
    const html = '<img src="https://images.test/bad" alt="Caption"><img src="https://images.test/good">';
    const first = article(html);
    prepareArticleImages(first, cooldown);
    first.querySelector('img')!.dispatchEvent(new Event('error'));
    const second = article(html);
    prepareArticleImages(second, cooldown);
    expect(second.querySelector('img')!.hasAttribute('src')).toBe(false);
    expect(second.querySelector('img')!.alt).toBe('Caption');
    expect(second.querySelectorAll('img')[1].src).toBe('https://images.test/good');
    now = 100;
    const third = article(html);
    prepareArticleImages(third, cooldown);
    expect(third.querySelector('img')!.src).toBe('https://images.test/bad');
    expect(second.querySelector('img')!.hasAttribute('src')).toBe(false);
  });

  it('keeps fragment variants distinct under the exact-URL policy', () => {
    const cooldown = new FailedImageCooldown();
    const root = article('<img src="https://images.test/sprite.svg#one"><img src="https://images.test/sprite.svg#two">');
    prepareArticleImages(root, cooldown);
    root.querySelector('img')!.dispatchEvent(new Event('error'));
    const next = article(root.innerHTML);
    prepareArticleImages(next, cooldown);
    expect(next.querySelectorAll('img')[0].hasAttribute('src')).toBe(false);
    expect(next.querySelectorAll('img')[1].getAttribute('src')).toBe('https://images.test/sprite.svg#two');
  });

  it('removes unsupported responsive sources before adoption', () => {
    const root = article('<picture><source srcset="https://images.test/large 2x"><img src="https://images.test/small" srcset="https://images.test/large 2x"></picture>');
    prepareArticleImages(root, new FailedImageCooldown());
    expect(root.querySelector('[srcset]')).toBeNull();
    expect(root.querySelector('img')!.getAttribute('src')).toBe('https://images.test/small');
  });

  it('configures images before insertion and preserves indexing and highlights', () => {
    const target = document.createElement('div');
    document.body.append(target);
    const replace = target.replaceChildren.bind(target);
    let renders = 0;
    target.replaceChildren = (...nodes) => {
      const image = (nodes[0] as HTMLElement).querySelector('img')!;
      expect(image.loading).toBe('lazy');
      expect(image.referrerPolicy).toBe('no-referrer');
      if (renders++ > 0) expect(image.hasAttribute('src')).toBe(false);
      replace(...nodes);
    };
    const markdown = '![Caption](https://images.test/render-failure)\n\n==Marked text== after.';
    const first = renderArticle(markdown, target);
    target.querySelector('img')!.dispatchEvent(new Event('error'));
    const second = renderArticle(markdown, target);
    expect(target.querySelector('img')!.hasAttribute('src')).toBe(false);
    expect(target.querySelector('img')!.alt).toBe('Caption');
    expect(second.canonicalText).toBe(first.canonicalText);
    expect(second.highlights).toEqual(first.highlights);
    target.remove();
  });
});
