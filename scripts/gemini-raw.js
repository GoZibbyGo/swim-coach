// Raw Gemini probe — prints the exact HTTP status and body so we can see
// what the API actually says. Key from env only. Tries a couple of models.
import process from 'node:process';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('Set GEMINI_API_KEY'); process.exit(1); }

const models = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-flash-latest'];

for (const model of models) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }] }),
    });
    const text = await res.text();
    console.log(`\n=== ${model} → HTTP ${res.status} ===`);
    console.log(text.slice(0, 1200));
  } catch (e) {
    console.log(`\n=== ${model} → fetch threw: ${e.message} ===`);
  }
}
