/** Opaque browser image errors: exact URL only, never a host-wide or HTTP-status policy. */
export class FailedImageCooldown {
  private readonly failures = new Map<string, number>();

  constructor(
    private readonly durationMs = 5 * 60_000,
    private readonly capacity = 256,
    private readonly now: () => number = Date.now,
  ) {}

  private prune(now: number): void {
    for (const [url, expires] of this.failures) {
      if (expires <= now) this.failures.delete(url);
    }
  }

  has(url: string): boolean {
    const now = this.now();
    this.prune(now);
    return this.failures.has(url);
  }

  fail(url: string): void {
    const now = this.now();
    this.prune(now);
    if (this.capacity <= 0) return;
    this.failures.delete(url);
    this.failures.set(url, now + this.durationMs);
    while (this.failures.size > this.capacity) {
      this.failures.delete(this.failures.keys().next().value!);
    }
  }
}

const displayedImageFailures = new FailedImageCooldown();

/** Must run in the parser's inert document, BEFORE adopting nodes into a live document. */
export function prepareArticleImages(root: HTMLElement, cooldown = displayedImageFailures): void {
  // Responsive images are not supported by the Markdown sanitizer. Do not allow a
  // picture source or future sanitizer change to bypass the single-URL policy.
  for (const source of root.querySelectorAll('source')) {
    source.removeAttribute('src');
    source.removeAttribute('srcset');
  }
  for (const img of root.querySelectorAll('img')) {
    img.removeAttribute('srcset');
    const src = img.getAttribute('src') ?? '';
    if (!/^https?:\/\//i.test(src)) { img.remove(); continue; }
    let url: string;
    try { url = new URL(src).href; } catch { img.remove(); continue; }
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    if (cooldown.has(url)) {
      // Keep the img and its alt text; never mutate Markdown or insert indexed text.
      img.removeAttribute('src');
      continue;
    }
    img.addEventListener('error', () => cooldown.fail(url), { once: true });
  }
}
