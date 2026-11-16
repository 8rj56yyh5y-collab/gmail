'use strict';
// Демо-данные: вымышленные компании, рассылка за 2 недели и несколько ответов. Запуск: npm run demo
const { db, setSetting } = require('./db');
const T = require('./templates');
const C = require('./countries');

const COMPANIES = [
  ['DE', 'Müller Schrott GmbH', 'mueller-schrott'], ['DE', 'Berger Metallhandel', 'berger-metall'], ['DE', 'Rhein Recycling AG', 'rhein-recycling'],
  ['DE', 'Schmidt & Söhne Stahl', 'schmidt-stahl'], ['DE', 'Nordmetall Hamburg', 'nordmetall'], ['DE', 'Bayern Pressen KG', 'bayern-pressen'],
  ['AT', 'Alpen Metall Recycling', 'alpen-metall'], ['AT', 'Donau Schrott', 'donau-schrott'], ['CH', 'Zürcher Rohstoffe AG', 'zuercher-rohstoffe'],
  ['FR', 'Ferraille Dupont', 'ferraille-dupont'], ['FR', 'Recyclage Moreau SA', 'moreau-recyclage'], ['FR', 'Métaux du Rhône', 'metaux-rhone'],
  ['FR', 'Lefèvre Environnement', 'lefevre-env'], ['BE', 'Wallonie Métal', 'wallonie-metal'], ['LU', 'LuxFer Recyclage', 'luxfer'],
  ['ES', 'Chatarras García', 'chatarras-garcia'], ['ES', 'Reciclajes Martín SL', 'reciclajes-martin'], ['ES', 'Metales del Norte', 'metales-norte'],
  ['ES', 'Hierros Valencia', 'hierros-valencia'], ['IT', 'Rottami Rossi Srl', 'rottami-rossi'], ['IT', 'Metalli Bianchi', 'metalli-bianchi'],
  ['GB', 'Northern Scrap Ltd', 'northern-scrap'], ['GB', 'Thames Metals', 'thames-metals'], ['IE', 'Dublin Recycling Co', 'dublin-recycling'],
  ['NL', 'Van Dijk Metaal BV', 'vandijk-metaal'], ['NL', 'Rotterdam Schroot', 'rotterdam-schroot'], ['PL', 'Złom-Pol Sp. z o.o.', 'zlom-pol'],
  ['PL', 'Recykling Kowalski', 'kowalski-recykling'], ['CZ', 'Kovošrot Praha', 'kovosrot-praha'], ['SE', 'Nordic Metal AB', 'nordic-metal'],
  ['DK', 'Dansk Jern Genbrug', 'dansk-jern'], ['PT', 'Sucatas Lisboa', 'sucatas-lisboa'], ['DE', 'Fischer Containerdienst', 'fischer-container'],
  ['DE', 'Weber Maschinenbau', 'weber-maschinen'], ['FR', 'Girard Industrie', 'girard-industrie'], ['ES', 'Grúas y Prensas Ruiz', 'prensas-ruiz'],
];
const TLD = { DE: 'de', AT: 'at', CH: 'ch', FR: 'fr', BE: 'be', LU: 'lu', ES: 'es', IT: 'it', GB: 'co.uk', IE: 'ie', NL: 'nl', PL: 'pl', CZ: 'cz', SE: 'se', DK: 'dk', PT: 'pt' };

const REPLIES = [
  ['mueller-schrott', 'de', 'Re: Bitte um Unterstützung', `Guten Tag,

vielen Dank für Ihre Nachricht. Wir haben derzeit eine gebrauchte Schrottschere (Lindemann, Baujahr 2009), die wir nicht mehr nutzen. Wären Sie daran interessiert? Den Transport müssten Sie selbst organisieren.

Bitte schicken Sie uns ein paar Informationen über Ihr Unternehmen.

Mit freundlichen Grüßen
Klaus Müller`],
  ['ferraille-dupont', 'fr', 'Re: Demande de soutien', `Bonjour,

Merci pour votre message. Nous ne pouvons pas offrir de soutien financier, mais nous pourrions vous mettre en contact avec une association qui aide les entreprises de recyclage.

Pouvez-vous nous envoyer une présentation de votre entreprise ?

Cordialement,
Marie Dupont`],
  ['chatarras-garcia', 'es', 'Re: Solicitud de apoyo', `Buenos días,

Hemos recibido su correo. Tenemos dos contenedores de 30 m³ que podríamos donar. ¿Dónde se encuentran ustedes exactamente?

Saludos,
Javier García`],
  ['northern-scrap', 'en', 'Re: Request for support', `Hi,

Thanks for getting in touch. We'd be happy to have a short call next week — would Tuesday at 11:00 CET work for you?

Best regards,
Tom Harris
Northern Scrap Ltd`],
  ['rotterdam-schroot', 'en', 'Re: Request for support', `Hello,

Please remove us from your mailing list. Unsubscribe.

Regards`],
];

