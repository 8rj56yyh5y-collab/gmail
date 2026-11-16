'use strict';
// Шаблоны писем и подстановка данных компании: {{company}}, {{name|Sir or Madam}}, {{sender_name}}…
const { db } = require('./db');

const VARS = [
  ['company', 'Название компании-получателя'],
  ['name', 'Контактное лицо (можно с запасным словом: {{name|Sir or Madam}})'],
  ['country', 'Страна получателя, как в файле'],
  ['website', 'Сайт получателя'],
  ['my_company', 'Наша компания (из настроек)'],
  ['sender_name', 'Кто пишет (из настроек)'],
  ['sender_position', 'Должность (из настроек)'],
  ['phone', 'Наш телефон (из настроек)'],
  ['my_website', 'Наш сайт (из настроек)'],
  ['signature', 'Подпись целиком (из настроек)'],
];

// Строка про отписку внизу письма — на языке получателя (честно и снижает риск попасть в спам).
const UNSUB = {
  en: 'If you would prefer not to receive further emails from us, just reply "unsubscribe".',
  de: 'Wenn Sie keine weiteren E-Mails von uns erhalten möchten, antworten Sie einfach mit „Abmelden“.',
  fr: 'Si vous ne souhaitez plus recevoir nos e-mails, répondez simplement « désinscrire ».',
  es: 'Si prefiere no recibir más correos de nuestra parte, responda simplemente «baja».',
  it: 'Se preferisce non ricevere altre e-mail da parte nostra, risponda semplicemente «cancellami».',
  pt: 'Se preferir não receber mais e-mails nossos, responda simplesmente «cancelar».',
  nl: 'Wilt u geen e-mails meer van ons ontvangen? Antwoord dan gewoon met "afmelden".',
  pl: 'Jeśli nie chcą Państwo otrzymywać od nas więcej wiadomości, wystarczy odpisać „wypisz”.',
  cs: 'Pokud si nepřejete dostávat další e-maily, odpovězte prosím „odhlásit“.',
  uk: 'Якщо ви не бажаєте отримувати від нас листи, просто дайте відповідь «відписатися».',
};

// Черновики для начала работы — замените своими текстами в разделе «Шаблоны».
const DEFAULTS = {
  en: {
    first: ['Request for support — {{my_company}}', `Dear {{name|Sir or Madam}},

My name is {{sender_name}} and I represent {{my_company}}, a scrap metal collection and recycling company.

We are reaching out to European companies that could help us keep our business running — with financial support, with equipment (presses, shears, scales, containers, trucks), or with used machinery you no longer need.

We came across {{company}} and believe your support could make a real difference for our team. We would be grateful for any help or advice, and we are open to long-term cooperation.

Would you be open to a short call, or may we send you more details?

Kind regards,
{{signature}}`],
    followup: ['Re: Request for support — {{my_company}}', `Dear {{name|Sir or Madam}},

I wanted to follow up on my previous email in case it got lost in your inbox.

Any form of support — financial, equipment, or simply advice on whom to contact — would mean a lot to us.

Thank you for your time.

Kind regards,
{{signature}}`],
  },
  de: {
    first: ['Bitte um Unterstützung — {{my_company}}', `Sehr geehrte Damen und Herren,

mein Name ist {{sender_name}}, ich vertrete {{my_company}}, ein Unternehmen für die Sammlung und das Recycling von Altmetall.

Wir wenden uns an europäische Unternehmen, die uns helfen könnten, unseren Betrieb aufrechtzuerhalten — mit finanzieller Unterstützung, mit Ausrüstung (Pressen, Scheren, Waagen, Container, Lkw) oder mit gebrauchten Maschinen, die Sie nicht mehr benötigen.

Wir sind auf {{company}} aufmerksam geworden und glauben, dass Ihre Unterstützung für unser Team viel bewirken könnte. Wir sind für jede Hilfe oder jeden Rat dankbar und offen für eine langfristige Zusammenarbeit.

Wären Sie zu einem kurzen Gespräch bereit, oder dürfen wir Ihnen weitere Informationen senden?

Mit freundlichen Grüßen
{{signature}}`],
    followup: ['Re: Bitte um Unterstützung — {{my_company}}', `Sehr geehrte Damen und Herren,

ich möchte kurz an meine vorherige E-Mail erinnern, falls sie untergegangen ist.

Jede Form der Unterstützung — finanziell, mit Ausrüstung oder einfach ein Hinweis, an wen wir uns wenden können — würde uns sehr helfen.

Vielen Dank für Ihre Zeit.

Mit freundlichen Grüßen
{{signature}}`],
  },
  fr: {
    first: ['Demande de soutien — {{my_company}}', `Madame, Monsieur,

Je m'appelle {{sender_name}} et je représente {{my_company}}, une entreprise de collecte et de recyclage de ferraille.

Nous contactons des entreprises européennes qui pourraient nous aider à maintenir notre activité — par un soutien financier, par du matériel (presses, cisailles, balances, conteneurs, camions) ou par des machines d'occasion dont vous n'avez plus besoin.

Nous avons découvert {{company}} et pensons que votre soutien pourrait vraiment changer les choses pour notre équipe. Nous serions reconnaissants pour toute aide ou tout conseil, et nous sommes ouverts à une coopération à long terme.

Seriez-vous disponible pour un court échange, ou pouvons-nous vous envoyer plus d'informations ?

Cordialement,
{{signature}}`],
    followup: ['Re: Demande de soutien — {{my_company}}', `Madame, Monsieur,

Je me permets de revenir vers vous au sujet de mon précédent e-mail, au cas où il vous aurait échappé.

Toute forme de soutien — financier, matériel ou simplement un conseil sur la personne à contacter — compterait beaucoup pour nous.

Merci pour votre temps.

Cordialement,
{{signature}}`],
  },
  es: {
    first: ['Solicitud de apoyo — {{my_company}}', `Estimados señores:

Me llamo {{sender_name}} y represento a {{my_company}}, una empresa de recogida y reciclaje de chatarra.

Nos dirigimos a empresas europeas que podrían ayudarnos a mantener nuestra actividad: con apoyo financiero, con equipos (prensas, cizallas, básculas, contenedores, camiones) o con maquinaria usada que ya no necesiten.

Conocimos {{company}} y creemos que su apoyo podría marcar una gran diferencia para nuestro equipo. Agradeceríamos cualquier ayuda o consejo, y estamos abiertos a una cooperación a largo plazo.

¿Estarían dispuestos a una breve llamada, o podemos enviarles más información?

Atentamente,
{{signature}}`],
    followup: ['Re: Solicitud de apoyo — {{my_company}}', `Estimados señores:

Les escribo para dar seguimiento a mi correo anterior, por si se hubiera perdido.

Cualquier forma de apoyo —financiero, con equipos o simplemente un consejo sobre a quién dirigirnos— significaría mucho para nosotros.

Gracias por su tiempo.

Atentamente,
{{signature}}`],
  },
};

