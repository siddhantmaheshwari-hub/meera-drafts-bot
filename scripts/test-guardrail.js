// End-to-end test of the scoring guardrail through the real webhook handler.
// Gemini calls are real; Telegram is stubbed so nothing is sent to any chat.
//   npm run test:guardrail
import handler from '../api/telegram.js';
import { parseScore } from '../lib/gemini.js';

const TEST_CHAT_ID = 111111;
process.env.ALLOWED_CHAT_IDS = String(TEST_CHAT_ID);
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';

const realFetch = globalThis.fetch;
let telegramMessages;
let geminiCalls;
let scorerOverride = null; // when set, replaces the scorer's reply to simulate malformed output

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.telegram.org/')) {
    const method = u.split('/').pop();
    if (method === 'sendMessage') telegramMessages.push(JSON.parse(init.body).text);
    return new Response(JSON.stringify({ ok: true, result: {} }));
  }
  if (u.includes('generativelanguage.googleapis.com')) {
    const body = JSON.parse(init.body);
    const kind = body.contents[0].parts[0].text.startsWith('Score this note') ? 'score' : 'draft';
    geminiCalls.push(kind);
    if (kind === 'score' && scorerOverride !== null) {
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: scorerOverride }] } }] }),
      );
    }
  }
  return realFetch(url, init);
};

async function runNote(text) {
  telegramMessages = [];
  geminiCalls = [];
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  const req = {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET },
    body: { update_id: 1, message: { message_id: 1, chat: { id: TEST_CHAT_ID }, text } },
  };
  const res = { status() { return this; }, json() { return this; }, send() { return this; } };
  try {
    await handler(req, res);
  } finally {
    console.log = origLog;
  }
  const scoreLine = logs.find((l) => l.startsWith('Note scored')) || '(no score logged)';
  return { scoreLine, drafted: geminiCalls.includes('draft'), messages: telegramMessages };
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}
const scoreOf = (line) => Number(line.match(/Note scored (\d+)/)?.[1] ?? NaN);
const REJECT_PREFIX = "I didn't create a draft because this note isn't substantive enough yet: ";

// ---- parseScore unit checks (malformed output must never pass) ----
const bad = [
  '', 'not json', '{"score": "8", "reason": "x"}', '{"score": 7.5, "reason": "x"}',
  '{"score": 11, "reason": "x"}', '{"score": -1, "reason": "x"}', '{"score": 8}',
  '{"score": 8, "reason": ""}', '{"reason": "x"}', '{"score": 8, "reason": "x"',
];
for (const b of bad) {
  let threw = false;
  try { parseScore(b); } catch { threw = true; }
  check(`parseScore rejects ${JSON.stringify(b)}`, threw);
}
check('parseScore accepts fenced JSON',
  parseScore('```json\n{"score": 7, "reason": "Clear idea."}\n```').score === 7);

// ---- The three required cases, through the real handler ----
const cases = [
  {
    name: 'TEST A - substantive note',
    text: "I've noticed that customers often ask whether our niacinamide is 5% or 10%, but the percentage alone doesn't tell you much. The pH, delivery base and batch consistency can all affect what the finished product actually delivers. We should explain why concentration on the label is only the beginning of the question.",
    expect: (r, s) => s >= 6 && r.drafted && r.messages.length === 2 && r.messages[0].startsWith(`Score: ${s}/10`) && !r.messages[1].startsWith(REJECT_PREFIX),
  },
  {
    name: 'TEST B - task/reminder',
    text: 'Write something about niacinamide tomorrow.',
    expect: (r, s) => s <= 3 && !r.drafted && r.messages.length === 1 && r.messages[0].startsWith(REJECT_PREFIX) && r.messages[0].includes(`Score: ${s}/10`),
  },
  {
    name: 'TEST C - abandoned/general thought',
    text: 'Need to write about climate and skincare formulations.',
    expect: (r, s) => s < 6 && !r.drafted && r.messages.length === 1 && r.messages[0].startsWith(REJECT_PREFIX) && r.messages[0].includes(`Score: ${s}/10`),
  },
];

for (const c of cases) {
  const r = await runNote(c.text);
  const s = scoreOf(r.scoreLine);
  check(c.name, c.expect(r, s), `| ${r.scoreLine} | drafting called: ${r.drafted}`);
  console.log(`      Telegram reply: ${(r.messages.join(' || ') || '(none)').slice(0, 300).replace(/\n+/g, ' / ')}${r.messages.join(' || ').length > 300 ? '...' : ''}`);
}

// ---- Malformed scorer output through the real handler: must not draft ----
scorerOverride = 'Sure! This note is great, I would give it a 9.';
const m = await runNote(cases[0].text);
scorerOverride = null;
check('Malformed scorer output blocks drafting', !m.drafted && m.messages.length === 1,
  `| drafting called: ${m.drafted} | reply: ${m.messages[0]}`);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exitCode = failures ? 1 : 0;
