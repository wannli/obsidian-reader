import { Modal, setIcon, type App } from 'obsidian';
import {
  hasNodeClass,
  nodeChoiceMatch,
  nodeChoiceSeed,
  nodeChoices,
  type NodeChoiceType,
} from '../core/node-choices';
import type { NodeResult, NodesApi } from './nodes';
import { bindModalSubmit } from './modal-submit';

export type HighlightHostChoice =
  | { kind: 'existing'; node: NodeResult }
  | { kind: 'existing-many'; nodes: NodeResult[] }
  | { kind: 'pick-in-article'; nodes: NodeResult[] }
  | { kind: 'create'; title: string; type: string; existingNodes?: NodeResult[] };

export interface HighlightHostPickerOptions {
  title?: string;
  query?: string;
  excerpt?: string;
  preferredPaths?: readonly string[];
  signal?: AbortSignal;
  allowCreate?: boolean;
  multiple?: boolean;
  selectedPaths?: string[];
  minSelection?: number;
  actionLabel?: string;
  tone?: 'highlight' | 'node' | 'neutral';
  allowPickFromArticle?: boolean;
}

export type HighlightHostApi = Pick<
  NodesApi,
  'version' | 'listTypes' | 'searchNodes' | 'getNode' | 'createNodeForLink'
>;

const excludedClasses = new Set(['article', 'feed']);
const allowedClass = (name: string) => !excludedClasses.has(name.toLocaleLowerCase());
const allowedNode = (node: NodeResult) => node.classes.every(allowedClass);

function append<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = parent.ownerDocument.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  parent.append(element);
  return element;
}

