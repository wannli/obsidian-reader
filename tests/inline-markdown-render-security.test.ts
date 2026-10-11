import { expect, it } from 'vitest';
import { addInlineLink, parseInlineMarkdown, setInlineLink } from '../src/inline';

const forbidden = 'script,style,iframe,object,embed,form,input,button,textarea,select,option,optgroup,video,audio,svg,math';
const attributes = '[style],[srcset],[id],[name],[autofocus],[contenteditable],[tabindex],[onclick],[onerror],[onload]';

it.each([
  '<div><script>alert(1)</script><style>body{display:none}</style><p>safe</p></div>',
  '<div><iframe src="https://evil.example"></iframe><object data="https://evil.example"></object><embed src="https://evil.example"><p>safe</p></div>',
  '<form action="https://evil.example"><input name="password" autofocus><button>submit</button><textarea>secret</textarea><p>safe</p></form>',
  '<div><select name="choice"><optgroup><option>choice</option></optgroup></select><p>safe</p></div>',
  '<div><video src="https://evil.example/movie" autoplay controls></video><audio src="https://evil.example/sound" autoplay></audio><p>safe</p></div>',
  '<div><svg onload="alert(1)"><foreignObject><p onclick="alert(1)">evil</p></foreignObject></svg><math><mi>x</mi></math><p>safe</p></div>',
  '<div id="spoof" name="spoof" style="position:fixed" contenteditable="true" tabindex="0" autofocus data-inline-highlight-id="spoof" data-inline-link-id="spoof" data-article-version="spoof" data-reader-ui="spoof"><p onclick="alert(1)">safe</p><img src="https://example.com/a.png" srcset="https://evil.example/a.png 2x" onerror="alert(1)"></div>',
  '<p><a href="javascript:alert(1)" onclick="alert(1)">unsafe</a><img src="javascript:alert(1)" onerror="alert(1)">safe</p>',
])('enforces the passive HTML security boundary: %s', source => {
  const parsed = parseInlineMarkdown(source);
  for (const root of [parsed.root, (() => { const root = document.createElement('article'); root.innerHTML = parsed.html; return root; })()]) {
    expect(root.querySelector(forbidden)).toBeNull();
    expect(root.querySelector(attributes)).toBeNull();
    expect(root.querySelector('[href^="javascript:"],[src^="javascript:"]')).toBeNull();
    expect(root.querySelector('[data-inline-highlight-id],[data-inline-link-id],[data-article-version],[data-reader-ui]')).toBeNull();
    expect(root.textContent).toContain('safe');
  }
  expect(parsed.highlights).toHaveLength(0);
  expect(parsed.links).toHaveLength(0);
});

it('retains safe passive article HTML and ordinary hyperlinks', () => {
  const source = '<section><h2>Heading</h2><p>Plain <em>emphasis</em> <strong>bold</strong> <code>literal</code> <a href="https://example.com" title="Reference">reference</a>.</p><blockquote>quote</blockquote><table><thead><tr><th>Header</th></tr></thead><tbody><tr><td>cell</td></tr></tbody></table><figure><img src="https://example.com/a.png" alt="Description" width="120"><figcaption>Caption</figcaption></figure></section>';
  const parsed = parseInlineMarkdown(source);
  for (const tag of ['section', 'h2', 'p', 'em', 'strong', 'code', 'a', 'blockquote', 'table', 'th', 'td', 'figure', 'img', 'figcaption']) {
    expect(parsed.root.querySelector(tag)).not.toBeNull();
  }
  expect(parsed.root.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
  expect(parsed.root.querySelector('img')?.getAttribute('alt')).toBe('Description');
  expect(parsed.canonicalText).toBe('Heading Plain emphasis bold literal reference. quote Header cell Caption');
});

it.each([
  ['https://example.com/page', '[**word**](https://example.com/page)'],
  ['https://example.com/a(b)', '[**word**](<https://example.com/a(b)>)'],
  ['https://example.com/a b', '[**word**](<https://example.com/a b>)'],
])('uses clean destinations unless syntax protection is needed: %s', (target, expected) => {
  const source = '**word**', parsed = parseInlineMarkdown(source);
  expect(addInlineLink(source, { quote: 'word', revision: parsed.revision }, target)).toBe(expected);
  const old = '[**word**](old.md "Authored title")';
  expect(setInlineLink(old, parseInlineMarkdown(old).links[0].id, target)).toBe(expected.slice(0, -1) + ' "Authored title")');
});
