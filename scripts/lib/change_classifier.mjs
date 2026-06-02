import { extractChangedFiles, isAutomationScopeFile } from './coverage_checker.mjs';

// ---------------------------------------------------------------------------
// File-pattern tables
// ---------------------------------------------------------------------------

const DOCUMENTATION_PATTERNS = [
  /\.md$/i,
  /^README(\..+)?$/i,
  /^CHANGELOG(\..+)?$/i,
  /^CONTRIBUTING(\..+)?$/i,
  /^LICENSE(\..+)?$/i,
  /^AGENTS\.md$/i,
];

const CI_CD_PATTERNS = [
  /^\.github\/workflows\//,
  /^\.github\/actions\//,
];

const CONFIGURATION_PATTERNS = [
  /^config\//,
  /^\.eslintrc/,
  /^\.prettierrc/,
  /^tsconfig.*\.json$/,
  /^vitest\.config\./,
  /^jest\.config\./,
  /^babel\.config\./,
];

const DEPENDENCY_PATTERNS = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^pnpm-lock\.yaml$/,
];

const TEST_PATTERNS = [
  /\/tests?\//,
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
  /\/__tests__\//,
];

// ---------------------------------------------------------------------------
// Per-file helpers
// ---------------------------------------------------------------------------

function isDocumentationFile(filePath) {
  // Automation-scope files (scripts/, prompts/, docs/code-generation.md) change
  // runtime behaviour even when they carry a .md extension — don't classify them
  // as documentation.
  if (isAutomationScopeFile(filePath)) return false;
  return DOCUMENTATION_PATTERNS.some((p) => p.test(filePath));
}

function isCiCdFile(filePath) {
  return CI_CD_PATTERNS.some((p) => p.test(filePath));
}

function isConfigurationFile(filePath) {
  return CONFIGURATION_PATTERNS.some((p) => p.test(filePath));
}

function isDependencyFile(filePath) {
  return DEPENDENCY_PATTERNS.some((p) => p.test(filePath));
}

function isTestFile(filePath) {
  return TEST_PATTERNS.some((p) => p.test(filePath));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a list of changed file paths.
 *
 * Returns the set of detected categories and a flag indicating whether any
 * file represents a change to executable/behavioural code.
 */
export function classifyChangedFiles(changedFiles) {
  const categories = new Set();
  let hasCode = false;

  for (const filePath of changedFiles) {
    if (isDocumentationFile(filePath)) {
      categories.add('documentation');
    } else if (isCiCdFile(filePath)) {
      categories.add('ci_cd');
    } else if (isConfigurationFile(filePath)) {
      categories.add('configuration');
    } else if (isDependencyFile(filePath)) {
      categories.add('dependency_update');
    } else if (isTestFile(filePath)) {
      categories.add('test_only');
    } else {
      hasCode = true;
    }
  }

  return { categories: [...categories], hasCode };
}

const NON_BEHAVIORAL = new Set(['documentation', 'ci_cd', 'configuration', 'dependency_update', 'test_only']);

/**
 * Given the classification output, decide whether test coverage is expected
 * for this PR and produce a human-readable reason.
 */
export function determineTestExpectation(categories, hasCode) {
  if (hasCode) {
    return {
      tests_expected: true,
      reason: 'Executable code or behavioural files are modified.',
    };
  }

  const catSet = new Set(categories);

  if (catSet.size === 0) {
    return { tests_expected: true, reason: 'Change type undetermined.' };
  }

  if ([...catSet].every((c) => NON_BEHAVIORAL.has(c))) {
    if (catSet.has('documentation') && catSet.size === 1) {
      return {
        tests_expected: false,
        reason: 'No executable behavior changed.',
      };
    }
    if (catSet.has('test_only') && catSet.size === 1) {
      return {
        tests_expected: false,
        reason: 'PR contains only test file changes.',
      };
    }
    if (catSet.has('dependency_update') && catSet.size === 1) {
      return {
        tests_expected: false,
        reason: 'Dependency version update; tests expected only if runtime behavior changes.',
      };
    }
    // ci_cd, configuration, or any other non-behavioral mix
    return {
      tests_expected: false,
      reason: 'Only non-behavioral files changed (documentation, CI/CD, configuration, or dependencies).',
    };
  }

  return {
    tests_expected: true,
    reason: 'Change type is mixed or includes behavioral modifications.',
  };
}

/**
 * Build a context block to inject into the review prompt.
 *
 * Returns an empty string when the diff contains no recognisable file paths so
 * that callers can safely concatenate it.
 */
export function buildChangeClassificationContext(rawDiff) {
  const changedFiles = extractChangedFiles(rawDiff);
  if (!changedFiles.length) return '';

  const { categories, hasCode } = classifyChangedFiles(changedFiles);
  const { tests_expected, reason } = determineTestExpectation(categories, hasCode);

  const classification = categories.length > 0 ? categories.join(', ') : 'none';
  const changeType = hasCode
    ? categories.length > 0 ? 'mixed' : 'feature_or_bugfix'
    : categories.length === 1 ? categories[0] : categories.length > 1 ? 'mixed' : 'unknown';

  return [
    '',
    '',
    'Change classification context:',
    `- change_type: ${changeType}`,
    `- detected_categories: ${classification}`,
    `- has_executable_code_changes: ${hasCode}`,
    `- tests_expected: ${tests_expected}`,
    `- tests_expected_reason: ${reason}`,
    '',
    'If tests_expected is false: do not generate findings about missing tests, do not recommend increasing test coverage, and do not reduce the verdict because of absent tests.',
  ].join('\n');
}
