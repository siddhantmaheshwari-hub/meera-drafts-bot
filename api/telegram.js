import { draftPost } from '../lib/gemini.js';
import { sendMessage, sendTyping } from '../lib/telegram.js';

const WELCOME =
  "Hi Meera. Send me a note (as rough as you like) and I'll reply with a LinkedIn draft in your voice.";

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
    if (allowed.length && !allowed.includes(String(chatId))) {
      await sendMessage(chatId, 'Sorry, this bot is private.');
      return res.status(200).json({ ok: true });
    }
    if (!allowed.length) {
      console.warn(`ALLOWED_CHAT_IDS is empty; accepting chat ${chatId}. Set it to lock the bot down.`);
    }

    const text = (message.text || message.caption || '').trim();

    if (text === '/start' || text === '/help') {
      await sendMessage(chatId, `${WELCOME}\n\nYour chat ID is ${chatId}.`);
      return res.status(200).json({ ok: true });
    }
    if (text === '/id') {
      await sendMessage(chatId, `Your chat ID is ${chatId}.`);
      return res.status(200).json({ ok: true });
    }
    if (!text) {
      await sendMessage(chatId, 'I can only work from text notes for now. Please type or paste the note.');
      return res.status(200).json({ ok: true });
    }

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
