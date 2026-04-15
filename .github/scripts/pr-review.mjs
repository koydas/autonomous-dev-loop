import fs from 'node:fs';

const e = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const n = e.pull_request?.number; if (!n) throw new Error('Missing pull_request.number');
const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
const h = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' };
const gh = (u, o = {}) => fetch(`https://api.github.com${u}`, { ...o, headers: { ...h, ...(o.headers || {}) } });

const dRes = await gh(`/repos/${owner}/${repo}/pulls/${n}`, { headers: { Accept: 'application/vnd.github.v3.diff' } });
if (!dRes.ok) throw new Error(`Diff fetch failed: ${dRes.status}`);
const raw = await dRes.text();
const ign = /(\/|^)(node_modules|dist)\//;
const lock = /(package-lock\.json|yarn\.lock|pnpm-lock\.ya?ml|bun\.lockb|Cargo\.lock|composer\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock)$/;
const kept = raw.split('\ndiff --git ').map((p, i) => (i ? `diff --git ${p}` : p)).filter(p => {
  const m = p.match(/^diff --git a\/(.+?) b\//m); const f = m?.[1] || ''; return f && !ign.test(f) && !lock.test(f);
}).join('\n');
const diff = (kept || raw).slice(0, 12000);

const system = 'You are a strict senior code reviewer.\n- No fluff\n- Only actionable issues\n- Be concise';
const user = `Analyze this pull request diff:\n\n${diff}\n\nOutput:\n\n## 🔍 Automated Code Review\n\n### ✅ Summary\n(max 3 lines)\n\n### ⚠️ Issues Found\n- [High|Medium|Low] Description\n  File: <file>\n  Fix: <fix>\n\n### 💡 Suggestions\n(optional)\n\n### 🧪 Tests\n(missing or weak tests)\n\n### 🚀 Verdict\n(APPROVE | REQUEST_CHANGES | COMMENT)\n\nConstraints:\n- Max 300 words\n- No repetition`;
const gRes = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body: JSON.stringify({ model: 'llama3-70b-8192', temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
if (!gRes.ok) throw new Error(`Groq failed: ${gRes.status} ${await gRes.text()}`);
const review = (await gRes.json())?.choices?.[0]?.message?.content?.trim();
if (!review?.includes('## 🔍 Automated Code Review')) throw new Error('Groq output missing expected heading');

const cRes = await gh(`/repos/${owner}/${repo}/issues/${n}/comments?per_page=100`); if (!cRes.ok) throw new Error(`Comment list failed: ${cRes.status}`);
const comments = await cRes.json();
const prior = comments.find(c => c.body?.includes('## 🔍 Automated Code Review'));
const url = prior ? `/repos/${owner}/${repo}/issues/comments/${prior.id}` : `/repos/${owner}/${repo}/issues/${n}/comments`;
const method = prior ? 'PATCH' : 'POST';
const pRes = await gh(url, { method, body: JSON.stringify({ body: review }) });
if (!pRes.ok) throw new Error(`Comment upsert failed: ${pRes.status} ${await pRes.text()}`);
