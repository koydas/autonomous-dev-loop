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
