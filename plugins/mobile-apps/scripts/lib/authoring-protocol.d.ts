export const PROTOCOL_VERSION: 2;
export const PROTOCOL_ID: 'powerapps.mobile.authoring';
export type AuthoringOperation = 'prototype' | 'edit' | 'teach' | 'connect';
export type ScreenState = 'planned' | 'building' | 'checking' | 'ready' | 'failed';
export type DecisionAction = 'approve' | 'reject' | 'revise' | 'apply' | 'discard';
export type TargetRole = 'screen' | 'collection' | 'item' | 'form' | 'field' | 'action' | 'surface';
export type RecordReference = { conceptId: string; recordId: string; label?: string };
export interface AuthoringContext {
  protocolVersion: 2;
  appInstanceId: string;
  jobId: string;
  previewRevision: string;
  scope: 'app' | 'screen' | 'target';
  screenId?: string;
  route?: string;
  targetId?: string;
  actionId?: string;
  label?: string;
  recordRef?: RecordReference;
  hasUnsavedChanges?: boolean;
}
export interface AuthoringTarget {
  id: string;
  screenId: string;
  label: string;
  role: TargetRole;
  bounds: { x: number; y: number; width: number; height: number };
  actionId?: string;
  recordRef?: RecordReference;
}
export type IntegrationSelection =
  | { kind: 'native'; catalogRevision: string; capabilityId: string }
  | ({
    kind: 'connector';
    catalogRevision: string;
    apiId: string;
    environmentId: string;
  } & (
    | { connectionId: string; connectionRef?: never }
    | { connectionId?: never; connectionRef: string }
  ));
export interface AuthoringJobRequest {
  protocolVersion: 2;
  operation: AuthoringOperation;
  prompt: string;
  appName?: string;
  appInstanceId?: string;
  baseRevision: string | null;
  context?: AuthoringContext;
  integration?: IntegrationSelection;
}
export interface AuthoringScreen {
  id: string;
  title: string;
  route: string;
  state: ScreenState;
  dependencies: string[];
  detail?: string;
}
export interface AuthoringQuestion {
  id: string;
  gateId: string;
  sourceRevision: string;
  kind: 'plan' | 'clarification' | 'apply' | 'schema';
  title: string;
  summary: string;
  items: string[];
  fields: Array<{ id: string; label: string; type: 'text' | 'select' | 'boolean'; choices: string[] }>;
}
export interface AuthoringDecision {
  approvalId: string;
  approvalRevision: number;
  action: DecisionAction;
  answer: Record<string, string | boolean>;
}
export interface AuthoringCandidate {
  id: string;
  baseRevision: string | null;
  sourceRevision: string;
  dataMode: 'prototype' | 'dataverse' | 'mixed' | 'connector-only';
  readyScreenIds: string[];
  checks: string[];
  final: boolean;
}
export interface AuthoringCapabilities {
  protocolVersion: 2;
  protocolId: 'powerapps.mobile.authoring';
  protocolHash: string;
  operations: AuthoringOperation[];
  questions: boolean;
  candidates: boolean;
  progressivePreview: boolean;
  contextualEditing: boolean;
  teaching: boolean;
  dataverseConversion: boolean;
  nativeCatalog: boolean;
  connectorCatalog: boolean;
}
export const OPERATIONS: readonly AuthoringOperation[];
export const SCREEN_STATES: readonly ScreenState[];
export const JOB_STATES: readonly string[];
export const DECISIONS: readonly DecisionAction[];
export const TARGET_ROLES: readonly TargetRole[];
export function assertContext(value: unknown): AuthoringContext;
export function assertTarget(value: unknown): AuthoringTarget;
export function assertIntegrationSelection(value: unknown): IntegrationSelection;
export function assertJobRequest(value: unknown): AuthoringJobRequest;
export function assertScreen(value: unknown): AuthoringScreen;
export function assertScreenPlan(value: unknown): AuthoringScreen[];
export function assertQuestion(value: unknown): AuthoringQuestion;
export function assertDecision(value: unknown): AuthoringDecision;
export function assertCandidate(value: unknown): AuthoringCandidate;
export function assertCapabilities(value: unknown): AuthoringCapabilities;
export function object(value: unknown, label: string): Record<string, unknown>;
export function text(value: unknown, label: string, maximum?: number, allowEmpty?: boolean): string;
export function id(value: unknown, label: string): string;
export function revision(value: unknown, label: string): string;
export function revision(value: unknown, label: string, optional: true): string | null;
export function integer(value: unknown, label: string, minimum?: number): number;
export function strings(value: unknown, label: string, maximum?: number): string[];
export function enumeration<T extends string>(value: unknown, choices: readonly T[], label: string): T;
export function optionalId(value: unknown, label: string): string | undefined;
