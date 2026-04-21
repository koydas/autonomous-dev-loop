export async function callGroq({ prompt, systemPrompt, apiKey, model, apiUrl }) {
  const payload = {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
  };

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
