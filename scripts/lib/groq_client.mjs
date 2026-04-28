export async function callGroq({
  prompt,
  systemPrompt,
  apiKey,
  model,
  apiUrl,
  temperature = 0,
  maxTokens,
  responseFormat = { type: 'json_object' },
}) {
  const payload = {
    model,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
  };
  if (maxTokens != null) {
    payload.max_tokens = maxTokens;
  }
  if (responseFormat) {
    payload.response_format = responseFormat;
  }

  const response = await fetch(apiUrl, {
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
