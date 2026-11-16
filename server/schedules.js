'use strict';
// Запланированные рассылки. В назначенное время создаётся обычная рассылка: получатели собираются
// в этот момент по сохранённому фильтру, поэтому компании, загруженные позже, тоже попадут.
// Повторы: каждую неделю, каждые 2 недели, каждый месяц (в тот же день и час по часам пользователя).
const { db, logEvent, setSetting } = require('./db');
const mailer = require('./mailer');
const { HttpError, str } = require('./contacts');

const REPEAT = { once: 'Один раз', weekly: 'Каждую неделю', biweekly: 'Каждые 2 недели', monthly: 'Каждый месяц' };
const PERIOD_DAYS = { weekly: 7, biweekly: 14, monthly: 30 };

// ---------- время в часовом поясе пользователя ----------
function validTz(tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }
function partsIn(ts, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(ts)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return p; // { year, month (1-12), day, hour, minute, second }
}
// «12 мая 10:00 по Киеву» → момент времени
function zoned(y, mo, d, h, mi, tz) {
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = partsIn(guess, tz);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += Date.UTC(y, mo - 1, d, h, mi) - shown;
  }
  return guess;
}
const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

// Следующий запуск после момента `after`
function nextRun(s, after) {
  if (s.repeat === 'once') return null;
  const p = partsIn(after, s.tz);
  if (s.repeat === 'monthly') {
    let y = p.year; let mo = p.month;
    for (let i = 0; i < 3; i++) {
      const t = zoned(y, mo, Math.min(s.day, daysInMonth(y, mo)), s.hour, s.minute, s.tz);
      if (t > after + 60e3) return t;
      mo += 1; if (mo > 12) { mo = 1; y += 1; }
    }
  }
  // неделя / 2 недели: шагаем от прошлого запланированного дня, чтобы сохранить день недели
  const step = PERIOD_DAYS[s.repeat];
  const b = partsIn(s.next_run_at || after, s.tz);
  let y = b.year; let mo = b.month; let d = b.day;
  let t = zoned(y, mo, d, s.hour, s.minute, s.tz);
  while (t <= after + 60e3) {
    const n = new Date(Date.UTC(y, mo - 1, d + step));
    y = n.getUTCFullYear(); mo = n.getUTCMonth() + 1; d = n.getUTCDate();
    t = zoned(y, mo, d, s.hour, s.minute, s.tz);
  }
  return t;
}

