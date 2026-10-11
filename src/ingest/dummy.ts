import type { ExtractedArticle } from '../types';
import { normalizeUrl } from './url';

export const DUMMY_NOTICE = 'Dummy article — extraction is disabled';

/** Trusted sample Markdown only: no transport, DOM parsing, extractor or Markdown converter. */
export function dummyArticle(url: string): ExtractedArticle & { extractor: 'dummy' } {
  const source = normalizeUrl(url);
  const parsed = new URL(source);
  let slug = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
  try { slug = decodeURIComponent(slug); } catch { /* Malformed percent escapes remain plain text. */ }
  slug = slug.replace(/\.(?:html?|php|aspx?)$/i, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 100);
  const title = `Dummy article — ${parsed.hostname}${slug ? ': ' + slug : ''}`;
  // Encode Markdown delimiters in the validated destination, without decoding publisher input.
  const destination = source.replace(/[\s<>"'`()[\]\\]/gu,
    char => encodeURIComponent(char).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()));
  const markdown = `> ${DUMMY_NOTICE}

This is generated sample text for Reader. It was not downloaded from the linked page and does not represent the publisher’s article. It gives you a safe place to practise highlighting, linking a highlight, and deleting a highlight while real extraction is switched off.

## A place for ideas

A neighborhood reading room begins with a simple promise: there is always time to follow an interesting idea. A visitor might arrive with a question about gardens and leave with notes about water, seasons, and the patient work of observation. The books are useful, but the connections between them make the room valuable.

A useful highlight preserves an idea without losing its surrounding context. A short sentence can be memorable on its own; the next paragraph explains why it matters. Keeping both nearby makes it easier to return later and understand what first caught your attention.

## From reading to remembering

Consider a notebook shared by a small project team. One person records a clear explanation, another links it to a related question, and a third removes a note that is no longer useful. The notebook improves through these small decisions rather than through collecting everything indiscriminately.

You can try the same sequence with this sample. Select a phrase in one paragraph, create a highlight, and connect that highlight to another note. Then remove a different highlight and check that the article text remains intact. Each paragraph is deliberately distinct so that a saved selection has recognizable context when you reopen the article.

- Highlight a sentence that explains an idea clearly.
- Link that highlight to a note where the idea can be used.
- Delete a test highlight without deleting the source paragraph.
- Reopen the article and revisit the remaining highlights.

## An ordinary, durable note

Good reading tools should leave understandable notes behind. Headings show the structure, paragraphs carry the argument, and a short list can describe the next action. None of this sample requires an image download, a remote service, or code execution to remain readable offline.

[Open the original URL](${destination}) if you want to visit the actual source. Turning off “Use dummy article content” enables real extraction for eligible articles; this generated sample is not evidence of what the publisher wrote.`;
  return { title, markdown, status: 'ready', extractor: 'dummy' };
}
