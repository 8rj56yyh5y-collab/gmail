'use strict';
// Входящие: раз в пару минут читаем почтовый ящик (IMAP), находим ответы на наши письма и складываем во «Входящие».
// Письма в самом ящике не трогаем (не удаляем и не помечаем прочитанными).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { simpleParser } = require('mailparser');
const { db, FILE_DIR, getSettings, getState, setState, logEvent } = require('./db');
const K = require('./contacts');
const mailer = require('./mailer');

const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'gmx.de', 'gmx.net', 'web.de', 't-online.de', 'orange.fr', 'free.fr', 'laposte.net', 'wanadoo.fr', 'icloud.com', 'me.com', 'aol.com', 'mail.ru', 'yandex.ru', 'ukr.net', 'libero.it', 'proton.me', 'protonmail.com', 'seznam.cz', 'wp.pl', 'o2.pl', 'interia.pl']);
const UNSUB_RE = /\b(unsubscribe|remove me|take me off|stop sending|do not contact|don't contact|no more emails|abmelden|austragen|keine (weiteren )?e-?mails|nicht mehr kontaktieren|désinscri|desinscri|ne plus (me )?(contacter|recevoir)|darse de baja|darme de baja|\bbaja\b|no me (escriban|contacten)|cancellami|disiscriv|non contattateci|afmelden|wypisz|nie (piszcie|kontaktuj)|odhlásit|cancelar subscri|відписат|отписат)/i;
const AUTO_SUBJ = /^(auto(matic)?[\s_-]*(reply|response|antwort)|out of (the )?office|abwesenheit|automatische antwort|réponse automatique|absence du bureau|respuesta automática|fuera de la oficina|risposta automatica|fuori sede|afwezig|automatisch antwoord|autoodpowiedź|nieobecność|odpověď mimo kancelář)/i;
const ID_RE = /<gm-\d+-[a-f0-9]+@[^>\s]+>/gi;

// Отрезаем цитату нашего письма: «On … wrote:», «Am … schrieb», «Le … a écrit», строки с «>»…
function freshPart(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const stop = /^(\s*(on|am|le|el|il|op|w dniu|dne)\b.{0,200}(wrote|schrieb|écrit|escribió|scritto|geschreven|napisał|napsal)\s*:?\s*$)|^\s*-{2,}\s*(original message|ursprüngliche nachricht|message d'origine|mensaje original|messaggio originale|oorspronkelijk bericht)|^\s*_{8,}\s*$|^\s*(from|von|de|da|van|od)\s*:\s.+@/i;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const two = `${lines[i]} ${lines[i + 1] || ''}`;
    if (stop.test(lines[i]) || (/^\s*(on|am|le|el|il|op)\b/i.test(lines[i]) && stop.test(two))) break;
    if (/^\s*>/.test(lines[i])) continue;
    out.push(lines[i]);
  }
  const res = out.join('\n').trim();
  return res || String(text || '').trim();
}

function findOurMessage(ids) {
  for (const id of ids) {
    const m = db.prepare("SELECT * FROM messages WHERE message_id = ? AND direction = 'out'").get(id);
    if (m) return m;
  }
  return null;
}

function saveAttachment(msgId, a) {
  if (!a.content || a.content.length > 15 * 1024 * 1024 || a.related) return;
  const stored = `${crypto.randomBytes(16).toString('hex')}`;
  fs.writeFileSync(path.join(FILE_DIR, stored), a.content);
  db.prepare('INSERT INTO attachments (message_id, name, mime, stored, size) VALUES (?, ?, ?, ?, ?)')
    .run(msgId, String(a.filename || 'file').slice(0, 200), String(a.contentType || 'application/octet-stream').slice(0, 100), stored, a.content.length);
}

// Разбор одного письма из ящика. Возвращает id сохранённого письма или null, если письмо к рассылке не относится.
async function ingest(raw, { forward = true } = {}) {
  const p = await simpleParser(raw, { skipImageLinks: true });
  const messageId = p.messageId || `<no-id-${crypto.createHash('sha1').update(raw).digest('hex')}@local>`;
  if (db.prepare('SELECT 1 FROM messages WHERE message_id = ?').get(messageId)) return null;
  const from = (p.from && p.from.value && p.from.value[0]) || {};
  const fromAddr = String(from.address || '').toLowerCase();
  const fromName = String(from.name || '').slice(0, 200);
  const st = getSettings();
  if (fromAddr && st.mail_user && fromAddr === String(st.mail_user).toLowerCase()) return null; // наше собственное письмо

  const refs = [p.inReplyTo, ...(Array.isArray(p.references) ? p.references : p.references ? [p.references] : [])].filter(Boolean);
  const rawText = typeof raw === 'string' ? raw : raw.toString('utf8');
  const hdr = (k) => String(p.headers.get(k) || '').toLowerCase();
  const ctype = p.headers.get('content-type');
  const isReport = ctype && /report/i.test(ctype.value || '') && /delivery-status/i.test(JSON.stringify(ctype.params || {}));
  const isBounce = isReport || /^(mailer-daemon|postmaster|mail-daemon)@/i.test(fromAddr) || /^(undeliver|delivery status notification|mail delivery failed|returned mail|unzustellbar|non remis|no se puede entregar)/i.test(p.subject || '');

  let ours = findOurMessage(refs);
  if (!ours && isBounce) ours = findOurMessage([...new Set(rawText.match(ID_RE) || [])]);
  let contact = ours ? db.prepare('SELECT * FROM contacts WHERE id = ?').get(ours.contact_id) : null;

  if (isBounce) {
    if (!contact) {
      const failed = (String(p.headers.get('x-failed-recipients') || '') + ' ' + ((/final-recipient:\s*rfc822;\s*([^\s]+)/i.exec(rawText) || [])[1] || '')).toLowerCase();
      const addr = (failed.match(/[^\s,;<>]+@[^\s,;<>]+/) || [])[0];
      if (addr) contact = db.prepare('SELECT * FROM contacts WHERE email = ?').get(addr);
    }
    if (!contact) return null;
    const now = Date.now();
    const id = Number(db.prepare(`INSERT INTO messages (contact_id, direction, kind, status, subject, body_text, full_text, from_addr, from_name, message_id, in_reply_to, refs, parent_id, received_at, unread, created_at)
      VALUES (?, 'in', 'bounce', 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(contact.id, String(p.subject || '').slice(0, 300), String(p.text || '').slice(0, 20000), '', fromAddr, fromName, messageId, String(p.inReplyTo || ''), refs.join(' ').slice(0, 4000), ours ? ours.id : null, now, now).lastInsertRowid);
    db.prepare("UPDATE contacts SET status = 'bounced', updated_at = ? WHERE id = ?").run(now, contact.id);
    if (ours) db.prepare("UPDATE messages SET error = 'Письмо не доставлено (адрес не существует или ящик переполнен)' WHERE id = ?").run(ours.id);
    K.cancelQueued(contact.id, 'адрес не существует');
    logEvent(null, 'contact', contact.id, 'bounced');
    return id;
  }

  if (!contact && fromAddr) contact = db.prepare('SELECT * FROM contacts WHERE email = ?').get(fromAddr);
  if (!contact && fromAddr) {
    // ответил коллега с того же корпоративного домена
    const dom = fromAddr.split('@')[1];
    if (dom && !FREE_MAIL.has(dom)) {
      const same = db.prepare("SELECT * FROM contacts WHERE email LIKE ? AND last_sent_at IS NOT NULL").all(`%@${dom}`);
      if (same.length === 1) contact = same[0];
    }
  }
  if (!contact) return null;
  if (!ours) ours = db.prepare("SELECT * FROM messages WHERE contact_id = ? AND direction = 'out' AND status = 'sent' ORDER BY sent_at DESC LIMIT 1").get(contact.id);

  const full = String(p.text || '').replace(/\r/g, '').trim() || String(p.html || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  const fresh = freshPart(full);
  const auto = (hdr('auto-submitted') && hdr('auto-submitted') !== 'no') || !!p.headers.get('x-autoreply') || !!p.headers.get('x-autorespond') || /auto_reply|auto-reply/.test(hdr('precedence')) || AUTO_SUBJ.test(String(p.subject || '').trim());
  const unsub = !auto && (UNSUB_RE.test(String(p.subject || '')) || UNSUB_RE.test(fresh.slice(0, 600)));
  const now = Date.now();
  const receivedAt = p.date instanceof Date && !Number.isNaN(p.date.getTime()) ? Math.min(p.date.getTime(), now) : now;
  const id = Number(db.prepare(`INSERT INTO messages (contact_id, campaign_id, direction, kind, status, lang, subject, body_text, full_text, from_addr, from_name, to_addr, message_id, in_reply_to, refs, parent_id, received_at, unread, unsubscribe, created_at)
    VALUES (?, ?, 'in', ?, 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(contact.id, ours ? ours.campaign_id : null, auto ? 'auto' : 'reply', contact.lang,
    String(p.subject || '(без темы)').slice(0, 300), fresh.slice(0, 50000), full.slice(0, 100000), fromAddr, fromName, st.mail_user || '', messageId,
    String(p.inReplyTo || ''), refs.join(' ').slice(0, 4000), ours ? ours.id : null, receivedAt, auto ? 0 : 1, unsub ? 1 : 0, now).lastInsertRowid);
  for (const a of p.attachments || []) saveAttachment(id, a);

  if (!auto) {
    db.prepare(`UPDATE contacts SET status = ?, last_reply_at = ?, updated_at = ? WHERE id = ?`).run(unsub ? 'unsubscribed' : 'replied', receivedAt, now, contact.id);
    K.cancelQueued(contact.id, unsub ? 'компания попросила не писать' : 'компания ответила');
    logEvent(null, 'contact', contact.id, unsub ? 'unsubscribed' : 'replied', { message: id });
    if (forward) { try { await mailer.forwardReply(id); } catch (e) { setState('forward_error', `Не удалось переслать ответ: ${e.message || e}`); } }
  }
  return id;
}

// ---------- опрос ящика по IMAP ----------
let busy = false;
async function poll({ manual = false } = {}) {
  if (busy) return { busy: true };
  const st = getSettings();
  if (mailer.TEST_MODE) return { skipped: 'test' };
  if (!st.mail_user || !st.mail_pass) return { skipped: 'not configured' };
  if (!manual && !Number(st.imap_enabled)) return { skipped: 'disabled' };
  busy = true;
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({ host: st.imap_host, port: Number(st.imap_port), secure: !!Number(st.imap_secure), auth: { user: st.mail_user, pass: st.mail_pass }, logger: false, socketTimeout: 120000 });
  client.on('error', () => {});
  let found = 0; let checked = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const box = client.mailbox;
      const validity = String(box.uidValidity);
      let last = Number(getState('imap_last_uid', '0'));
      if (getState('imap_uidvalidity') !== validity) {
        // первый запуск: смотрим письма с момента первой отправки (или за 3 дня)
        const first = db.prepare("SELECT MIN(sent_at) t FROM messages WHERE direction = 'out' AND status = 'sent'").get().t;
        const since = new Date(Math.min(first || Date.now(), Date.now() - 3 * 86400e3));
        const uids = await client.search({ since }, { uid: true });
        last = uids && uids.length ? Math.min(...uids) - 1 : Math.max(0, Number(box.uidNext) - 1);
        setState('imap_uidvalidity', validity);
      }
      const candidates = [];
      const ourIds = new Set();
      if (Number(box.uidNext) - 1 > last) {
        for await (const msg of client.fetch(`${last + 1}:*`, { uid: true, envelope: true, size: true, headers: ['references', 'in-reply-to'] }, { uid: true })) {
          if (msg.uid <= last) continue;
          checked++;
          const from = String((msg.envelope.from && msg.envelope.from[0] && msg.envelope.from[0].address) || '').toLowerCase();
          const h = msg.headers ? msg.headers.toString('utf8') : '';
          const relevant = /<gm-\d+-/.test(h) || /^(mailer-daemon|postmaster)@/.test(from) || (from && db.prepare('SELECT 1 FROM contacts WHERE email = ? OR (email LIKE ? AND last_sent_at IS NOT NULL)').get(from, `%@${from.split('@')[1]}`));
          if (relevant && msg.size < 30 * 1024 * 1024) candidates.push(msg.uid);
          ourIds.add(msg.uid);
        }
      }
      for (const uid of candidates) {
        const m = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (m && m.source && await ingest(m.source)) found++;
      }
      const maxUid = Math.max(last, ...ourIds);
      setState('imap_last_uid', String(maxUid));
    } finally { lock.release(); }
    await client.logout();
    setState('imap_error', '');
  } catch (e) {
    setState('imap_error', String(e.responseText || e.message || e).slice(0, 300));
    try { client.close(); } catch { /* уже закрыт */ }
    if (manual) { busy = false; throw new K.HttpError(502, `Не удалось прочитать почту: ${e.responseText || e.message || e}`); }
  } finally {
    busy = false;
    setState('imap_last_check', String(Date.now()));
  }
  return { checked, found };
}

async function testImap(st) {
  if (mailer.TEST_MODE) return { ok: true, test: true };
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({ host: st.imap_host, port: Number(st.imap_port), secure: !!Number(st.imap_secure), auth: { user: st.mail_user, pass: st.mail_pass }, logger: false });
  client.on('error', () => {});
  await client.connect();
  const s = await client.status('INBOX', { messages: true });
  await client.logout();
  return { ok: true, messages: s.messages };
}

function list(f = {}) {
  const tab = f.tab || 'replies';
  const w = ["m.direction = 'in'"];
  const p = [];
  if (tab === 'replies') w.push("m.kind = 'reply'");
  else if (tab === 'unread') w.push("m.kind = 'reply' AND m.unread = 1");
  else if (tab === 'unsub') w.push('m.unsubscribe = 1');
  else if (tab === 'auto') w.push("m.kind = 'auto'");
  else if (tab === 'bounce') w.push("m.kind = 'bounce'");
  if (f.q) { w.push('(lower(c.company) LIKE ? OR lower(m.from_addr) LIKE ? OR lower(m.subject) LIKE ? OR lower(m.body_text) LIKE ?)'); p.push(...Array(4).fill(`%${String(f.q).toLowerCase().slice(0, 100)}%`)); }
  if (f.lang) { w.push('c.lang = ?'); p.push(String(f.lang)); }
  const rows = db.prepare(`SELECT m.id, m.contact_id, m.kind, m.subject, substr(m.body_text, 1, 240) preview, m.from_addr, m.from_name, m.received_at, m.unread, m.unsubscribe, m.forwarded, m.translation != '' translated,
      c.company, c.country, c.lang, c.email, (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) files
    FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE ${w.join(' AND ')} ORDER BY m.received_at DESC LIMIT 300`).all(...p);
  const counts = db.prepare(`SELECT
      SUM(kind = 'reply') replies, SUM(kind = 'reply' AND unread = 1) unread, SUM(unsubscribe = 1) unsub, SUM(kind = 'auto') auto, SUM(kind = 'bounce') bounce
    FROM messages WHERE direction = 'in'`).get();
  return { rows, counts };
}

function unreadCount() { return db.prepare("SELECT COUNT(*) n FROM messages WHERE direction = 'in' AND kind = 'reply' AND unread = 1").get().n; }

function status() {
  const st = getSettings();
  return { enabled: !!Number(st.imap_enabled), last_check: Number(getState('imap_last_check', '0')) || null, error: getState('imap_error'), forward_to: st.forward_to, forward_error: getState('forward_error'), poll_sec: Number(st.poll_sec) };
}

let timer = null;
function start() {
  if (timer || mailer.TEST_MODE) return;
  const loop = async () => {
    try { await poll(); } catch (e) { console.error('Входящие:', e.message || e); }
    timer = setTimeout(loop, Math.max(30, Number(getSettings().poll_sec) || 120) * 1000);
    timer.unref();
  };
  timer = setTimeout(loop, 5000); timer.unref();
}

module.exports = { ingest, poll, testImap, list, unreadCount, status, start, freshPart };
