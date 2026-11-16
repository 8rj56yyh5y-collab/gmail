'use strict';
// Отправка писем: очередь рассылки с паузами и дневным лимитом, напоминания, ответы из системы, пересылка ответов.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const { db, FILE_DIR, logEvent, getSettings, setSetting, getState, setState } = require('./db');
const T = require('./templates');
const K = require('./contacts');
const C = require('./countries');

const { HttpError, str } = K;
const TEST_MODE = process.env.MAIL_TRANSPORT === 'json'; // тесты и демо: письма никуда не уходят
const outbox = []; // в тестовом режиме сюда складываются «отправленные» письма

// ---------- транспорт ----------
let cached = { key: '', t: null };
function transport(st = getSettings()) {
  if (TEST_MODE) {
    if (!cached.t || cached.key !== 'json') cached = { key: 'json', t: nodemailer.createTransport({ jsonTransport: true }) };
    return cached.t;
  }
  if (!st.mail_user || !st.mail_pass) throw new HttpError(400, 'Почта не подключена — укажите адрес и пароль приложения в «Настройках»');
  const key = [st.smtp_host, st.smtp_port, st.smtp_secure, st.mail_user, st.mail_pass].join('|');
  if (cached.key !== key) {
    cached = { key, t: nodemailer.createTransport({
      host: st.smtp_host, port: Number(st.smtp_port), secure: !!Number(st.smtp_secure),
      auth: { user: st.mail_user, pass: st.mail_pass }, connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 60000,
    }) };
  }
  return cached.t;
}
const configured = (st = getSettings()) => TEST_MODE || !!(st.mail_user && st.mail_pass);
const fromAddr = (st) => (st.from_name ? { name: st.from_name, address: st.mail_user || 'demo@example.com' } : (st.mail_user || 'demo@example.com'));
const domainOf = (st) => String(st.mail_user || 'gobsek.local').split('@')[1] || 'gobsek.local';
const newMessageId = (st, id) => `<gm-${id}-${crypto.randomBytes(6).toString('hex')}@${domainOf(st)}>`;

async function deliver(mail) {
  const st = getSettings();
  const info = await transport(st).sendMail({ from: fromAddr(st), replyTo: st.reply_to || undefined, ...mail });
  if (TEST_MODE) outbox.push({ ...mail, raw: info.message });
  return info;
}

// ---------- окно отправки и лимит ----------
function localTime(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date());
    return { hour: Number(parts.find((p) => p.type === 'hour').value), weekday: parts.find((p) => p.type === 'weekday').value };
  } catch { const d = new Date(); return { hour: d.getHours(), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] }; }
}
function inWindow(st) {
  const { hour, weekday } = localTime(st.timezone);
  if (Number(st.weekdays_only) && (weekday === 'Sat' || weekday === 'Sun')) return false;
  const from = Number(st.window_from); const to = Number(st.window_to);
  if (from === to) return true;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}
const sent24h = () => db.prepare("SELECT COUNT(*) n FROM messages WHERE direction = 'out' AND status = 'sent' AND kind IN ('first','followup') AND sent_at > ?").get(Date.now() - 24 * 3600e3).n;

// ---------- очередь ----------
let nextAt = 0; let busy = false; let lastTickError = '';
const rand = (a, b) => a + Math.random() * Math.max(0, b - a);

function nextQueued(now = Date.now()) {
  return db.prepare(`SELECT m.* FROM messages m JOIN campaigns c ON c.id = m.campaign_id
    WHERE m.status = 'queued' AND m.direction = 'out' AND c.status = 'running' AND COALESCE(m.scheduled_at, 0) <= ?
    ORDER BY COALESCE(m.scheduled_at, 0), m.id LIMIT 1`).get(now);
}

async function tick({ force = false } = {}) {
  if (busy) return null;
  const st = getSettings();
  if (!force) {
    if (!Number(st.sending_enabled) || !configured(st)) return null;
    if (Date.now() < nextAt) return null;
    if (!inWindow(st)) return null;
    if (sent24h() >= Number(st.daily_limit)) return null;
  }
  const m = nextQueued();
  if (!m) { finishCampaigns(); return null; }
  busy = true;
  try {
    const r = await sendQueued(m, st);
    nextAt = Date.now() + rand(Number(st.delay_min), Number(st.delay_max)) * 1000;
    return r;
  } finally { busy = false; }
}

