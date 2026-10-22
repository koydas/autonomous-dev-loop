const fs = require('fs');
const path = require('path');

describe('Prompt wiring tests for updated behavior', () => {
  const prReviewPromptPath = path.resolve(__dirname, '..', 'prompts', 'pr-review-system.md');
  const validationPromptPath = path.resolve(__dirname, '..', 'prompts', 'validation-system.md');

  let prReviewContent;
  let validationContent;

  beforeAll(() => {
    prReviewContent = fs.readFileSync(prReviewPromptPath, 'utf8');
    validationContent = fs.readFileSync(validationPromptPath, 'utf8');
  });

  test('pr-review-system.md includes Low-only notes mean APPROVED rule', () => {
    expect(prReviewContent).toMatch(/Low\s*notes?\s*alone\s*mean\s*APPROVED/i);
  });

  test('pr-review-system.md includes deletion exception clause', () => {
    expect(prReviewContent).toMatch(/Treat\s*large\s*deletions\s*of\s*existing\s*content\s*as\s*a\s*HIGH\s*severity\s*regression\s*unless\s*the\s*title\s*or\s*description\s*accounts\s*for\s*them/i);
  });

  test('validation-system.md includes blocker falsifiability test phrase', () => {
    expect(validationContent).toMatch(/Every\s*blocker\s*must\s*pass\s*this\s*test/i);
  });
});
