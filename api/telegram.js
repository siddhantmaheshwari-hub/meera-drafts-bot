import { waitUntil } from '@vercel/functions';
import { draftPost, scoreNote, PASSING_SCORE } from '../lib/gemini.js';
import { runNewsDrafts } from '../lib/news.js';
import { sendMessage, sendTyping } from '../lib/telegram.js';

const WELCOME =
  "Hi Meera. Send me a note and I'll score it from 0 to 10. Notes scoring 6 or more get a LinkedIn draft in your voice.\n\nSend /news to get drafts from today's skincare news. They also arrive automatically every morning at 8:00.";

function allowedChatIds() {
  return (process.env.ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Meera drafts bot is running.');
  }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(401).send('Unauthorized');
  }

  // Direct messages arrive as `message`; notes posted in a channel the bot administers arrive as `channel_post`.
  const message = req.body?.message || req.body?.channel_post;
  const chatId = message?.chat?.id;
  // Ignore edits, channel posts, etc. Always 200 so Telegram doesn't retry.
  if (!chatId) return res.status(200).json({ ok: true });

  try {
    const allowed = allowedChatIds();
    const isAllowed = !allowed.length || allowed.includes(String(chatId));
    const text = (message.text || message.caption || '').trim();
    const command = text.split(/[\s@]/)[0]; // "/start@my_bot" -> "/start"

    // Commands answer in any chat, so a new chat can find the ID to add to ALLOWED_CHAT_IDS.
    // They never call Gemini, so this doesn't open the bot up.
    if (command === '/start' || command === '/help' || command === '/id') {
      const status = isAllowed
        ? ''
        : '\n\nThis chat is not enabled yet. Add this ID to ALLOWED_CHAT_IDS in Vercel and redeploy.';
      const intro = command === '/id' ? '' : `${WELCOME}\n\n`;
      await sendMessage(chatId, `${intro}Your chat ID is ${chatId}.${status}`);
      return res.status(200).json({ ok: true });
    }

    if (!isAllowed) {
      console.warn(`Rejected note from chat ${chatId} (not in ALLOWED_CHAT_IDS)`);
      await sendMessage(chatId, `Sorry, this bot is private. (Chat ID: ${chatId})`);
      return res.status(200).json({ ok: true });
    }
    if (!allowed.length) {
      console.warn(`ALLOWED_CHAT_IDS is empty; accepting chat ${chatId}. Set it to lock the bot down.`);
    }

    // News takes minutes (article fetches, several Gemini calls), so reply now and finish in the
    // background. Answering Telegram quickly stops it from re-sending /news and running it twice.
    if (command === '/news') {
      await sendMessage(chatId, "Looking through today's skincare news. Drafts will arrive here in a few minutes.");
      waitUntil(
        runNewsDrafts({ send: (t) => sendMessage(chatId, t) }).catch(async (err) => {
          console.error(err);
          await sendMessage(chatId, "Sorry, I couldn't fetch the news just now. Please try /news again later.").catch(() => {});
        }),
      );
      return res.status(200).json({ ok: true });
    }

    if (!text) {
      await sendMessage(chatId, 'I can only work from text notes for now. Please type or paste the note.');
      return res.status(200).json({ ok: true });
    }

    await sendTyping(chatId).catch(() => {});

    // Scoring guardrail: only notes scoring PASSING_SCORE or higher reach the drafting step.
    // If scoring fails (malformed output, API error), scoreNote throws and the catch below
    // replies with an error, so nothing is drafted.
    const { score, reason } = await scoreNote(text);
    console.log(`Note scored ${score}/10: ${reason}`);
    if (score < PASSING_SCORE) {
      await sendMessage(
        chatId,
        `I didn't create a draft because this note isn't substantive enough yet: ${reason}\n\nScore: ${score}/10 (a draft needs ${PASSING_SCORE} or more)`,
        message.message_id,
      );
      return res.status(200).json({ ok: true });
    }

    await sendMessage(chatId, `Score: ${score}/10. ${reason}\n\nWriting the draft now...`, message.message_id);
    await sendTyping(chatId).catch(() => {});
    const draft = await draftPost(text);
    await sendMessage(chatId, draft, message.message_id);
  } catch (err) {
    console.error(err);
    await sendMessage(chatId, "Sorry, I couldn't write a draft just now. Please try sending the note again.").catch(
      () => {},
    );
  }

  // Respond 200 even on failure; otherwise Telegram re-sends the same note repeatedly.
  return res.status(200).json({ ok: true });
}