function finishCampaigns() {
  db.exec(`UPDATE campaigns SET status = 'done' WHERE status = 'running'
    AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.campaign_id = campaigns.id AND m.status = 'queued')`);
}

async function sendQueued(m, st) {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(m.contact_id);
  const camp = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(m.campaign_id);
  const cancel = (why) => { db.prepare("UPDATE messages SET status = 'cancelled', error = ? WHERE id = ?").run(why, m.id); return { id: m.id, cancelled: why }; };
  if (!contact) return cancel('компания удалена');
  if (['unsubscribed', 'bounced', 'blocked'].includes(contact.status)) return cancel('компания в стоп-листе');
  if (m.kind === 'followup' && contact.last_reply_at) return cancel('компания уже ответила');

  let parent = null;
  if (m.kind === 'followup') {
    parent = db.prepare('SELECT * FROM messages WHERE id = ?').get(m.parent_id);
    if (!parent || parent.status !== 'sent') return cancel('первое письмо не отправлено');
  }
  const tpl = T.pickTemplate(m.lang || contact.lang, m.kind, camp ? camp.fallback : st.fallback_lang);
  if (!tpl) {
    if (m.kind === 'followup') return cancel('нет шаблона напоминания на этом языке');
    db.prepare("UPDATE messages SET status = 'failed', error = ? WHERE id = ?").run(`Нет шаблона на языке «${C.LANGS[m.lang] || m.lang}»`, m.id);
    return { id: m.id, failed: 'no template' };
  }
  const mail = T.compose(contact, tpl, st, { followupOf: parent });
  const messageId = newMessageId(st, m.id);
  const files = db.prepare('SELECT * FROM template_files WHERE template_id = ?').all(tpl.id);
  const unsubTo = st.reply_to || st.mail_user;
  try {
    await deliver({
      to: contact.contact_name ? { name: contact.contact_name, address: contact.email } : contact.email,
      subject: mail.subject, text: mail.text, html: mail.html, messageId,
      inReplyTo: parent ? parent.message_id : undefined,
      references: parent ? [parent.refs, parent.message_id].filter(Boolean).join(' ') : undefined,
      headers: unsubTo ? { 'List-Unsubscribe': `<mailto:${unsubTo}?subject=unsubscribe>` } : {},
      attachments: files.map((f) => ({ filename: f.name, path: path.join(FILE_DIR, f.stored), contentType: f.mime })),
    });
  } catch (e) {
    return onSendError(m, contact, e);
  }
  const now = Date.now();
  db.prepare(`UPDATE messages SET status = 'sent', subject = ?, body_text = ?, lang = ?, message_id = ?, in_reply_to = ?, refs = ?, from_addr = ?, to_addr = ?, sent_at = ?, error = '', attempts = attempts + 1 WHERE id = ?`)
    .run(mail.subject, mail.text, tpl.lang, messageId, parent ? parent.message_id : '', parent ? [parent.refs, parent.message_id].filter(Boolean).join(' ') : '', st.mail_user || '', contact.email, now, m.id);
  db.prepare("UPDATE contacts SET status = CASE WHEN status IN ('new','queued') THEN 'sent' ELSE status END, last_sent_at = ?, updated_at = ? WHERE id = ?").run(now, now, contact.id);
  if (m.kind === 'first' && camp && camp.followup_days > 0) {
    db.prepare(`INSERT INTO messages (contact_id, campaign_id, direction, kind, status, lang, parent_id, scheduled_at, to_addr, created_at)
      VALUES (?, ?, 'out', 'followup', 'queued', ?, ?, ?, ?, ?)`).run(contact.id, camp.id, tpl.lang, m.id, now + camp.followup_days * 86400e3, contact.email, now);
  }
  setState('sender_error', '');
  finishCampaigns();
  return { id: m.id, sent: true, to: contact.email, lang: tpl.lang };
}