function seedTemplates() {
  if (db.prepare('SELECT COUNT(*) n FROM templates').get().n) return;
  const ins = db.prepare('INSERT INTO templates (lang, kind, subject, body, updated_at) VALUES (?, ?, ?, ?, ?)');
  for (const [lang, kinds] of Object.entries(DEFAULTS)) for (const [kind, [s, b]] of Object.entries(kinds)) ins.run(lang, kind, s, b, Date.now());
}

function signatureOf(st) {
  if (st.signature && st.signature.trim()) return st.signature.trim();
  return [st.sender_name, st.sender_position, st.my_company, st.phone, st.website].filter(Boolean).join('\n');
}
function fill(text, contact, st) {
  const vals = {
    company: contact.company, name: contact.contact_name, country: contact.country_raw || contact.country, website: contact.website,
    my_company: st.my_company, sender_name: st.sender_name || st.from_name, sender_position: st.sender_position, phone: st.phone,
    my_website: st.website, signature: signatureOf(st),
  };
  return String(text || '').replace(/\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/gi, (all, key, def) => {
    const v = vals[key.toLowerCase()];
    if (v != null && String(v).trim()) return String(v).trim();
    return def != null ? def.trim() : '';
  }).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function toHtml(text, footer = '') {
  const linkify = (s) => s.replace(/(https?:\/\/[^\s<]+|www\.[^\s<]+)/g, (u) => `<a href="${u.startsWith('http') ? u : `https://${u}`}">${u}</a>`);
  const paras = String(text).split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${linkify(escHtml(p)).replace(/\n/g, '<br>')}</p>`).join('');
  const foot = footer ? `<p style="margin:22px 0 0;color:#8a8a8a;font-size:12px">${escHtml(footer)}</p>` : '';
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#111">${paras}${foot}</body></html>`;
}

function getTemplate(lang, kind = 'first') {
  return db.prepare('SELECT * FROM templates WHERE lang = ? AND kind = ?').get(lang, kind);
}
// Выбор шаблона: язык компании → запасной язык. null — шаблона нет.
function pickTemplate(lang, kind, fallback) {
  return getTemplate(lang, kind) || (fallback && fallback !== 'skip' ? getTemplate(fallback, kind) : null);
}

function compose(contact, tpl, st, { followupOf } = {}) {
  const subject = followupOf ? (/^re:/i.test(followupOf.subject) ? followupOf.subject : `Re: ${followupOf.subject}`) : fill(tpl.subject, contact, st);
  const text = fill(tpl.body, contact, st);
  const footer = Number(st.unsub_link) ? (UNSUB[tpl.lang] || UNSUB.en) : '';
  return { subject: subject.slice(0, 300), text: footer ? `${text}\n\n—\n${footer}` : text, html: toHtml(text, footer), lang: tpl.lang };
}

module.exports = { VARS, DEFAULTS, seedTemplates, fill, compose, toHtml, getTemplate, pickTemplate, signatureOf, UNSUB };
