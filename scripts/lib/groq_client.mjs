export async function callGroq({ prompt, apiKey, model, apiUrl }) {
  const payload = {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You generate one small, safe repository file change. Return strict JSON with keys summary, target_path, and file_content.',
      },
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

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('AI response was not valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI response JSON must be an object');
  }

  return parsed;
}