function onSendError(m, contact, e) {
  const code = Number(e.responseCode) || 0;
  const msg = String(e.response || e.message || e).slice(0, 300);
  // Неверный логин/пароль — останавливаем всю рассылку, иначе почтовый сервис заблокирует ящик.
  if (e.code === 'EAUTH' || code === 535 || code === 534) {
    setSetting('sending_enabled', 0);
    setState('sender_error', `Почта не приняла логин или пароль. Рассылка остановлена. ${msg}`);
    db.prepare("UPDATE messages SET error = ? WHERE id = ?").run(msg, m.id);
    return { id: m.id, error: 'auth' };
  }
  // Адрес не существует / отклонён — письмо не повторяем, компанию помечаем.
  if (code >= 550 && code < 560 && /recipient|mailbox|user|address|unknown|does not exist|not found|invalid/i.test(msg)) {
    db.prepare("UPDATE messages SET status = 'failed', error = ?, attempts = attempts + 1 WHERE id = ?").run(msg, m.id);
    db.prepare("UPDATE contacts SET status = 'bounced', updated_at = ? WHERE id = ?").run(Date.now(), contact.id);
    return { id: m.id, error: 'rejected' };
  }
  // Лимит почтового сервиса (Gmail: 550 5.4.5 / 421 4.7.0) — ставим рассылку на паузу.
  if (/limit|quota|rate|too many/i.test(msg)) {
    setSetting('sending_enabled', 0);
    setState('sender_error', `Почтовый сервис сообщил о превышении лимита — рассылка на паузе. Включите завтра или уменьшите дневной лимит. ${msg}`);
    db.prepare("UPDATE messages SET error = ? WHERE id = ?").run(msg, m.id);
    return { id: m.id, error: 'limit' };
  }
  // Временная ошибка — пробуем ещё 2 раза с паузой.
  const attempts = (m.attempts || 0) + 1;
  if (attempts >= 3) db.prepare("UPDATE messages SET status = 'failed', error = ?, attempts = ? WHERE id = ?").run(msg, attempts, m.id);
  else db.prepare('UPDATE messages SET error = ?, attempts = ?, scheduled_at = ? WHERE id = ?').run(msg, attempts, Date.now() + 10 * 60e3, m.id);
  setState('sender_error', `Ошибка отправки: ${msg}`);
  nextAt = Date.now() + 2 * 60e3;
  return { id: m.id, error: 'temporary' };
}

// ---------- рассылки ----------
function audience(filter) {
  const f = { ...filter };
  if (!f.status) f.status = 'new';
  const { sql, params } = K.where(f);
  let extra = "c.status NOT IN ('unsubscribed','bounced','blocked') AND NOT EXISTS (SELECT 1 FROM messages q WHERE q.contact_id = c.id AND q.status = 'queued')";
  // для повторяющихся рассылок: не писать тем, кому уже писали за последние N дней
  const gap = Math.max(0, Math.min(365, Number(f.gap_days) || 0));
  if (gap) { extra += ' AND (c.last_sent_at IS NULL OR c.last_sent_at < ?)'; params.push(Date.now() - gap * 86400e3); }
  return db.prepare(`SELECT c.id, c.lang, c.email FROM contacts c ${sql ? `${sql} AND ${extra}` : `WHERE ${extra}`}`).all(...params);
}

// Предпросмотр: сколько писем и на каких языках уйдёт
function previewCampaign(body) {
  const st = getSettings();
  const fallback = body.fallback === 'skip' ? 'skip' : (body.fallback || st.fallback_lang || 'en');
  const list = audience(body.filter || {});
  const byLang = {};
  for (const c of list) {
    const has = !!T.getTemplate(c.lang, 'first');
    const use = has ? c.lang : (fallback !== 'skip' && T.getTemplate(fallback, 'first') ? fallback : null);
    const k = c.lang;
    byLang[k] = byLang[k] || { lang: k, name: C.LANGS[k] || k, count: 0, template: has, send_as: use, followup: !!(use && T.getTemplate(use, 'followup')) };
    byLang[k].count++;
  }
  const langs = Object.values(byLang).sort((a, b) => b.count - a.count);
  const willSend = langs.filter((l) => l.send_as).reduce((s, l) => s + l.count, 0);
  const perDay = Math.max(1, Number(st.daily_limit));
  return { total: list.length, will_send: willSend, skipped: list.length - willSend, langs, days: Math.ceil(willSend / perDay), daily_limit: perDay, fallback };
}

