export async function buildAutomationGateContext({ prBody, coverageReport }) {
  const coverageThreshold = getCoverageThreshold(prBody) || 80;
  const currentCoverage = await getActualCoveragePercentage();

  if (currentCoverage < coverageThreshold) {
    return {
      status: 'fail',
      message: `Test coverage ${currentCoverage}% below required ${coverageThreshold}% threshold`,
      fixable: false
    };
  }

  return {
    status: 'pass',
    message: `Test coverage ${currentCoverage}% meets ${coverageThreshold}% requirement`,
    fixable: false
  };
}

function getCoverageThreshold(prBody) {
  const match = prBody.match(/\/\/\s*coverage:\s*(\d+)%/i);
  return match ? parseInt(match[1], 10) : null;
}

async function getActualCoveragePercentage() {
  const nyc = require('nyc');
  const reporter = new nyc({
    cwd: process.cwd(),
    reporter: ['json'],
    tempDirectory: '.nyc_output'
  });

  await reporter.load();
  const report = reporter.reporterFor('json').report();
  return Math.round(report.summary.lines.pct);
}