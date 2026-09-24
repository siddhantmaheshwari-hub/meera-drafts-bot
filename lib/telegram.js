const MAX_MESSAGE_LENGTH = 4096;

async function callTelegram(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description || res.status}`);
  return data.result;
}

// Telegram caps messages at 4096 chars; split on paragraph breaks where possible.
function splitMessage(text) {
  const chunks = [];
  let rest = text;
  while (rest.length > MAX_MESSAGE_LENGTH) {
    let cut = rest.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH);
    if (cut <= 0) cut = rest.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
    if (cut <= 0) cut = MAX_MESSAGE_LENGTH;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// Sent as plain text (no parse_mode) so drafts never fail on Markdown escaping.
export async function sendMessage(chatId, text, replyToMessageId) {
  const chunks = splitMessage(text);
  for (const [i, chunk] of chunks.entries()) {
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: chunk,
      ...(i === 0 && replyToMessageId
        ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } }
        : {}),
    });
  }
}

export function sendTyping(chatId) {
  return callTelegram('sendChatAction', { chat_id: chatId, action: 'typing' });
}

export { callTelegram };
