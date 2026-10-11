# Browser/mobile ingestion boundary

Public APIs (shared result and transport types are in `src/types.ts`):

```ts
normalizeUrl(url: string): string
parseFeed(xml: string, url: string): ParsedFeed
extractArticle(url: string, get: HttpGet, mode: 'dummy' | 'defuddle'): Promise<ExtractedArticle>
```

- `normalizeUrl` accepts absolute HTTP(S) URLs without credentials, controls or excessive length. It normalizes the host/default port/path through `URL`, removes fragments for identity, and **preserves** query parameters, their order, path case and trailing slashes. It does not trust publisher canonical links.
- `parseFeed` supports RSS 2.0, RSS 1.0/RDF and Atom (including namespaces and inherited `xml:base`). It returns `{title, entries: [{id, title, url, published?, summary?, feedText?}]}`, where `feedText` is `{markdown: string, isExcerpt: boolean}`. Dates are ISO strings when usable; titles are bounded plain text. GUID/Atom ID and normalized URL are both deduplication keys; the first usable entry wins. Invalid entry URLs are skipped; a nonempty feed with no usable entries throws. Valid empty feeds are allowed. `summary` remains a bounded plain-text preview. `feedText` carries all safely converted text supplied inline by the feed, not a fabricated article or an article-page extraction. Consumers must put this genuine Markdown in the readable article body, preserve publisher titles, and prevent dummy replacement; parser output alone does not prove that storage/UI integration is complete. Article-page acquisition remains separate from feed HTTP. Pass the final feed response URL when known so relative links resolve after redirects.
- `extractArticle` requires an explicit mode: `'dummy'` returns deterministic sample content without fetching, while `'defuddle'` requests HTML through the injected `HttpGet`, runs the synchronous **`defuddle/full` browser entry**, sanitizes before Markdown conversion, and returns `{title, markdown, status: 'ready' | 'partial', extractor: 'defuddle', warning?}`. `partial` has a human-readable warning for short/restricted text, extractor failure, or conservative article/main fallback. Unusable text, link-only pages, HTTP/MIME errors, timeouts and unsafe/oversized sources reject with an `Error`; callers must persist/show the error instead of treating it as a ready empty article. Quality is heuristic, not a completeness guarantee.

## Feed summary metadata

`entry.summary` is optional plain display text, not HTML or Markdown: consumers must render it with `textContent` (or equivalent escaping), never interpolate it as HTML or use it as a completed body. Atom `text` preserves literal text; `html` is sanitized/flattened; `xhtml` handles actual children and namespace prefixes. RSS prefers usable `description` text, then the standard content-module `encoded` element. Atom `content` is not used as a summary fallback.

Summaries are limited to 2,000 UTF-16 characters, including an ellipsis when truncated; HTML parsing uses at most a 16,384-character source prefix plus the existing DOM limits. Active subtrees, hidden content, source comments, event/URL attributes and image markup are discarded. Literal tag syntax in text remains text, not executable HTML. Unusable/empty/unsupported summaries are omitted without dropping otherwise valid entries. No network requests, Defuddle invocation, article state fields or body inference are introduced.

## Supplied feed Markdown

`feedText` is an approved **transient parser result**, not a new YAML property. Namespaced RSS `content:encoded` and inline Atom `content` take priority and set `isExcerpt: false`. RSS `description` and Atom `summary` set `isExcerpt: true`, even when long or apparently complete. The distinction comes from the supplying field, never a length heuristic; explicit content does not prove completeness against an unfetched publisher page. Empty/unsupported/out-of-line content can fall back to a usable summary; out-of-line Atom `src` is never fetched, and Media RSS `media:content` is not an article body.

The complete selected field is sanitized and converted to Markdown without the preview's 2,000-character output or 16,384-character input truncation. Feed payload/DOM bounds still apply, and Markdown output is capped at 4 MiB. Exceeding a safety bound throws visibly rather than silently clipping supplied text. Paragraphs, lists, quotes, code examples, safe links and remote-image references are retained; events/active HTML and source comments are removed. Literal comment syntax in code remains literal. Inherited `xml:base`, prefixed XHTML and relative resource URLs are handled in inert browser DOMs. This path performs no HTTP requests or Defuddle construction/parse—only the browser Markdown converter is reused.

