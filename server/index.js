'use strict';
// Gobsek Mail — сервер. Node 22+, без фреймворков: node:http + node:sqlite.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { db, FILE_DIR, logEvent, DEFAULT_SETTINGS, getSettings, setSetting, envLocked, NUM_KEYS } = require('./db');
const auth = require('./auth');
const C = require('./countries');
const K = require('./contacts');
const T = require('./templates');
const I = require('./importer');
const mailer = require('./mailer');
const inbox = require('./inbox');
const ai = require('./ai');
const sched = require('./schedules');

const { HttpError, str } = K;
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 25 * 1024 * 1024;
const VERSION = require('../package.json').version;
const APP_NAME = process.env.APP_NAME || 'Gobsek Mail';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

// ---------- первый запуск ----------
function bootstrap() {
  T.seedTemplates();
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n) return;
  const login = str(process.env.ADMIN_LOGIN || 'admin', 40);
  let password = process.env.ADMIN_PASSWORD;
  let generated = false;
  if (!password || auth.passwordProblem(password)) { password = auth.randomPassword(); generated = true; }
  db.prepare('INSERT INTO users (login, name, pass_hash, must_change_pw, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(login, process.env.ADMIN_NAME || 'Администратор', auth.hashPassword(password), generated ? 1 : 0, Date.now());
  console.log('\n  ┌──────────────────────────────────────────────');
  console.log(`  │ Создан вход: логин «${login}»`);
  if (generated) console.log(`  │ Временный пароль: ${password}  (сменить при первом входе)`);
  else console.log('  │ Пароль — из переменной ADMIN_PASSWORD');
  console.log('  └──────────────────────────────────────────────\n');
}

// ---------- помощники ----------
function send(res, status, data, req, headers = {}) {
  const json = JSON.stringify(data);
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers };
  if (req && json.length > 4096 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    res.writeHead(status, { ...h, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    return res.end(zlib.gzipSync(json));
  }
  res.writeHead(status, h);
  res.end(json);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Слишком большой файл (до 20 МБ)')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Некорректный запрос')); }
    });
    req.on('error', reject);
  });
}
const needUser = (u) => { if (!u) throw new HttpError(401, 'Войдите в систему'); if (u.must_change_pw) throw new HttpError(428, 'Сначала смените временный пароль'); return u; };
const publicUser = (u) => u && ({ id: u.id, login: u.login, name: u.name, must_change_pw: !!u.must_change_pw });

const PUBLIC_SETTINGS = Object.keys(DEFAULT_SETTINGS).filter((k) => k !== 'mail_pass');
function settingsOut() {
  const st = getSettings();
  const out = Object.fromEntries(PUBLIC_SETTINGS.map((k) => [k, st[k]]));
  out.has_password = !!st.mail_pass;
  out.env_locked = envLocked();
  return out;
}
const PRESETS = {
  gmail: { smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_secure: 1, imap_host: 'imap.gmail.com', imap_port: 993, imap_secure: 1 },
  outlook: { smtp_host: 'smtp-mail.outlook.com', smtp_port: 587, smtp_secure: 0, imap_host: 'outlook.office365.com', imap_port: 993, imap_secure: 1 },
  yahoo: { smtp_host: 'smtp.mail.yahoo.com', smtp_port: 465, smtp_secure: 1, imap_host: 'imap.mail.yahoo.com', imap_port: 993, imap_secure: 1 },
  zoho: { smtp_host: 'smtp.zoho.eu', smtp_port: 465, smtp_secure: 1, imap_host: 'imap.zoho.eu', imap_port: 993, imap_secure: 1 },
  ukrnet: { smtp_host: 'smtp.ukr.net', smtp_port: 465, smtp_secure: 1, imap_host: 'imap.ukr.net', imap_port: 993, imap_secure: 1 },
};
function saveSettings(user, body) {
  const locked = envLocked();
  const changed = [];
  if (body.provider && PRESETS[body.provider]) Object.assign(body, PRESETS[body.provider]);
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (body[k] === undefined || locked.includes(k)) continue;
    let v = body[k];
    if (k === 'mail_pass') { if (!v) continue; v = String(v).replace(/\s+/g, ''); }
    else if (NUM_KEYS.includes(k)) {
      v = Number(v);
      if (!Number.isFinite(v)) throw new HttpError(400, `Некорректное значение: ${k}`);
      const lim = { daily_limit: [1, 2000], delay_min: [5, 3600], delay_max: [5, 7200], window_from: [0, 23], window_to: [0, 24], poll_sec: [30, 3600], smtp_port: [1, 65535], imap_port: [1, 65535] }[k];
      if (lim) v = Math.min(lim[1], Math.max(lim[0], Math.round(v)));
      else v = v ? 1 : 0;
    } else v = str(v, k === 'signature' ? 2000 : 300);
    if (k === 'timezone') { try { new Intl.DateTimeFormat('en', { timeZone: v }); } catch { throw new HttpError(400, 'Неизвестный часовой пояс'); } }
    if (k === 'fallback_lang' && v !== 'skip' && !C.LANGS[v]) throw new HttpError(400, 'Неизвестный язык');
    if (['forward_to', 'reply_to', 'mail_user'].includes(k) && v && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) throw new HttpError(400, 'Проверьте адрес почты');
    setSetting(k, v); changed.push(k);
  }
  const st = getSettings();
  if (Number(st.delay_max) < Number(st.delay_min)) setSetting('delay_max', st.delay_min);
  logEvent(user.id, 'settings', null, 'update', { keys: changed.filter((k) => k !== 'mail_pass') });
  return settingsOut();
}

