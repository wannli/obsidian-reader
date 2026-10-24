import { passages, type Passage } from '../core/annotations';

/** One surface, one exact body revision. Never caches YAML, ASTs or vault-wide strings. */
export class ArticleAnalysis {
  private body?: string;
  private marks?: Passage[];
  passages(body: string): Passage[] {
    if (body !== this.body || !this.marks) {
      // Compute first: a failed analysis must not publish a mismatched cache key.
      const marks = passages(body);
      this.body = body;
      this.marks = marks;
    }
    // Keep mutable UI intents independent of the cached evidence, including nested spans.
    return this.marks.map((mark) => ({
      ...mark,
      ...(mark.fragments ? { fragments: mark.fragments.map((span) => ({ ...span })) } : {}),
      ...(mark.hosts ? { hosts: [...mark.hosts] } : {}),
      ...(mark.citation ? { citation: { ...mark.citation } } : {}),
    }));
  }
  clear(): void {
    this.body = undefined;
    this.marks = undefined;
  }
}
