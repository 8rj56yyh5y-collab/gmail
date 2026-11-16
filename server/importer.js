'use strict';
// Импорт списков компаний: CSV (любой разделитель), Excel .xlsx, или просто вставленный текст.
// Колонки угадываются по заголовкам на русском/украинском/английском/немецком… — пользователь может поправить.
const zlib = require('node:zlib');
const { db, logEvent } = require('./db');
const C = require('./countries');

class ImportError extends Error { constructor(m) { super(m); this.status = 400; } }

// ---------- CSV ----------
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const counts = { ';': 0, ',': 0, '\t': 0, '|': 0 };
  let inQ = false;
  for (const ch of firstLine) { if (ch === '"') inQ = !inQ; else if (!inQ && ch in counts) counts[ch]++; }
  const sep = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
  const rows = []; let row = []; let cell = ''; inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += ch;
    } else if (ch === '"' && cell === '') inQ = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---------- XLSX (zip + xml, без внешних библиотек) ----------
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ImportError('Файл повреждён или это не .xlsx');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28); const extraLen = buf.readUInt16LE(p + 30); const commLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(local + 26); const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = buf.slice(start, start + csize);
    files[name] = () => (method === 8 ? zlib.inflateRawSync(data) : data);
    p += 46 + nameLen + extraLen + commLen;
  }
  return files;
}
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');
const texts = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');
function colIndex(ref) { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }

function parseXLSX(buf) {
  const z = unzip(buf);
  const get = (n) => (z[n] ? z[n]().toString('utf8') : '');
  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  // первый лист по порядку в книге
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = get('xl/workbook.xml'); const rels = get('xl/_rels/workbook.xml.rels');
  const firstSheet = /<sheet\b[^>]*r:id="([^"]+)"/.exec(wb);
  if (firstSheet && rels) {
    const rel = new RegExp(`<Relationship\\b[^>]*Id="${firstSheet[1]}"[^>]*>`).exec(rels);
    const target = rel && /Target="([^"]+)"/.exec(rel[0]);
    if (target) sheetPath = target[1].startsWith('/') ? target[1].slice(1) : `xl/${target[1].replace(/^\.\//, '')}`;
  }
  const sheet = get(sheetPath);
  if (!sheet) throw new ImportError('В файле Excel не найден лист с данными');
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]; const inner = cm[2] || '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs); const t = (/t="(\w+)"/.exec(attrs) || [])[1];
      const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = texts(inner);
      else if (v != null) val = unxml(v);
      const idx = ref ? colIndex(ref[1]) : row.length;
      row[idx] = val;
    }
    rows.push(Array.from(row, (x) => x ?? ''));
  }
  return rows;
}

// ---------- распознавание колонок ----------
const EMAIL_RE = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const HAS_EMAIL = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const FIELD_HINTS = {
  email: ['email', 'e-mail', 'e mail', 'mail', 'почта', 'пошта', 'емейл', 'імейл', 'эл почта', 'электронная почта', 'електронна пошта', 'correo', 'courriel', 'адрес'],
  company: ['company', 'компания', 'компанія', 'название', 'назва', 'организация', 'організація', 'firma', 'firm', 'organisation', 'organization', 'entreprise', 'empresa', 'unternehmen', 'фирма', 'name of company', 'company name'],
  country: ['country', 'страна', 'країна', 'land', 'pays', 'país', 'pais', 'staat', 'государство'],
  lang: ['language', 'язык', 'мова', 'lang', 'sprache', 'langue', 'idioma'],
  contact_name: ['contact', 'контакт', 'контактное лицо', 'контактна особа', 'имя', "ім'я", 'імя', 'фио', 'піб', 'person', 'name', 'ansprechpartner', 'nom', 'nombre', 'кому'],
  website: ['website', 'web', 'site', 'сайт', 'url', 'www', 'homepage', 'webseite'],
};
const normH = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();

