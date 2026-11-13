import { knownReason } from './messages.ts';
import type { Report } from './types.ts';
/** A share export is a whitelist projection, never a regex-redacted copy of arbitrary metadata. */
export function shareReport(report:Report){
  return {version:1,generatedAt:report.generatedAt,status:report.status,boundary:'Point-in-time capability evidence, not a guarantee of task quality or safety.',checks:report.checks.map(c=>({capability:c.capability,status:c.status,availability:c.availability,preconditions:c.preconditions,verification:c.verification,freshness:c.freshness,reasonCodes:c.reasonCodes.map(knownReason),evidence:c.evidence.map(e=>({kind:e.kind,code:knownReason(e.code),observedAt:e.observedAt}))})),routes:report.routes.map(r=>({status:r.status,capabilities:r.requires.map(id=>report.checks.find(c=>c.id===id)!.capability)}))};
}
/** Model-visible results deliberately exclude original task text, file paths and the owning Session id. */
export function modelReport(report:Report){return {id:report.id,revision:report.revision,...shareReport(report),nextSteps:report.checks.map(c=>({capability:c.capability,actions:c.nextSteps}))};}
