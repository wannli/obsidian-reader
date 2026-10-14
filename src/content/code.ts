import { Lexer, walkTokens } from 'marked';
import { MAX_HTML_BYTES, bounded } from './bounds';
import { UnsafePublisherContent } from './security';

const cannotPreserve = (): never => {
  throw new UnsafePublisherContent('preformatted code could not be preserved safely.');
};

/** Protect literal code from converter trimming, list indentation and language inference. */
export function preserveCode(root: DocumentFragment): (markdown: string) => string {
  const occupied = new Set(
    [...(root.textContent ?? '').matchAll(/READERLITERALCODE(\d+)X/g)].map((match) => match[1]),
  );
  let salt = 0;
  while (occupied.has(String(salt))) salt++;
  const prefix = `READERLITERALCODE${salt}X`,
    blocks: string[] = [];
  for (const pre of root.querySelectorAll('pre')) {
    if (!root.contains(pre)) continue;
    const placeholder = pre.ownerDocument.createElement('p');
    placeholder.textContent = `${prefix}${blocks.length}END`;
    blocks.push(pre.textContent ?? '');
    pre.replaceWith(placeholder);
  }
  return (markdown) => {
    // One pass, not one whole-document replacement per block. Prefixes must be structural.
    const pattern = new RegExp(
      `^([ \\t]*(?:(?:>[ \\t]*)|(?:(?:[-+*]|\\d+[.)])[ \\t]+))*)${prefix}(\\d+)END[ \\t]*$`,
      'gm',
    );
    const counts = blocks.map(() => 0);
    let length = markdown.length;
    markdown = markdown.replace(pattern, (line: string, rawPrefix: string, index: string) => {
      const code = blocks[Number(index)];
      if (code === undefined) return cannotPreserve();
      counts[Number(index)]++;
      let opening = '';
      for (const char of rawPrefix)
        opening += char === '\t' ? ' '.repeat(4 - (opening.length % 4)) : char;
      const continuation = opening.replace(/(?:[-+*]|\d+[.)])[ \t]+/g, (marker) =>
        ' '.repeat(marker.length),
      );
      let size = 3;
      for (const match of code.matchAll(/`+/g)) size = Math.max(size, match[0].length + 1);
      const fence = '`'.repeat(size);
      const block = `${fence}\n${code}${code.endsWith('\n') ? '' : '\n'}${fence}`;
      let lines = 1;
      for (const _match of block.matchAll(/\n/g)) lines++;
      length += block.length + opening.length + (lines - 1) * continuation.length - line.length;
      if (length > MAX_HTML_BYTES) throw new Error('Content is too large.');
      return block
        .split('\n')
        .map((line, index) => (index ? continuation : opening) + line)
        .join('\n');
    });
    if (counts.some((count) => count !== 1)) return cannotPreserve();
    bounded(markdown);
    const emitted: string[] = [];
    walkTokens(Lexer.lex(markdown), (token) => {
      if (token.type === 'code') emitted.push(token.text);
    });
    // Markdown list lexers expand tabs; source tabs above remain literal, never rewritten.
    const comparable = (value: string): string => value.replace(/\t/g, '    ');
    if (
      emitted.length !== blocks.length ||
      blocks.some((code, i) => comparable(code.replace(/\n$/, '')) !== comparable(emitted[i]))
    )
      return cannotPreserve();
    return markdown;
  };
}
