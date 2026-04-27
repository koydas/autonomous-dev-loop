/**
 * Minimal parser for flat YAML files (key: value pairs only).
 * Supports blank lines and # comments. No nesting, no anchors.
 */
export function parseFlatYaml(content) {
  const result = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Minimal parser for 3-level nested YAML (top-key → section-key → leaf key: value).
 * Supports blank lines and # comments. No anchors, no lists, no inline objects.
 * Indentation must be consistent: 2 spaces per level.
 */
export function parseNestedYaml(content) {
  const result = {};
  let l0 = null;
  let l1 = null;
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - trimmed.length;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (indent === 0) {
      l0 = key;
      result[l0] = {};
      l1 = null;
    } else if (indent === 2) {
      l1 = key;
      if (l0) result[l0][l1] = {};
    } else if (indent === 4 && l0 && l1) {
      result[l0][l1][key] = value;
    }
  }
  return result;
}
