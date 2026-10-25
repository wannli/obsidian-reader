import { AbstractInputSuggest, FuzzySuggestModal, TFolder, type App } from 'obsidian';

/** Existing folders are suggestions; the settings text field also accepts new locations. */
export class FolderPicker extends FuzzySuggestModal<TFolder> {
  constructor(
    app: App,
    private choose: (path: string) => void,
  ) {
    super(app);
    this.setPlaceholder('Choose a vault folder');
  }
  getItems(): TFolder[] {
    const root = this.app.vault.getRoot();
    return [
      root,
      ...this.app.vault
        .getAllLoadedFiles()
        .filter((file): file is TFolder => file instanceof TFolder && file !== root),
    ];
  }
  getItemText(folder: TFolder): string {
    return folder.path === '/' || !folder.path ? 'Vault root' : folder.path;
  }
  onChooseItem(folder: TFolder): void {
    this.choose(folder.path === '/' ? '' : folder.path);
  }
}

/** Native anchored suggestions keep folder editing in the settings surface. */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(app: App, input: HTMLInputElement, choose: (path: string) => void) {
    super(app, input);
    this.limit = 30;
    this.onSelect((folder) => {
      const path = folder.path === '/' ? '' : folder.path;
      this.setValue(path);
      choose(path);
      this.close();
    });
  }
  getSuggestions(query: string): TFolder[] {
    const root = this.app.vault.getRoot();
    return [
      root,
      ...this.app.vault
        .getAllLoadedFiles()
        .filter((file): file is TFolder => file instanceof TFolder && file !== root),
    ].filter((folder) => folder.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  }
  renderSuggestion(folder: TFolder, element: HTMLElement): void {
    element.textContent = folder.path === '/' || !folder.path ? 'Vault root' : folder.path;
    element.style.minHeight = '44px';
  }
}
