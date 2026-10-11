import type { CompactAnchor, Highlight } from '../types';

export type InlineErrorCode = 'stale' | 'ambiguous' | 'not-found' | 'unsupported' | 'overlap' | 'unsafe-target';
export class InlineMarkdownError extends Error {
  constructor(public readonly code: InlineErrorCode, message: string) { super(message); this.name = 'InlineMarkdownError'; }
}
/** UTF-16 offsets into the original, unmodified Markdown. */
export interface SourceRange { start: number; end: number }
export interface InlineHighlight extends Highlight { source: SourceRange; anchor: CompactAnchor }
export interface InlineLink {
  id: string; target: string; quote: string; source: SourceRange; anchor: CompactAnchor;
  kind: 'wiki' | 'markdown';
}
export interface InlineParseOptions {
  /** Remove only the first H1 if its canonical text equals this title. No source edit. */
  stripTitle?: string;
}
export interface ParsedInlineMarkdown {
  revision: string;
  html: string;
  /** Detached, sanitized article root; source maps are private, never trusted HTML attributes. */
  root: HTMLElement;
  canonicalText: string;
  highlights: InlineHighlight[];
  links: InlineLink[];
  /** Rendered annotations in unsupported constructs are not silently treated as editable. */
  warnings: string[];
  /** Protect source even when an authored highlight cannot be safely mapped/edited. */
  hasUnsupportedHighlights: boolean;
}
export interface InlineSelection {
  quote: string;
  anchor?: CompactAnchor;
  /** Must be supplied here or in anchor.version for version-checked selection writes. */
  revision?: string;
}
