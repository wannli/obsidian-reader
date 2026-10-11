import type { ArticleStatus } from '../types';
import type { ReadingPosition } from './eink-types';
export interface ReaderState { file?: string; queue?: ArticleStatus; scrollTop?: number; subpath?: string; readingPosition?: ReadingPosition; }
export interface ReaderOpenOptions extends Omit<ReaderState, 'file'> { focus?: boolean; isCurrent?: () => boolean; }