function guessMapping(headers, rows) {
  const m = { email: -1, company: -1, country: -1, lang: -1, contact_name: -1, website: -1, info: [] };
  const used = new Set();
  const h = headers.map(normH);
  for (const field of ['email', 'company', 'country', 'lang', 'website', 'contact_name']) {
    let best = -1;
    h.forEach((x, i) => { if (best < 0 && !used.has(i) && FIELD_HINTS[field].some((k) => x === k)) best = i; });
    h.forEach((x, i) => { if (best < 0 && !used.has(i) && FIELD_HINTS[field].some((k) => k.length > 3 && x.includes(k))) best = i; });
    if (best >= 0) { m[field] = best; used.add(best); }
  }
  // колонка с почтой — та, где больше всего адресов
  if (m.email < 0) {
    const score = headers.map((_, i) => rows.slice(0, 50).filter((r) => HAS_EMAIL.test(String(r[i] || ''))).length);
    const best = score.indexOf(Math.max(...score));
    if (score[best] > 0) { m.email = best; used.add(best); }
  }
  // страна — колонка, где значения узнаются как страны
  if (m.country < 0) {
    const score = headers.map((_, i) => (used.has(i) ? 0 : rows.slice(0, 50).filter((r) => C.findCountry(r[i])).length));
    const best = score.indexOf(Math.max(...score));
    if (score[best] >= Math.max(1, Math.min(rows.length, 50) * 0.3)) { m.country = best; used.add(best); }
  }
  if (m.company < 0) { const i = headers.findIndex((_, i) => !used.has(i) && rows.some((r) => String(r[i] || '').trim())); if (i >= 0) { m.company = i; used.add(i); } }
  m.info = headers.map((_, i) => i).filter((i) => !used.has(i) && rows.some((r) => String(r[i] || '').trim()));
  return m;
}

function readTable(name, buf) {
  const lower = String(name || '').toLowerCase();
  let rows;
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm') || (buf[0] === 0x50 && buf[1] === 0x4b)) rows = parseXLSX(buf);
  else if (lower.endsWith('.xls') && buf[0] === 0xd0) throw new ImportError('Старый формат .xls не поддерживается — в Excel: «Файл → Сохранить как → Книга Excel (.xlsx)» или CSV');
  else rows = parseCSV(buf.toString('utf8'));
  rows = rows.map((r) => r.map((c) => String(c ?? '').trim())).filter((r) => r.some(Boolean));
  if (!rows.length) throw new ImportError('В файле нет данных');
  const width = Math.max(...rows.map((r) => r.length));
  rows = rows.map((r) => Array.from({ length: width }, (_, i) => r[i] || ''));
  // первая строка — заголовки, если в ней нет адресов почты
  const hasHeader = !rows[0].some((c) => /@/.test(c));
  const headers = hasHeader ? rows[0].map((c, i) => c || `Колонка ${i + 1}`) : rows[0].map((_, i) => `Колонка ${i + 1}`);
  return { headers, rows: hasHeader ? rows.slice(1) : rows };
}

