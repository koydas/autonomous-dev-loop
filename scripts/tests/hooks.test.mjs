import { test } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const testFilePath = path.join(__dirname, 'test-file.txt');
const scriptPath = path.join(__dirname, '../..');

beforeEach(() => {
  fs.writeFileSync(testFilePath, 'test content');
});

afterEach(() => {
  fs.unlinkSync(testFilePath);
});

test('PostToolUse hook triggers tests for scripts/ directory', () => {
  const result = execSync(`node --test ${scriptPath}/scripts/tests/*.test.mjs`, {
    env: {
      TOOL_INPUT_FILE_PATH: path.join(scriptPath, 'scripts/test-file.txt'),
    },
  });
  expect(result.toString()).toContain('Running test suite...');
});

test('PostToolUse hook triggers tests for .github/workflows/ directory', () => {
  const result = execSync(`node --test ${scriptPath}/scripts/tests/*.test.mjs`, {
    env: {
      TOOL_INPUT_FILE_PATH: path.join(scriptPath, '.github/workflows/test-file.txt'),
    },
  });
  expect(result.toString()).toContain('Running test suite...');
});