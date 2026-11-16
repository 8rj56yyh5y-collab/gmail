'use strict';
// База Gobsek Mail — встроенный SQLite из Node 22 (node:sqlite).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(FILE_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'mail.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  must_change_pw INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_login INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT, ua TEXT
);
CREATE TABLE IF NOT EXISTS login_fails (key TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS login_fails_key ON login_fails(key, ts);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Загруженные файлы со списками компаний
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  filename TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview','done')),
  headers_json TEXT NOT NULL,
  rows_json TEXT NOT NULL,
  mapping_json TEXT NOT NULL DEFAULT '{}',
  total INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  dupes INTEGER NOT NULL DEFAULT 0,
  invalid INTEGER NOT NULL DEFAULT 0
);

-- Компании (один адрес — одна строка)
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  company TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',        -- ISO-код страны (DE, FR…) или пусто
  country_raw TEXT NOT NULL DEFAULT '',    -- как было написано в файле
  lang TEXT NOT NULL DEFAULT 'en',
  website TEXT NOT NULL DEFAULT '',
  info TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','queued','sent','replied','bounced','unsubscribed','blocked')),
  import_id INTEGER REFERENCES imports(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_sent_at INTEGER,
  last_reply_at INTEGER
);
CREATE INDEX IF NOT EXISTS contacts_status ON contacts(status);

-- Шаблоны писем: на каждый язык — первое письмо и напоминание
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY,
  lang TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'first' CHECK (kind IN ('first','followup')),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (lang, kind)
);
CREATE TABLE IF NOT EXISTS template_files (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  name TEXT NOT NULL, mime TEXT NOT NULL, stored TEXT NOT NULL, size INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','paused','done','cancelled')),
  followup_days INTEGER NOT NULL DEFAULT 0,
  fallback TEXT NOT NULL DEFAULT 'en',
  filter_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);

-- Все письма: исходящие (рассылка, напоминания, ответы из системы) и входящие (ответы компаний)
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES campaigns(id),
  direction TEXT NOT NULL CHECK (direction IN ('out','in')),
  kind TEXT NOT NULL CHECK (kind IN ('first','followup','manual','reply','auto','bounce')),
  status TEXT NOT NULL CHECK (status IN ('queued','sent','failed','cancelled','received')),
  lang TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',     -- текст письма (для входящих — без цитаты нашего письма)
  full_text TEXT NOT NULL DEFAULT '',     -- входящее целиком, с цитатой
  from_addr TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  to_addr TEXT NOT NULL DEFAULT '',
  message_id TEXT,
  in_reply_to TEXT NOT NULL DEFAULT '',
  refs TEXT NOT NULL DEFAULT '',
  parent_id INTEGER REFERENCES messages(id),
  scheduled_at INTEGER,
  sent_at INTEGER,
  received_at INTEGER,
  error TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  unsubscribe INTEGER NOT NULL DEFAULT 0,
  translation TEXT NOT NULL DEFAULT '',
  forwarded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_queue ON messages(status, scheduled_at);
CREATE INDEX IF NOT EXISTS messages_contact ON messages(contact_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS messages_msgid ON messages(message_id) WHERE message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  name TEXT NOT NULL, mime TEXT NOT NULL, stored TEXT NOT NULL, size INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
`);

function logEvent(userId, entity, entityId, action, data = {}) {
  db.prepare('INSERT INTO events (ts, user_id, entity, entity_id, action, data) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Date.now(), userId ?? null, entity, entityId ?? null, action, JSON.stringify(data));
}

// ---------- настройки ----------
const DEFAULT_SETTINGS = {
  // почтовый ящик
  provider: 'gmail',
  smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_secure: 1,
  imap_host: 'imap.gmail.com', imap_port: 993, imap_secure: 1,
  mail_user: '', mail_pass: '',
  from_name: '', reply_to: '',
  // о нас — подставляется в письма
  my_company: '', sender_name: '', sender_position: '', phone: '', website: '', signature: '',
  // отправка
  sending_enabled: 0,
  daily_limit: 120,
  delay_min: 60, delay_max: 150,
  window_from: 8, window_to: 18, weekdays_only: 1, timezone: 'Europe/Berlin',
  fallback_lang: 'en',
  // входящие
  imap_enabled: 1, poll_sec: 120,
  forward_to: '',
  unsub_link: 1,
};
const SECRET_KEYS = ['mail_pass'];
const NUM_KEYS = Object.keys(DEFAULT_SETTINGS).filter((k) => typeof DEFAULT_SETTINGS[k] === 'number');

// Пароль почты в базе хранится зашифрованным (AES-256-GCM). Ключ — APP_SECRET или файл data/.secret.
function secretKey() {
  if (process.env.APP_SECRET) return crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
  const f = path.join(DATA_DIR, '.secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
}
const KEY = secretKey();
function encrypt(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}
function decrypt(v) {
  if (!v || !v.startsWith('v1:')) return v || '';
  try {
    const [, iv, tag, data] = v.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'hex'));
    d.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8');
  } catch { return ''; }
}

// Переменные окружения сильнее настроек из интерфейса (удобно для хостинга).
const ENV_MAP = {
  smtp_host: 'SMTP_HOST', smtp_port: 'SMTP_PORT', imap_host: 'IMAP_HOST', imap_port: 'IMAP_PORT',
  mail_user: 'MAIL_USER', mail_pass: 'MAIL_PASSWORD', from_name: 'FROM_NAME', forward_to: 'FORWARD_TO',
};
function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    if (!(key in DEFAULT_SETTINGS) && !key.startsWith('_')) continue;
    out[key] = NUM_KEYS.includes(key) ? Number(value) : SECRET_KEYS.includes(key) ? decrypt(value) : value;
  }
  for (const [k, env] of Object.entries(ENV_MAP)) {
    if (process.env[env]) out[k] = NUM_KEYS.includes(k) ? Number(process.env[env]) : process.env[env];
  }
  return out;
}
const envLocked = () => Object.entries(ENV_MAP).filter(([, e]) => process.env[e]).map(([k]) => k);
function setSetting(key, value) {
  const v = SECRET_KEYS.includes(key) ? encrypt(value) : String(value);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, v);
}
// Служебные значения (состояние почтового ящика, ошибки) — ключи с «_».
const getState = (key, def = '') => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(`_${key}`); return r ? r.value : def; };
const setState = (key, value) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`_${key}`, String(value ?? ''));

module.exports = { db, DATA_DIR, FILE_DIR, logEvent, DEFAULT_SETTINGS, getSettings, setSetting, getState, setState, envLocked, NUM_KEYS };
