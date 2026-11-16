'use strict';
// Сквозной тест: файл → компании → рассылка на нужных языках → ответы, отписки, недоставка, пересылка.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-test-'));
process.env.DATA_DIR = dir;
process.env.MAIL_TRANSPORT = 'json';
process.env.ADMIN_PASSWORD = 'Admin12345';

const { db, setSetting } = require('../server/db');
const { server } = require('../server/index');
const mailer = require('../server/mailer');
const inbox = require('../server/inbox');
const I = require('../server/importer');
const C = require('../server/countries');

let base; let cookie = '';
async function call(method, p, body, { csrf = true } = {}) {
  const headers = { cookie };
  if (csrf) headers['X-GM'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data };
}

// мини-архиватор для .xlsx в тесте
function zip(files) {
  const parts = []; const central = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = zlib.deflateRawSync(Buffer.from(text)); const nb = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(Buffer.byteLength(text), 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(Buffer.byteLength(text), 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nb, data); central.push(ch, nb); off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; });
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('страны и языки распознаются на любом языке', () => {
  assert.equal(C.findCountry('Deutschland'), 'DE');
  assert.equal(C.findCountry('Германия'), 'DE');
  assert.equal(C.findCountry('Іспанія'), 'ES');
  assert.equal(C.findCountry('Lyon, France'), 'FR');
  assert.equal(C.findCountry('UK'), 'GB');
  assert.equal(C.countryFromEmail('info@firma.at'), 'AT');
  assert.equal(C.langOf('AT'), 'de');
  assert.equal(C.findLang('Español'), 'es');
});

test('без входа и без заголовка X-GM — нельзя', async () => {
  assert.equal((await call('GET', '/api/contacts')).status, 401);
  assert.equal((await call('POST', '/api/login', { login: 'admin', password: 'Admin12345' }, { csrf: false })).status, 403);
  assert.equal((await call('POST', '/api/login', { login: 'admin', password: 'wrong' })).status, 401);
  const r = await call('POST', '/api/login', { login: 'admin', password: 'Admin12345' });
  assert.equal(r.status, 200);
});

test('импорт CSV: колонки угадываются, повторы и строки без почты пропускаются', async () => {
  const csv = 'Название;Страна;E-mail;Сайт;Отрасль\n'
    + 'Müller GmbH;Deutschland;info@mueller.de;mueller.de;Schrott\n'
    + 'Dupont SA;Франция;contact@dupont.fr, sales@dupont.fr;;Ferraille\n'
    + 'García SL;;ventas@garcia.es;;\n'
    + 'Без почты;Italy;;;\n'
    + 'Müller дубль;Germany;INFO@mueller.de;;\n'
    + 'Nordic AB;Sweden;hej@nordic.se;;\n';
  const p = await call('POST', '/api/import/preview', { name: 'list.csv', data: `data:text/csv;base64,${Buffer.from(csv).toString('base64')}` });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.headers[p.data.mapping.email], 'E-mail');
  assert.equal(p.data.headers[p.data.mapping.country], 'Страна');
  assert.equal(p.data.headers[p.data.mapping.company], 'Название');
  const c = await call('POST', `/api/import/${p.data.id}/commit`, {});
  assert.equal(c.status, 200);
  assert.deepEqual([c.data.added, c.data.dupes, c.data.invalid], [5, 1, 1]);
  const rows = db.prepare('SELECT email, country, lang, info FROM contacts ORDER BY id').all();
  const by = Object.fromEntries(rows.map((r) => [r.email, r]));
  assert.equal(by['info@mueller.de'].lang, 'de');
  assert.equal(by['sales@dupont.fr'].lang, 'fr');
  assert.equal(by['ventas@garcia.es'].country, 'ES'); // по домену
  assert.equal(by['hej@nordic.se'].lang, 'sv');
  assert.match(by['info@mueller.de'].info, /Отрасль: Schrott/);
});

test('импорт XLSX', () => {
  const xlsx = zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Company</t></si><si><t>Country</t></si><si><t>Email</t></si><si><r><t>Rossi </t></r><r><t>Srl</t></r></si><si><t>Italia</t></si><si><t>info@rossi.it</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2" t="s"><v>5</v></c></row></sheetData></worksheet>',
  });
  const { headers, rows } = I.readTable('a.xlsx', xlsx);
  assert.deepEqual(headers, ['Company', 'Country', 'Email']);
  const list = I.buildContacts(headers, rows, I.guessMapping(headers, rows));
  assert.equal(list[0].company, 'Rossi Srl');
  assert.equal(list[0].lang, 'it');
});

