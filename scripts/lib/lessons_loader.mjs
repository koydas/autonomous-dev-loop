// Reads the signals the pipeline recorded on the `metrics` branch and turns them into the lessons block of a
// prompt (ADR-0051). The only I/O of the active-lessons feature: lessons.mjs stays pure.
// Never throws and never blocks a run: any failure (branch missing, API error, timeout) is one warn event and
// no lessons, because a stage must not fail for lack of advice. `ADL_LESSONS=off` turns the feature off.
import { log as obsLog } from './observability.mjs';
import { RUNS_JSONL_PATH, METRICS_BRANCH } from './run_record.mjs';
import { LESSON_STAGES, parseSignals, extractLessons, formatLessonsContext } from './lessons.mjs';

const OBS_STAGE = { generation: 'code_gen', autofix: 'autofix' };
const TIMEOUT_MS = 10000;

/**
 * @param {{ stage: 'generation' | 'autofix', repository: string, token: string, apiBase?: string, fetchImpl?: typeof fetch,
 *           now?: number, timeoutMs?: number, env?: Record<string, string | undefined> }} args
 * @returns {Promise<{ lessons: { id: string, count: number, text: string }[], context: string }>}
 */
export async function loadLessons({ stage, repository, token, apiBase = 'https://api.github.com', fetchImpl = fetch, now = Date.now(), timeoutMs = TIMEOUT_MS, env = process.env } = {}) {
  const none = { lessons: [], context: '' };
  if (!LESSON_STAGES.includes(stage) || String(env.ADL_LESSONS ?? '').trim().toLowerCase() === 'off') return none;
  const obsStage = OBS_STAGE[stage];
  const unavailable = (meta) => {
    obsLog({ stage: obsStage, event: 'lessons.unavailable', level: 'warn', meta: { stage, ...meta } });
    return none;
  };
  if (!repository || !token) return unavailable({ reason: 'not_configured' });
  let text;
  try {
    const res = await fetchImpl(`${String(apiBase).trim()}/repos/${repository}/contents/${RUNS_JSONL_PATH}?ref=${METRICS_BRANCH}`, {
      headers: { Accept: 'application/vnd.github.raw+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // No metrics branch or file yet: nothing recorded, so nothing to learn. Not a fault.
    if (res.status === 404) return none;
    if (!res.ok) return unavailable({ reason: 'http_error', status: res.status });
    text = await res.text();
  } catch (err) {
    return unavailable({ reason: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network_error' });
  }
  const lessons = extractLessons(parseSignals(text), { now });
  const context = formatLessonsContext(lessons, stage);
  if (lessons.length) obsLog({ stage: obsStage, event: 'lessons.loaded', level: 'info', meta: { stage, count: lessons.length, ids: lessons.map((l) => l.id) } });
  return { lessons, context };
}
