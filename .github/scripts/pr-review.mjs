import fs from 'node:fs';

const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const prNumber = event.pull_request?.number;
if (!prNumber) throw new Error('Missing pull_request.number');

const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');

const githubHeaders = {
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28',
};

const ghFetch = (path, options = {}) =>
  fetch(`https://api.github.com${path}`, {
    ...options,
    headers: { ...githubHeaders, ...(options.headers || {}) },
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
const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
  },
  body: JSON.stringify({
    model: 'llama3-70b-8192',
    temperature: 0.2,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  }),
});
if (!groqRes.ok) throw new Error(`Groq failed: ${groqRes.status} ${await groqRes.text()}`);

const review = (await groqRes.json())?.choices?.[0]?.message?.content?.trim();
if (!review?.includes('## 🔍 Automated Code Review'))
  throw new Error('Groq output missing expected heading');

// Post or update the PR comment
const commentsRes = await ghFetch(
  `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`
);
if (!commentsRes.ok) throw new Error(`Comment list failed: ${commentsRes.status}`);

const comments = await commentsRes.json();
const existing = comments.find((c) => c.body?.includes('## 🔍 Automated Code Review'));

const commentUrl = existing
  ? `/repos/${owner}/${repo}/issues/comments/${existing.id}`
  : `/repos/${owner}/${repo}/issues/${prNumber}/comments`;
const commentMethod = existing ? 'PATCH' : 'POST';

const postRes = await ghFetch(commentUrl, {
  method: commentMethod,
  body: JSON.stringify({ body: review }),
});
if (!postRes.ok) throw new Error(`Comment upsert failed: ${postRes.status} ${await postRes.text()}`);
