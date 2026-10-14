import { Lexer, walkTokens } from 'marked';
import { bounded } from './bounds';

export class UnsafePublisherContent extends Error {
  constructor(detail: string) {
    super(`Cannot capture publisher content: ${detail}`);
  }
}

/** Known Dataview/Templater defaults only, not a third-party plugin sandbox. Custom inline
 * prefixes, delimiter changes or processors of unlabelled code require host-level isolation. */
export function assertSafeExternalText(value: string): void {
  bounded(value);
  // Templater scans raw note text, including fenced code and frontmatter. Escaping Markdown
  // delimiters is not a reliable defence; fail closed instead of changing literal examples.
  assertNoTemplateDelimiters(value);
  walkTokens(Lexer.lex(value), (token) => {
    if (token.type === 'codespan') assertSafeInlineCode(token.text);
    // External metadata strings do not get HTML-to-Markdown fence neutralization.
    if (token.type === 'code' && token.lang)
      throw new UnsafePublisherContent('code-fence language labels are not allowed.');
  });
}

export function assertNoTemplateDelimiters(value: string): void {
  if (value.includes('<%'))
    throw new UnsafePublisherContent('Templater delimiters are not allowed.');
}

export function assertSafeInlineCode(value: string): void {
  if (/^\s*\$?=/.test(value))
    throw new UnsafePublisherContent('Dataview inline expressions are not allowed.');
}
