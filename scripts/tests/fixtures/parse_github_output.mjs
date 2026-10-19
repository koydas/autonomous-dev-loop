// Test helper: a minimal reimplementation of the Actions runner's GITHUB_OUTPUT parser
// (actions/runner FileCommandManager): `NAME=VALUE` (first `=` before any `<<`) or
// `NAME<<DELIM` … `DELIM`, empty lines skipped, anything else rejected, last value wins.
export function parseGithubOutput(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const outputs = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '') continue;
    const eq = line.indexOf('=');
    const heredoc = line.indexOf('<<');
    if (eq > 0 && (heredoc < 0 || eq < heredoc)) {
      outputs[line.slice(0, eq)] = line.slice(eq + 1);
    } else if (heredoc > 0 && (eq < 0 || heredoc < eq)) {
      const name = line.slice(0, heredoc);
      const delimiter = line.slice(heredoc + 2);
      if (delimiter === '') throw new Error(`Invalid delimiter on line ${i + 1}`);
      const value = [];
      for (i += 1; i < lines.length && lines[i] !== delimiter; i += 1) value.push(lines[i]);
      if (i >= lines.length) throw new Error(`Matching delimiter not found: ${delimiter}`);
      outputs[name] = value.join('\n');
    } else {
      throw new Error(`Invalid format on line ${i + 1}: ${JSON.stringify(line)}`);
    }
  }
  return outputs;
}
