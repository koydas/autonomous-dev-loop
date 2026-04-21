import fs from 'node:fs';

// Fail fast with clear messages for required env vars
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const GITHUB_EVENT_PATH = process.env.GITHUB_EVENT_PATH;

if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not set');
if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set');
if (!GITHUB_REPOSITORY) throw new Error('GITHUB_REPOSITORY is not set');
if (!GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH is not set');

// Parse and validate the GitHub event payload
let event;
try {
  event = JSON.parse(fs.readFileSync(GITHUB_EVENT_PATH, 'utf8'));
} catch (err) {
  throw new Error(`Failed to parse GitHub event payload: ${err.message}`);
}
if (!event || typeof event !== 'object') throw new Error('GitHub event payload is not a valid object');

const prNumber = event.pull_request?.number;
if (!prNumber) throw new Error('Missing pull_request.number in event payload');

const [owner, repo] = GITHUB_REPOSITORY.split('/');

const githubHeaders = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28',
};

const ghFetch = (path, options = {}) =>
  fetch(`https://api.github.com${path}`, {
    ...options,
    headers: { ...githubHeaders, ...(options.headers || {}) },
  }).catch((err) => {
    throw new Error(`Network error calling GitHub API (${path}): ${err.message}`);
  });

// Fetch the PR diff
const diffRes = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
  headers: { Accept: 'application/vnd.github.v3.diff' },
});
if (!diffRes.ok) throw new Error(`Diff fetch failed: ${diffRes.status}`);
const rawDiff = await diffRes.text();

// Filter out generated/vendor files
const ignoredPaths = /(\/|^)(node_modules|dist)\//;
const lockFiles = /(package-lock\.json|yarn\.lock|pnpm-lock\.ya?ml|bun\.lockb|Cargo\.lock|composer\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock)$/;

const filteredDiff = rawDiff
  .split('\ndiff --git ')
  .map((chunk, i) => (i ? `diff --git ${chunk}` : chunk))
  .filter((chunk) => {
    const match = chunk.match(/^diff --git a\/(.+?) b\//m);
    const filePath = match?.[1] || '';
    return filePath && !ignoredPaths.test(filePath) && !lockFiles.test(filePath);
  })
  .join('\n');

const diff = (filteredDiff || rawDiff).slice(0, 12000);

// Build the review prompt
const systemPrompt =
  'You are a strict senior code reviewer.\n- No fluff\n- Only actionable issues\n- Be concise';

const userPrompt = `Analyze this pull request diff:\n\n${diff}\n\nOutput:\n\n## 🔍 Automated Code Review\n\n### ✅ Summary\n(max 3 lines)\n\n### ⚠️ Issues Found\n- [High|Medium|Low] Description\n  File: <file>\n  Fix: <fix>\n\n### 💡 Suggestions\n(optional)\n\n### 🧪 Tests\n(missing or weak tests)\n\n### 🚀 Verdict\n(APPROVE | REQUEST_CHANGES | COMMENT)\n\nConstraints:\n- Max 300 words\n- No repetition`;

// Call Groq
let groqRes;
try {
  groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
} catch (err) {
  throw new Error(`Network error calling Groq API: ${err.message}`);
}
if (!groqRes.ok) throw new Error(`Groq failed: ${groqRes.status} ${await groqRes.text()}`);

const rawReview = (await groqRes.json())?.choices?.[0]?.message?.content?.trim();
if (!rawReview) throw new Error('Groq returned empty content');

const HEADING = '## 🔍 Automated Code Review';
const review = rawReview.includes(HEADING) ? rawReview : `${HEADING}\n\n${rawReview}`;

// Post or update the PR comment
const commentsRes = await ghFetch(
  `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`
);
if (!commentsRes.ok) throw new Error(`Comment list failed: ${commentsRes.status}`);

const comments = await commentsRes.json();
const existing = comments.find((c) => c.body?.includes(HEADING));

const commentUrl = existing
  ? `/repos/${owner}/${repo}/issues/comments/${existing.id}`
  : `/repos/${owner}/${repo}/issues/${prNumber}/comments`;
const commentMethod = existing ? 'PATCH' : 'POST';

const postRes = await ghFetch(commentUrl, {
  method: commentMethod,
  body: JSON.stringify({ body: review }),
});
if (!postRes.ok) throw new Error(`Comment upsert failed: ${postRes.status} ${await postRes.text()}`);