function seed() {
  if (db.prepare('SELECT COUNT(*) n FROM contacts').get().n) return;
  T.seedTemplates();
  for (const [k, v] of Object.entries({ my_company: 'Gobsek Metal', sender_name: 'Олег Демченко', sender_position: 'Директор', phone: '+380 00 000 00 00', website: 'gobsek.example', from_name: 'Gobsek Metal', forward_to: '', daily_limit: 120 })) setSetting(k, v);
  const now = Date.now(); const day = 86400e3;
  const ins = db.prepare('INSERT INTO contacts (email, company, contact_name, country, country_raw, lang, website, info, status, created_at, updated_at, last_sent_at, last_reply_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const camp = Number(db.prepare("INSERT INTO campaigns (name, status, followup_days, fallback, filter_json, created_by, created_at) VALUES ('Европа — первая волна', 'running', 5, 'en', '{}', 1, ?)").run(now - 14 * day).lastInsertRowid);
  const msg = db.prepare(`INSERT INTO messages (contact_id, campaign_id, direction, kind, status, lang, subject, body_text, to_addr, from_addr, message_id, sent_at, scheduled_at, created_at)
    VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, 'demo@gobsek.example', ?, ?, ?, ?)`);
  const st = { my_company: 'Gobsek Metal', sender_name: 'Олег Демченко', sender_position: 'Директор', phone: '+380 00 000 00 00', website: 'gobsek.example', unsub_link: 1 };
  const ids = {};
  COMPANIES.forEach(([cc, name, slug], i) => {
    const email = `info@${slug}.${TLD[cc]}`;
    const lang = C.langOf(cc) || 'en';
    const sent = i < 30;
    const sentAt = sent ? now - (14 - Math.floor(i / 2.4)) * day + (i % 7) * 3600e3 : null;
    const r = ins.run(email, name, '', cc, C.countryName(cc), lang, `www.${slug}.${TLD[cc]}`, `Сфера: переработка металлолома\nИсточник: каталог EuRIC`, sent ? 'sent' : 'queued', now - 15 * day, now, sentAt, null);
    const id = Number(r.lastInsertRowid); ids[slug] = id;
    const tpl = T.pickTemplate(lang, 'first', 'en');
    const mail = T.compose({ company: name, contact_name: '', country_raw: C.countryName(cc) }, tpl, st);
    msg.run(id, camp, 'first', sent ? 'sent' : 'queued', tpl.lang, sent ? mail.subject : '', sent ? mail.text : '', email, sent ? `<gm-demo-${id}@gobsek.example>` : null, sentAt, sent ? null : now + i * 60e3, now - 14 * day);
  });
  // ответы
  const inMsg = db.prepare(`INSERT INTO messages (contact_id, campaign_id, direction, kind, status, lang, subject, body_text, full_text, from_addr, from_name, message_id, received_at, unread, unsubscribe, created_at)
    VALUES (?, ?, 'in', 'reply', 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  REPLIES.forEach(([slug, lang, subj, text], i) => {
    const id = ids[slug]; const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    const at = (c.last_sent_at || now) + (1 + i) * 0.7 * day;
    const unsub = /unsubscribe/i.test(text) ? 1 : 0;
    inMsg.run(id, camp, lang, subj, text, text, c.email, '', `<demo-reply-${i}@${c.email.split('@')[1]}>`, Math.min(at, now - 3600e3), i < 3 ? 1 : 0, unsub, now);
    db.prepare('UPDATE contacts SET status = ?, last_reply_at = ? WHERE id = ?').run(unsub ? 'unsubscribed' : 'replied', Math.min(at, now - 3600e3), id);
  });
  // недоставленное и автоответ
  const b = ids['metalli-bianchi'];
  db.prepare("UPDATE contacts SET status = 'bounced' WHERE id = ?").run(b);
  db.prepare(`INSERT INTO messages (contact_id, direction, kind, status, subject, body_text, from_addr, message_id, received_at, unread, created_at)
    VALUES (?, 'in', 'bounce', 'received', 'Delivery Status Notification (Failure)', 'Address not found: the email account does not exist.', 'mailer-daemon@googlemail.com', '<demo-bounce@x>', ?, 0, ?)`).run(b, now - 5 * day, now);
  const a = ids['nordmetall'];
  db.prepare(`INSERT INTO messages (contact_id, direction, kind, status, lang, subject, body_text, from_addr, message_id, received_at, unread, created_at)
    VALUES (?, 'in', 'auto', 'received', 'de', 'Abwesenheitsnotiz', 'Ich bin bis zum 20.11. nicht im Büro. In dringenden Fällen wenden Sie sich bitte an zentrale@nordmetall.de.', 'info@nordmetall.de', '<demo-auto@x>', ?, 0, ?)`).run(a, now - 6 * day, now);
  console.log('Демо-данные загружены: 36 компаний, 30 писем отправлено, 5 ответов.');
}

module.exports = { seed };
