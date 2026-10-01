import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';

// Load the Claude settings JSON
const settingsPath = path.resolve('.claude', 'settings.json');
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

// Extract the command from the hook configuration
const command = settings.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command;

assert.ok(command, 'Hook command should be defined');

// The command should check for files under scripts/ or .github/workflows/ and run the test suite
const expectedPattern = "(scripts/|\\.github/workflows/)";
assert.match(command, new RegExp(expectedPattern), 'Command should contain the correct path matcher regex');

// Ensure the command runs the expected test command
assert.ok(command.includes('node --test scripts/tests/*.test.mjs'), 'Command should invoke the test suite with node --test');
