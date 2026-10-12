export const NODE_COLORS = { red: '🔴', orange: '🟠', yellow: '🟡', green: '🟢', blue: '🔵', purple: '🟣' } as const;
export interface NodeType { type: string; label: string; color?: keyof typeof NODE_COLORS }
export interface NodeResult { path: string; title: string; type: string; aliases: string[]; color?: keyof typeof NODE_COLORS }
export interface NodesApi {
  version: 1;
  listTypes(): NodeType[];
  searchNodes(query: string): NodeResult[];
  getNode(path: string): NodeResult | null;
  createNode(options: { type?: string; suggestedTitle?: string; sourcePath?: string; signal?: AbortSignal }): Promise<NodeResult | null>;
  createNodeForLink?(options: { type?: string; suggestedTitle?: string; sourcePath: string; signal?: AbortSignal }, link: (node: NodeResult) => Promise<void>): Promise<NodeResult | null>;
}
export const NODES_UNAVAILABLE = 'Enable a compatible Nodes plugin (API version 1) to link nodes. Ordinary highlights and links still work.';
/** Optional public API only; no Nodes implementation imports or vault assumptions. */
export function nodesApi(app: unknown): NodesApi | null {
  const plugins = (app as { plugins?: { getPlugin?: (id: string) => unknown } })?.plugins;
  const api = (plugins?.getPlugin?.('obsidian-nodes') as { api?: NodesApi } | undefined)?.api;
  return api?.version === 1 && ['listTypes', 'searchNodes', 'getNode', 'createNode'].every(key => typeof (api as unknown as Record<string, unknown>)[key] === 'function') ? api : null;
}
export function suggestedNodeTitle(quote: string): string | undefined {
  const title = quote.trim();
  return title.length <= 80 && !/[\r\n]/.test(title) && title.split(/\s+/).length <= 12 ? title : undefined;
}
