// Called once a day by Vercel Cron (see vercel.json). Drafts posts from skincare news and
// sends them to the news chat (NEWS_CHAT_ID, or the first ID in ALLOWED_CHAT_IDS).
import { runNewsDrafts } from '../lib/news.js';
import { sendMessage } from '../lib/telegram.js';

export default async function handler(req, res) {
  // Vercel Cron sends "Authorization: Bearer <CRON_SECRET>". Refuse to run without it,
  // so nobody else can trigger Gemini calls and channel posts.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).send('Unauthorized');
  }

  const chatId = process.env.NEWS_CHAT_ID || (process.env.ALLOWED_CHAT_IDS || '').split(',')[0].trim();
  if (!chatId) return res.status(500).send('Set NEWS_CHAT_ID or ALLOWED_CHAT_IDS');

  try {
    const results = await runNewsDrafts({ send: (text) => sendMessage(chatId, text) });
    const summary = results.map((r) => ({ title: r.story.title, status: r.status, score: r.score }));
    console.log('News drafts:', JSON.stringify(summary));
    return res.status(200).json({ ok: true, results: summary });
  } catch (err) {
    console.error(err);
    await sendMessage(chatId, "News drafts didn't run today because of an error. Check the Vercel logs.").catch(() => {});
    return res.status(500).json({ ok: false });
  }
}