/** Return explicit destination intents; only the caller creates or writes through Fileclass v2. */
export function chooseHighlightHost(
  app: App,
  api: HighlightHostApi,
  options: HighlightHostPickerOptions = {},
): Promise<HighlightHostChoice | null> {
  if (options.signal?.aborted) return Promise.resolve(null);
  const multiple = options.multiple === true;
  const minimum = Number.isFinite(options.minSelection)
    ? Math.max(0, Math.ceil(options.minSelection!))
    : 1;
  const actionLabel = options.actionLabel?.trim() || 'Add highlight';
  const action = actionLabel.charAt(0).toLocaleLowerCase() + actionLabel.slice(1);
  return new Promise((resolve) => {
    let settled = false;
    const active = () => !settled && !options.signal?.aborted;
    const finish = (choice: HighlightHostChoice | null) => {
      if (settled || (choice && !active())) return;
      settled = true;
      resolve(choice);
      modal.close();
    };
    class HighlightHostDialog extends Modal {
      onOpen(): void {
        this.setTitle(options.title ?? 'Add highlight to notes');
        this.modalEl.classList.add('reader-highlight-picker-modal', 'prompt');
        if (options.tone === 'highlight' || options.tone === 'node')
          this.modalEl.classList.add(`reader-picker-${options.tone}`);
        this.contentEl.classList.add('reader-highlight-picker');
        if (options.excerpt?.trim()) {
          const excerpt = append(this.contentEl, 'div', 'reader-highlight-picker-excerpt');
          const words = Array.from(options.excerpt.replace(/\s+/gu, ' ').trim());
          const preview = words.slice(0, 220).join('') + (words.length > 220 ? '…' : '');
          excerpt.textContent = preview;
          excerpt.setAttribute('aria-label', `Selected passage: ${preview}`);
        }
        const selectedSection = append(this.contentEl, 'div', 'reader-highlight-picker-selected');
        const selectedHeading = append(
          selectedSection,
          'div',
          'reader-highlight-picker-selected-heading',
        );
        const selectedResults = append(
          selectedSection,
          'div',
          'reader-highlight-picker-selected-results',
        );
        selectedResults.setAttribute('role', 'group');
        selectedResults.setAttribute('aria-label', 'Selected typed notes');
        const controls = append(this.contentEl, 'div', 'reader-highlight-picker-controls');
        const searchWrap = append(
          controls,
          'div',
          'reader-highlight-picker-search-wrap prompt-input-container',
        );
        const search = append(searchWrap, 'input', 'reader-highlight-picker-search prompt-input');
        search.type = 'search';
        search.placeholder = 'Search notes or enter a new title';
        search.setAttribute('aria-label', 'Search typed notes');
        search.value = nodeChoiceSeed(options.query);
        const results = append(
          this.contentEl,
          'div',
          'reader-highlight-picker-results prompt-results',
        );
        results.setAttribute('role', 'group');
        results.setAttribute('aria-label', 'Typed notes and creation choices');
        const message = append(this.contentEl, 'div', 'reader-highlight-picker-message');
        message.setAttribute('role', 'alert');
        const footer = append(this.contentEl, 'div', 'reader-highlight-picker-footer');
        const cancel = append(footer, 'button', '', 'Cancel');
        const retry = append(footer, 'button', '', 'Retry');
        const fromArticle =
          multiple && options.allowPickFromArticle
            ? append(
                footer,
                'button',
                'reader-highlight-picker-article-choice',
                'Choose from article…',
              )
            : undefined;
        const confirm = multiple ? append(footer, 'button', 'mod-cta', actionLabel) : undefined;
        for (const button of [cancel, retry, fromArticle, confirm])
          if (button) button.type = 'button';
        let types: NodeChoiceType[] = [];
        let rows: NodeResult[] = [];
        let exact: NodeResult[] = [];
        let selected = new Map<string, NodeResult>();
        const originalPaths = new Set(options.selectedPaths ?? []);
        let initialized = !multiple;
        let canCreate = false;
        let hasError = false;
        const preferredPaths = [
          ...new Set([
            ...(options.preferredPaths ?? []),
            ...(!multiple ? (options.selectedPaths ?? []) : []),
          ]),
        ].slice(0, 20);
        const query = () => search.value.replace(/\s+/gu, ' ').trim();
        const classNames = (node: NodeResult) =>
          node.classes
            .map((type) => types.find((entry) => entry.type === type)?.label)
            .filter(Boolean)
            .join(' · ');
        const icon = (parent: HTMLElement, name: string | undefined, className: string) => {
          if (!name) return;
          const element = append(parent, 'span', className);
          element.setAttribute('aria-hidden', 'true');
          setIcon(element, name);
        };
        const updateFooter = () => {
          if (fromArticle) fromArticle.disabled = hasError || !initialized;
          if (confirm) {
            confirm.disabled = hasError || !initialized || selected.size < minimum;
            confirm.setAttribute('aria-label', `${actionLabel} (${selected.size} selected)`);
          }
        };
        const clearError = () => {
          hasError = false;
          message.hidden = true;
          message.textContent = '';
          retry.hidden = true;
        };
        const showError = (error: unknown) => {
          if (!active()) return;
          hasError = true;
          message.textContent =
            error instanceof Error ? error.message : 'Typed notes are unavailable. Try again.';
          message.hidden = false;
          retry.hidden = false;
          updateFooter();
        };
        const run = (work: () => void) => {
          if (!active()) return;
          const focusedResult = results.contains(this.contentEl.ownerDocument.activeElement);
          clearError();
          try {
            work();
          } catch (error) {
            if (!active()) return;
            rows = [];
            exact = [];
            showError(error);
            renderResults();
            const focused = this.contentEl.ownerDocument.activeElement;
            if (
              focusedResult ||
              !this.contentEl.contains(focused) ||
              (focused as HTMLButtonElement | null)?.disabled
            )
              retry.focus();
          }
        };
        const readTypes = () => {
          if (
            api.version !== 2 ||
            !['listTypes', 'searchNodes', 'getNode'].every(
              (key) => typeof (api as unknown as Record<string, unknown>)[key] === 'function',
            )
          )
            throw new Error('Fileclass typed-note search is unavailable.');
          const available = api.listTypes();
          if (!Array.isArray(available)) throw new Error('Fileclass types are unavailable.');
          types = [
            ...new Map(
              available
                .filter(
                  (entry) =>
                    typeof entry.type === 'string' && entry.type.trim() && allowedClass(entry.type),
                )
                .map((entry) => [entry.type, { ...entry, label: entry.label || entry.type }]),
            ).values(),
          ];
          canCreate = options.allowCreate !== false && typeof api.createNodeForLink === 'function';
        };
        const searchNodes = (term: string) => {
          const found = api.searchNodes(term);
          if (!Array.isArray(found)) throw new Error('Fileclass search is unavailable.');
          return found;
        };
        const revalidate = (path: string, type = ''): NodeResult => {
          const node = api.getNode(path);
          if (!active()) throw new Error('Selection cancelled.');
          if (!node || node.path !== path || !allowedNode(node) || !hasNodeClass(node, types, type))
            throw new Error('This note is no longer available as a typed note. Search again.');
          return node;
        };
        const validateSelected = () => [...selected.keys()].map((path) => revalidate(path));
        const findExact = (term: string, found: NodeResult[], type = '', freshAll = false) => {
          const duplicates: NodeResult[] = [];
          if (!term) return duplicates;
          const candidates = freshAll
            ? [...new Map(found.map((node) => [node.path, node])).values()]
            : nodeChoices(found, types, { query: term, type });
          for (const match of candidates) {
            if (
              !freshAll &&
              !['Exact title', 'Exact alias'].includes(nodeChoiceMatch(match, term) ?? '')
            )
              continue;
            const fresh = api.getNode(match.path);
            if (!active()) return [];
            if (
              fresh &&
              fresh.path === match.path &&
              allowedNode(fresh) &&
              hasNodeClass(fresh, types, type) &&
              ['Exact title', 'Exact alias'].includes(nodeChoiceMatch(fresh, term) ?? '')
            )
              duplicates.push(fresh);
          }
          return duplicates;
        };
        const focusRow = (path: string) => {
          const replacement = [
            ...this.contentEl.querySelectorAll<HTMLButtonElement>('[data-path]'),
          ].find((row) => row.dataset.path === path);
          (
            replacement ??
            results.querySelector<HTMLButtonElement>('button:not(:disabled)') ??
            search
          ).focus();
        };
        const apply = () =>
          run(() => {
            readTypes();
            if (!active()) return;
            const nodes = validateSelected();
            if (nodes.length < minimum || !initialized)
              throw new Error(
                `Choose at least ${minimum} typed ${minimum === 1 ? 'note' : 'notes'}.`,
              );
            if (active()) finish({ kind: 'existing-many', nodes });
          });
        const create = (type: string, title: string) =>
          run(() => {
            readTypes();
            if (!active()) return;
            if (!canCreate) throw new Error('Fileclass linked-note creation is unavailable.');
            if (title !== query())
              throw new Error('The search changed. Choose a current creation row.');
            if (!title || !types.some((entry) => entry.type === type))
              throw new Error('Choose an available Fileclass and enter a note title.');
            const nodes = multiple ? validateSelected() : [];
            if (!active()) return;
            if (multiple && (!initialized || nodes.length + 1 < minimum))
              throw new Error(`Choose at least ${minimum} typed notes.`);
            const found = searchNodes(title);
            if (!active()) return;
            const duplicates = findExact(title, [...found, ...nodes], type, true);
            if (!active()) return;
            if (duplicates.length) {
              rows = duplicates;
              exact = duplicates;
              renderResults();
              showError(
                new Error('An existing note matches this title. Choose it or change the search.'),
              );
              focusRow(duplicates[0].path);
              return;
            }
            finish({ kind: 'create', title, type, ...(multiple ? { existingNodes: nodes } : {}) });
          });
        const renderResults = () => {
          results.replaceChildren();
          selectedResults.replaceChildren();
          selectedSection.hidden = !multiple || selected.size === 0;
          selectedHeading.textContent = [...selected.keys()].some((path) => originalPaths.has(path))
            ? [...selected.keys()].some((path) => !originalPaths.has(path))
              ? 'Linked notes and new selections'
              : 'Already linked'
            : 'Selected notes';
          const visible = [
            ...selected.values(),
            ...rows.filter((node) => !selected.has(node.path)).slice(0, 100),
          ];
          const displayName = (node: NodeResult) =>
            node.title.replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
          const names = new Map<string, number>();
          const matching = new Map(
            [...rows, ...selected.values()].map((node) => [node.path, node] as const),
          );
          for (const node of matching.values()) {
            if (!hasNodeClass(node, types)) continue;
            const name = displayName(node);
            names.set(name, (names.get(name) ?? 0) + 1);
          }
          for (const node of visible) {
            const row = append(
              selected.has(node.path) && multiple ? selectedResults : results,
              'button',
              'reader-highlight-picker-result suggestion-item mod-complex',
            );
            row.type = 'button';
            row.dataset.path = node.path;
            if (multiple) {
              row.setAttribute('role', 'checkbox');
              row.setAttribute('aria-checked', String(selected.has(node.path)));
              row.classList.toggle('is-checked', selected.has(node.path));
            }
            const classIcon = node.classes
              .map((type) => types.find((entry) => entry.type === type)?.icon)
              .find(Boolean);
            icon(
              row,
              node.icon || classIcon || 'file-text',
              'reader-highlight-picker-icon suggestion-icon',
            );
            const content = append(
              row,
              'span',
              'reader-highlight-picker-result-content suggestion-content',
            );
            append(
              content,
              'span',
              'reader-highlight-picker-result-title suggestion-title',
              node.title,
            );
            if ((names.get(displayName(node)) ?? 0) > 1) {
              content.append(' ');
              append(content, 'span', 'reader-highlight-picker-result-path', node.path);
            }
            const labels = [
              node.title,
              classNames(node),
              node.path,
              preferredPaths.includes(node.path) ? 'Suggested note' : '',
              nodeChoiceMatch(node, query()),
            ].filter(Boolean);
            row.setAttribute('aria-label', labels.join(' — '));
            row.title = labels.join(' — ');
            if (multiple) {
              const check = append(row, 'span', 'reader-highlight-picker-check');
              check.setAttribute('aria-hidden', 'true');
              if (selected.has(node.path)) setIcon(check, 'check');
            }
            row.addEventListener('click', () =>
              run(() => {
                if (multiple && selected.has(node.path)) selected.delete(node.path);
                else {
                  readTypes();
                  if (!active()) return;
                  const fresh = revalidate(node.path);
                  if (!active()) return;
                  if (!multiple) {
                    finish({ kind: 'existing', node: fresh });
                    return;
                  }
                  selected.set(fresh.path, fresh);
                }
                renderResults();
                updateFooter();
                focusRow(node.path);
              }),
            );
          }
          const title = query();
          if (canCreate && title && !hasError) {
            for (const type of types) {
              if (
                [...exact, ...selected.values()].some(
                  (node) =>
                    hasNodeClass(node, types, type.type) &&
                    ['Exact title', 'Exact alias'].includes(nodeChoiceMatch(node, title) ?? ''),
                )
              )
                continue;
              const row = append(
                results,
                'button',
                'reader-highlight-picker-result reader-highlight-picker-create-row suggestion-item mod-complex',
              );
              row.type = 'button';
              row.dataset.createType = type.type;
              row.disabled = multiple && (!initialized || selected.size + 1 < minimum);
              icon(row, type.icon || 'file-plus', 'reader-highlight-picker-icon suggestion-icon');
              const content = append(
                row,
                'span',
                'reader-highlight-picker-result-content suggestion-content',
              );
              const label = append(
                content,
                'span',
                'reader-highlight-picker-result-title suggestion-title',
                'Create “',
              );
              const shortTitle = nodeChoiceSeed(title, 48);
              append(
                label,
                'span',
                'reader-highlight-picker-create-query',
                shortTitle === title ? title : `${shortTitle}…`,
              );
              label.append('”');
              content.append(' ');
              const accessibleLabel = `Create “${title}” as ${type.label} and ${action}${multiple ? ` to ${selected.size + 1} notes` : ''}`;
              row.setAttribute('aria-label', accessibleLabel);
              row.title = accessibleLabel;
              row.addEventListener('click', () => create(type.type, title));
            }
          }
          if (!rows.length && !results.children.length)
            append(
              results,
              'p',
              '',
              types.length ? 'No matching typed notes.' : 'No Fileclasses are available.',
            );
          if (rows.length > 100) append(results, 'p', '', 'Refine your search to see more notes.');
        };
        const refresh = () =>
          run(() => {
            readTypes();
            if (!active()) return;
            if (!initialized) {
              const initial = new Map<string, NodeResult>();
              for (const path of new Set(options.selectedPaths))
                initial.set(path, revalidate(path));
              if (!active()) return;
              selected = initial;
              initialized = true;
            }
            const preferred: NodeResult[] = [];
            for (const path of preferredPaths) {
              const node = api.getNode(path);
              if (!active()) return;
              if (node) preferred.push(node);
            }
            const term = query();
            const found = searchNodes(term);
            if (!active()) return;
            rows = nodeChoices([...preferred, ...found].filter(allowedNode), types, {
              query: term,
              preferredPaths,
            });
            exact = canCreate ? findExact(term, [...rows, ...selected.values()]) : [];
            if (!active()) return;
            renderResults();
            updateFooter();
          });
        cancel.addEventListener('click', () => finish(null));
        retry.addEventListener('click', refresh);
        confirm?.addEventListener('click', apply);
        bindModalSubmit(this, () => {
          if (multiple) {
            if (confirm && !confirm.disabled) apply();
          } else {
            const focused = this.contentEl.ownerDocument.activeElement;
            const row =
              results.contains(focused) && focused?.tagName === 'BUTTON'
                ? (focused as HTMLButtonElement)
                : results.querySelector<HTMLButtonElement>('button:not(:disabled)');
            if (row && !row.disabled) row.click();
          }
        });
        fromArticle?.addEventListener('click', () =>
          run(() => {
            readTypes();
            if (!active()) return;
            const nodes = validateSelected();
            if (!initialized) throw new Error('The selected notes are unavailable. Try again.');
            if (active()) finish({ kind: 'pick-in-article', nodes });
          }),
        );
        search.addEventListener('input', refresh);
        search.addEventListener('keydown', (event) => {
          if (event.isComposing) return;
          if (
            event.key === 'ArrowDown' ||
            (event.key === 'Enter' && !event.metaKey && !event.ctrlKey)
          ) {
            event.preventDefault();
            if (event.repeat) return;
            if (event.key === 'Enter' && multiple && !query() && confirm && !confirm.disabled)
              apply();
            else results.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
          }
        });
        const onRowKey = (event: KeyboardEvent) => {
          const buttons = [
            ...selectedResults.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
            ...results.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
          ];
          const target = buttons.find((button) => button === event.target);
          if (event.isComposing || !target) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) target.click();
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            (
              buttons[buttons.indexOf(target) + (event.key === 'ArrowDown' ? 1 : -1)] ?? search
            ).focus();
          }
        };
        selectedResults.addEventListener('keydown', onRowKey);
        results.addEventListener('keydown', onRowKey);
        clearError();
        refresh();
        if (active()) search.focus();
      }
      onClose(): void {
        options.signal?.removeEventListener('abort', abort);
        this.contentEl.replaceChildren();
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }
    }
    const modal = new HighlightHostDialog(app);
    const abort = () => finish(null);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) finish(null);
    else modal.open();
  });
}
