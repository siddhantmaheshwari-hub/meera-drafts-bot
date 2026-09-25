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
// Scoring (up to 25s) + drafting (up to 50s) stay inside the 90s function limit in vercel.json.
const DEADLINE_MS = 50_000;

function modelList() {
  const primary = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const fallbacks = (process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-3.8-flash,gemini-flash-latest')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return [...new Set([primary, ...fallbacks])];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function generate(model, apiKey, body) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
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
    throw new Error(`Gemini ${model} returned no text (${reason})`);
  }
  return text;
}

// Sends `body` to the primary model, retrying and falling back to other models on transient errors.
export async function generateWithFallback(body, deadlineMs) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const started = Date.now();
  let lastError;
  for (const model of modelList()) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_MODEL; attempt++) {
      if (Date.now() - started > deadlineMs) throw lastError || new Error('Gemini timed out');
      try {
        return await generate(model, apiKey, body);
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

export async function draftPost(note) {
  const systemPrompt = buildSystemPrompt();
  return generateWithFallback(
    {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [
        { role: 'user', parts: [{ text: `Here is my note. Turn it into a LinkedIn post.\n\n${note}` }] },
      ],
      // Headroom for models that spend output tokens on thinking before the draft.
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
    },
    DEADLINE_MS,
  );
}

// ---- Scoring guardrail: decides whether a note is substantive enough to draft ----

export const PASSING_SCORE = 6;
const SCORING_DEADLINE_MS = 25_000;
const SCORING_ATTEMPTS = 2; // re-ask once if Gemini returns malformed JSON

// Strictly validates the scorer's reply. Returns { score, reason } or throws, so malformed
// output can never be read as a passing score.
export function parseScore(raw) {
  if (typeof raw !== 'string') throw new Error('Scorer returned no text');
  const cleaned = raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error(`Scorer returned non-JSON: ${raw.slice(0, 200)}`);

  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error(`Scorer returned malformed JSON: ${raw.slice(0, 200)}`);
  }

  const { score, reason } = parsed ?? {};
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 10) {
    throw new Error(`Scorer returned an invalid score: ${JSON.stringify(score)}`);
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new Error('Scorer returned no reason');
  }
  return { score, reason: reason.replace(/\s+/g, ' ').trim() };
}

export async function scoreNote(note) {
  const body = {
    system_instruction: {
      parts: [{ text: readFileSync(path.join(PROMPTS_DIR, 'scoring.md'), 'utf8').trim() }],
    },
    contents: [{ role: 'user', parts: [{ text: `Score this note.\n\n<note>\n${note}\n</note>` }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: { score: { type: 'INTEGER' }, reason: { type: 'STRING' } },
        required: ['score', 'reason'],
      },
    },
  };

  let lastError;
  for (let attempt = 1; attempt <= SCORING_ATTEMPTS; attempt++) {
    const raw = await generateWithFallback(body, SCORING_DEADLINE_MS);
    try {
      return parseScore(raw);
    } catch (err) {
      lastError = err;
      console.warn(`Scoring attempt ${attempt}: ${err.message}`);
    }
  }
  throw lastError; // fail closed: the caller must not draft
}