function home() {
  const now = Date.now();
  const contacts = db.prepare('SELECT status, COUNT(*) n FROM contacts GROUP BY status').all();
  const by = Object.fromEntries(contacts.map((r) => [r.status, r.n]));
  const total = contacts.reduce((s, r) => s + r.n, 0);
  const sent = db.prepare("SELECT COUNT(DISTINCT contact_id) n FROM messages WHERE direction = 'out' AND status = 'sent' AND kind = 'first'").get().n;
  const replied = db.prepare("SELECT COUNT(DISTINCT contact_id) n FROM messages WHERE direction = 'in' AND kind = 'reply'").get().n;
  const day = 86400e3;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const from = start.getTime() - 29 * day;
  const series = Array.from({ length: 30 }, (_, i) => ({ t: from + i * day, sent: 0, replies: 0 }));
  for (const r of db.prepare("SELECT sent_at t FROM messages WHERE direction = 'out' AND status = 'sent' AND kind IN ('first','followup') AND sent_at >= ?").all(from)) {
    const i = Math.floor((r.t - from) / day); if (series[i]) series[i].sent++;
  }
  for (const r of db.prepare("SELECT received_at t FROM messages WHERE direction = 'in' AND kind = 'reply' AND received_at >= ?").all(from)) {
    const i = Math.floor((r.t - from) / day); if (series[i]) series[i].replies++;
  }
  const langs = db.prepare(`SELECT c.lang, COUNT(*) contacts,
      SUM(EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = c.id AND m.direction = 'out' AND m.status = 'sent' AND m.kind = 'first')) sent,
      SUM(EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = c.id AND m.direction = 'in' AND m.kind = 'reply')) replied
    FROM contacts c GROUP BY c.lang ORDER BY contacts DESC`).all();
  const countries = db.prepare(`SELECT c.country, COUNT(*) contacts,
      SUM(EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = c.id AND m.direction = 'out' AND m.status = 'sent' AND m.kind = 'first')) sent,
      SUM(EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = c.id AND m.direction = 'in' AND m.kind = 'reply')) replied
    FROM contacts c GROUP BY c.country ORDER BY contacts DESC LIMIT 12`).all();
  const latest = inbox.list({ tab: 'replies' }).rows.slice(0, 6);
  return { total, by_status: by, sent, replied, unread: inbox.unreadCount(), series, langs, countries, latest, sender: mailer.status(), inbox: inbox.status(), next_schedule: sched.nextUp(), now };
}

