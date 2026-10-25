import { FuzzySuggestModal, TFolder, type App } from 'obsidian';

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
