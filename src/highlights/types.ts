export interface TextQuoteSelector { exact: string; prefix: string; suffix: string }
export interface TextPositionSelector { start: number; end: number }
export interface DomPoint { node: Text; offset: number }
export interface DomRangeSelector {
  start: { path: number[]; offset: number };
  end: { path: number[]; offset: number };
}
export interface ArticleAnchor {
  /** Caller body version or fixed persistence token; exact/context are always verified. */
  articleVersion: string;
  normalisationVersion: number;
  quote: TextQuoteSelector;
  position: TextPositionSelector;
  structural?: DomRangeSelector;
}
export interface IndexedCodePoint { value: string; start: DomPoint; end: DomPoint }
export interface TextIndex {
  root: HTMLElement;
  normalisationVersion: 1;
  text: string;
  codePoints: readonly string[];
  units: readonly IndexedCodePoint[];
}
export type AnchorResolution =
  | { state: 'resolved'; range: Range; position: TextPositionSelector; method: 'position' | 'structural' | 'quote' }
  | { state: 'orphaned'; reason: 'unsupported-normalisation' | 'invalid-anchor' | 'not-found' | 'ambiguous' | 'context-mismatch' };
export type HighlightColour = 'yellow' | 'green' | 'blue' | 'pink' | 'purple' | 'orange' | 'red';
export interface ResolvedHighlight { id: string; range: Range; colour: HighlightColour }
export interface SelectionSnapshot { range: Range; anchor: ArticleAnchor; rect: DOMRect | null }
