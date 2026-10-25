import type { App } from 'obsidian';
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
  readonly embeddedCreation?: true;
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
      completionContainer?: HTMLElement;
    },
    link: (node: NodeResult) => Promise<void>,
  ): Promise<NodeResult | null>;
  pickNodeForLink?(
    options: {
      suggestedTitle?: string;
      sourcePath: string;
      signal?: AbortSignal;
    },
    link: (node: NodeResult) => Promise<void>,
  ): Promise<NodeResult | null>;
}
export function nodesApi(app: App): NodesApi | undefined {
  const host = app as App & { plugins?: { getPlugin(id: string): { api?: NodesApi } | undefined } };
  const api = host.plugins?.getPlugin('fileclass-inline')?.api;
  return api?.version === 2 &&
    ['listTypes', 'searchNodes', 'getNode', 'createNode'].every(
      (key) => typeof (api as unknown as Record<string, unknown>)[key] === 'function',
    ) &&
    (api.pickNodeForLink === undefined || typeof api.pickNodeForLink === 'function') &&
    (api.createNodeForLink === undefined || typeof api.createNodeForLink === 'function')
    ? api
    : undefined;
}