function exportCsv(q) {
  const { sql, params } = K.where(q);
  const rows = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.contact_id = c.id AND m.direction = 'in' AND m.kind = 'reply') replies FROM contacts c ${sql} ORDER BY c.id`).all(...params);
  const cols = [['company', 'Компания'], ['email', 'Email'], ['contact_name', 'Контакт'], ['country', 'Страна (код)'], ['country_raw', 'Страна в файле'], ['lang', 'Язык'], ['status', 'Статус'], ['replies', 'Ответов'], ['website', 'Сайт'], ['info', 'Информация'], ['notes', 'Заметки']];
  const cell = (v) => { const s = String(v ?? ''); return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + [cols.map((c) => c[1]).join(';'), ...rows.map((r) => cols.map(([k]) => cell(r[k])).join(';'))].join('\r\n');
}

function saveTemplate(user, lang, kind, body) {
  if (!C.LANGS[lang]) throw new HttpError(400, 'Неизвестный язык');
  if (!['first', 'followup'].includes(kind)) throw new HttpError(400, 'Неизвестный тип шаблона');
  const subject = str(body.subject, 300); const text = str(body.body, 20000);
  if (!subject || !text) throw new HttpError(400, 'Нужны тема и текст письма');
  db.prepare('INSERT INTO templates (lang, kind, subject, body, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(lang, kind) DO UPDATE SET subject = excluded.subject, body = excluded.body, updated_at = excluded.updated_at')
    .run(lang, kind, subject, text, Date.now());
  logEvent(user.id, 'template', null, 'save', { lang, kind });
  return T.getTemplate(lang, kind);
}
function templatesOut() {
  const files = db.prepare('SELECT id, template_id, name, size FROM template_files').all();
  return db.prepare('SELECT * FROM templates ORDER BY lang, kind').all().map((t) => ({ ...t, files: files.filter((f) => f.template_id === t.id) }));
}
const ATTACH_OK = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx', 'application/msword': '.doc', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx' };
function addTemplateFile(user, id, body) {
  const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(id));
  if (!t) throw new HttpError(404, 'Шаблон не найден');
  const m = /^data:([^;]+);base64,(.+)$/s.exec(String(body.data || ''));
  if (!m || !ATTACH_OK[m[1]]) throw new HttpError(415, 'Можно прикрепить PDF, Word, PowerPoint, JPG или PNG');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) throw new HttpError(413, 'Вложение больше 8 МБ — письма с большими файлами чаще попадают в спам');
  const stored = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(FILE_DIR, stored), buf);
  db.prepare('INSERT INTO template_files (template_id, name, mime, stored, size) VALUES (?, ?, ?, ?, ?)').run(t.id, str(body.name, 150) || `file${ATTACH_OK[m[1]]}`, m[1], stored, buf.length);
  logEvent(user.id, 'template', t.id, 'add_file', { name: body.name });
  return templatesOut();
}

function users() { return db.prepare('SELECT id, login, name, active, created_at, last_login FROM users ORDER BY id').all(); }

// ---------- маршруты ----------
async function api(req, res, url) {
  const p = url.pathname; const m = req.method;
  const user = auth.userFromRequest(req);
  // защита от подделки запросов: все изменяющие запросы — только из нашего интерфейса
  if (m !== 'GET' && req.headers['x-gm'] !== '1') throw new HttpError(403, 'Запрос отклонён');
  const body = m === 'GET' ? {} : await readBody(req);
  const q = Object.fromEntries(url.searchParams);
  let r;

  if (p === '/api/meta' && m === 'GET') return { name: APP_NAME, version: VERSION, ai: ai.enabled(), test_mode: mailer.TEST_MODE, langs: C.LANGS, countries: C.countries(), vars: T.VARS };
  if (p === '/api/login' && m === 'POST') {
    if (auth.loginBlocked(body.login, req)) throw new HttpError(429, 'Слишком много попыток. Подождите 15 минут.');
    const out = auth.login(body.login, body.password, req);
    if (!out) throw new HttpError(401, 'Неверный логин или пароль');
    res.setHeader('Set-Cookie', auth.cookie(out.token, auth.SESSION_HOURS * 3600));
    return { user: publicUser(out.user) };
  }
  if (p === '/api/logout' && m === 'POST') {
    if (user) auth.destroySession(user.token);
    res.setHeader('Set-Cookie', auth.cookie('', 0));
    return { ok: true };
  }
  if (p === '/api/me' && m === 'GET') return { user: publicUser(user) };
  if (p === '/api/password' && m === 'POST') {
    if (!user) throw new HttpError(401, 'Войдите в систему');
    const full = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    if (!auth.verifyPassword(body.current, full.pass_hash)) throw new HttpError(400, 'Текущий пароль неверный');
    const prob = auth.passwordProblem(body.next); if (prob) throw new HttpError(400, prob);
    db.prepare('UPDATE users SET pass_hash = ?, must_change_pw = 0 WHERE id = ?').run(auth.hashPassword(body.next), user.id);
    auth.destroyUserSessions(user.id, user.token);
    logEvent(user.id, 'user', user.id, 'password');
    return { user: publicUser({ ...user, must_change_pw: 0 }) };
  }

  const u = needUser(user);

  if (p === '/api/home' && m === 'GET') return home();
  if (p === '/api/badges' && m === 'GET') return { unread: inbox.unreadCount(), queued: mailer.status().queued };

  // компании
  if (p === '/api/contacts' && m === 'GET') return K.list(q);
  if (p === '/api/contacts/facets' && m === 'GET') return K.facets();
  if (p === '/api/contacts.csv' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="companies-${new Date().toISOString().slice(0, 10)}.csv"`, ...SECURITY_HEADERS });
    res.end(exportCsv(q)); return undefined;
  }
  if (p === '/api/contacts/bulk' && m === 'POST') return K.bulk(u, body);
  if (p === '/api/contacts' && m === 'POST') {
    const email = str(body.email, 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw new HttpError(400, 'Некорректный адрес почты');
    if (db.prepare('SELECT 1 FROM contacts WHERE email = ?').get(email)) throw new HttpError(409, 'Такой адрес уже есть в базе');
    const country = /^[A-Z]{2}$/.test(body.country) ? body.country : C.findCountry(body.country) || C.countryFromEmail(email);
    const lang = C.LANGS[body.lang] ? body.lang : C.langOf(country) || 'en';
    const now = Date.now();
    const id = Number(db.prepare('INSERT INTO contacts (email, company, contact_name, country, country_raw, lang, website, info, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(email, str(body.company, 300) || email.split('@')[1], str(body.contact_name, 200), country, str(body.country_raw || C.countryName(country), 100), lang, str(body.website, 300), str(body.info, 5000), now, now).lastInsertRowid);
    logEvent(u.id, 'contact', id, 'create');
    return K.get(id);
  }
  if ((r = /^\/api\/contacts\/(\d+)$/.exec(p))) {
    if (m === 'GET') return K.get(r[1]);
    if (m === 'PUT') return K.update(u, r[1], body);
  }
  if ((r = /^\/api\/contacts\/(\d+)\/send$/.exec(p)) && m === 'POST') { const out = await mailer.sendManual(u, r[1], body); return { ...out, contact: K.get(r[1]) }; }
  if ((r = /^\/api\/contacts\/(\d+)\/queue$/.exec(p)) && m === 'POST') {
    return mailer.createCampaign(u, { name: str(body.name, 120) || 'Отдельное письмо', filter: { ids: r[1], status: K.STATUSES.join(',') }, followup_days: body.followup_days, fallback: body.fallback });
  }

  // импорт
  if (p === '/api/import/preview' && m === 'POST') return I.preview(u, body);
  if ((r = /^\/api\/import\/(\d+)\/mapping$/.exec(p)) && m === 'POST') return I.remap(r[1], body.mapping);
  if ((r = /^\/api\/import\/(\d+)\/commit$/.exec(p)) && m === 'POST') return I.commit(u, r[1], body.mapping);
  if (p === '/api/imports' && m === 'GET') return db.prepare("SELECT id, filename, created_at, total, added, dupes, invalid FROM imports WHERE status = 'done' ORDER BY id DESC LIMIT 50").all();

  // шаблоны
  if (p === '/api/templates' && m === 'GET') return templatesOut();
  if ((r = /^\/api\/templates\/([a-z]{2})\/(first|followup)$/.exec(p))) {
    if (m === 'PUT') { saveTemplate(u, r[1], r[2], body); return templatesOut(); }
    if (m === 'DELETE') {
      const t = T.getTemplate(r[1], r[2]);
      if (t) {
        for (const f of db.prepare('SELECT stored FROM template_files WHERE template_id = ?').all(t.id)) fs.rmSync(path.join(FILE_DIR, f.stored), { force: true });
        db.prepare('DELETE FROM templates WHERE id = ?').run(t.id);
        logEvent(u.id, 'template', t.id, 'delete', { lang: r[1], kind: r[2] });
      }
      return templatesOut();
    }
  }
  if (p === '/api/templates/preview' && m === 'POST') {
    const st = getSettings();
    const contact = body.contact_id ? db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(body.contact_id)) : null;
    const sample = contact || { company: 'Müller Recycling GmbH', contact_name: '', country_raw: 'Germany', country: 'DE', website: 'example.de' };
    return T.compose(sample, { subject: str(body.subject, 300), body: str(body.body, 20000), lang: body.lang || 'en' }, st);
  }
  if (p === '/api/templates/test' && m === 'POST') return mailer.sendTest(u, body);
  if ((r = /^\/api\/templates\/(\d+)\/files$/.exec(p)) && m === 'POST') return addTemplateFile(u, r[1], body);
  if ((r = /^\/api\/template-files\/(\d+)$/.exec(p)) && m === 'DELETE') {
    const f = db.prepare('SELECT * FROM template_files WHERE id = ?').get(Number(r[1]));
    if (f) { fs.rmSync(path.join(FILE_DIR, f.stored), { force: true }); db.prepare('DELETE FROM template_files WHERE id = ?').run(f.id); }
    return templatesOut();
  }

  // перевод
  if (p === '/api/ai/translate-template' && m === 'POST') return ai.translateTemplate(u, body);
  if (p === '/api/ai/translate-draft' && m === 'POST') return ai.translateDraft(u, body);
  if ((r = /^\/api\/messages\/(\d+)\/translate$/.exec(p)) && m === 'POST') return ai.translateMessage(u, r[1]);

  // рассылки
  if (p === '/api/campaigns' && m === 'GET') return mailer.campaigns();
  if (p === '/api/campaigns/preview' && m === 'POST') return mailer.previewCampaign(body);
  if (p === '/api/campaigns' && m === 'POST') return mailer.createCampaign(u, body);
  if ((r = /^\/api\/campaigns\/(\d+)\/status$/.exec(p)) && m === 'POST') return mailer.setCampaignStatus(u, r[1], body.status);
  if ((r = /^\/api\/campaigns\/(\d+)\/retry$/.exec(p)) && m === 'POST') return mailer.retryFailed(u, r[1]);
  if (p === '/api/queue' && m === 'GET') {
    return db.prepare(`SELECT m.id, m.kind, m.status, m.lang, m.scheduled_at, m.sent_at, m.error, m.campaign_id, c.company, c.email, c.country, m.contact_id
      FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE m.direction = 'out' AND m.campaign_id IS NOT NULL AND (m.status IN ('queued','failed') OR m.sent_at > ?)
      ORDER BY CASE m.status WHEN 'failed' THEN 0 WHEN 'sent' THEN 2 ELSE 1 END, CASE WHEN m.status = 'sent' THEN -m.sent_at ELSE COALESCE(m.scheduled_at, 0) END, m.id LIMIT 200`).all(Date.now() - 2 * 86400e3);
  }
  if (p === '/api/sender' && m === 'GET') return { sender: mailer.status(), inbox: inbox.status(), next_schedule: sched.nextUp() };

  // запланированные рассылки
  if (p === '/api/schedules' && m === 'GET') return sched.list();
  if (p === '/api/schedules' && m === 'POST') {
    if (!mailer.configured()) throw new HttpError(400, 'Сначала подключите почту в «Настройках»');
    return sched.create(u, body);
  }
  if ((r = /^\/api\/schedules\/(\d+)$/.exec(p)) && m === 'POST') return sched.update(u, r[1], body);
  if ((r = /^\/api\/schedules\/(\d+)\/run$/.exec(p)) && m === 'POST') return sched.runNow(u, r[1]);
  if (p === '/api/sender' && m === 'POST') {
    if (body.enabled && !mailer.configured()) throw new HttpError(400, 'Сначала подключите почту в «Настройках»');
    setSetting('sending_enabled', body.enabled ? 1 : 0);
    if (body.enabled) { mailer._resetDelay(); require('./db').setState('sender_error', ''); }
    logEvent(u.id, 'sender', null, body.enabled ? 'start' : 'pause');
    return { sender: mailer.status() };
  }
  if (p === '/api/sender/next' && m === 'POST') {
    if (!mailer.configured()) throw new HttpError(400, 'Сначала подключите почту в «Настройках»');
    const out = await mailer.tick({ force: true });
    if (!out) throw new HttpError(409, 'В очереди нет писем, готовых к отправке');
    return { result: out, sender: mailer.status() };
  }

  // входящие
  if (p === '/api/inbox' && m === 'GET') return inbox.list(q);
  if (p === '/api/inbox/check' && m === 'POST') return { ...(await inbox.poll({ manual: true })), inbox: inbox.status() };
  if ((r = /^\/api\/messages\/(\d+)\/read$/.exec(p)) && m === 'POST') {
    db.prepare("UPDATE messages SET unread = ? WHERE id = ? AND direction = 'in'").run(body.unread ? 1 : 0, Number(r[1]));
    return { ok: true };
  }
  if (p === '/api/inbox/read-all' && m === 'POST') { db.exec("UPDATE messages SET unread = 0 WHERE direction = 'in'"); return { ok: true }; }
  if ((r = /^\/api\/files\/(\d+)$/.exec(p)) && m === 'GET') {
    const f = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(r[1]));
    if (!f) throw new HttpError(404, 'Файл не найден');
    const fp = path.join(FILE_DIR, f.stored);
    if (!fs.existsSync(fp)) throw new HttpError(404, 'Файл не найден');
    const safe = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(f.mime);
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': safe ? f.mime : 'application/octet-stream', 'Content-Disposition': `${safe ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" });
    fs.createReadStream(fp).pipe(res); return undefined;
  }

  // настройки
  if (p === '/api/settings' && m === 'GET') return settingsOut();
  if (p === '/api/settings' && m === 'PUT') return saveSettings(u, body);
  if (p === '/api/settings/test' && m === 'POST') {
    const st = getSettings();
    if (!mailer.TEST_MODE && (!st.mail_user || !st.mail_pass)) throw new HttpError(400, 'Укажите адрес почты и пароль приложения');
    const out = { smtp: null, imap: null };
    try { await mailer.testSmtp(st); out.smtp = 'ok'; } catch (e) { out.smtp = String(e.response || e.message || e).slice(0, 300); }
    try { const s = await inbox.testImap(st); out.imap = 'ok'; out.messages = s.messages; } catch (e) { out.imap = String(e.responseText || e.message || e).slice(0, 300); }
    return out;
  }
  if (p === '/api/users' && m === 'GET') return users();
  if (p === '/api/users' && m === 'POST') {
    const login = str(body.login, 40); const name = str(body.name, 100);
    if (!/^[\p{L}\d._-]{3,40}$/u.test(login)) throw new HttpError(400, 'Логин — от 3 символов: буквы, цифры, точка, дефис');
    if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) throw new HttpError(409, 'Такой логин уже есть');
    const pw = auth.randomPassword();
    const id = Number(db.prepare('INSERT INTO users (login, name, pass_hash, must_change_pw, created_at) VALUES (?, ?, ?, 1, ?)').run(login, name || login, auth.hashPassword(pw), Date.now()).lastInsertRowid);
    logEvent(u.id, 'user', id, 'create', { login });
    return { users: users(), password: pw, login };
  }
  if ((r = /^\/api\/users\/(\d+)\/(reset|toggle)$/.exec(p)) && m === 'POST') {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r[1]));
    if (!target) throw new HttpError(404, 'Пользователь не найден');
    if (target.id === u.id) throw new HttpError(400, 'Это ваша учётная запись — смените пароль в профиле');
    let pw;
    if (r[2] === 'reset') { pw = auth.randomPassword(); db.prepare('UPDATE users SET pass_hash = ?, must_change_pw = 1 WHERE id = ?').run(auth.hashPassword(pw), target.id); }
    else db.prepare('UPDATE users SET active = 1 - active WHERE id = ?').run(target.id);
    auth.destroyUserSessions(target.id);
    logEvent(u.id, 'user', target.id, r[2]);
    return { users: users(), password: pw, login: target.login };
  }
  if (p === '/api/journal' && m === 'GET') {
    return db.prepare('SELECT e.*, u.name user_name FROM events e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.id DESC LIMIT 300').all();
  }
  throw new HttpError(404, 'Не найдено');
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }); return res.end('Не найдено');
  }
  const ext = path.extname(file);
  const type = MIME[ext] || 'application/octet-stream';
  const raw = fs.readFileSync(file);
  const h = { 'Content-Type': type, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300', ...SECURITY_HEADERS };
  if (/text|javascript|json|svg/.test(type) && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    res.writeHead(200, { ...h, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    return res.end(zlib.gzipSync(raw));
  }
  res.writeHead(200, h); res.end(raw);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);
  try {
    const out = await api(req, res, url);
    if (out !== undefined && !res.headersSent) send(res, 200, out, req);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status >= 500 && !e.status ? 'Ошибка сервера' : e.message }, req);
  }
});

bootstrap();
if (process.env.DEMO === '1') require('./demo').seed();
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`${APP_NAME}: http://localhost:${PORT}${mailer.TEST_MODE ? '  (тестовый режим — письма никуда не уходят)' : ''}`);
    mailer.start();
    inbox.start();
    sched.start();
  });
}

module.exports = { server };
