/** Quiet diagnostics: inspect in Obsidian's developer console, not as toast notices. */
export function logReaderError(error: unknown): void {
  console.error('[Reader]', error);
}
