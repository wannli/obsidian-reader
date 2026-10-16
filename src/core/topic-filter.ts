import { type Token } from 'marked';
import { readerMarkdown, visibleMarkdown } from './markdown';
import { decodeHTML } from 'entities';
import { linkPath, type ArticleInfo } from './model';

export interface TopicFilter {
  label: string;
  /** Exact selected vault-file path, not a display name or alias. */
  path?: string;
  /** Caller supplies the topic name and aliases, or a free-text query. */
  terms: readonly string[];
}

const normalize = (text: string) => text.normalize('NFC').replace(/\s+/gu, ' ').trim();

/** Literal whole words/phrases; accents are preserved, whitespace is equivalent.
 * Unicode letters, marks, numbers and underscores are word constituents.
 * Uses Unicode simple case folding (not locale-dependent linguistic stemming).
 */
export function matchesTopicText(text: string, terms: readonly string[]): boolean {
  const value = normalize(text);
  return terms.some((term) => {
    const literal = normalize(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (
      !!literal &&
      new RegExp(`(?:^|[^\\p{L}\\p{M}\\p{N}_])${literal}(?![\\p{L}\\p{M}\\p{N}_])`, 'iu').test(
        value,
      )
    );
  });
}

/** One supplied article only: no I/O, mutation, index, or persistent body cache.
 * resolveLink receives the unwrapped link path and the article's source path.
 * body MUST exclude frontmatter (use the document snapshot's body).
 * Queue selection and bounded body reads remain the caller's responsibility.
 */
export function matchesTopicArticle(
  article: ArticleInfo,
  body: string,
  filter: TopicFilter,
  resolveLink: (link: string, source: string) => string | undefined,
): boolean {
  if (
    filter.path &&
    article.topics.some((link) => {
      const target = linkPath(link);
      return target !== undefined && resolveLink(target, article.path) === filter.path;
    })
  )
    return true;
  if (matchesTopicText(article.title, filter.terms)) return true;
  return matchesTopicText(markdownText(body), filter.terms);
}

/** Visible Markdown projection following Reader's escaped-HTML renderer.
 * Raw HTML is literal visible text, never interpreted as markup or visibility.
 * URLs, definitions, images and Reader comments are not prose.
 * Code text is visible, but fence language labels are not. Block boundaries do
 * not manufacture phrases. Oversized nesting fails closed rather than recursing.
 */
function markdownText(body: string): string {
  const pieces: string[] = [];
  const separator = () => pieces.push('\0');
  function visit(tokens: Token[] | undefined, depth: number): void {
    if (!tokens) return;
    if (depth > 64) {
      separator();
      return;
    }
    for (const token of tokens) {
      switch (token.type) {
        case 'readerComment':
          break;
        case 'html':
          if (token.block) separator();
          pieces.push(token.text);
          if (token.block) separator();
          break;
        case 'def':
        case 'image':
        case 'hr':
        case 'space':
          separator();
          break;
        case 'readerWiki':
          pieces.push(String(token.label));
          break;
        case 'readerHighlight':
          visit(token.tokens, depth + 1);
          break;
        case 'br':
          pieces.push(' ');
          break;
        case 'code':
          separator();
          pieces.push(token.text);
          separator();
          break;
        case 'codespan':
          pieces.push(token.text);
          break;
        case 'escape':
          pieces.push(token.text);
          break;
        case 'text':
          if (token.tokens) visit(token.tokens, depth + 1);
          else pieces.push(decodeHTML(token.text));
          break;
        case 'paragraph':
        case 'heading':
        case 'blockquote':
          separator();
          visit(token.tokens, depth + 1);
          separator();
          break;
        case 'list':
          for (const item of token.items) {
            separator();
            visit(item.tokens, depth + 1);
          }
          separator();
          break;
        case 'table':
          for (const row of [token.header, ...token.rows])
            for (const cell of row) {
              separator();
              visit(cell.tokens, depth + 1);
            }
          separator();
          break;
        case 'link':
          // Autolinks/bare URL labels are destinations, not topic prose.
          if (token.autolink || /^(?:https?:\/\/|mailto:)/i.test(token.text)) separator();
          else visit(token.tokens, depth + 1);
          break;
        case 'strong':
        case 'em':
        case 'del':
          visit(token.tokens, depth + 1);
          break;
        default:
          separator();
      }
    }
  }
  visit(readerMarkdown().lexer(visibleMarkdown(body)), 0);
  return pieces.join('');
}
