// Machine-readable serialization of the Diagnostics page (ADR-0047 §1): `findings.json`. A second rendering of
// the same diagnose() result, not a second disclosure: only fields the page already shows are copied, by name,
// so a field added to a finding later is not published until it is added here. Pure, no LLM.
import { leverFor } from './meta_levers.mjs';

export const FINDINGS_SCHEMA_VERSION = 1;

const evidenceOf = (ev) => ({ run_id: ev.run_id, ts: ev.ts ?? null, event: ev.event ?? null, summary: ev.summary ?? '', pr: ev.pr ?? null, url: ev.url ?? null });
const stamp = (v) => (Number.isFinite(v) ? v : null);

// Stable identity of a finding: its rule id (the rules that emit several findings already put the stage in it).
// A collision, which no rule produces today, is numbered in order so the key stays unique within the file.
function keysOf(findings) {
  const seen = new Map();
  return findings.map((f) => {
    const n = (seen.get(f.id) ?? 0) + 1;
    seen.set(f.id, n);
    return n === 1 ? f.id : `${f.id}:${n}`;
  });
}

/**
 * `findings.json` content for a diagnose() result. `window` is the overview window (`{ from, to, runs }`),
 * `generatedAt` the build time. `lever` is `leverFor(finding)`: null unless the finding is active, warning or
 * critical and its rule is mapped (ADR-0047 §2); the Diagnostics card shows the same lever.
 */
export function buildFindingsExport({ diagnosis, window = {}, generatedAt = null } = {}) {
  const findings = diagnosis?.findings ?? [];
  const keys = keysOf(findings);
  return {
    schema_version: FINDINGS_SCHEMA_VERSION,
    generated_at: generatedAt,
    window: { from: stamp(window.from), to: stamp(window.to), runs: Number.isFinite(window.runs) ? window.runs : 0 },
    status: diagnosis?.status ?? 'no_data',
    findings: findings.map((f, i) => ({
      key: keys[i], id: f.id, category: f.category, title: f.title, severity: f.severity, status: f.status ?? 'active',
      first_seen: stamp(f.first_seen), last_seen: stamp(f.last_seen), clean_since: stamp(f.clean_since),
      fact: f.fact, hypothesis: f.hypothesis ?? null, impact: f.impact, frequency: f.frequency,
      evidence: (f.evidence ?? []).map(evidenceOf), lever: leverFor(f),
    })),
    gaps: (diagnosis?.gaps ?? []).map((g) => ({ id: g.id, title: g.title, detail: g.detail })),
  };
}

/** Serialized form written at the site root. */
export const findingsExportJson = (args) => `${JSON.stringify(buildFindingsExport(args), null, 2)}\n`;
