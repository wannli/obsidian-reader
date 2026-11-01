import { Modal, Setting, type App } from 'obsidian';
import type { TopicFilter } from '../core/topic-filter';
import { bindModalSubmit } from './modal-submit';

/** null cancels; a free-text choice is a filter, never a request to create a note. */
export function chooseTopicFilter(
  app: App,
  topics: readonly TopicFilter[],
  current: TopicFilter | undefined,
  signal: AbortSignal,
): Promise<TopicFilter | null> {
  return new Promise((resolve) => {
    let selected = false;
    class TopicFilterDialog extends Modal {
      onOpen(): void {
        this.setTitle('Filter articles by topic');
        const input = this.contentEl.createEl('input', {
          type: 'search',
          value: current?.label ?? '',
          placeholder: 'Topic name or any word / phrase',
          attr: { 'aria-label': 'Topic filter' },
        });
        const results = this.contentEl.createDiv({ cls: 'reader-topic-filter-options' });
        const select = (filter: TopicFilter) => {
          if (signal.aborted) return;
          selected = true;
          resolve(filter);
          this.close();
        };
        const render = () => {
          results.empty();
          const query = input.value.trim();
          if (query)
            new Setting(results)
              .setName(`Search for “${query}”`)
              .setDesc('Match this word or phrase without creating a topic.')
              .addButton((button) =>
                button
                  .setButtonText('Use text')
                  .onClick(() => select({ label: query, terms: [query] })),
              );
          const needle = query.toLocaleLowerCase();
          const matches = topics
            .filter((topic) =>
              topic.terms.some((term) => term.toLocaleLowerCase().includes(needle)),
            )
            .sort((a, b) => {
              if (!needle) return 0; // Preserve frequency ordering of empty-query suggestions.
              const rank = (topic: TopicFilter) =>
                topic.terms.some((term) => term.toLocaleLowerCase() === needle)
                  ? 0
                  : topic.terms.some((term) => term.toLocaleLowerCase().startsWith(needle))
                    ? 1
                    : 2;
              return rank(a) - rank(b) || a.label.localeCompare(b.label);
            });
          for (const topic of matches.slice(0, 100))
            new Setting(results)
              .setName(topic.label)
              .setDesc(topic.path ?? '')
              .addButton((button) => button.setButtonText('Filter').onClick(() => select(topic)));
          if (matches.length > 100)
            results.createEl('p', { text: 'Refine your search to see more topics.' });
          if (!matches.length && !query)
            results.createEl('p', { text: 'Enter any word or phrase to filter articles.' });
        };
        input.addEventListener('input', render);
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && input.value.trim() && !event.isComposing) {
            event.preventDefault();
            select({ label: input.value.trim(), terms: [input.value.trim()] });
          }
        });
        bindModalSubmit(this, () => {
          const focused = this.contentEl.ownerDocument.activeElement;
          if (results.contains(focused) && focused?.tagName === 'BUTTON') {
            (focused as HTMLButtonElement).click();
            return;
          }
          const query = input.value.trim();
          if (query) select({ label: query, terms: [query] });
        });
        new Setting(this.contentEl).addButton((button) =>
          button.setButtonText('Cancel').onClick(() => this.close()),
        );
        render();
        input.focus();
      }
      onClose(): void {
        signal.removeEventListener('abort', abort);
        this.contentEl.empty();
        if (!selected) resolve(null);
      }
    }
    const modal = new TopicFilterDialog(app);
    const abort = () => modal.close();
    if (signal.aborted) {
      resolve(null);
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    modal.open();
  });
}
