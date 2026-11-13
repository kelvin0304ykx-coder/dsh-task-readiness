export const CAPABILITIES = ['web.search','web.fetch','files.read','files.write','image.inspect','office.create','office.render','office.convert','office.recalculate','browser.read','mcp.list'] as const;
export type Capability = typeof CAPABILITIES[number];
export type Language = 'zh' | 'en';
export interface Requirement { id: string; capability: Capability; server?: string }
export interface TaskRoute { id: string; requires: string[] }
export interface TaskIntent { version: 1; title: string; requirements: Requirement[]; routes: TaskRoute[]; files: string[]; outputDirectory?: string }
export type Availability = 'available' | 'absent' | 'unknown';
export type Preconditions = 'satisfied' | 'unmet' | 'unknown';
export type Verification = 'not_run' | 'passed' | 'failed' | 'cancelled' | 'outcome_unknown';
export type Freshness = 'current' | 'stale' | 'unknown';
export type Status = 'ready_unverified' | 'verified' | 'blocked' | 'unknown' | 'stale';
export interface Evidence { kind: 'declaration' | 'policy' | 'preflight' | 'probe'; code: string; observedAt: string }
export interface ProbeEvidence { id: string; status: Exclude<Verification,'not_run'>; checkedAt: string; binding: string; scope: string }
export interface CapabilityFact { availability: Availability; preconditions: Preconditions; reasonCodes: string[]; evidence: Evidence[]; probe?: ProbeEvidence }
export interface ModelRoute { provider: string; model: string }
export interface SessionSnapshot {
  sessionId: string; stamp: string; observedAt: string; scope: 'step' | 'registered' | 'unavailable';
  route: ModelRoute | null; cwd?: string;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access' | 'unknown';
  approval: 'ask' | 'never' | 'unknown';
  facts: Partial<Record<string,CapabilityFact>>;
}
export interface NextStep { id: string; label: string; kind: 'prepare' | 'probe' | 'manual' }
export interface CapabilityResult {
  id: string; capability: Capability; label: string; status: Status;
  availability: Availability; preconditions: Preconditions; verification: Verification; freshness: Freshness;
  reasonCodes: string[]; summary: string; nextSteps: NextStep[]; evidence: Evidence[]; probe?: ProbeEvidence;
}
export interface Report {
  version: 1; id: string; revision: number; sessionId: string; binding: string; generatedAt: string;
  intent: TaskIntent; status: Status; checks: CapabilityResult[];
  routes: Array<{id:string;status:Status;requires:string[]}>;
  boundary: string;
}
export class ReadinessError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name='ReadinessError'; this.code=code; }
}