function createCampaign(user, body) {
  const st = getSettings();
  const p = previewCampaign(body);
  if (!p.will_send) throw new HttpError(400, 'Некому отправлять: нет подходящих компаний или нет шаблонов на их языках');
  const name = str(body.name, 120) || `Рассылка от ${new Date().toLocaleDateString('ru-RU')}`;
  const followup = Math.max(0, Math.min(60, Math.round(Number(body.followup_days) || 0)));
  const now = Date.now();
  const sendAs = Object.fromEntries(p.langs.map((l) => [l.lang, l.send_as]));
  db.exec('BEGIN');
  let campaignId;
  try {
    campaignId = Number(db.prepare('INSERT INTO campaigns (name, status, followup_days, fallback, filter_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, 'running', followup, p.fallback, JSON.stringify(body.filter || {}), user.id, now).lastInsertRowid);
    const ins = db.prepare("INSERT INTO messages (contact_id, campaign_id, direction, kind, status, lang, to_addr, created_at) VALUES (?, ?, 'out', 'first', 'queued', ?, ?, ?)");
    const upd = db.prepare("UPDATE contacts SET status = CASE WHEN status = 'new' THEN 'queued' ELSE status END, updated_at = ? WHERE id = ?");
    for (const c of audience(body.filter || {})) {
      const lang = sendAs[c.lang];
      if (!lang) continue;
      ins.run(c.id, campaignId, lang, c.email, now);
      upd.run(now, c.id);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logEvent(user.id, 'campaign', campaignId, 'create', { count: p.will_send, followup });
  if (body.start_now !== false && !Number(st.sending_enabled)) setSetting('sending_enabled', 1);
  return { id: campaignId, queued: p.will_send };
}

function campaigns() {
  return db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM messages m WHERE m.campaign_id = c.id AND m.kind = 'first') total,
      (SELECT COUNT(*) FROM messages m WHERE m.campaign_id = c.id AND m.kind = 'first' AND m.status = 'sent') sent,
      (SELECT COUNT(*) FROM messages m WHERE m.campaign_id = c.id AND m.status = 'queued') queued,
      (SELECT COUNT(*) FROM messages m WHERE m.campaign_id = c.id AND m.kind = 'followup' AND m.status = 'sent') followups,
      (SELECT COUNT(*) FROM messages m WHERE m.campaign_id = c.id AND m.status = 'failed') failed,
      (SELECT COUNT(DISTINCT m.contact_id) FROM messages m JOIN contacts k ON k.id = m.contact_id WHERE m.campaign_id = c.id AND m.status = 'sent' AND k.last_reply_at > m.sent_at) replied
    FROM campaigns c ORDER BY c.id DESC LIMIT 100`).all();
}

function setCampaignStatus(user, id, status) {
  const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(Number(id));
  if (!c) throw new HttpError(404, 'Рассылка не найдена');
  if (!['running', 'paused', 'cancelled'].includes(status)) throw new HttpError(400, 'Неизвестное действие');
  if (c.status === 'cancelled' || (c.status === 'done' && status !== 'cancelled')) throw new HttpError(409, 'Рассылка уже завершена');
  db.prepare('UPDATE campaigns SET status = ? WHERE id = ?').run(status, c.id);
  if (status === 'cancelled') {
    const ids = db.prepare("SELECT DISTINCT contact_id FROM messages WHERE campaign_id = ? AND status = 'queued'").all(c.id).map((r) => r.contact_id);
    db.prepare("UPDATE messages SET status = 'cancelled', error = 'рассылка отменена' WHERE campaign_id = ? AND status = 'queued'").run(c.id);
    const back = db.prepare("UPDATE contacts SET status = 'new' WHERE id = ? AND status = 'queued'");
    for (const cid of ids) back.run(cid);
  }
  logEvent(user.id, 'campaign', c.id, status);
  return { ok: true };
}

function retryFailed(user, id) {
  const n = Number(db.prepare("UPDATE messages SET status = 'queued', error = '', attempts = 0, scheduled_at = NULL WHERE campaign_id = ? AND status = 'failed' AND kind = 'first' AND contact_id IN (SELECT id FROM contacts WHERE status NOT IN ('bounced','unsubscribed','blocked'))").run(Number(id)).changes);
  if (n) db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ? AND status = 'done'").run(Number(id));
  logEvent(user.id, 'campaign', Number(id), 'retry', { count: n });
  return { queued: n };
}

function status() {
  const st = getSettings();
  const queued = db.prepare(`SELECT COUNT(*) n FROM messages m JOIN campaigns c ON c.id = m.campaign_id WHERE m.status = 'queued' AND c.status = 'running'`).get().n;
  const due = db.prepare(`SELECT COUNT(*) n FROM messages m JOIN campaigns c ON c.id = m.campaign_id WHERE m.status = 'queued' AND c.status = 'running' AND COALESCE(m.scheduled_at,0) <= ?`).get(Date.now()).n;
  const s24 = sent24h();
  let reason = '';
  if (!configured(st)) reason = 'Почта не подключена';
  else if (!Number(st.sending_enabled)) reason = 'Рассылка на паузе';
  else if (!due) reason = queued ? 'Ждём срока напоминаний' : 'Очередь пуста';
  else if (s24 >= Number(st.daily_limit)) reason = 'Дневной лимит исчерпан — продолжим автоматически';
  else if (!inWindow(st)) reason = `Вне рабочего времени (${st.window_from}:00–${st.window_to}:00${Number(st.weekdays_only) ? ', пн–пт' : ''}, ${st.timezone})`;
  return {
    enabled: !!Number(st.sending_enabled), configured: configured(st), test_mode: TEST_MODE, queued, due, sent_24h: s24, daily_limit: Number(st.daily_limit),
    in_window: inWindow(st), next_at: reason ? null : Math.max(Date.now(), nextAt), waiting: reason, error: getState('sender_error'),
  };
}

// ---------- ручное письмо / ответ компании ----------
async function sendManual(user, contactId, body) {
  const st = getSettings();
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(contactId));
  if (!contact) throw new HttpError(404, 'Компания не найдена');
  const text = str(body.text, 50000);
  if (!text) throw new HttpError(400, 'Напишите текст письма');
  let parent = null;
  if (body.reply_to) parent = db.prepare('SELECT * FROM messages WHERE id = ? AND contact_id = ?').get(Number(body.reply_to), contact.id);
  if (!parent) parent = db.prepare("SELECT * FROM messages WHERE contact_id = ? AND message_id IS NOT NULL AND status IN ('sent','received') ORDER BY id DESC LIMIT 1").get(contact.id);
  const subject = str(body.subject, 300) || (parent ? (/^re:/i.test(parent.subject) ? parent.subject : `Re: ${parent.subject}`) : '');
  if (!subject) throw new HttpError(400, 'Укажите тему письма');
  const now = Date.now();
  const id = Number(db.prepare(`INSERT INTO messages (contact_id, direction, kind, status, lang, subject, body_text, to_addr, parent_id, created_at)
    VALUES (?, 'out', ?, 'queued', ?, ?, ?, ?, ?, ?)`).run(contact.id, parent ? 'reply' : 'manual', str(body.lang, 5) || contact.lang, subject, text, contact.email, parent ? parent.id : null, now).lastInsertRowid);
  const messageId = newMessageId(st, id);
  const refs = parent ? [parent.refs, parent.message_id].filter(Boolean).join(' ').split(/\s+/).slice(-20).join(' ') : '';
  const quote = parent && parent.direction === 'in' ? `\n\n${new Date(parent.received_at || parent.created_at).toUTCString()}, ${parent.from_name || parent.from_addr}:\n${(parent.body_text || '').split('\n').map((l) => `> ${l}`).join('\n')}` : '';
  try {
    await deliver({
      to: contact.email, subject, text: text + quote, html: T.toHtml(text), messageId,
      inReplyTo: parent ? parent.message_id : undefined, references: refs || undefined,
    });
  } catch (e) {
    db.prepare("UPDATE messages SET status = 'failed', error = ? WHERE id = ?").run(String(e.message || e).slice(0, 300), id);
    throw new HttpError(502, `Письмо не отправлено: ${e.message || e}`);
  }
  db.prepare("UPDATE messages SET status = 'sent', message_id = ?, in_reply_to = ?, refs = ?, from_addr = ?, sent_at = ? WHERE id = ?")
    .run(messageId, parent ? parent.message_id || '' : '', refs, st.mail_user || '', Date.now(), id);
  db.prepare("UPDATE contacts SET status = CASE WHEN status IN ('new','queued') THEN 'sent' ELSE status END, last_sent_at = ?, updated_at = ? WHERE id = ?").run(Date.now(), Date.now(), contact.id);
  logEvent(user.id, 'message', id, parent ? 'reply' : 'manual', { to: contact.email });
  return { id };
}

// ---------- пересылка ответа на рабочую почту ----------
async function forwardReply(msgId) {
  const st = getSettings();
  const to = String(st.forward_to || '').trim();
  if (!to) return false;
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
  const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(m.contact_id);
  const att = db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(m.id);
  const head = [
    `Ответила компания: ${c.company}`,
    `Страна: ${C.countryName(c.country) || c.country_raw || '—'} · язык письма: ${C.LANGS[c.lang] || c.lang}`,
    `От: ${m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr}`,
    m.unsubscribe ? 'Компания просит больше не писать — она добавлена в стоп-лист.' : '',
    'Чтобы ответить компании, просто нажмите «Ответить» — письмо уйдёт ей напрямую.',
  ].filter(Boolean).join('\n');
  const body = `${head}\n\n────────────────────────\n${m.full_text || m.body_text}`;
  await deliver({
    to, subject: `[Ответ] ${c.company}${c.country ? ` (${c.country})` : ''}: ${m.subject}`.slice(0, 300),
    replyTo: m.from_name ? { name: m.from_name, address: m.from_addr } : m.from_addr,
    text: body, html: T.toHtml(body),
    attachments: att.map((a) => ({ filename: a.name, path: path.join(FILE_DIR, a.stored), contentType: a.mime })),
  });
  db.prepare('UPDATE messages SET forwarded = 1 WHERE id = ?').run(m.id);
  return true;
}

async function testSmtp(st) {
  if (TEST_MODE) return { ok: true, test: true };
  const t = nodemailer.createTransport({ host: st.smtp_host, port: Number(st.smtp_port), secure: !!Number(st.smtp_secure), auth: { user: st.mail_user, pass: st.mail_pass }, connectionTimeout: 15000 });
  await t.verify();
  return { ok: true };
}

async function sendTest(user, { to, lang }) {
  const st = getSettings();
  const addr = str(to, 200) || st.mail_user;
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(addr)) throw new HttpError(400, 'Укажите адрес для проверки');
  const tpl = T.pickTemplate(lang || 'en', 'first', 'en');
  if (!tpl) throw new HttpError(404, 'Нет шаблона');
  const sample = { company: 'Example GmbH', contact_name: '', country_raw: 'Germany', country: 'DE', website: 'example.com' };
  const mail = T.compose(sample, tpl, st);
  await deliver({ to: addr, subject: `[Проверка] ${mail.subject}`, text: mail.text, html: mail.html, messageId: newMessageId(st, `t${Date.now()}`) });
  logEvent(user.id, 'template', tpl.id, 'test_send', { to: addr });
  return { ok: true, to: addr };
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch((e) => { lastTickError = String(e.message || e); console.error('Отправка:', lastTickError); }); }, 3000);
  timer.unref();
}

module.exports = { start, tick, status, deliver, transport, configured, previewCampaign, createCampaign, campaigns, setCampaignStatus, retryFailed, sendManual, forwardReply, testSmtp, sendTest, inWindow, outbox, TEST_MODE, _resetDelay: () => { nextAt = 0; } };
