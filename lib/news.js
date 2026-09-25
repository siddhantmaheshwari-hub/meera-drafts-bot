// Daily news drafts: Google News (India) skincare search -> pick relevant stories -> read the
// article -> the same scoring guardrail and drafting step used for Meera's own notes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { draftPost, generateWithFallback, scoreNote, PASSING_SCORE } from './gemini.js';

const DEFAULT_QUERY =
  '(skincare OR "skin care" OR cosmetics OR sunscreen OR CDSCO OR "beauty industry" OR dermatologist) when:1d';
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
};
const MIN_ARTICLE_CHARS = 400;
const MAX_ARTICLE_CHARS = 6000;

export function newsFeedUrl(query = process.env.NEWS_QUERY || DEFAULT_QUERY) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
}

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1]).trim() : '';
}

export function parseFeed(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    const source = tag(item, 'source');
    let title = tag(item, 'title');
    // Google appends " - Source" to titles; the source is already its own field.
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    return { title, source, link: tag(item, 'link'), published: tag(item, 'pubDate') };
  });
}

export async function fetchNews(limit = 20) {
  const res = await fetch(newsFeedUrl(), { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Google News ${res.status}`);
  return parseFeed(await res.text()).slice(0, limit);
}

// Google News RSS links are encoded redirects. This asks Google for the publisher URL,
// the same way the News web app does. Returns null if Google changes the format.
export async function resolveArticleUrl(link) {
  const id = new URL(link).pathname.split('/').pop();
  const page = await (
    await fetch(`https://news.google.com/rss/articles/${id}`, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(10_000) })
  ).text();
  const sig = page.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = page.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!sig || !ts) return null;

  const inner = `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts},"${sig}"]`;
  const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST',
    headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]])),
    signal: AbortSignal.timeout(10_000),
  });
  const url = (await res.text()).match(/\[\\"garturlres\\",\\"(.*?)\\"/)?.[1];
  return url ? url.replace(/\\\\u003d/g, '=').replace(/\\\\u0026/g, '&') : null;
}

// Plain-text body of an article page: meta description plus paragraph text. Paywalled or
// JavaScript-rendered pages come back short and are skipped by the caller.
export async function fetchArticleText(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return '';
  const html = (await res.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '');
  const meta = html.match(/<meta[^>]+(?:name|property)="(?:og:)?description"[^>]+content="([^"]*)"/i)?.[1] || '';
  const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(([, p]) => decodeEntities(p.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 60 && !/subscri|log ?in|cookie|newsletter|sign up|advertis/i.test(p));
  return [decodeEntities(meta), ...paragraphs].filter(Boolean).join('\n').slice(0, MAX_ARTICLE_CHARS);
}

// Asks Gemini which headlines fit Meera's lens. Returns indexes into `items`.
async function selectStories(items, max) {
  const list = items.map((s, i) => `${i}. ${s.title} (${s.source})`).join('\n');
  const raw = await generateWithFallback(
    {
      system_instruction: { parts: [{ text: readFileSync(path.join(process.cwd(), 'prompts', 'news-select.md'), 'utf8') }] },
      contents: [{ role: 'user', parts: [{ text: `Pick at most ${max} stories.\n\n${list}` }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 1024,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: { picks: { type: 'ARRAY', items: { type: 'INTEGER' } } },
          required: ['picks'],
        },
      },
    },
    25_000,
  );
  const picks = JSON.parse(raw).picks;
  if (!Array.isArray(picks)) throw new Error(`Story selection returned no picks: ${raw.slice(0, 200)}`);
  return [...new Set(picks)].filter((i) => Number.isInteger(i) && i >= 0 && i < items.length).slice(0, max);
}

// The article becomes the "note". The header keeps both the scorer and the drafter from
// passing the reporter's facts off as Meera's own experience.
export function buildNewsNote(story, url, text) {
  return [
    `NEWS ARTICLE for Meera to examine in a post. The post should walk through what ${story.source} reports, test those claims against a documentation standard, say what the article does not establish, and end with a question readers can ask brands. It does not need Meera's personal experience. Every fact below comes from ${story.source}, not from Meera or Skinstinct: attribute these facts to ${story.source}, and do not invent personal experiences, Skinstinct figures, or facts the article does not contain.`,
    `Headline: ${story.title}`,
    `Source: ${story.source}, published ${story.published}`,
    `URL: ${url}`,
    'Article text:',
    text,
  ].join('\n');
}

async function processStory(story) {
  const url = await resolveArticleUrl(story.link).catch(() => null);
  if (!url) return { story, status: 'skipped', reason: "couldn't resolve the article link" };

  const text = await fetchArticleText(url).catch(() => '');
  if (text.length < MIN_ARTICLE_CHARS) {
    return { story, url, status: 'skipped', reason: "couldn't read the article (paywall or page blocked)" };
  }

  const note = buildNewsNote(story, url, text);
  const { score, reason } = await scoreNote(note);
  if (score < PASSING_SCORE) return { story, url, status: 'rejected', score, reason };

  return { story, url, status: 'drafted', score, draft: await draftPost(note) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The cron job has minutes to spare, so when every model is rate-limited (429) or overloaded
// (503), wait and try again instead of giving up. Uses Gemini's "retry in Ns" hint when present.
async function patiently(fn, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries || ![429, 503].includes(err.status)) throw err;
      const hinted = Number(err.message.match(/retry in ([\d.]+)s/)?.[1]);
      const waitMs = Math.min(Number.isFinite(hinted) ? hinted * 1000 + 1000 : 20_000, 45_000);
      console.warn(`All Gemini models busy (${err.status}); waiting ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
  }
}

// Runs the whole pipeline. `send(text)` delivers a message (Telegram in production).
export async function runNewsDrafts({ send, maxDrafts = Number(process.env.NEWS_MAX_DRAFTS) || 3 }) {
  const items = await fetchNews(20);
  if (!items.length) {
    await send('News drafts: Google News returned no skincare stories in the last 24 hours.');
    return [];
  }

  const picks = await patiently(() => selectStories(items, maxDrafts));
  if (!picks.length) {
    await send(`News drafts: none of today's ${items.length} skincare stories looked relevant enough to draft from.`);
    return [];
  }

  // One story at a time: the free Gemini tier allows only a few requests per minute.
  const results = [];
  for (const i of picks) {
    results.push(
      await patiently(() => processStory(items[i])).catch((err) => {
        console.error(err);
        const reason = err.status === 429 ? 'Gemini rate limit reached' : 'an error occurred while processing it';
        return { story: items[i], status: 'skipped', reason };
      }),
    );
  }

  for (const r of results.filter((r) => r.status === 'drafted')) {
    await send(`Draft from the news (score ${r.score}/10)\n${r.story.title} (${r.story.source})\n${r.url}\n\n${r.draft}`);
  }

  const notDrafted = results.filter((r) => r.status !== 'drafted');
  if (notDrafted.length) {
    const lines = notDrafted.map((r) => {
      const why = r.status === 'rejected' ? `scored ${r.score}/10: ${r.reason}` : r.reason;
      return `- ${r.story.title} (${r.story.source}): ${why}\n  ${r.url || r.story.link}`;
    });
    await send(`News stories not drafted:\n\n${lines.join('\n\n')}`);
  }
  return results;
}
