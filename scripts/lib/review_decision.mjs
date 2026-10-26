// The final review decision, shared by pr_review.mjs and the `review` eval suite so that the verdict a suite scores
// is the one production publishes (EV-01). Pure, deterministic, no LLM and no I/O. The circuit breaker
// (ADR-0050) depends on the verdict history and stays a separate stage in pr_review.mjs.

import { withholdOnUnreviewedCode } from './review_prompt.mjs';
import { decideVerdict } from './review_evidence.mjs';
import { analyzeAdversarial, enforceAdversarialProtocol } from './adversarial_review.mjs';

/**
 * Resolves the verdict from the model's parsed review, in the order production applies the stages:
 * evidence (ADR-0024/0026), then code cut from the diff (ADR-0038), then the adversarial protocol (ADR-0049).
 * `stages` keeps each intermediate decision so callers can tell which stage withheld.
 * A guardrail finding (RV-03, ADR-0060) is a deterministic defect: it turns an APPROVE or a WITHHELD into
 * REQUEST_CHANGES, like a failing check (`guardrailOverride`).
 * `findingAssessment` (RV-04a, ADR-0061, RV-05, ADR-0063, finding_evidence.mjs): a REQUEST_CHANGES whose blocking findings
 * are all unproven (neither verified by a quote in the PR tree nor supported by lines of the diff) is WITHHELD
 * (`unproven_findings`): a human decides, auto-fix does not run. A failing check or a guardrail finding keeps its
 * REQUEST_CHANGES.
 * @returns {{ verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'WITHHELD', reason: string | null, withheldFor: 'evidence' | 'unreviewed_code' | 'unseen_findings' | 'protocol' | 'unproven_findings' | null, guardrailOverride: boolean, adversarial: ReturnType<typeof analyzeAdversarial>, stages: { evidence: object, code: object } }}
 */
export function resolveReviewDecision({ llmApproved, cleanReview, evidence, evidenceRequired, unreviewedCodeFiles = [], shownFiles = [], guardrailFindings = [], findingAssessment = null }) {
  const evidenceDecision = decideVerdict(llmApproved, evidence, { evidenceRequired });
  const codeDecision = withholdOnUnreviewedCode(evidenceDecision, unreviewedCodeFiles, cleanReview, { checksFailed: evidence.failing.length > 0, shownFiles });
  const adversarial = analyzeAdversarial(cleanReview);
  const protocol = enforceAdversarialProtocol(codeDecision, adversarial);
  const guardrailOverride = guardrailFindings.length > 0 && protocol.verdict !== 'REQUEST_CHANGES';
  const afterGuardrails = guardrailOverride
    ? { verdict: 'REQUEST_CHANGES', reason: `guardrail findings: ${[...new Set(guardrailFindings.map((f) => f.rule))].join(', ')}` }
    : protocol;
  const unprovenOnly = Boolean(findingAssessment) && findingAssessment.blocking > 0 && findingAssessment.unproven === findingAssessment.blocking;
  const unprovenWithheld = unprovenOnly && afterGuardrails.verdict === 'REQUEST_CHANGES' && evidence.failing.length === 0 && guardrailFindings.length === 0;
  const { verdict, reason } = unprovenWithheld
    ? { verdict: 'WITHHELD', reason: `${findingAssessment.unproven} blocking finding(s), none verified or supported by the diff` }
    : afterGuardrails;
  const withheldFor = unprovenWithheld ? 'unproven_findings'
    : verdict !== 'WITHHELD' ? null
    : evidenceDecision.verdict === 'APPROVE' && codeDecision.verdict === 'WITHHELD' ? 'unreviewed_code'
    : evidenceDecision.verdict === 'REQUEST_CHANGES' && codeDecision.verdict === 'WITHHELD' ? 'unseen_findings'
    : codeDecision.verdict === 'APPROVE' ? 'protocol'
    : 'evidence';
  return { verdict, reason, withheldFor, guardrailOverride, adversarial, stages: { evidence: evidenceDecision, code: codeDecision } };
}
