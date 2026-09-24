// Try the voice prompt without Telegram:
//   npm run draft -- "note text here"
import { draftPost } from '../lib/gemini.js';

const note = process.argv.slice(2).join(' ').trim();
if (!note) {
  console.error('Usage: npm run draft -- "your note here"');
  process.exit(1);
}

console.log(await draftPost(note));
