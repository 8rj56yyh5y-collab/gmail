'use strict';
// Перевод через Claude (необязательно): ответы компаний — на русский, наш ответ — на язык компании,
// шаблон — на новый язык. Включается переменной ANTHROPIC_API_KEY; без неё кнопки перевода скрыты.
const { db, logEvent } = require('./db');
const { HttpError } = require('./contacts');
const C = require('./countries');

const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
let client = null;
function getClient() {
  if (client) return client;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const mod = require('@anthropic-ai/sdk');
    const Anthropic = mod.default || mod.Anthropic || mod;
    client = new Anthropic();
    return client;
  } catch { return null; }
}
const enabled = () => !!getClient();

const LANG_EN = { en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', cs: 'Czech', sk: 'Slovak',
  hu: 'Hungarian', ro: 'Romanian', bg: 'Bulgarian', hr: 'Croatian', sl: 'Slovenian', sr: 'Serbian (Latin script)', el: 'Greek', sv: 'Swedish', no: 'Norwegian',
  da: 'Danish', fi: 'Finnish', et: 'Estonian', lv: 'Latvian', lt: 'Lithuanian', uk: 'Ukrainian', tr: 'Turkish', ru: 'Russian' };

async function ask(prompt, maxTokens = 4000) {
  const c = getClient();
  if (!c) throw new HttpError(503, 'Перевод не подключён (нужен ANTHROPIC_API_KEY)');
  let res;
  try {
    res = await c.messages.create({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
  } catch (e) {
    if (e?.status === 429) throw new HttpError(503, 'Сервис перевода перегружен, попробуйте через минуту');
    if (e?.status === 401 || e?.status === 403) throw new HttpError(503, 'Ключ ANTHROPIC_API_KEY не подошёл');
    throw new HttpError(502, 'Не удалось перевести, попробуйте ещё раз');
  }
  if (res.stop_reason === 'refusal') throw new HttpError(422, 'Перевод этого текста недоступен');
  return (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

// Перевести входящее письмо на русский (результат сохраняется, второй раз не платим)
async function translateMessage(user, id) {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(id));
  if (!m) throw new HttpError(404, 'Письмо не найдено');
  if (m.translation) return { translation: m.translation };
  const out = await ask(`Translate this business email into Russian. Keep the meaning, names, numbers and the paragraph structure. Output only the translation, no comments.

Subject: ${m.subject}

${m.body_text.slice(0, 20000)}`);
  db.prepare('UPDATE messages SET translation = ? WHERE id = ?').run(out, m.id);
  logEvent(user.id, 'message', m.id, 'translate');
  return { translation: out };
}

// Перевести наш ответ (написанный по-русски) на язык компании
async function translateDraft(user, { text, lang }) {
  const target = LANG_EN[lang];
  if (!target) throw new HttpError(400, 'Неизвестный язык');
  const out = await ask(`Translate this business email reply into ${target}. Use a polite, natural business tone that a native speaker would write. Keep names, numbers and paragraph breaks. Output only the translated email text, no comments.

${String(text || '').slice(0, 20000)}`);
  logEvent(user.id, 'ai', null, 'translate_draft', { lang });
  return { text: out };
}

// Сделать шаблон на новом языке из существующего (плейсхолдеры {{…}} не трогаем)
async function translateTemplate(user, { from_lang, to_lang, kind }) {
  const src = db.prepare('SELECT * FROM templates WHERE lang = ? AND kind = ?').get(from_lang, kind || 'first');
  if (!src) throw new HttpError(404, 'Нет исходного шаблона');
  const target = LANG_EN[to_lang];
  if (!target) throw new HttpError(400, 'Неизвестный язык');
  const out = await ask(`Translate this email template into ${target} for a native business reader. Keep every placeholder in double curly braces EXACTLY as is (for example {{company}}, {{name|Sir or Madam}} — but translate the fallback word after "|" ). Keep paragraph breaks.
Reply in exactly this format:
SUBJECT: <translated subject>
BODY:
<translated body>

SUBJECT: ${src.subject}
BODY:
${src.body}`);
  const m = /SUBJECT:\s*(.+)\n+BODY:\s*\n?([\s\S]+)/i.exec(out);
  if (!m) throw new HttpError(502, 'Перевод получился в неожиданном виде, попробуйте ещё раз');
  logEvent(user.id, 'ai', src.id, 'translate_template', { to_lang });
  return { subject: m[1].trim(), body: m[2].trim(), lang: to_lang, name: C.LANGS[to_lang] };
}

module.exports = { enabled, translateMessage, translateDraft, translateTemplate };
