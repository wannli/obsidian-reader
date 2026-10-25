import type { Modal } from 'obsidian';

/** Complete a modal through its existing primary action on Cmd/Ctrl-Enter. */
export function bindModalSubmit(modal: Modal, submit: () => void): void {
  modal.contentEl.addEventListener(
    'keydown',
    (event) => {
      if (
        event.key !== 'Enter' ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing ||
        event.repeat
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      submit();
    },
    true,
  );
}
