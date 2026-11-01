import type { App } from 'obsidian';
import type { RelationProvider } from './node-relations';

/** Reader's public-facing typed-note seam; Fileclass v1 is the sole external authority. */
export interface NodeResult {
  path: string;
  title: string;
  type: string;
  classes: string[];
  aliases: string[];
  icon?: string;
}
export interface NodesApi {
  readonly version: 2;
  /** Reader-owned Fileclass v1 relation supplement; optional for isolated providers. */
  relations?: RelationProvider;
  listTypes(): { type: string; label: string; icon?: string }[];
  searchNodes(query: string): NodeResult[];
  getNode(path: string): NodeResult | null;
  createNode(options: {
    type?: string;
    suggestedTitle?: string;
    sourcePath?: string;
    signal?: AbortSignal;
  }): Promise<NodeResult | null>;
  createNodeForLink?(
    options: {
      type?: string;
      suggestedTitle?: string;
      sourcePath: string;
      signal?: AbortSignal;
      acceptSuggestedTitle?: boolean;
    },
    link: (node: NodeResult) => Promise<void>,
  ): Promise<NodeResult | null>;
  pickNodeForLink?(
    options: { suggestedTitle?: string; sourcePath: string; signal?: AbortSignal },
    link: (node: NodeResult) => Promise<void>,
  ): Promise<NodeResult | null>;
}

const readers = new WeakMap<App, () => NodesApi | undefined>();
/** Owned by ReaderPlugin's lifetime. Also provides an explicit isolated test seam. */
export function bindNodesApi(app: App, provider: () => NodesApi | undefined): () => void {
  readers.set(app, provider);
  return () => {
    if (readers.get(app) === provider) readers.delete(app);
  };
}
export function nodesApi(app: App): NodesApi | undefined {
  const api = readers.get(app)?.();
  return api?.version === 2 &&
    ['listTypes', 'searchNodes', 'getNode', 'createNode'].every(
      (key) => typeof (api as unknown as Record<string, unknown>)[key] === 'function',
    ) &&
    (api.pickNodeForLink === undefined || typeof api.pickNodeForLink === 'function') &&
    (api.createNodeForLink === undefined || typeof api.createNodeForLink === 'function')
    ? api
    : undefined;
}