// Шаг 1: разобрать файл и показать предпросмотр
function preview(user, { name, data, text }) {
  let buf;
  if (text) buf = Buffer.from(String(text), 'utf8');
  else {
    const m = /^data:[^;]*;base64,(.*)$/s.exec(String(data || ''));
    buf = Buffer.from(m ? m[1] : String(data || ''), 'base64');
  }
  if (!buf.length) throw new ImportError('Пустой файл');
  if (buf.length > 20 * 1024 * 1024) throw new ImportError('Файл больше 20 МБ');
  const { headers, rows } = readTable(text ? 'paste.csv' : name, buf);
  if (rows.length > 50000) throw new ImportError('За раз — до 50 000 строк');
  const mapping = guessMapping(headers, rows);
  const r = db.prepare('INSERT INTO imports (filename, user_id, created_at, headers_json, rows_json, mapping_json, total) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(String(name || 'Вставленный список').slice(0, 200), user.id, Date.now(), JSON.stringify(headers), JSON.stringify(rows), JSON.stringify(mapping), rows.length);
  const id = Number(r.lastInsertRowid);
  return { id, headers, mapping, total: rows.length, sample: buildContacts(headers, rows.slice(0, 200), mapping).slice(0, 12) };
}

function buildContacts(headers, rows, mapping) {
  const cell = (r, i) => (i >= 0 ? String(r[i] || '').trim() : '');
  const out = [];
  for (const r of rows) {
    let emailsCell = cell(r, mapping.email);
    if (!emailsCell) emailsCell = r.join(' ');
    const emails = [...new Set((emailsCell.match(EMAIL_RE) || []).map((e) => e.toLowerCase().replace(/^[.'-]+|[.'-]+$/g, '')))];
    const company = cell(r, mapping.company);
    const countryRaw = cell(r, mapping.country);
    const website = cell(r, mapping.website);
    const info = (mapping.info || []).map((i) => (cell(r, i) ? `${headers[i]}: ${cell(r, i)}` : '')).filter(Boolean).join('\n');
    if (!emails.length) { out.push({ invalid: true, company, reason: 'нет адреса почты' }); continue; }
    for (const email of emails) {
      const country = C.findCountry(countryRaw) || C.countryFromEmail(email);
      const lang = C.findLang(cell(r, mapping.lang)) || C.langOf(country) || 'en';
      out.push({ email, company: company || email.split('@')[1], contact_name: cell(r, mapping.contact_name), country, country_raw: countryRaw, lang, website, info });
    }
  }
  return out;
}

function remap(id, mapping) {
  const imp = db.prepare("SELECT * FROM imports WHERE id = ? AND status = 'preview'").get(Number(id));
  if (!imp) throw new ImportError('Импорт не найден');
  const headers = JSON.parse(imp.headers_json); const rows = JSON.parse(imp.rows_json);
  const m = sanitizeMapping(mapping, headers.length);
  db.prepare('UPDATE imports SET mapping_json = ? WHERE id = ?').run(JSON.stringify(m), imp.id);
  return { id: imp.id, headers, mapping: m, total: rows.length, sample: buildContacts(headers, rows.slice(0, 200), m).slice(0, 12) };
}
function sanitizeMapping(mapping, width) {
  const ok = (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) < width ? Number(v) : -1);
  const m = {};
  for (const k of ['email', 'company', 'country', 'lang', 'contact_name', 'website']) m[k] = ok(mapping?.[k]);
  m.info = [...new Set((Array.isArray(mapping?.info) ? mapping.info : []).map(ok).filter((x) => x >= 0))];
  return m;
}

// Шаг 2: записать в базу (повторяющиеся адреса пропускаются — старые данные не трогаем, только дополняем пустые поля)
function commit(user, id, mapping) {
  const imp = db.prepare("SELECT * FROM imports WHERE id = ? AND status = 'preview'").get(Number(id));
  if (!imp) throw new ImportError('Импорт не найден или уже выполнен');
  const headers = JSON.parse(imp.headers_json); const rows = JSON.parse(imp.rows_json);
  const m = mapping ? sanitizeMapping(mapping, headers.length) : JSON.parse(imp.mapping_json);
  if (m.email < 0 && !rows.some((r) => HAS_EMAIL.test(r.join(' ')))) throw new ImportError('Не выбрана колонка с почтой');
  const list = buildContacts(headers, rows, m);
  const now = Date.now();
  let added = 0; let dupes = 0; let invalid = 0;
  const find = db.prepare('SELECT * FROM contacts WHERE email = ?');
  const ins = db.prepare(`INSERT INTO contacts (email, company, contact_name, country, country_raw, lang, website, info, import_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const fill = db.prepare(`UPDATE contacts SET company = CASE WHEN company = '' THEN ? ELSE company END, contact_name = CASE WHEN contact_name = '' THEN ? ELSE contact_name END,
    website = CASE WHEN website = '' THEN ? ELSE website END, info = CASE WHEN info = '' THEN ? ELSE info END, updated_at = ? WHERE id = ?`);
  db.exec('BEGIN');
  try {
    for (const c of list) {
      if (c.invalid || c.email.length > 200) { invalid++; continue; }
      const ex = find.get(c.email);
      if (ex) { dupes++; fill.run(c.company, c.contact_name, c.website, c.info, now, ex.id); continue; }
      ins.run(c.email, c.company.slice(0, 300), c.contact_name.slice(0, 200), c.country, c.country_raw.slice(0, 100), c.lang, c.website.slice(0, 300), c.info.slice(0, 5000), imp.id, now, now);
      added++;
    }
    db.prepare("UPDATE imports SET status = 'done', mapping_json = ?, added = ?, dupes = ?, invalid = ?, rows_json = '[]' WHERE id = ?").run(JSON.stringify(m), added, dupes, invalid, imp.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logEvent(user.id, 'import', imp.id, 'import', { added, dupes, invalid });
  return { id: imp.id, added, dupes, invalid, total: list.length };
}

module.exports = { preview, remap, commit, parseCSV, parseXLSX, readTable, guessMapping, buildContacts, ImportError };
