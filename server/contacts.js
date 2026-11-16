'use strict';
// Компании: список с фильтрами, карточка, правка, статистика.
const { db, logEvent } = require('./db');
const C = require('./countries');

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);

const STATUSES = ['new', 'queued', 'sent', 'replied', 'bounced', 'unsubscribed', 'blocked'];
const csv = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);

// Фильтр → SQL. Используется и в списке, и при запуске рассылки.
function where(f = {}) {
  const w = []; const p = [];
  const statuses = csv(f.status).filter((s) => STATUSES.includes(s));
  if (statuses.length) { w.push(`c.status IN (${statuses.map(() => '?').join(',')})`); p.push(...statuses); }
  const langs = csv(f.lang).filter((l) => /^[a-z]{2}$/.test(l));
  if (langs.length) { w.push(`c.lang IN (${langs.map(() => '?').join(',')})`); p.push(...langs); }
  const countries = csv(f.country).filter((x) => /^([A-Z]{2}|-)$/.test(x));
  if (countries.length) { w.push(`c.country IN (${countries.map((x) => (x === '-' ? "''" : '?')).join(',')})`); p.push(...countries.filter((x) => x !== '-')); }
  if (f.import_id) { w.push('c.import_id = ?'); p.push(Number(f.import_id)); }
  const ids = csv(f.ids).map(Number).filter(Number.isInteger);
  if (ids.length) { w.push(`c.id IN (${ids.map(() => '?').join(',')})`); p.push(...ids); }
  const q = str(f.q, 100).toLowerCase();
  if (q) { w.push('(lower(c.company) LIKE ? OR lower(c.email) LIKE ? OR lower(c.contact_name) LIKE ? OR lower(c.info) LIKE ?)'); p.push(...Array(4).fill(`%${q}%`)); }
  return { sql: w.length ? `WHERE ${w.join(' AND ')}` : '', params: p };
}

