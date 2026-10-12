import { DEFAULT_HIGHLIGHT_TYPES, type TypedHighlightType } from './typed-highlights';
export type ArticleStatus = 'feed' | 'inbox' | 'later' | 'archive';
export type ContentState = 'pending' | 'ready' | 'partial' | 'error' | 'protected';
export type ArticleExtractor = 'pending' | 'summary' | 'manual' | 'dummy' | 'defuddle' | 'feed';
export interface CompactAnchor { start: number; end: number; prefix: string; suffix: string; version?: string; }
export interface Highlight {
  color?: import('./typed-highlights').HighlightColor;
  id: string;
  quote: string;
  link?: string;
  anchor?: CompactAnchor;
}
export interface Article {
  path: string;
  /** Ephemeral raw-note revision for acquisition compare-and-swap; never persisted. */
  revision?: string;
  title: string;
  url: string;
  feed?: string;
  published?: string;
  status?: ArticleStatus;
  content: ContentState;
  extractor: ArticleExtractor;
  summary?: string;
  retryAfter?: string;
  readingPosition?: import('./reading-position').ReadingPosition;
  topics?: string[];
  authors?: string[];
  relationshipRevisions?: { topics: string; authors: string };
  error?: string;
  body: string;
  highlights: Highlight[];
}
export interface Feed {
  prefix?: string;
  path: string;
  id: string;
  title: string;
  url: string;
  enabled: boolean;
  error?: string;
}
export interface ReaderSettings {
  typedHighlightTypes: TypedHighlightType[];
  feedsFolder: string;
  pollMinutes: number;
  feedScheduleVersion: number;
  maxFeedItems: number;
  useDummyContent: boolean;
}
export const DEFAULT_SETTINGS: ReaderSettings = {
  typedHighlightTypes: DEFAULT_HIGHLIGHT_TYPES.map(type => ({ ...type })),
  feedsFolder: 'Reading/Wires',
  pollMinutes: 240, feedScheduleVersion: 1, maxFeedItems: 50, useDummyContent: true,
};
export interface ReadGuard { assert(): void; dispose(): void; }
export interface FileStore {
  /** Capture an observed target revision; assert synchronously at another note's commit boundary. */
  observe?(path: string, read: (current: string) => void): Promise<ReadGuard>;
  /** Full indexed entries, including empty folders and non-Markdown files. */
  assertNotePath?(path: string): void;
  list(): Promise<string[]>;
  /** Current synchronous Markdown path index, for reference-resolution commit guards. */
  indexedPaths?(): readonly string[];
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** Synchronous revision of all changes except an optional target path. */
  revision(excludingPath?: string): number;
  /** Release adapter change observers once the repository is shut down. */
  dispose?(): void;
  /** Synchronous indexed absence check, used inside a metadata CAS callback. */
  assertAbsent?(path: string): void;
  /** Run the final adapter guard before dispatch. */
  create(path: string, content: string, options?: { guard?: () => void }): Promise<void>;
  process(path: string, update: (current: string) => string): Promise<void>;
  /** Inspect the latest native buffer without saving it; the later write must recheck it. */
  inspect?(path: string, read: (current: string) => void): Promise<void>;
  /** Preserve exact bytes; no implicit link updates. Reject stale source, collisions and unsafe editors. */
  rename(from: string, to: string, options: { expectedContent: string; guard?: () => void }): Promise<void>;
  /** Recoverable removal; reject changed bytes, identity and unsafe editors. */
  trash?(path: string, options: { expectedContent: string; guard?: () => void }): Promise<void>;

}
export interface NewArticle { title: string; url: string; status?: ArticleStatus; feed?: string; feedPrefix?: string; published?: string; body?: string; content?: ContentState; extractor?: ArticleExtractor; summary?: string; feedText?: { markdown: string; isExcerpt: boolean }; }
export interface ExtractedArticle { title: string; markdown: string; status: 'ready' | 'partial'; extractor: 'dummy' | 'defuddle'; warning?: string; }
export interface FeedEntry { id: string; title: string; url: string; published?: string; summary?: string; feedText?: { markdown: string; isExcerpt: boolean }; }
export interface ParsedFeed { title: string; entries: FeedEntry[]; }
export interface HttpResponse { status: number; text: string; headers: Record<string, string>; url?: string; }
export type HttpGet = (url: string, headers?: Record<string, string>) => Promise<HttpResponse>;