test('рассылка: каждой компании — письмо на её языке, нет шаблона → запасной английский', async () => {
  setSetting('my_company', 'Gobsek Metal'); setSetting('sender_name', 'Oleg'); setSetting('forward_to', 'boss@example.com');
  const pv = await call('POST', '/api/campaigns/preview', { filter: {}, fallback: 'en' });
  assert.equal(pv.data.total, 5);
  const sv = pv.data.langs.find((l) => l.lang === 'sv');
  assert.equal(sv.template, false); assert.equal(sv.send_as, 'en');
  const skip = await call('POST', '/api/campaigns/preview', { filter: {}, fallback: 'skip' });
  assert.equal(skip.data.skipped, 1);

  const r = await call('POST', '/api/campaigns', { filter: {}, fallback: 'en', followup_days: 5, name: 'Тест' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.queued, 5);
  // повторно тем же — некому (уже в очереди)
  assert.equal((await call('POST', '/api/campaigns', { filter: {} })).status, 400);

  for (let i = 0; i < 5; i++) await mailer.tick({ force: true });
  assert.equal(mailer.outbox.length, 5);
  const de = mailer.outbox.find((m) => (m.to.address || m.to) === 'info@mueller.de');
  assert.match(de.subject, /Bitte um Unterstützung — Gobsek Metal/);
  assert.match(de.text, /Müller GmbH/);
  assert.match(de.text, /Abmelden/);
  assert.match(de.messageId, /^<gm-\d+-[a-f0-9]+@/);
  const sv2 = mailer.outbox.find((m) => (m.to.address || m.to) === 'hej@nordic.se');
  assert.match(sv2.subject, /Request for support/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM contacts WHERE status = 'sent'").get().n, 5);
  // напоминания запланированы на +5 дней
  const fu = db.prepare("SELECT * FROM messages WHERE kind = 'followup' AND status = 'queued'").all();
  assert.equal(fu.length, 5);
  assert.ok(fu[0].scheduled_at > Date.now() + 4.9 * 86400e3);
  assert.equal(await mailer.tick({ force: true }), null); // сейчас отправлять нечего
});

const rawMail = (h, body) => Buffer.from(`${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`);

test('ответ компании: во «Входящих», напоминание отменено, переслано руководителю', async () => {
  const sent = db.prepare("SELECT m.* FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE c.email = 'info@mueller.de' AND m.kind = 'first'").get();
  const before = mailer.outbox.length;
  const id = await inbox.ingest(rawMail({
    From: 'Klaus Müller <k.mueller@mueller.de>', To: 'me@gobsek.example', Subject: 'Re: Bitte um Unterstützung', 'Message-ID': '<r1@mueller.de>',
    'In-Reply-To': sent.message_id, References: sent.message_id, Date: new Date().toUTCString(),
  }, 'Guten Tag,\n\nwir haben eine gebrauchte Presse.\n\nAm 01.11.2026 schrieb Oleg:\n> Sehr geehrte Damen und Herren'));
  assert.ok(id);
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  assert.equal(m.kind, 'reply'); assert.equal(m.unread, 1);
  assert.doesNotMatch(m.body_text, /Sehr geehrte/); // цитата отрезана
  assert.match(m.full_text, /Sehr geehrte/);
  const c = db.prepare("SELECT * FROM contacts WHERE email = 'info@mueller.de'").get();
  assert.equal(c.status, 'replied');
  assert.equal(db.prepare("SELECT status FROM messages WHERE contact_id = ? AND kind = 'followup'").get(c.id).status, 'cancelled');
  const fwd = mailer.outbox[before];
  assert.equal(fwd.to, 'boss@example.com');
  assert.match(fwd.subject, /^\[Ответ\] Müller GmbH \(DE\)/);
  assert.equal(fwd.replyTo.address, 'k.mueller@mueller.de');
  // повторное чтение того же письма не дублирует
  assert.equal(await inbox.ingest(rawMail({ From: 'k.mueller@mueller.de', Subject: 'x', 'Message-ID': '<r1@mueller.de>' }, 'x')), null);
  // посторонняя почта не попадает во «Входящие»
  assert.equal(await inbox.ingest(rawMail({ From: 'news@shop.com', Subject: 'Sale', 'Message-ID': '<s@shop.com>' }, 'Sale!')), null);

  const list = await call('GET', '/api/inbox');
  assert.equal(list.data.rows.length, 1);
  assert.equal(list.data.counts.unread, 1);
});

test('отписка, автоответ и недоставка', async () => {
  const fr = db.prepare("SELECT * FROM contacts WHERE email = 'contact@dupont.fr'").get();
  await inbox.ingest(rawMail({ From: 'contact@dupont.fr', Subject: 'Re: Demande', 'Message-ID': '<u1@dupont.fr>' }, 'Merci de ne plus nous contacter. Désinscrire.'));
  assert.equal(db.prepare('SELECT status FROM contacts WHERE id = ?').get(fr.id).status, 'unsubscribed');

  const es = db.prepare("SELECT * FROM contacts WHERE email = 'ventas@garcia.es'").get();
  await inbox.ingest(rawMail({ From: 'ventas@garcia.es', Subject: 'Respuesta automática: Solicitud', 'Message-ID': '<a1@garcia.es>', 'Auto-Submitted': 'auto-replied' }, 'Estoy fuera de la oficina.'));
  assert.equal(db.prepare('SELECT status FROM contacts WHERE id = ?').get(es.id).status, 'sent'); // автоответ — не ответ
  assert.equal(db.prepare("SELECT status FROM messages WHERE contact_id = ? AND kind = 'followup'").get(es.id).status, 'queued'); // напоминание остаётся

  const sv = db.prepare("SELECT * FROM contacts WHERE email = 'hej@nordic.se'").get();
  const sentSv = db.prepare("SELECT message_id FROM messages WHERE contact_id = ? AND kind = 'first'").get(sv.id);
  await inbox.ingest(rawMail({ From: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', Subject: 'Delivery Status Notification (Failure)', 'Message-ID': '<b1@google>' },
    `Address not found\nYour message wasn't delivered to hej@nordic.se\n\nMessage-ID: ${sentSv.message_id}`));
  assert.equal(db.prepare('SELECT status FROM contacts WHERE id = ?').get(sv.id).status, 'bounced');
});

test('напоминание уходит в ту же переписку, если не ответили', async () => {
  db.exec("UPDATE messages SET scheduled_at = 0 WHERE kind = 'followup' AND status = 'queued'");
  const before = mailer.outbox.length;
  for (let i = 0; i < 5; i++) await mailer.tick({ force: true });
  const sent = mailer.outbox.slice(before);
  const to = sent.map((m) => m.to.address || m.to).sort();
  assert.deepEqual(to, ['sales@dupont.fr', 'ventas@garcia.es']); // dupont.fr contact@ отписался, mueller ответил, nordic не существует
  const es = sent.find((m) => (m.to.address || m.to) === 'ventas@garcia.es');
  assert.match(es.subject, /^Re: Solicitud de apoyo/);
  assert.ok(es.inReplyTo && es.references);
});

test('ответ из системы уходит в цепочку с In-Reply-To', async () => {
  const c = db.prepare("SELECT * FROM contacts WHERE email = 'info@mueller.de'").get();
  const r = await call('POST', `/api/contacts/${c.id}/send`, { text: 'Vielen Dank! Ja, wir sind interessiert.' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const last = mailer.outbox[mailer.outbox.length - 1];
  assert.equal(last.inReplyTo, '<r1@mueller.de>');
  assert.match(last.subject, /^Re: Bitte um Unterstützung/);
  assert.match(last.text, /> Guten Tag/);
});

test('стоп-лист: компания не получает рассылку', async () => {
  const c = db.prepare("SELECT * FROM contacts WHERE email = 'sales@dupont.fr'").get();
  await call('POST', '/api/contacts/bulk', { ids: [c.id], action: 'block' });
  const pv = await call('POST', '/api/campaigns/preview', { filter: { status: 'new,sent,replied' } });
  assert.ok(!pv.data.langs.some((l) => l.lang === 'fr'));
});

test('настройки: пароль почты не отдаётся и хранится зашифрованным', async () => {
  const r = await call('PUT', '/api/settings', { provider: 'gmail', mail_user: 'me@gmail.com', mail_pass: 'abcd efgh ijkl mnop', daily_limit: 99999 });
  assert.equal(r.status, 200);
  assert.equal(r.data.mail_pass, undefined);
  assert.equal(r.data.has_password, true);
  assert.equal(r.data.daily_limit, 2000);
  const raw = db.prepare("SELECT value FROM settings WHERE key = 'mail_pass'").get().value;
  assert.match(raw, /^v1:/);
  assert.doesNotMatch(raw, /abcd/);
  assert.equal(require('../server/db').getSettings().mail_pass, 'abcdefghijklmnop');
});
