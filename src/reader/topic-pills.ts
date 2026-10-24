import type { ReferenceIcon } from './render';

export interface ArticleTopic {
  readonly target?: string;
  readonly label: string;
}

/** Read-only metadata presentation; never an annotation or a note-creation action. */
export function articleTopicPill(
  document: Document,
  topics: readonly ArticleTopic[],
  paintIcon?: ReferenceIcon,
): HTMLElement | undefined {
  if (!topics.length) return;
  const group = document.createElement('span');
  group.className = 'reader-reference-group';
  for (const topic of topics) {
    if (group.hasChildNodes()) group.append(document.createTextNode(' '));
    const label = document.createElement('span');
    label.className = 'reader-reference-label';
    label.textContent = topic.label;
    if (!topic.target) {
      group.append(label);
      continue;
    }
    const link = document.createElement('a');
    link.className = 'internal-link reader-reference-pill';
    link.href = topic.target.split('/').map(encodeURIComponent).join('/');
    link.dataset.readerTopic = topic.target;
    link.title = `Open note · ${topic.label} (Enter when focused)`;
    link.append(label);
    const icon = document.createElement('span');
    icon.className = 'reader-node-icon reader-reference-icon';
    icon.setAttribute('aria-hidden', 'true');
    try {
      paintIcon?.(topic.target, icon);
      if (icon.hasChildNodes()) link.prepend(icon);
    } catch {
      // A disappearing optional provider must not hide existing topic labels.
    }
    group.append(link);
  }
  return group;
}
