import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Step outputs for GitHub Actions (`$GITHUB_OUTPUT`). Values may carry model output or issue text
// (audit 2026-10-19 F04/F28): a fixed heredoc delimiter lets a value line equal to it close the block
// early and forge the next lines as outputs. Every multi-line value gets a random delimiter per write.

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const DELIMITER_PREFIX = 'ghadelim_';

function assertName(name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new Error(`Invalid GITHUB_OUTPUT name: ${JSON.stringify(name)} (expected ${NAME_PATTERN})`);
  }
}

// The runner reads the file line by line, so a lone \r is a line break too.
function normalizeValue(value) {
  return (value == null ? '' : String(value)).replace(/\r\n?/g, '\n');
}

/**
 * One output in the runner's file-command syntax: `name=value` for a value without a line break,
 * `name<<DELIM\nvalue\nDELIM\n` otherwise, DELIM = `ghadelim_<uuid>`, redrawn while the value contains it.
 * @param {string} name - must match ^[A-Za-z_][A-Za-z0-9_-]*$
 * @param {unknown} value - stringified; null/undefined → ''
 * @param {{ uuid?: () => string }} [options] - delimiter source (tests)
 * @returns {string}
 */
export function formatOutput(name, value, { uuid = randomUUID } = {}) {
  assertName(name);
  const text = normalizeValue(value);
  if (!text.includes('\n')) return `${name}=${text}\n`;
  let delimiter = `${DELIMITER_PREFIX}${uuid()}`;
  while (text.includes(delimiter)) delimiter = `${DELIMITER_PREFIX}${uuid()}`;
  return `${name}<<${delimiter}\n${text}\n${delimiter}\n`;
}

/**
 * Appends outputs to `process.env.GITHUB_OUTPUT` in one write; no-op when it is unset.
 * Every name is validated before anything is written. Multi-line values are written first and
 * single-line ones (control outputs: valid, score, attempt_number, …) last, so even a broken heredoc
 * could not override them under the runner's last-wins rule.
 * @param {Array<[string, unknown]> | Record<string, unknown>} entries - in caller order
 * @param {{ uuid?: () => string }} [options]
 * @returns {string} the text written ('' when GITHUB_OUTPUT is unset)
 */
export function appendOutputs(entries, options = {}) {
  const pairs = Array.isArray(entries) ? entries : Object.entries(entries);
  const multiLine = [];
  const singleLine = [];
  for (const [name, value] of pairs) {
    const formatted = formatOutput(name, value, options);
    (normalizeValue(value).includes('\n') ? multiLine : singleLine).push(formatted);
  }
  const text = [...multiLine, ...singleLine].join('');
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return '';
  appendFileSync(file, text, 'utf8');
  return text;
}
