import type { ReadingPosition } from '../reading-position';
export type { ReadingPosition } from '../reading-position';

export interface EinkPaginationOptions {
  initialPosition?: ReadingPosition;
  onChange?: () => void;
}

export interface EinkPagination {
  turn(delta: number): boolean;
  reveal(range: Range): boolean;
  getPosition(): ReadingPosition;
  restore(position: ReadingPosition): void;
  /** Attach a UI-only completion page after the source columns. */
  setEndPage(element: HTMLElement): void;
  /** Recount changed render/status content without replacing the reading anchor. */
  refresh(): void;
  /** One-based page; ready is false while hidden or too small to paginate. */
  progress(): { page: number; total: number; ready: boolean };
  dispose(): void;
}

export interface EinkGeometry {
  /** Physical direction of successive columns; text direction remains inherited. */
  flow: 1 | -1;
  stride: number;
  gutter: number;
  width: number;
  height: number;
}

/** Media-only columns retain a live element until disposal; it is never serialized. */
export interface EinkAnchor {
  position: ReadingPosition;
  element?: Element;
}
