// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { VisibleText } from '../src/reader/text';

function article(html: string): HTMLElement {
  const root = document.createElement('article');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}
const normalized = (text: string) => text.replace(/\s+/gu, ' ').trim();
afterEach(() => document.body.replaceChildren());

describe('VisibleText', () => {
  it('round-trips a bookmark spanning emphasis, links and highlights', () => {
    const root = article('One <em>two <a href="#">three</a></em> <mark>four</mark> five six.');
    const index = new VisibleText(root),
      marker = index.marker(root.firstChild!, 0);
    expect(marker).toBe('One two three four five');
    const range = index.range(marker)!;
    expect(range.startContainer).toBe(root.firstChild);
    expect(range.endContainer).toBe(root.lastChild);
    expect(range.toString()).toBe(marker);
  });

  it('maps collapsed whitespace across inline boundaries back to original DOM offsets', () => {
    const root = article('  Alpha\t<em>\n\u00a0 beta </em>\n<a>gamma</a>  delta\n epsilon ');
    const index = new VisibleText(root);
    expect(index.text).toBe(' Alpha beta gamma delta epsilon ');
    const marker = index.marker(root.firstChild!, 0);
    expect(marker).toBe('Alpha beta gamma delta epsilon');
    const range = index.range(marker)!;
    expect(range.startOffset).toBe(2);
    expect(range.endContainer).toBe(root.lastChild);
    expect(normalized(range.toString())).toBe(marker);
    expect(index.range(' beta\n gamma ')?.toString()).toBe('beta \ngamma');
    // Starting inside a collapsed whitespace run does not drop the following word.
    expect(index.marker(root.querySelector('em')!.firstChild!, 1)).toBe('beta gamma delta epsilon');
  });

  it('keeps adjoining inline fragments in the same word', () => {
    const root = article('inter<strong>nation</strong>al agreement has five more words.');
    const index = new VisibleText(root);
    expect(index.marker(root.firstChild!, 0)).toBe('international agreement has five more');
    expect(index.range('international')?.toString()).toBe('international');
    expect(index.marker(root.querySelector('strong')!.firstChild!, 0)).toBe(
      'agreement has five more words.',
    );
  });

  it('uses a whole final word instead of a fragment when no next word exists', () => {
    const root = article('A final <strong>book</strong>mark  '),
      index = new VisibleText(root);
    expect(index.marker(root.lastChild!, 1)).toBe('bookmark');
    expect(index.range('bookmark')?.toString()).toBe('bookmark');
  });

  it('extends repeated five-word prefixes until their following text distinguishes them', () => {
    const root = article('one two three four five early. one <em>two three</em> four five later.');
    const index = new VisibleText(root),
      start = root.firstChild!.textContent!.lastIndexOf('one');
    const marker = index.marker(root.firstChild!, start);
    expect(marker).toBe('one two three four five later.');
    expect(index.range(marker)?.startOffset).toBe(start);
  });

  it('preserves UTF-16 range offsets through emoji, accents and non-Latin text', () => {
    const root = article('🌿 café <em>日本語</em> words are visible.'),
      index = new VisibleText(root);
    const marker = index.marker(root.firstChild!, 0);
    expect(marker).toBe('🌿 café 日本語 words are');
    expect(index.range(marker)?.toString()).toBe(marker);
    expect(index.range('café 日本語')?.startOffset).toBe(3);
  });

  it('bounds anchors, including unbroken text, without ending on half an emoji', () => {
    const root = article('a'.repeat(255) + '🌿' + 'b'.repeat(50)),
      index = new VisibleText(root);
    const marker = index.marker(root.firstChild!, 0);
    expect(marker).toBe('a'.repeat(255));
    expect(marker.length).toBeLessThanOrEqual(256);
    expect(index.range(marker)?.toString()).toBe(marker);
    const repeated = article('word '.repeat(70).trim()),
      repeatedIndex = new VisibleText(repeated);
    expect(repeatedIndex.marker(repeated.firstChild!, 0).split(' ')).toHaveLength(40);
  });

  it('rejects missing text and invalid boundaries, and tolerates empty text nodes', () => {
    const root = article('');
    root.append(document.createTextNode(''), document.createTextNode('last'));
    const index = new VisibleText(root);
    expect(index.range('last')?.startContainer).toBe(root.lastChild);
    expect(index.range('')).toBeUndefined();
    expect(index.range(' \n ')).toBeUndefined();
    expect(index.range('missing')).toBeUndefined();
    expect(index.marker(root.firstChild!, 0)).toBe('');
    expect(index.marker(document.createTextNode('last'), 0)).toBe('');
    for (const offset of [-1, 0.5, 5, NaN, Infinity, 4])
      expect(index.marker(root.lastChild!, offset)).toBe('');
    expect(new VisibleText(article('')).text).toBe('');
    expect(new VisibleText(article(' \n\t ')).marker(document.createTextNode(' '), 0)).toBe('');
  });
});