function list(f = {}) {
  const { sql, params } = where(f);
  const limit = Math.min(500, Math.max(1, Number(f.limit) || 100));
  const offset = Math.max(0, Number(f.offset) || 0);
  const total = db.prepare(`SELECT COUNT(*) n FROM contacts c ${sql}`).get(...params).n;
  const order = { company: 'c.company COLLATE NOCASE', country: "c.country = '', c.country, c.company COLLATE NOCASE", recent: 'COALESCE(c.last_reply_at, c.last_sent_at, c.created_at) DESC' }[f.sort] || 'c.id DESC';
  const rows = db.prepare(`SELECT c.id, c.email, c.company, c.contact_name, c.country, c.country_raw, c.lang, c.status, c.last_sent_at, c.last_reply_at, c.created_at,
      (SELECT COUNT(*) FROM messages m WHERE m.contact_id = c.id AND m.direction = 'in' AND m.kind = 'reply') replies
    FROM contacts c ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return { total, rows, limit, offset };
}

function get(id) {
  const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(id));
  if (!c) throw new HttpError(404, 'Компания не найдена');
  c.messages = db.prepare(`SELECT id, direction, kind, status, lang, subject, body_text, full_text, from_addr, from_name, to_addr, scheduled_at, sent_at, received_at, error, unread, unsubscribe, translation, forwarded, created_at, campaign_id
    FROM messages WHERE contact_id = ? ORDER BY COALESCE(sent_at, received_at, scheduled_at, created_at), id`).all(c.id);
  const att = db.prepare('SELECT id, message_id, name, size FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE contact_id = ?)').all(c.id);
  for (const m of c.messages) m.attachments = att.filter((a) => a.message_id === m.id);
  return c;
}

function update(user, id, body) {
  const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(id));
  if (!c) throw new HttpError(404, 'Компания не найдена');
  const next = { ...c };
  for (const k of ['company', 'contact_name', 'website', 'notes', 'info', 'country_raw']) if (body[k] !== undefined) next[k] = str(body[k], k === 'info' || k === 'notes' ? 5000 : 300);
  if (body.email !== undefined) {
    const e = str(body.email, 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e)) throw new HttpError(400, 'Некорректный адрес почты');
    if (e !== c.email && db.prepare('SELECT 1 FROM contacts WHERE email = ? AND id != ?').get(e, c.id)) throw new HttpError(409, 'Такой адрес уже есть в базе');
    next.email = e;
  }
  if (body.country !== undefined) next.country = /^[A-Z]{2}$/.test(body.country) ? body.country : '';
  if (body.lang !== undefined) { if (!C.LANGS[body.lang]) throw new HttpError(400, 'Неизвестный язык'); next.lang = body.lang; }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) throw new HttpError(400, 'Неизвестный статус');
    next.status = body.status;
    if (['unsubscribed', 'blocked', 'bounced'].includes(body.status)) cancelQueued(c.id, 'компания в стоп-листе');
  }
  db.prepare(`UPDATE contacts SET email = ?, company = ?, contact_name = ?, website = ?, notes = ?, info = ?, country = ?, country_raw = ?, lang = ?, status = ?, updated_at = ? WHERE id = ?`)
    .run(next.email, next.company, next.contact_name, next.website, next.notes, next.info, next.country, next.country_raw, next.lang, next.status, Date.now(), c.id);
  logEvent(user.id, 'contact', c.id, 'update', Object.fromEntries(Object.keys(body).map((k) => [k, body[k]])));
  return get(c.id);
}

function cancelQueued(contactId, reason) {
  return Number(db.prepare("UPDATE messages SET status = 'cancelled', error = ? WHERE contact_id = ? AND status = 'queued'").run(reason, contactId).changes);
}

// Массовые действия над выбранными компаниями
function bulk(user, { ids, action, lang }) {
  const list = csv(ids).map(Number).filter(Number.isInteger).slice(0, 10000);
  if (!list.length) throw new HttpError(400, 'Ничего не выбрано');
  const ph = list.map(() => '?').join(',');
  let n = 0;
  if (action === 'lang') {
    if (!C.LANGS[lang]) throw new HttpError(400, 'Неизвестный язык');
    n = Number(db.prepare(`UPDATE contacts SET lang = ?, updated_at = ? WHERE id IN (${ph})`).run(lang, Date.now(), ...list).changes);
  } else if (action === 'block') {
    n = Number(db.prepare(`UPDATE contacts SET status = 'blocked', updated_at = ? WHERE id IN (${ph})`).run(Date.now(), ...list).changes);
    db.prepare(`UPDATE messages SET status = 'cancelled', error = 'компания в стоп-листе' WHERE status = 'queued' AND contact_id IN (${ph})`).run(...list);
  } else if (action === 'reset') {
    n = Number(db.prepare(`UPDATE contacts SET status = 'new', updated_at = ? WHERE status IN ('blocked','sent','queued') AND id IN (${ph})`).run(Date.now(), ...list).changes);
    db.prepare(`UPDATE messages SET status = 'cancelled', error = 'сброшено вручную' WHERE status = 'queued' AND contact_id IN (${ph})`).run(...list);
  } else if (action === 'delete') {
    // компании с перепиской не удаляем — чтобы не потерять ответы
    n = Number(db.prepare(`DELETE FROM contacts WHERE id IN (${ph}) AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = contacts.id AND m.status IN ('sent','received'))`).run(...list).changes);
  } else throw new HttpError(400, 'Неизвестное действие');
  logEvent(user.id, 'contact', null, `bulk_${action}`, { count: n });
  return { changed: n };
}

// Сводка для фильтров: какие страны/языки/статусы есть в базе
function facets() {
  return {
    statuses: db.prepare('SELECT status k, COUNT(*) n FROM contacts GROUP BY status').all(),
    langs: db.prepare('SELECT lang k, COUNT(*) n FROM contacts GROUP BY lang ORDER BY n DESC').all(),
    countries: db.prepare("SELECT country k, COUNT(*) n FROM contacts GROUP BY country ORDER BY n DESC").all(),
    imports: db.prepare("SELECT id, filename, created_at, added FROM imports WHERE status = 'done' ORDER BY id DESC LIMIT 30").all(),
  };
}

module.exports = { HttpError, str, STATUSES, where, list, get, update, bulk, facets, cancelQueued };
