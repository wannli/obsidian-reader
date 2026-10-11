import type { ReaderController } from '../controller';
import type { NodeOption, RelationshipDelta, RelationshipExpectation } from '../storage/relationships';
import type { RelationshipProperty } from '../storage/topic-links';
import { typedNodeTarget } from '../typed-highlights';

/** Pure staged state: selecting, searching and creating drafts perform no writes. */
export class RelationshipDraft {
  readonly initial: Set<string>;
  readonly selected: Set<string>;
  readonly staged = new Map<string, string>();
  private known: Set<string>;
  private constructor(readonly property: RelationshipProperty, readonly path: string, readonly options: NodeOption[], selected: string[],
    private controller: ReaderController, private expected: RelationshipExpectation) {
    this.initial = new Set(selected); this.selected = new Set(selected); this.known = new Set(options.map(option => option.path));
    for (const path of selected) if (!options.some(option => option.path === path)) options.push({ path, title: path.replace(/\.md$/i, '') + ' (unavailable)' });
  }
  static async load(controller: ReaderController, path: string, property: RelationshipProperty, current: () => boolean = () => true): Promise<RelationshipDraft> {
    const expectedGeneration = controller.repository.articleGeneration(path);
    const [options, article] = await Promise.all([
      property === 'authors' ? controller.repository.listAuthors() : controller.repository.listTopics(), controller.repository.getArticle(path),
    ]);
    if (!current() || controller.repository.articleGeneration(path) !== expectedGeneration) throw new Error('Article changed. Reopen the assignment dialog.');
    // The revision binds YAML entries AND their resolved targets from this same
    // article snapshot, so a later shadowing note cannot turn removal into a no-op.
    return new RelationshipDraft(property, path, options.map(option => ({ ...option })), article[property] ?? [], controller,
      { expectedId: article.id, expectedGeneration, revision: article.relationshipRevisions?.[property], current });
  }
  stage(name: string): void {
    const path = typedNodeTarget(name) + '.md';
    if (!this.options.some(option => option.path === path)) {
      this.options.push({ path, title: name });
    }
    if (!this.known.has(path)) this.staged.set(path, name);
    this.selected.add(path);
  }
  delta(): RelationshipDelta {
    return {
      add: [...this.selected].filter(path => !this.initial.has(path) && !this.staged.has(path)),
      remove: [...this.initial].filter(path => !this.selected.has(path)),
      create: [...this.staged].filter(([path]) => this.selected.has(path)).map(([, name]) => name),
    };
  }
  save() {
    if (this.expected.current?.() === false) return Promise.reject(new Error('Article changed. Reopen the assignment dialog.'));
    return this.property === 'authors' ? this.controller.assignAuthors(this.path, this.delta(), this.expected)
      : this.controller.assignTopics(this.path, this.delta(), this.expected);
  }
}
