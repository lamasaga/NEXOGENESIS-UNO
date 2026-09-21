export type ConstructionFocus='connections'|'domains'|'cards'|'viewpoints'|'comprehensive';
export type ConstructionOperation='relation_add'|'relation_update'|'relation_remove'|'domain_assign'|'card_edit'|'card_merge';
export interface ConstructionControls {contract:'focus-and-permissions-v1';focuses:ConstructionFocus[];primary:ConstructionFocus;allowed:ConstructionOperation[]}
export const CONSTRUCTION_CONTROLS:'focus-and-permissions-v1';
export const CONSTRUCTION_FOCUSES:ReadonlyArray<{id:ConstructionFocus;label:string;description:string;goal:string}>;
export const CONSTRUCTION_OPERATIONS:ReadonlyArray<{id:ConstructionOperation;group:string;label:string}>;
export function defaultConstructionControls(primary?:ConstructionFocus):ConstructionControls;
export function validateConstructionControls(value:unknown):ConstructionControls;
export function constructionGoal(controls:ConstructionControls,notes?:string):string;
export function constructionSummary(controls:ConstructionControls):string;
export function knowledgePreferenceText(saved:{purpose?:string;prompt?:string;organization?:{cards:string;domains:string;cross_domain:string}}):string;