// ---------- создание / изменение ----------
function create(user, body) {
  const repeat = REPEAT[body.repeat] ? body.repeat : 'once';
  const at = Number(body.run_at);
  if (!Number.isFinite(at)) throw new HttpError(400, 'Выберите дату и время');
  if (at < Date.now() - 5 * 60e3) throw new HttpError(400, 'Эта дата уже прошла');
  const tz = validTz(body.tz) ? body.tz : 'Europe/Kyiv';
  const p = partsIn(at, tz);
  const ends = body.ends_at ? Number(body.ends_at) : null;
  if (ends && ends <= at) throw new HttpError(400, 'Дата окончания должна быть позже первого запуска');
  const filter = { ...(body.filter || {}) };
  // в повторяющихся по умолчанию не пишем одной и той же компании чаще, чем раз в период
  if (repeat !== 'once' && filter.gap_days == null) filter.gap_days = PERIOD_DAYS[repeat];
  const name = str(body.name, 120) || (repeat === 'once' ? 'Запланированная рассылка' : `${REPEAT[repeat]} — рассылка`);
  const id = Number(db.prepare(`INSERT INTO schedules (name, repeat, next_run_at, day, hour, minute, tz, ends_at, filter_json, fallback, followup_days, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(name, repeat, at, p.day, p.hour, p.minute, tz, ends, JSON.stringify(filter),
    body.fallback === 'skip' ? 'skip' : str(body.fallback, 5) || 'en', Math.max(0, Math.min(60, Math.round(Number(body.followup_days) || 0))), user.id, Date.now()).lastInsertRowid);
  logEvent(user.id, 'schedule', id, 'create', { repeat, at });
  return get(id);
}

function get(id) {
  const s = db.prepare('SELECT * FROM schedules WHERE id = ?').get(Number(id));
  if (!s) throw new HttpError(404, 'Запланированная рассылка не найдена');
  return s;
}

function list() {
  return db.prepare('SELECT s.*, c.name last_campaign_name FROM schedules s LEFT JOIN campaigns c ON c.id = s.last_campaign_id ORDER BY s.active DESC, COALESCE(s.next_run_at, 9e15), s.id DESC').all()
    .map((s) => {
      let audience = null;
      if (s.active) { try { audience = mailer.previewCampaign({ filter: JSON.parse(s.filter_json), fallback: s.fallback }).will_send; } catch { audience = null; } }
      return { ...s, filter: JSON.parse(s.filter_json), audience_now: audience };
    });
}

function update(user, id, body) {
  const s = get(id);
  if (body.action === 'pause') db.prepare('UPDATE schedules SET active = 0 WHERE id = ?').run(s.id);
  else if (body.action === 'resume') {
    let next = s.next_run_at;
    if (!next || next < Date.now()) next = s.repeat === 'once' ? null : nextRun(s, Date.now());
    if (!next) throw new HttpError(409, 'Дата уже прошла — выберите новую');
    db.prepare('UPDATE schedules SET active = 1, next_run_at = ? WHERE id = ?').run(next, s.id);
  } else if (body.action === 'reschedule') {
    const at = Number(body.run_at);
    if (!Number.isFinite(at) || at < Date.now() - 5 * 60e3) throw new HttpError(400, 'Выберите дату в будущем');
    const tz = validTz(body.tz) ? body.tz : s.tz;
    const p = partsIn(at, tz);
    db.prepare('UPDATE schedules SET next_run_at = ?, day = ?, hour = ?, minute = ?, tz = ?, active = 1 WHERE id = ?').run(at, p.day, p.hour, p.minute, tz, s.id);
  } else if (body.action === 'delete') {
    db.prepare('DELETE FROM schedules WHERE id = ?').run(s.id);
    logEvent(user.id, 'schedule', s.id, 'delete');
    return { deleted: true };
  } else throw new HttpError(400, 'Неизвестное действие');
  logEvent(user.id, 'schedule', s.id, body.action);
  return get(s.id);
}

// ---------- запуск ----------
function runOne(s, { manual = false } = {}) {
  const now = Date.now();
  const user = { id: s.created_by };
  const d = new Date(now).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: s.tz });
  let result; let campaignId = null;
  try {
    const r = mailer.createCampaign(user, { name: `${s.name} · ${d}`, filter: JSON.parse(s.filter_json), fallback: s.fallback, followup_days: s.followup_days, start_now: false });
    campaignId = r.id;
    result = `Поставлено в очередь: ${r.queued} писем`;
    // запланированная рассылка сама включает отправку — письма уйдут в рабочее время с обычными паузами
    setSetting('sending_enabled', 1);
  } catch (e) {
    result = e.status === 400 ? 'Некому отправлять — все подходящие компании уже получили письмо' : `Ошибка: ${e.message}`;
  }
  let next = manual ? s.next_run_at : nextRun(s, now);
  if (next && s.ends_at && next > s.ends_at) next = null;
  db.prepare('UPDATE schedules SET runs = runs + 1, last_run_at = ?, last_result = ?, last_campaign_id = COALESCE(?, last_campaign_id), next_run_at = ?, active = ? WHERE id = ?')
    .run(now, result, campaignId, next, next ? s.active : 0, s.id);
  logEvent(null, 'schedule', s.id, 'run', { result, campaign: campaignId, manual });
  return { result, campaign_id: campaignId, next_run_at: next };
}
function runNow(user, id) { const s = get(id); return runOne(s, { manual: true }); }

function tick(now = Date.now()) {
  const due = db.prepare('SELECT * FROM schedules WHERE active = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?').all(now);
  return due.map((s) => runOne(s));
}

function nextUp() {
  return db.prepare('SELECT id, name, repeat, next_run_at FROM schedules WHERE active = 1 AND next_run_at IS NOT NULL ORDER BY next_run_at LIMIT 1').get() || null;
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => { try { tick(); } catch (e) { console.error('Расписание:', e.message || e); } }, 30000);
  timer.unref();
  try { tick(); } catch { /* при старте — не страшно */ }
}

module.exports = { REPEAT, create, list, update, runNow, tick, nextRun, nextUp, start, zoned, partsIn };
