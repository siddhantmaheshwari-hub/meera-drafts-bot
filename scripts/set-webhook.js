// Registers the Vercel URL as the bot's webhook (run once after the first deploy).
//   npm run set-webhook      -> point Telegram at PUBLIC_URL/api/telegram
//   npm run webhook-info     -> show what Telegram currently has registered
import { callTelegram } from '../lib/telegram.js';

if (process.argv.includes('--info')) {
  console.log(await callTelegram('getWebhookInfo', {}));
  process.exit(0);
}

const publicUrl = process.env.PUBLIC_URL?.replace(/\/+$/, '');
if (!publicUrl) {
  console.error('Set PUBLIC_URL in .env.local (e.g. https://meera-drafts-bot.vercel.app)');
  process.exit(1);
}

const url = `${publicUrl}/api/telegram`;
await callTelegram('setWebhook', {
  url,
  secret_token: process.env.TELEGRAM_WEBHOOK_SECRET || undefined,
  allowed_updates: ['message', 'channel_post'],
  drop_pending_updates: true,
});
console.log(`Webhook set to ${url}`);
// Shows these in Telegram's "/" menu.
await callTelegram('setMyCommands', {
  commands: [
    { command: 'news', description: "Drafts from today's skincare news" },
    { command: 'start', description: 'How this bot works' },
    { command: 'id', description: 'Show this chat ID' },
  ],
});
console.log('Bot commands registered');
console.log(await callTelegram('getWebhookInfo', {}));
