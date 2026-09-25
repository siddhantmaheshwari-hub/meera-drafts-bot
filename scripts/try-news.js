// Runs the daily news-drafts pipeline locally and prints what would be sent to Telegram.
//   npm run news          -> print only
//   npm run news -- --send -> actually send to NEWS_CHAT_ID / first ALLOWED_CHAT_IDS
import { runNewsDrafts } from '../lib/news.js';
import { sendMessage } from '../lib/telegram.js';

const live = process.argv.includes('--send');
const chatId = process.env.NEWS_CHAT_ID || (process.env.ALLOWED_CHAT_IDS || '').split(',')[0].trim();

const results = await runNewsDrafts({
  send: async (text) => {
    console.log(`\n===== ${live ? `SENT to ${chatId}` : 'WOULD SEND'} =====\n${text}`);
    if (live) await sendMessage(chatId, text);
  },
});
console.log('\nSummary:', results.map((r) => `${r.status}${r.score != null ? ` (${r.score})` : ''}: ${r.story.title}`));
