import { readFileSync } from 'node:fs';
import path from 'node:path';

const PROMPTS_DIR = path.join(process.cwd(), 'prompts');
export const VOICE_SKILL_PATH = path.join(PROMPTS_DIR, 'voice-skill.txt');

// Read fresh for every draft, so Gemini always gets the current contents of voice-skill.txt.
// Fails loudly rather than drafting without the voice instructions.
function buildSystemPrompt() {
  const voiceSkill = readFileSync(VOICE_SKILL_PATH, 'utf8').trim();
  if (!voiceSkill) throw new Error(`${VOICE_SKILL_PATH} is empty`);
  return [
    readFileSync(path.join(PROMPTS_DIR, 'task.md'), 'utf8').trim(),
    '--- VOICE GUIDE (from voice-skill.txt) ---',
    voiceSkill,
  ].join('\n\n');
}

// Overloaded / rate-limited / retired model: worth trying again or moving to the next model.
const RETRYABLE = new Set([404, 429, 500, 503, 504]);
const ATTEMPTS_PER_MODEL = 2;
// Stay well inside the 60s function limit in vercel.json.
const DEADLINE_MS = 50_000;

function modelList() {
  const primary = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const fallbacks = (process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-3.6-flash,gemini-flash-latest')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return [...new Set([primary, ...fallbacks])];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function generate(model, note, apiKey, systemPrompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [
          { role: 'user', parts: [{ text: `Here is my note. Turn it into a LinkedIn post.\n\n${note}` }] },
        ],
        // Headroom for models that spend output tokens on thinking before the draft.
        generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
      }),
    },
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Gemini ${model} ${res.status}: ${data?.error?.message || res.statusText}`);
    err.status = res.status;
    throw err;
  }

  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts
    ?.filter((p) => !p.thought)
    .map((p) => p.text || '')
    .join('')
    .trim();
  if (!text) {
    const reason = data.promptFeedback?.blockReason || candidate?.finishReason || 'empty response';
    throw new Error(`Gemini ${model} returned no draft (${reason})`);
  }
  return text;
}

export async function draftPost(note) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const systemPrompt = buildSystemPrompt();
  const started = Date.now();
  let lastError;
  for (const model of modelList()) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_MODEL; attempt++) {
      if (Date.now() - started > DEADLINE_MS) throw lastError || new Error('Gemini timed out');
      try {
        return await generate(model, note, apiKey, systemPrompt);
      } catch (err) {
        lastError = err;
        console.warn(err.message);
        if (!RETRYABLE.has(err.status)) throw err; // bad key, bad request, etc.
        if (err.status === 404) break; // model gone: skip straight to the next one
        if (attempt < ATTEMPTS_PER_MODEL) await sleep(1500 * attempt);
      }
    }
  }
  throw lastError;
}
