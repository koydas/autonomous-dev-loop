const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export async function callAnthropic({
  prompt,
  systemPrompt,
  apiKey,
  model,
  temperature = 0,
  maxTokens = 4096,
}) {
  const payload = {
    model,
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
  };

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`Anthropic API HTTP error ${response.status}: ${rawText}`);
  }

  let raw;
  try {
    raw = JSON.parse(rawText);
  } catch {
    throw new Error('Anthropic API returned non-JSON response');
  }

  const content = raw?.content?.[0]?.text;
  if (!content || typeof content !== 'string') {
    throw new Error('Unexpected Anthropic API response format');
  }

  return content;
}
