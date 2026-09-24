# Meera drafts bot

Meera texts a rough note to a Telegram bot. The bot sends the note to Gemini along with her voice guide, and replies in the same chat with a LinkedIn draft.

```
Meera (Telegram) ──> Telegram ──webhook──> Vercel /api/telegram ──> Gemini
        ^                                          │
        └──────────── draft (sendMessage) ─────────┘
```

No npm dependencies. It needs Node 18 or later (Vercel's runtime already qualifies; the local scripts use `--env-file`, which needs Node 20.6 or later).

## Files

| Path | What it does |
| --- | --- |
| `api/telegram.js` | The webhook Vercel runs. Checks the secret and the allowed chat, then drafts and replies. |
| `lib/gemini.js` | Reads `prompts/voice-skill.txt` for every draft, sends it to Gemini as the system instruction, and calls Gemini. |
| `lib/telegram.js` | Sends messages, splitting any over Telegram's 4096-character limit. |
| `prompts/voice-skill.txt` | **Meera's voice guide.** Its full contents go to Gemini with every note. |
| `prompts/task.md` | The ghostwriting rules: don't invent facts, plain text only. |
| `scripts/set-webhook.js` | Points Telegram at your Vercel URL (run once). |
| `scripts/try-draft.js` | Tries a note from the command line, without Telegram. |
| `vercel.json` | 60s timeout; bundles `prompts/` with the function. |

## Setup

1. **Fill in env vars.** Copy `.env.example` to `.env.local` and fill it in. For `TELEGRAM_WEBHOOK_SECRET`, use any long random string.
2. **Try the voice locally:**
   ```bash
   npm run draft -- "q2 returns: 23% texture complaints, mostly humid cities. reformulated, now 8%"
   ```
3. **Deploy to Vercel.** Push this folder to GitHub and import it in Vercel (or run `npx vercel`). Under Project, Settings, Environment Variables, add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS` and `ALLOWED_CHAT_IDS`, then redeploy.
4. **Register the webhook.** Set `PUBLIC_URL` in `.env.local` to your production URL (for example `https://meera-drafts-bot.vercel.app`), then:
   ```bash
   npm run set-webhook
   ```
5. **Using a channel instead of DMs (optional).** Add the bot to the channel as an admin with "Post messages" permission. Notes posted there get a draft reply in the same channel. Channel IDs start with `-100`.
6. **Lock it to Meera.** Have Meera send `/start` to the bot, and it replies with her chat ID. `/start` and `/id` work in any chat, even one that isn't allowed yet. Put that number in `ALLOWED_CHAT_IDS` on Vercel and redeploy. Separate multiple IDs with commas, for example `-1003979909185,123456789`. Notes only get drafted in chats on that list. If the list is empty, anyone who finds the bot can use your Gemini quota.

If Vercel Deployment Protection is on for production, Telegram's requests will be blocked. Turn it off for the production domain, or use a URL that isn't protected.

## Changing the voice

Replace or edit `prompts/voice-skill.txt`, keeping that file name. Locally, the next draft uses the new version straight away, so you can compare with `npm run draft`. On Vercel, redeploy, because each deployment bundles its own copy of the file. If the file is missing or empty, the bot replies with an error instead of writing a draft that isn't in her voice.

## Troubleshooting

- `npm run webhook-info` shows Telegram's view of things, including `last_error_message`.
- Vercel, then Project, then Logs shows function errors (for example a Gemini 401).
- If Gemini replies 401, the key is wrong or was copied incompletely. Current AI Studio keys look like `AQ.Ab8...`; older ones start with `AIza`. Both work.
- If Gemini replies 503 ("high demand"), that's temporary. The bot retries, then tries each model in `GEMINI_FALLBACK_MODELS`.
- If Gemini replies 404 ("no longer available"), Google has retired that model. Pick a current one; this lists what your key can use:
  `curl -H "x-goog-api-key: $GEMINI_API_KEY" https://generativelanguage.googleapis.com/v1beta/models`
