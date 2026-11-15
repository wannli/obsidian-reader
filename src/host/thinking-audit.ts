import { Modal, type App, type TFile } from 'obsidian';
import type { ArticleStore } from '../core/store';

/** Read-only, explicit pages. No inferred canonical article and no repair control. */
export function openThinkingAudit(app: App, store: ArticleStore<TFile>, signal: AbortSignal): void {
  const lifetime = new AbortController();
  class Audit extends Modal {
    private offset = 0;
    private busy = false;
    onOpen(): void {
      this.setTitle('Reader integrity audit — read only');
      this.contentEl.addClass('reader-thinking-browser');
      this.contentEl.createEl('p', {
        text: 'URL groups use observed article metadata. Legacy-link evidence checks paged article source snapshots, not all-vault backlinks. No file is chosen as canonical and nothing is repaired.',
      });
      const results = this.contentEl.createDiv({ cls: 'reader-thinking-list' });
      const status = this.contentEl.createEl('p', { attr: { role: 'status' } });
      const next = this.contentEl.createEl('button', { text: 'Check first 50 articles' });
      next.addEventListener('click', async () => {
        if (this.busy || lifetime.signal.aborted) return;
        this.busy = true;
        next.disabled = true;
        status.textContent = 'Checking source snapshots…';
        try {
          const report = await store.audit({
            signal: lifetime.signal,
            offset: this.offset,
            limit: 50,
          });
          if (lifetime.signal.aborted) return;
          if (this.offset === 0) {
            results.createEl('h2', { text: 'Normalized-URL duplicates' });
            if (!report.duplicateUrls.length)
              results.createEl('p', {
                text: 'No duplicate groups in currently observed article metadata.',
              });
            for (const group of report.duplicateUrls) {
              const item = results.createDiv({ cls: 'reader-thinking-item' });
              item.createEl('strong', { text: group.url });
              for (const path of group.paths) item.createEl('p', { text: path });
            }
            results.createEl('h2', { text: 'Uncertain legacy passage links' });
          }
          for (const item of report.uncertainLegacyAnchors)
            results.createEl('p', {
              text: `${item.path}: ${item.reason}${item.blockId ? ' — ^' + item.blockId : ''}`,
            });
          status.textContent = `Checked ${report.coverage.scanned} article source snapshot(s) on this page, of ${report.coverage.total} indexed articles. ${report.coverage.skipped.length} could not be checked. No repairs made.`;
          for (const skipped of report.coverage.skipped)
            results.createEl('p', { text: `${skipped.path}: ${skipped.reason}` });
          if (report.nextOffset === undefined) next.textContent = 'Audit pages complete';
          else {
            this.offset = report.nextOffset;
            next.textContent = 'Check next 50 articles';
            next.disabled = false;
          }
        } catch (error) {
          if (!lifetime.signal.aborted) {
            status.textContent = error instanceof Error ? error.message : String(error);
            next.disabled = false;
          }
        } finally {
          this.busy = false;
        }
      });
      next.click();
    }
    onClose(): void {
      lifetime.abort();
      signal.removeEventListener('abort', abort);
      this.contentEl.empty();
    }
  }
  const modal = new Audit(app),
    abort = () => modal.close();
  if (signal.aborted) return;
  signal.addEventListener('abort', abort, { once: true });
  modal.open();
}
