import type { StorageContext } from './context';
import { listRelationshipNodes, updateRelationships, type NodeOption, type RelationshipDelta, type RelationshipExpectation } from './relationships';
export type TopicOption = NodeOption;
export type TopicDelta = RelationshipDelta;
export const listTopics = (context: StorageContext) => listRelationshipNodes(context, 'topics');
export const listAuthors = (context: StorageContext) => listRelationshipNodes(context, 'authors');
export const updateArticleTopics = (context: StorageContext, path: string, delta: TopicDelta, options: RelationshipExpectation = {}) => updateRelationships(context, path, 'topics', delta, options);
export const updateArticleAuthors = (context: StorageContext, path: string, delta: RelationshipDelta, options: RelationshipExpectation = {}) => updateRelationships(context, path, 'authors', delta, options);
