const generationSystem = require('../prompts/generation-system');

describe('Generation System', () => {
  it('should handle insufficient file context', () => {
    const inputFile = 'input-file.txt';
    const outputFile = 'output-file.txt';
    const fileContext = {};
    const result = generationSystem.generateCode(inputFile, outputFile, fileContext);
    expect(result).toBe('Insufficient file context');
  });
});