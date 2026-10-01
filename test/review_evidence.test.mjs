import { decideVerdict, formatWithheldNote } from '../scripts/lib/review_evidence.mjs';
import { strict as assert } from 'assert';

describe('review_evidence module', () => {
  it('should return WITHHELD verdict when evidence is missing', () => {
    const result = decideVerdict({
      modelVerdict: 'APPROVED',
      evidence: null,
      config: { withholdOnMissing: true }
    });
    assert.equal(result.verdict, 'WITHHELD');
    assert.match(result.note, /unverified evidence/);
  });

  it('should format withheld note correctly', () => {
    const note = formatWithheldNote({ reason: 'missing evidence' });
    assert.match(note, /missing evidence/);
  });
});
