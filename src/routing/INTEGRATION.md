# Article-routing contract

Exports from `src/routing/index.ts`:

```ts
installArticleRouting(options: ArticleRoutingOptions): ArticleRouting
interface ArticleRoutingOptions {
  app: App;
  readerViewType?: string; // pass main's VIEW constant
  templateExclusions?: () => ArticleTemplateExclusions;
  openReaderInLeaf(leaf: WorkspaceLeaf, request: ArticleRouteRequest): void | Promise<void>;
  onError?(error: unknown): void;
}
interface ArticleRouteRequest {
  path: string;
  subpath?: string; // #^hl-ID where available
  ephemeralState: Record<string, unknown>;
  isCurrent(): boolean;
}
interface ArticleRouting {
  preserveMarkdown(leaf: WorkspaceLeaf, path: string): () => void;
  dispose(): void;
}
```

## Main/UI integration (owned by reader-ui)

- Article identity is explicit `type: article` anywhere, or an untyped valid HTTP(S)
  URL note inside a canonical queue folder. No configurable legacy article folder
  or URL-only inference exists. Explicitly typed articles outside queues remain
  readable and unqueued.
- Pass `templateExclusions: () => currentTemplateExclusions` using the same current
  snapshot as the repository. `ArticleTemplateExclusions` is exported by
  `src/storage/classifier.ts`: `{ folders?: readonly string[];
  files?: readonly string[] }`. Main owns loading optional template configuration;
  routing neither queries QuickAdd nor discovers template paths privately.
- Install after `registerView`, keep the returned object, and register its
  `dispose()` with plugin lifecycle (`this.register(() => routing.dispose())`).
  Stop routing before disposing Reader views during unload.
- The installer does not mutate panes on dispose. Unload restoration of custom
  views is main's responsibility: retain each leaf's `state.file`, restore that
  same leaf to Markdown if desired, never detach it or create a replacement tab.
- Use FileView for native file identity and navigable-leaf reuse. Keep
  `canAcceptExtension()` false so ordinary Markdown still passes classification.
  Implement `ReaderView.getState()/setState()` with `{ file: path, subpath? }`;
  delegate file transitions to FileView, including list/Previous/Next navigation.
  Restore state before opening an article; avoid a racing default first-article
  open. Without this UI integration restored custom panes cannot know their path.
- `openReaderInLeaf` replaces only its supplied leaf using
  `leaf.setViewState({ type: VIEW, state: { file: request.path,
  subpath: request.subpath } }, request.ephemeralState)`.
  Do not set `active: true`, call `revealLeaf`, or choose a different leaf.
- Start the leaf transition before the callback's first await. Check
  `request.isCurrent()` before changing state and after any await before further
  opening/rendering. Reader's own async loading needs a generation/disposed guard.
  UI must not focus article title/highlights if this is no longer the active leaf.
- Wire **Open Markdown** / **Review Markdown** separately from ordinary internal
  links: choose the intended leaf first; call `preserveMarkdown(leaf, path)`
  **before** opening Markdown in it. Use its returned cancellation function if
  opening fails. The reservation is consumed by that leaf/path visit and stays
  effective through metadata changes and focus changes. Navigating away clears
  it, so reopening normally routes again. It is not a global Source-mode switch.
- Ordinary wiki/note destinations still go through native Obsidian opening.
  Identity comes exclusively from storage's shared `isArticleNote` classifier:
  explicitly typed articles anywhere; untyped URL notes remain ordinary Markdown
  even in canonical queue folders; explicit nonarticle types (including topics) remain Markdown.
  Malformed YAML and missing files remain Markdown. Template exclusions belong
  to that shared storage policy, never a private QuickAdd runtime hook.
- Deep links preserve the ephemeral state and explicit `subpath`. If Obsidian
  supplies only a source location, the adapter maps an exact metadata-cache block
  start to `#^block-id`. UI may focus the matching saved highlight using its native
  highlight ID. Existing ReaderApp/mountReader had no focus-anchor API at inspection;
  anchor rendering/focus is reader-ui's optional callback responsibility.

## Confirmed QuickAdd policy

Fresh native QuickAdd captures open in **Reader too**. The user's confirmation
supersedes the earlier automatic Source-editor/cursor contract. This module has
**no QuickAdd detection**, creation-time window, frontmatter exception, macro,
or global Source exemption. Generic `mode: source` is not a bypass; only the
explicit Reader editing action calls `preserveMarkdown`. Native QuickAdd assets
are maintained separately; no capture engine is introduced here.

## Public API evidence and limits

Installed official `obsidian` 1.13.1 declarations:
`node_modules/obsidian/obsidian.d.ts`: `file-open` 8078 (event has file, not leaf;
can be an embed), `active-leaf-change` 8071, `layout-change` 8084,
`iterateAllLeaves` 8009, `getViewState/setViewState` 8267–8271,
`getEphemeralState` 8290, metadata `changed` 4453, `onLayoutReady` 7822.
We reconcile actual leaf states rather than guess activeLeaf from a file event.
Listener references are removed on dispose; delayed layout-ready is inert.

Classification uses `src/storage/markdown.ts` `parseNote`, then
`src/storage/classifier.ts`
`isArticleNote(path, frontmatter, templateExclusions)`,
reading authoritative vault text instead of trusting potentially stale cache.
No extension registration, core patch, Node/Electron import, or vault mutation.
Pure simulations are not native Obsidian/iOS or physical sync acceptance.
