import { button, element, messageOf } from './dom';
import type { RelationshipDraft } from './relationship-draft';
/** Shared native-modal/BrowserStore draft controls; no vault writes before Save. */
export function relationshipPicker(root: HTMLElement, draft: RelationshipDraft, close: () => void, saved: () => void) {
  const property = draft.property, singular = property === 'authors' ? 'author' : 'topic';
  let busy = false, disposed = false;
  const search = element('input'); search.type = 'search'; search.placeholder = `Search ${property}`; search.setAttribute('aria-label', `Search ${property}`);
  const description = element('p', '', `Select existing ${property} anywhere in the vault. New ${singular} nodes are staged in Nodes and created only when you Save.`);
  const list = element('div', 'r2-topic-list'), count = element('p'); count.setAttribute('role', 'status');
  const name = element('input'); name.type = 'text'; name.placeholder = `New ${singular} name`; name.setAttribute('aria-label', `New ${singular} name`);
  const error = element('p', 'r2-error'); error.setAttribute('role', 'alert');
  const render = () => {
    list.replaceChildren(); count.textContent = draft.selected.size + ' selected';
    for (const option of draft.options.filter(option => (option.title + ' ' + option.path).toLocaleLowerCase().includes(search.value.toLocaleLowerCase()))) {
      const row = element('label', 'r2-relationship-option'), checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = draft.selected.has(option.path); checkbox.disabled = busy;
      checkbox.setAttribute('aria-label', option.path);
      checkbox.onchange = () => { if (busy) return; if (checkbox.checked) draft.selected.add(option.path); else draft.selected.delete(option.path); count.textContent = draft.selected.size + ' selected'; };
      row.append(checkbox, element('span', '', `${option.title} · ${option.path}${draft.staged.has(option.path) ? ' (create on Save)' : ''}`)); list.append(row);
    }
    if (!list.childElementCount) list.append(element('p', '', `No matching ${property}.`));
  };
  const stage = button(`Create ${singular}`, () => {
    if (busy) return;
    try { draft.stage(name.value); name.value = ''; search.value = ''; error.textContent = ''; render(); }
    catch (failure) { error.textContent = messageOf(failure); }
  });
  const cancel = button('Cancel', () => { if (!busy) close(); });
  const save = button('Save', async () => {
    if (busy || disposed) return; busy = true; error.textContent = '';
    for (const control of [search, name, stage, cancel, save]) control.disabled = true;
    render();
    try { await draft.save(); if (!disposed) { busy = false; saved(); close(); } }
    catch (failure) {
      if (!disposed) { busy = false; error.textContent = messageOf(failure); for (const control of [search, name, stage, cancel, save]) control.disabled = false; render(); }
    }
  }, 'mod-cta');
  search.oninput = render;
  const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape' && busy) { event.preventDefault(); event.stopPropagation(); } };
  root.addEventListener('keydown', keyboard, true);
  root.append(description, search, list, count, name, stage, error, cancel, save); render(); search.focus();
  return { isSaving: () => busy, dispose: () => { disposed = true; root.removeEventListener('keydown', keyboard, true); } };
}
