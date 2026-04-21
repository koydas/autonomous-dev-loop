/**
 * Groq client for the issue validation agent.
 *
 * Uses raw fetch (OpenAI-compatible Groq API) with response_format json_object
 * so the model is forced to return valid JSON — consistent with how the
 * existing groq_client.mjs works for the coder agent.
 *
 * The file is named claude_client.mjs for backward-compat with imports in
 * validate_issue.mjs; the underlying provider is Groq.
 */

export async function callClaude({ systemPrompt, userPrompt, apiKey, model, apiUrl }) {
  const resolvedModel = model || 'llama-3.3-70b-versatile';
  const resolvedUrl = apiUrl || 'https://api.groq.com/openai/v1/chat/completions';

  const payload = {
    model: resolvedModel,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };

  const response = await fetch(resolvedUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`Groq API HTTP error ${response.status}: ${rawText}`);
  }

  let raw;
  try {
    raw = JSON.parse(rawText);
  } catch {
    throw new Error('Groq API returned non-JSON response');
  }

  const content = raw?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error('Unexpected Groq API response format');
  }

  return content;
}