Inspection of the provided WIRED AI RSS and Simon Willison everything Atom URLs found descriptions and HTML summaries, respectively, not explicit content fields. Both are therefore excerpts. Simon's actual `Quoting @joedaroo` entry supplies genuine rich text and must not have its title/body replaced with dummy content. Restoring already-created notes, protecting edits/highlights, and deciding persisted state remain storage/controller responsibilities; there is no new persisted origin flag here.

## Explicit dummy mode

The controller passes `settings.useDummyContent ? 'dummy' : 'defuddle'`. The UI setting **Use dummy article content** defaults ON; the ingestion function itself keeps its legacy real-extraction default. Dummy mode validates/normalizes the URL and returns **before any HTTP request, timer, DOM parse, Defuddle construction/parse or Markdown conversion**. It does not disguise dummy HTML as a publisher response. Feed transport is unaffected by this article-mode switch.

The dummy result has `status: 'ready'`, `extractor: 'dummy'`, a deterministic URL-derived title prefixed “Dummy article”, and multi-paragraph Markdown beginning with “Dummy article — extraction is disabled”. It explicitly says the text was generated and is not the publisher’s article. Distinct paragraphs, headings, a list and a validated source link support highlight/link/delete exercises without images or external assets. No clock, randomness or generated HTML comments are used.

`ExtractedArticle.extractor` distinguishes dummy from Defuddle results at the ingestion boundary; it is not persisted on new article notes. There is no `provenance` or `attempted` field. Scheduling must not treat an arbitrary nonempty body as replaceable: only independently verified dummy or excerpt bytes can be upgraded, and authored/highlighted snapshots must be preserved. The dummy sample counts as complete for dummy mode, not as a real extraction.

## Safety and limits

No Node/Electron APIs, filesystem, `defuddle/node`, runtime jsdom, server, or extractor-triggered network calls. Tests use jsdom only as Vitest's DOM environment. HTML is parsed inside an inert template in a `DOMParser` document and is never attached to the live application DOM. DOMPurify uses a narrow passive HTML allowlist before extraction and again before conversion. Scripts, styles, iframes, forms, SVG/MathML, event attributes, srcset and credential/non-HTTP(S) destinations are removed. Safe relative links/images use validated response/base URLs. Hidden source nodes are not recovered as article text.

Markdown keeps ordinary headings, quotes, lists, tables, links, images and code. Actual HTML comment nodes are discarded, not serialized into generated markers. Literal comment/tag syntax inside fenced and inline code is preserved. Prose is entity-escaped so encoded HTML cannot become active HTML, comments or unvalidated automatic links after conversion. Unknown code-language labels are omitted to avoid executable Obsidian plugin fences such as `dataviewjs`; code text is retained.

Limits: 8,192-character URLs; 2 MiB feed and 4 MiB article/Markdown **UTF-8** payloads; 20,000 DOM nodes; depth 64; 1,000 feed entries. Feed XML rejects DTD/entity declarations before parsing, and rejects malformed or non-feed documents. A conservative markup-count preflight also prevents excessive node allocation before native parsing (including tag-like text inside comments/code). Exceeding a limit throws, rather than silently truncating article text or feed entries.

Extraction has a 20-second total deadline with a transport timeout race and processing checkpoints. Late transport responses are ignored and never parsed/written. `HttpGet` has no AbortSignal, so this module cannot cancel its underlying request. The transport must bound network allocation, own cancellation if available, and validate redirect hops/credential policy; this module checks the input and exposed final URL, not intermediate redirects or DNS. Synchronous DOM/extractor work cannot be preempted by a timer on the browser main thread; input/node/depth limits bound that work and deadline checks reject overdue results. The transport also owns byte decoding/charset handling (`HttpResponse.text` is already decoded).

## Offline scope

Returned full article Markdown is ready for authoritative vault storage and offline text reading. **Images remain remote HTTP(S) links and require network access.** No image downloading/embedding/archive is implemented yet; images can change or disappear and may contact publisher/CDN hosts when displayed. This is not a fully offline media archive.

Fixtures are in `tests/ingestion*.test.ts`: zero-request/zero-Defuddle dummy generation, deterministic/safe sample content, unchanged real extraction, RSS/Atom/RDF, GUID/URL aliases, malicious XML/HTML/Markdown destinations, literal code comments, bounded plain-text previews, complete supplied RSS/Atom Markdown with excerpt classification, response quality, independent bounds and late-timeout behavior. Browser smoke checks can run against the preview's modules. Physical iOS and sync acceptance remain **NOT RUN** without hardware evidence.
