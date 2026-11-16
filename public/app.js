'use strict';
/* Gobsek Mail — интерфейс (без фреймворков). Маршруты через #/... */
(function () {
  // ================= Утилиты =================
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ic = (n, s = 18) => window.icon(n, s);
  const S = { me: null, meta: null, badges: {}, timers: [] };
  const nf = (n, d = 0) => (n == null || n === '' ? '—' : Number(n).toLocaleString('ru-RU', { maximumFractionDigits: d }));
  const pct = (a, b) => (b ? `${nf((a / b) * 100, 1)}%` : '—');
  const dt = (ts) => (ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
  const dOnly = (ts) => (ts ? new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '—');
  const ago = (ts) => {
    if (!ts) return '—';
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return 'только что';
    if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
    if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)} дн назад`;
    return dOnly(ts);
  };
  const inTime = (ts) => { const s = Math.max(0, Math.round((ts - Date.now()) / 1000)); return s < 60 ? `${s} с` : s < 3600 ? `${Math.floor(s / 60)} мин ${s % 60} с` : `${Math.floor(s / 3600)} ч ${Math.floor((s % 3600) / 60)} мин`; };
  const initials = (n) => String(n || '?').replace(/[^\p{L}\s]/gu, '').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  const flag = (cc) => (/^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '🏳️');
  const cname = (cc) => ((S.meta.countries || []).find((c) => c.code === cc) || {}).name || cc || 'Не указана';
  const lname = (l) => (S.meta.langs || {})[l] || l;
  const langTag = (l, miss = false) => `<span class="lang${miss ? ' miss' : ''}" title="${esc(lname(l))}">${esc(l)}</span>`;
  const STATUS = { new: 'Новая', queued: 'В очереди', sent: 'Письмо отправлено', replied: 'Ответили', bounced: 'Адрес не существует', unsubscribed: 'Просили не писать', blocked: 'В стоп-листе' };
  const CSTATUS = { running: 'Идёт', paused: 'На паузе', done: 'Завершена', cancelled: 'Отменена' };
  const pill = (s, text) => `<span class="pill s-${esc(s)}">${esc(text || STATUS[s] || CSTATUS[s] || s)}</span>`;
  const REPEAT = { once: 'Один раз', weekly: 'Каждую неделю', biweekly: 'Каждые 2 недели', monthly: 'Каждый месяц' };
  const myTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Kyiv'; } catch { return 'Europe/Kyiv'; } };
  const dWhen = (ts) => (ts ? new Date(ts).toLocaleString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '—');
  const localInput = (ts) => { const d = new Date(ts); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  const repeatText = (s) => (s.repeat === 'monthly' ? `Каждый месяц, ${s.day}-го числа в ${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}` : s.repeat === 'once' ? 'Один раз' : `${REPEAT[s.repeat]}, ${new Date(s.next_run_at || Date.now()).toLocaleDateString('ru-RU', { weekday: 'long' })} в ${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`);
  const KIND = { first: 'Первое письмо', followup: 'Напоминание', manual: 'Письмо', reply: 'Ответ', auto: 'Автоответ', bounce: 'Не доставлено' };

  async function api(path, opts = {}) {
    const o = { method: opts.method || 'GET', headers: { 'X-GM': '1' }, credentials: 'same-origin' };
    if (opts.body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opts.body); }
    const res = await fetch(path, o);
    let data = {};
    try { data = await res.json(); } catch { /* пусто */ }
    if (res.status === 401 && !path.startsWith('/api/login')) { S.me = null; go('#/login'); throw new Error(data.error || 'Войдите в систему'); }
    if (res.status === 428) { S.me = { ...(S.me || {}), must_change_pw: true }; render(); throw new Error(data.error); }
    if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
    return data;
  }
  const post = (p, body) => api(p, { method: 'POST', body: body || {} });
  const put = (p, body) => api(p, { method: 'PUT', body });
  const del = (p) => api(p, { method: 'DELETE', body: {} });

  let toastT;
  function toast(msg, err = false) {
    const t = $('#toast'); t.textContent = msg; t.className = `toast show${err ? ' err' : ''}`;
    clearTimeout(toastT); toastT = setTimeout(() => { t.className = 'toast'; }, err ? 5200 : 2600);
  }
  const fail = (e) => toast(e.message || String(e), true);
  const busy = async (btn, fn) => { if (btn) btn.disabled = true; try { return await fn(); } catch (e) { fail(e); return null; } finally { if (btn) btn.disabled = false; } };
  const readFile = (file) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });

  function modal(html, { wide = false, onOpen } = {}) {
    const m = $('#modal');
    m.innerHTML = `<div class="box${wide ? ' wide' : ''}">${html}</div>`;
    m.classList.remove('hidden');
    return new Promise((resolve) => {
      const close = (v) => { m.classList.add('hidden'); m.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') close(null); };
      document.addEventListener('keydown', onKey);
      m.onclick = (e) => { if (e.target === m) close(null); const c = e.target.closest('[data-close]'); if (c) close(c.dataset.close === 'ok' ? true : null); };
      if (onOpen) onOpen($('.box', m), close);
    });
  }
  function ask({ title, text = '', fields = [], ok = 'Готово', danger = false }) {
    const fh = fields.map((f) => `<label class="field"><span>${esc(f.label)}</span>${f.type === 'select'
      ? `<select class="input" name="${f.name}">${f.options.map(([v, t]) => `<option value="${esc(v)}" ${String(f.value ?? '') === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`
      : f.type === 'textarea' ? `<textarea class="input" name="${f.name}" rows="5" style="height:auto;padding:10px 14px" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`
      : `<input class="input" name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}">`}
      ${f.hint ? `<small class="hint">${esc(f.hint)}</small>` : ''}</label>`).join('');
    return modal(`<h2>${esc(title)}</h2>${text ? `<p class="muted" style="margin:0">${text}</p>` : ''}<form class="stack" novalidate>${fh}
      <div class="acts"><button type="button" class="btn soft" data-close>Отмена</button><button class="btn ${danger ? 'danger' : ''}">${esc(ok)}</button></div></form>`, {
      onOpen: (box, close) => {
        const form = $('form', box);
        const first = $('input,textarea', form); if (first) setTimeout(() => first.focus(), 30);
        form.onsubmit = (e) => {
          e.preventDefault();
          const out = {};
          for (const f of fields) {
            const el = form.elements[f.name]; const v = el.value.trim();
            if (f.required && !v) { el.classList.add('bad'); el.focus(); return; }
            out[f.name] = v;
          }
          close(out);
        };
      },
    });
  }
  const confirmBox = (title, text, ok = 'Да', danger = false) => ask({ title, text, ok, danger }).then((r) => !!r);

  // ================= Маршрутизация =================
  const go = (h) => { if (location.hash === h) render(); else location.hash = h; };
  window.addEventListener('hashchange', () => render());
  function route() {
    const h = location.hash.replace(/^#/, '') || '/';
    const [path, qs] = h.split('?');
    return { path, parts: path.split('/').filter(Boolean), q: Object.fromEntries(new URLSearchParams(qs || '')) };
  }
  const qs = (o) => { const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString(); return s ? `?${s}` : ''; };

  // ================= Каркас =================
  const NAV = [
    ['/', 'home', 'Обзор'], ['/inbox', 'inbox', 'Входящие', 'unread'], ['/companies', 'building', 'Компании'], ['/send', 'send', 'Рассылка', 'queued'],
    ['/templates', 'doc', 'Шаблоны писем'], ['/import', 'upload', 'Загрузить файл'], ['sep'], ['/settings', 'sliders', 'Настройки'],
  ];
  const TABS = [['/', 'home', 'Обзор'], ['/inbox', 'inbox', 'Входящие', 'unread'], ['/import', 'plus', 'Файл', null, true], ['/send', 'send', 'Рассылка'], ['/more', 'menu', 'Ещё']];
  const brandMark = '<span class="brand-mark">GM</span>';

  function shell(content) {
    const r = route();
    const active = (p) => (p === '/' ? r.path === '/' : r.path.startsWith(p) || (p === '/companies' && r.parts[0] === 'c'));
    const badge = (k) => (k && S.badges[k] ? `<span class="badge${k === 'unread' ? ' red' : ''}">${S.badges[k]}</span>` : '');
    const nav = NAV.map(([p, i, t, b]) => (p === 'sep' ? '<div class="nav-sep"></div>' : `<a href="#${p}" class="${active(p) ? 'on' : ''}">${ic(i, 19)}<span>${t}</span>${badge(b)}</a>`)).join('');
    const tabs = TABS.map(([p, i, t, b, plus]) => `<a href="#${p}" class="${plus ? 'plus' : ''} ${!plus && active(p) ? 'on' : ''}">${plus ? `<span class="pl">${ic(i, 24)}</span>` : ic(i, 22)}<span>${t}</span>${badge(b)}</a>`).join('');
    const theme = document.documentElement.dataset.theme;
    return `<div class="shell">
      <aside class="side">
        <a class="brand" href="#/">${brandMark}<span><b>${esc(S.meta.name)}</b><span>Письма компаниям Европы</span></span></a>
        <a class="btn hl" href="#/send/new">${ic('send', 18)} Новая рассылка</a>
        <nav class="nav">${nav}</nav>
        <div class="side-foot">
          ${S.meta.test_mode ? `<div class="note warn xs">${ic('info', 15)}<span>Тестовый режим: письма никуда не уходят</span></div>` : ''}
          <div class="theme-switch" role="group" aria-label="Тема">${themeButtons(theme)}</div>
          <a class="me" href="#/settings/profile"><span class="avatar">${esc(initials(S.me.name))}</span><span style="min-width:0"><b>${esc(S.me.name)}</b><span>${esc(S.me.login)}</span></span></a>
        </div>
      </aside>
      <header class="top"><a class="brand" href="#/">${brandMark}<span><b>${esc(S.meta.name)}</b></span></a>
        <div class="row"><a class="icon-btn" href="#/send/new" aria-label="Новая рассылка">${ic('send', 20)}</a><a class="icon-btn" href="#/settings" aria-label="Настройки">${ic('sliders', 20)}</a></div></header>
      <main class="main" id="main">${content}</main>
      <nav class="tabbar">${tabs}</nav>
    </div>`;
  }
  const themeButtons = (theme) => [['light', 'sun', 'Белая'], ['dark', 'moon', 'Чёрная']].map(([t, i, n]) => `<button data-theme-set="${t}" class="${theme === t ? 'on' : ''}">${ic(i, 15)} ${n}</button>`).join('');
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('gm-theme', t); } catch { /* приватный режим */ }
    $$('[data-theme-set]').forEach((b) => b.classList.toggle('on', b.dataset.themeSet === t));
    const meta = document.querySelector('meta[name=theme-color]'); if (meta) meta.content = t === 'dark' ? '#000000' : '#ffffff';
  }
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-theme-set]'); if (b) setTheme(b.dataset.themeSet); });

  async function loadBadges() { try { S.badges = await api('/api/badges'); } catch { /* не страшно */ } }
  function refreshNavBadges() {
    const shellEl = $('.shell'); if (!shellEl) return;
    const tmp = document.createElement('div'); tmp.innerHTML = shell('');
    $('.side .nav', shellEl).innerHTML = $('.side .nav', tmp).innerHTML;
    $('.tabbar', shellEl).innerHTML = $('.tabbar', tmp).innerHTML;
  }
  // раз в минуту обновляем счётчики (новые ответы)
  setInterval(() => { if (S.me && !S.me.must_change_pw && document.visibilityState === 'visible') loadBadges().then(refreshNavBadges); }, 60000);

  // ================= Рендер =================
  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    S.timers.forEach(clearInterval); S.timers = [];
    const root = $('#root');
    if (!S.meta) { try { S.meta = await api('/api/meta'); } catch (e) { root.innerHTML = `<div class="card empty" style="margin:40px">${esc(e.message)}</div>`; return; } }
    if (!S.me) { try { S.me = (await api('/api/me')).user; } catch { S.me = null; } }
    if (!S.me) return pageLogin(root);
    if (S.me.must_change_pw) return pageForcePassword(root);
    const r = route();
    const pages = {
      '': pageHome, inbox: pageInbox, companies: pageCompanies, c: pageCompany, import: pageImport, send: r.parts[1] === 'new' ? pageNewCampaign : pageSend,
      templates: r.parts[1] ? pageTemplate : pageTemplates, settings: pageSettings, more: pageMore, login: pageHome,
    };
    const page = pages[r.parts[0] || ''] || pageNotFound;
    if (!$('.shell')) root.innerHTML = shell('');
    else { const tmp = document.createElement('div'); tmp.innerHTML = shell(''); $('.side .nav').innerHTML = $('.side .nav', tmp).innerHTML; $('.tabbar').innerHTML = $('.tabbar', tmp).innerHTML; }
    $('#main').innerHTML = '<div class="sk" style="height:110px;margin-bottom:16px"></div><div class="sk" style="height:360px"></div>';
    window.scrollTo(0, 0);
    try {
      const html = await page(r);
      if (seq !== renderSeq) return;
      if (typeof html === 'string') $('#main').innerHTML = html;
      if (page.after) page.after(r);
    } catch (e) {
      if (seq !== renderSeq) return;
      $('#main').innerHTML = `<div class="card empty">${ic('alert', 32)}<p>${esc(e.message)}</p><a class="btn soft" href="#/">На главную</a></div>`;
    }
    loadBadges().then(() => { if (seq === renderSeq) refreshNavBadges(); });
  }
  const rerender = () => render();
  function pageNotFound() { return `<div class="card empty">${ic('info', 32)}<h2>Страница не найдена</h2><a class="btn soft" href="#/">На главную</a></div>`; }
  const head = (title, sub = '', actions = '', crumbs = '') => `${crumbs ? `<div class="crumbs">${crumbs}</div>` : ''}<div class="page-head"><div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div><div class="row">${actions}</div></div>`;
  function kpi(label, value, cmp = '', cls = '') { return `<div class="kpi ${cls}"><div class="lbl">${label}</div><div class="val">${value}</div>${cmp ? `<div class="cmp">${cmp}</div>` : ''}</div>`; }
  const listCard = (title, items, empty, more = '') => `<div class="card flush"><div class="card-h" style="padding:16px 18px 0">${title}${more}</div><div class="list" style="margin-top:6px">${items.length ? items.join('') : `<div class="empty">${empty}</div>`}</div></div>`;

  // ================= Вход =================
  // Фраза на странице входа — каждый раз другая. Спокойно, по делу, без пафоса.
  const MOTTOS = [
    'Каждое отправленное письмо — ещё один шанс. Шансов становится больше с каждым днём.',
    'Не ответят все. Но хватит одного хорошего ответа, чтобы многое поменялось.',
    'Сегодняшнее письмо может стать завтрашним партнёрством.',
    'Большие дела складываются из маленьких шагов, сделанных вовремя.',
    'Попросить о помощи — тоже работа. И её делают те, кто не сдаётся.',
    'Регулярность делает больше, чем удача.',
    'Мы делаем своё дело хорошо. Осталось, чтобы об этом узнали.',
    'Где-то в Европе есть компания, которая ждёт именно такого письма.',
    'Ответ, который всё изменит, может прийти уже сегодня.',
  ];
  function pageLogin(root) {
    root.innerHTML = `<div class="auth">
      <section class="auth-art">
        <a class="brand">${brandMark}<span><b>${esc(S.meta.name)}</b><span>письма компаниям Европы</span></span></a>
        <div><h1>Одно письмо — на родном языке каждой компании</h1><p>Загрузите файл со списком компаний — система сама определит страну, выберет письмо на нужном языке, отправит его и соберёт ответы во «Входящие».</p>
          <blockquote class="motto">${esc(MOTTOS[Math.floor(Math.random() * MOTTOS.length)])}</blockquote></div>
        <div class="pts">
          <div class="pt">${ic('globe', 20)}<span><b>Язык по стране</b>Германия — по-немецки, Испания — по-испански. Без ручной сортировки.</span></div>
          <div class="pt">${ic('clock', 20)}<span><b>Спокойная отправка</b>Паузы между письмами и дневной лимит — чтобы почта не попала в спам.</span></div>
          <div class="pt">${ic('inbox', 20)}<span><b>Ответы в одном месте</b>Каждый ответ — во «Входящих» и пересылкой на вашу почту.</span></div>
        </div>
      </section>
      <section class="auth-form"><form class="box" id="lf" novalidate>
        <div><h2 style="margin-bottom:4px">Вход</h2><p class="muted" style="margin:0">Войдите, чтобы продолжить работу.</p></div>
        <label class="field"><span>Логин</span><input class="input" name="login" autocomplete="username" autocapitalize="none" required></label>
        <label class="field"><span>Пароль</span><input class="input" name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn lg block">Войти</button>
        <p class="faint xs" style="margin:0">Нет доступа — попросите администратора добавить вас в «Настройках → Команда».</p>
      </form></section></div>`;
    $('#lf').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      await busy($('button', f), async () => { const r = await post('/api/login', { login: f.login.value.trim(), password: f.password.value }); S.me = r.user; go('#/'); });
    };
    setTimeout(() => $('#lf input').focus(), 30);
  }
  function pageForcePassword(root) {
    root.innerHTML = `<div class="auth"><section class="auth-art"><a class="brand">${brandMark}<span><b>${esc(S.meta.name)}</b></span></a>
      <div><h1>Придумайте свой пароль</h1><p>Вы вошли по временному паролю. Задайте постоянный — его будете знать только вы.</p></div><div></div></section>
      <section class="auth-form"><form class="box" id="pf" novalidate>
        <h2 style="margin:0">Смена пароля</h2>
        <label class="field"><span>Временный пароль</span><input class="input" name="current" type="password" autocomplete="current-password" required></label>
        <label class="field"><span>Новый пароль</span><input class="input" name="next" type="password" autocomplete="new-password" required><small class="hint">Минимум 8 символов, буквы и цифры</small></label>
        <button class="btn lg block">Сохранить и войти</button>
      </form></section></div>`;
    $('#pf').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target;
      await busy($('button', f), async () => { const r = await post('/api/password', { current: f.current.value, next: f.next.value }); S.me = r.user; go('#/'); });
    };
  }

  // ================= Статус отправки (общий блок) =================
  function senderCard(s, inb, nextSch) {
    const err = s.error;
    const cls = err ? 'err' : s.enabled && !s.waiting ? 'on' : '';
    const title = !s.configured ? 'Почта не подключена' : err ? 'Отправка остановлена' : s.enabled ? (s.waiting ? 'Рассылка включена' : 'Идёт отправка') : 'Рассылка на паузе';
    const sub = !s.configured ? 'Подключите ящик в настройках — и можно запускать рассылку.'
      : err ? esc(err)
      : s.enabled && !s.waiting ? `<span class="pulse"></span> Следующее письмо через <b data-next="${s.next_at}">${inTime(s.next_at)}</b> · в очереди ${nf(s.due)}`
      : `${s.enabled ? esc(s.waiting || '') : 'Письма не уходят, пока не нажмёте «Запустить»'}${s.queued ? ` · в очереди ${nf(s.queued)}` : ''}`;
    const btn = !s.configured ? `<a class="btn" href="#/settings">${ic('plug', 18)} Подключить почту</a>`
      : s.enabled ? `<button class="btn soft" data-sender="0">${ic('pause', 18)} Пауза</button>` : `<button class="btn hl" data-sender="1">${ic('play', 18)} Запустить</button>`;
    const schLine = nextSch ? `<div class="small" style="margin-top:6px">${ic('clock', 14)} Запланировано: <a class="link" href="#/send">${esc(nextSch.name)}</a> — ${dWhen(nextSch.next_run_at)}</div>` : '';
    const limit = `${schLine}<div class="small muted" style="margin-top:6px">За сутки: <b>${nf(s.sent_24h)}</b> из ${nf(s.daily_limit)}${inb ? ` · почта проверена ${inb.last_check ? ago(inb.last_check) : 'ещё не проверялась'}${inb.error ? ` · <span style="color:var(--danger)">ошибка чтения: ${esc(inb.error)}</span>` : ''}` : ''}</div>`;
    return `<div class="card sender ${cls}"><div class="big">${ic(err ? 'alert' : s.enabled ? 'send' : 'pause', 26)}</div>
      <div style="min-width:0"><b class="t">${title}</b><div class="small muted">${sub}</div>${limit}</div>
      <div class="row">${s.configured && s.due ? `<button class="btn outline sm" data-next-now title="Отправить следующее письмо сейчас, без паузы">${ic('zap', 16)} Отправить одно сейчас</button>` : ''}${btn}</div></div>`;
  }
  function bindSender(after = rerender) {
    $$('[data-sender]').forEach((b) => b.onclick = () => busy(b, async () => { await post('/api/sender', { enabled: b.dataset.sender === '1' }); toast(b.dataset.sender === '1' ? 'Рассылка запущена' : 'Рассылка на паузе'); after(); }));
    $$('[data-next-now]').forEach((b) => b.onclick = () => busy(b, async () => { const r = await post('/api/sender/next'); toast(r.result.sent ? `Отправлено: ${r.result.to}` : r.result.cancelled ? `Пропущено: ${r.result.cancelled}` : 'Не отправлено — смотрите ошибку'); after(); }));
    const t = setInterval(() => { $$('[data-next]').forEach((el) => { const at = Number(el.dataset.next); el.textContent = at > Date.now() ? inTime(at) : 'сейчас'; }); }, 1000);
    S.timers.push(t);
  }

  // ================= Обзор =================
  let homeData;
  async function pageHome() {
    const h = await api('/api/home'); homeData = h;
    const rate = h.sent ? (h.replied / h.sent) * 100 : 0;
    const empty = !h.total;
    const latest = h.latest.map((m) => mailLi(m));
    const langRows = h.langs.map((l) => `<tr><td>${langTag(l.lang)} ${esc(lname(l.lang))}</td><td class="r num">${nf(l.contacts)}</td><td class="r num">${nf(l.sent)}</td><td class="r num"><b>${nf(l.replied)}</b></td><td class="r num muted">${pct(l.replied, l.sent)}</td></tr>`).join('');
    const ctrRows = h.countries.map((c) => `<tr class="click" data-href="#/companies?country=${c.country || '-'}"><td><span class="flagc">${flag(c.country)}</span> ${esc(cname(c.country))}</td><td class="r num">${nf(c.contacts)}</td><td class="r num">${nf(c.sent)}</td><td class="r num"><b>${nf(c.replied)}</b></td></tr>`).join('');
    return `${head('Обзор', 'Как идёт рассылка и кто ответил', `<a class="btn soft" href="#/import">${ic('upload')} Загрузить файл</a><a class="btn" href="#/send/new">${ic('send')} Новая рассылка</a>`)}
      ${senderCard(h.sender, h.inbox, h.next_schedule)}
      ${empty ? `<div class="card" style="margin-top:16px"><h2>С чего начать</h2><div class="timeline" style="margin-top:12px">
        ${[['plug', 'Подключите почту', 'Gmail или другой ящик — в «Настройках». Для Gmail нужен «пароль приложения».', '#/settings'],
          ['doc', 'Проверьте шаблоны писем', 'Английский, немецкий, французский и испанский уже есть — вставьте свои тексты.', '#/templates'],
          ['upload', 'Загрузите файл с компаниями', 'Excel или CSV: название, страна, почта, любая информация.', '#/import'],
          ['send', 'Запустите рассылку', 'Система разошлёт письма на нужных языках и соберёт ответы во «Входящие».', '#/send/new']]
          .map(([i, t, d, href], n) => `<a class="ev" href="${href}"><span class="ic">${n + 1}</span><span><b>${t}</b><div class="small muted">${d}</div></span></a>`).join('')}</div></div>` : ''}
      <div class="grid-kpi" style="margin-top:16px">
        ${kpi('Компаний в базе', nf(h.total), `${nf(h.by_status.new || 0)} ещё не получали письмо`)}
        ${kpi('Отправлено писем', nf(h.sent), `${nf(h.sender.queued)} в очереди`)}
        ${kpi('Ответили', nf(h.replied), h.sent ? `${nf(rate, 1)}% от отправленных` : 'пока нет ответов', 'ink')}
        ${kpi('Новые ответы', nf(h.unread), h.unread ? '<a class="link" href="#/inbox?tab=unread" style="color:inherit">Открыть входящие →</a>' : 'всё прочитано', h.unread ? 'hl' : '')}
      </div>
      <div class="grid-2" style="margin-top:16px">
        <div class="card"><div class="card-h"><h3>Письма и ответы за 30 дней</h3><div class="legend"><span><span class="dot" style="background:var(--text)"></span>Отправлено</span><span><span class="dot" style="background:var(--hl)"></span>Ответы</span></div></div>${daysChart(h.series)}</div>
        ${listCard(`<h3>Последние ответы</h3>`, latest, 'Ответов пока нет — они появятся здесь автоматически', '<a class="link small" href="#/inbox">Все входящие</a>')}
      </div>
      <div class="grid-2" style="margin-top:16px">
        <div class="card flush"><div class="card-h" style="padding:16px 18px 6px"><h3>По языкам</h3></div><div class="table-wrap"><table class="t"><thead><tr><th>Язык</th><th class="r">Компаний</th><th class="r">Отправлено</th><th class="r">Ответили</th><th class="r">%</th></tr></thead><tbody>${langRows || '<tr><td colspan="5" class="muted">Нет данных</td></tr>'}</tbody></table></div></div>
        <div class="card flush"><div class="card-h" style="padding:16px 18px 6px"><h3>По странам</h3><a class="link small" href="#/companies">Все компании</a></div><div class="table-wrap"><table class="t"><thead><tr><th>Страна</th><th class="r">Компаний</th><th class="r">Отправлено</th><th class="r">Ответили</th></tr></thead><tbody>${ctrRows || '<tr><td colspan="4" class="muted">Нет данных</td></tr>'}</tbody></table></div></div>
      </div>`;
  }
  pageHome.after = () => { bindSender(); bindRows(); };
  function bindRows() { $$('tr[data-href]').forEach((tr) => tr.onclick = (e) => { if (!e.target.closest('a,button,input,label')) go(tr.dataset.href); }); }

  function daysChart(series) {
    const W = 560; const H = 210; const pad = { l: 28, r: 8, t: 10, b: 24 };
    const max = Math.max(4, ...series.map((d) => Math.max(d.sent, d.replies)));
    const bw = (W - pad.l - pad.r) / series.length;
    const y = (v) => H - pad.b - (v / max) * (H - pad.t - pad.b);
    const ticks = [0, Math.round(max / 2), max];
    const grid = ticks.map((t) => `<line class="gl" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join('');
    const bars = series.map((d, i) => {
      const x = pad.l + i * bw;
      const w = Math.max(2, bw * 0.38);
      return `<g><title>${dOnly(d.t)}: отправлено ${d.sent}, ответов ${d.replies}</title>
        <rect x="${x + bw * 0.1}" y="${y(d.sent)}" width="${w}" height="${H - pad.b - y(d.sent)}" rx="2" fill="var(--text)" opacity=".85"/>
        <rect x="${x + bw * 0.1 + w + 1}" y="${y(d.replies)}" width="${w}" height="${H - pad.b - y(d.replies)}" rx="2" fill="var(--hl)"/>
        ${i % 5 === 0 ? `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${dOnly(d.t)}</text>` : ''}</g>`;
    }).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Письма и ответы по дням">${grid}${bars}</svg>`;
  }

  // ================= Входящие =================
  function mailLi(m) {
    const tags = [m.unsubscribe ? `<span class="tag" style="color:var(--danger)">${ic('ban', 13)} просят не писать</span>` : '', m.kind === 'auto' ? `<span class="tag">${ic('robot', 13)} автоответ</span>` : '',
      m.kind === 'bounce' ? `<span class="tag" style="color:var(--danger)">${ic('bounce', 13)} не доставлено</span>` : '', m.files ? `<span class="tag">${ic('clip', 13)} ${m.files}</span>` : '',
      m.forwarded ? `<span class="tag">${ic('share', 13)} переслано</span>` : '', m.translated ? `<span class="tag">${ic('translate', 13)} переведено</span>` : ''].filter(Boolean).join('');
    return `<a class="mail-li${m.unread ? ' unread' : ''}" href="#/c/${m.contact_id}?m=${m.id}">
      <span class="av">${flag(m.country)}</span>
      <span style="min-width:0;display:grid;gap:2px"><span class="who"><span class="ell">${esc(m.company)}</span>${langTag(m.lang)}</span>
        <span class="subj ell">${esc(m.subject)}</span><span class="prev">${esc(m.preview)}</span></span>
      <span class="when">${ago(m.received_at)}</span>
      ${tags ? `<span class="meta">${tags}</span>` : ''}</a>`;
  }
  async function pageInbox(r) {
    const tab = r.q.tab || 'replies';
    const d = await api(`/api/inbox${qs({ tab, q: r.q.q || '' })}`);
    const c = d.counts || {};
    const tabs = [['replies', 'Ответы', c.replies], ['unread', 'Непрочитанные', c.unread], ['unsub', 'Просят не писать', c.unsub], ['auto', 'Автоответы', c.auto], ['bounce', 'Не доставлено', c.bounce]];
    const sender = await api('/api/sender');
    const inb = sender.inbox;
    return `${head('Входящие', 'Ответы компаний на наши письма. Обычная почта сюда не попадает — только переписка по рассылке.',
      `<button class="btn soft" id="readall">${ic('check')} Прочитано всё</button><button class="btn" id="check">${ic('refresh')} Проверить почту</button>`)}
      ${inb.error ? `<div class="note warn" style="margin-bottom:14px">${ic('alert')}<span>Не удаётся прочитать почту: ${esc(inb.error)}. Проверьте настройки ящика.</span></div>` : ''}
      ${inb.forward_error ? `<div class="note warn" style="margin-bottom:14px">${ic('alert')}<span>${esc(inb.forward_error)}</span></div>` : ''}
      <div class="row between" style="margin-bottom:14px">
        <div class="tabs">${tabs.map(([k, t, n]) => `<a href="#/inbox${qs({ tab: k })}" class="${tab === k ? 'on' : ''}">${t}${n ? ` <span class="faint">${n}</span>` : ''}</a>`).join('')}</div>
        <form id="sf" class="row" style="flex:1 1 220px;max-width:340px"><input class="input" name="q" placeholder="Поиск по компании, теме, тексту" value="${esc(r.q.q || '')}"></form>
      </div>
      <div class="card flush"><div class="list">${d.rows.length ? d.rows.map(mailLi).join('') : `<div class="empty">${ic('inbox', 34)}<p>Здесь пока пусто.</p><p class="small">Почта проверяется автоматически каждые ${Math.round(inb.poll_sec / 60) || 2} мин${inb.last_check ? ` · последняя проверка ${ago(inb.last_check)}` : ''}.</p></div>`}</div></div>
      <p class="small faint" style="margin-top:12px">${inb.forward_to ? `${ic('share', 14)} Новые ответы также пересылаются на <b>${esc(inb.forward_to)}</b>.` : `${ic('info', 14)} Можно пересылать каждый ответ на рабочую почту — укажите адрес в <a class="link" href="#/settings">настройках</a>.`}</p>`;
  }
  pageInbox.after = (r) => {
    $('#check').onclick = (e) => busy(e.currentTarget, async () => { const x = await post('/api/inbox/check'); toast(x.skipped === 'test' ? 'Тестовый режим — почта не читается' : x.skipped ? 'Почта не подключена' : `Проверено писем: ${x.checked || 0}, новых ответов: ${x.found || 0}`); rerender(); });
    $('#readall').onclick = (e) => busy(e.currentTarget, async () => { await post('/api/inbox/read-all'); rerender(); });
    $('#sf').onsubmit = (e) => { e.preventDefault(); go(`#/inbox${qs({ tab: r.q.tab || '', q: e.target.q.value.trim() })}`); };
    S.timers.push(setInterval(() => { if (document.visibilityState === 'visible' && !$('#sf input:focus')) api(`/api/inbox${qs({ tab: r.q.tab || 'replies', q: r.q.q || '' })}`).then((d) => { const l = $('.card.flush .list'); if (l && d.rows.length) l.innerHTML = d.rows.map(mailLi).join(''); }).catch(() => {}); }, 60000));
  };

  // ================= Компания + переписка =================
  async function pageCompany(r) {
    const c = await api(`/api/contacts/${r.parts[1]}`);
    const focus = Number(r.q.m) || 0;
    const msgs = c.messages.filter((m) => m.status !== 'cancelled' || m.kind === 'first');
    const unreadIds = c.messages.filter((m) => m.unread).map((m) => m.id);
    const lastIn = [...c.messages].reverse().find((m) => m.direction === 'in' && m.kind === 'reply');
    const thread = msgs.map((m) => msgCard(m, c, m.id === focus)).join('');
    const stopped = ['unsubscribed', 'bounced', 'blocked'].includes(c.status);
    pageCompany.data = { c, unreadIds, lastIn };
    return `${head(`<span class="flagc">${flag(c.country)}</span> ${esc(c.company)}`, `${esc(c.email)} · ${esc(cname(c.country))} · письмо на языке: ${esc(lname(c.lang))}`,
      `${pill(c.status)}<button class="btn soft" id="edit">${ic('edit')} Изменить</button>`, `<a href="#/companies">Компании</a> / ${esc(c.company)}`)}
      <div class="detail">
        <div class="stack" style="min-width:0">
          <div class="thread">${thread || `<div class="card empty">${ic('mail', 32)}<p>Писем этой компании ещё не было.</p>${stopped ? '' : '<button class="btn" id="queue1">Отправить письмо по шаблону</button>'}</div>`}</div>
          ${stopped ? `<div class="note warn">${ic('ban')}<span>${c.status === 'unsubscribed' ? 'Компания попросила больше не писать — рассылка ей не уходит.' : c.status === 'bounced' ? 'Адрес не существует — письма не доставляются.' : 'Компания в стоп-листе.'} Отправить личное письмо всё ещё можно.</span></div>` : ''}
          <div class="card composer" id="composer"><div class="card-h"><h3>${lastIn ? `${ic('reply')} Ответить компании` : `${ic('mail')} Написать письмо`}</h3>${S.meta.ai ? `<span class="small muted">Пишите по-русски — переведём на ${esc(lname(c.lang).toLowerCase())}</span>` : ''}</div>
            <form id="cf" class="stack">
              ${lastIn ? '' : '<label class="field"><span>Тема</span><input class="input" name="subject" placeholder="Тема письма"></label>'}
              <textarea class="input" name="text" placeholder="${lastIn ? 'Текст ответа…' : 'Текст письма…'}"></textarea>
              <div class="row between"><div class="row">${S.meta.ai ? `<button type="button" class="btn soft" id="tr-draft">${ic('translate')} Перевести на ${esc(lname(c.lang).toLowerCase())}</button>` : ''}</div>
                <button class="btn">${ic('send')} Отправить</button></div>
              <small class="hint">Письмо уйдёт с вашего ящика в ту же цепочку переписки — компания увидит его как обычный ответ.</small>
            </form></div>
        </div>
        <aside class="aside stack">
          <div class="card"><h3>О компании</h3><dl class="kv" style="margin-top:12px">
            <dt>Почта</dt><dd>${esc(c.email)}</dd>
            ${c.contact_name ? `<dt>Контакт</dt><dd>${esc(c.contact_name)}</dd>` : ''}
            <dt>Страна</dt><dd>${flag(c.country)} ${esc(cname(c.country))}${c.country_raw && c.country_raw !== cname(c.country) ? ` <span class="faint">(${esc(c.country_raw)})</span>` : ''}</dd>
            <dt>Язык писем</dt><dd>${esc(lname(c.lang))}</dd>
            ${c.website ? `<dt>Сайт</dt><dd><a class="link" href="${esc(/^https?:/.test(c.website) ? c.website : `https://${c.website}`)}" target="_blank" rel="noopener noreferrer">${esc(c.website)}</a></dd>` : ''}
            <dt>Добавлена</dt><dd>${dt(c.created_at)}</dd>
            ${c.last_sent_at ? `<dt>Последнее письмо</dt><dd>${dt(c.last_sent_at)}</dd>` : ''}
            ${c.last_reply_at ? `<dt>Ответ</dt><dd>${dt(c.last_reply_at)}</dd>` : ''}
          </dl>
          ${c.info ? `<div class="note" style="margin-top:14px;white-space:pre-wrap;display:block">${esc(c.info)}</div>` : ''}
          ${c.notes ? `<div class="note warn" style="margin-top:10px;white-space:pre-wrap;display:block"><b>Заметки:</b> ${esc(c.notes)}</div>` : ''}</div>
          <div class="card stack"><h3>Действия</h3>
            <button class="btn soft block" id="notes">${ic('edit')} Заметка</button>
            ${!stopped && !c.messages.some((m) => m.status === 'queued') ? `<button class="btn soft block" id="queue2">${ic('send')} Поставить письмо по шаблону</button>` : ''}
            ${c.messages.some((m) => m.status === 'queued') ? `<button class="btn soft block" data-st="sent">${ic('xCircle')} Убрать из очереди</button>` : ''}
            ${c.status === 'blocked' || c.status === 'unsubscribed' ? `<button class="btn soft block" data-st="${c.last_reply_at ? 'replied' : 'new'}">${ic('unlock')} Убрать из стоп-листа</button>` : `<button class="btn danger block" data-st="blocked">${ic('ban')} В стоп-лист (больше не писать)</button>`}
          </div>
        </aside>
      </div>`;
  }
  function msgCard(m, c, focus) {
    const isIn = m.direction === 'in';
    const who = isIn ? `${ic(m.kind === 'bounce' ? 'bounce' : m.kind === 'auto' ? 'robot' : 'reply', 17)} ${esc(m.from_name || m.from_addr)} <small>${esc(m.from_name ? m.from_addr : '')}</small>`
      : `${ic('send', 17)} Мы → ${esc(m.to_addr || c.email)} <small>${esc(KIND[m.kind] || '')}${m.lang ? ` · ${esc(m.lang.toUpperCase())}` : ''}</small>`;
    const when = isIn ? dt(m.received_at) : m.status === 'sent' ? dt(m.sent_at) : m.status === 'queued' ? (m.scheduled_at && m.scheduled_at > Date.now() ? `запланировано на ${dt(m.scheduled_at)}` : 'в очереди') : '';
    const st = m.status === 'failed' ? pill('failed', 'Не отправлено') : m.status === 'queued' ? pill('queued', 'В очереди') : m.status === 'cancelled' ? pill('cancelled', 'Отменено') : '';
    const body = m.status === 'queued' && !m.body_text ? '<span class="muted">Текст подставится из шаблона в момент отправки.</span>' : esc(m.body_text);
    const quoted = isIn && m.full_text && m.full_text.trim() !== m.body_text.trim() ? `<details><summary>Показать письмо целиком (с цитатой)</summary><pre>${esc(m.full_text)}</pre></details>` : '';
    const files = (m.attachments || []).map((a) => `<a class="file-chip" href="/api/files/${a.id}" target="_blank" rel="noopener">${ic('clip', 14)} <span class="ell">${esc(a.name)}</span> <span class="faint">${nf(a.size / 1024)} КБ</span></a>`).join('');
    const acts = isIn && m.kind === 'reply' ? `${S.meta.ai && !m.translation ? `<button class="btn sm soft" data-tr="${m.id}">${ic('translate', 15)} Перевести на русский</button>` : ''}<button class="btn sm soft" data-reply>${ic('reply', 15)} Ответить</button><button class="btn sm outline" data-unread="${m.id}">Отметить непрочитанным</button>` : '';
    return `<div class="msg ${isIn ? 'in' : 'out'}${m.status === 'queued' ? ' queued' : ''}" id="m${m.id}" ${focus ? 'data-focus' : ''}>
      <div class="mh"><span class="who">${who}</span><span class="row small muted">${st}${m.unsubscribe ? pill('unsubscribed', 'Просят не писать') : ''}${when}</span></div>
      <div class="mb">${m.subject ? `<span class="s">${esc(m.subject)}</span>` : ''}${body}</div>
      ${m.error && m.status !== 'sent' ? `<div class="note warn" style="margin:0 16px 14px">${ic('alert')}<span>${esc(m.error)}</span></div>` : m.error ? `<div class="note warn" style="margin:0 16px 14px">${ic('alert')}<span>${esc(m.error)}</span></div>` : ''}
      ${m.translation ? `<div class="tr"><b>Перевод на русский</b>${esc(m.translation)}</div>` : ''}
      ${quoted}
      ${files || acts ? `<div class="mf">${files}${acts}</div>` : ''}</div>`;
  }
  pageCompany.after = (r) => {
    const { c, unreadIds } = pageCompany.data;
    unreadIds.forEach((id) => post(`/api/messages/${id}/read`, { unread: false }).catch(() => {}));
    const f = $('[data-focus]') || (r.q.m ? null : null);
    if (f) setTimeout(() => f.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    $$('[data-tr]').forEach((b) => b.onclick = () => busy(b, async () => {
      const x = await post(`/api/messages/${b.dataset.tr}/translate`);
      const card = b.closest('.msg'); const div = document.createElement('div'); div.className = 'tr'; div.innerHTML = `<b>Перевод на русский</b>${esc(x.translation)}`;
      card.insertBefore(div, card.querySelector('.mf')); b.remove();
    }));
    $$('[data-unread]').forEach((b) => b.onclick = () => busy(b, async () => { await post(`/api/messages/${b.dataset.unread}/read`, { unread: true }); toast('Отмечено как непрочитанное'); go('#/inbox'); }));
    $$('[data-reply]').forEach((b) => b.onclick = () => { $('#composer').scrollIntoView({ behavior: 'smooth' }); setTimeout(() => $('#cf textarea').focus(), 300); });
    const form = $('#cf');
    form.onsubmit = (e) => {
      e.preventDefault();
      const text = form.text.value.trim();
      if (!text) { form.text.classList.add('bad'); form.text.focus(); return; }
      busy($('button:not([type])', form), async () => {
        await post(`/api/contacts/${c.id}/send`, { text, subject: form.subject ? form.subject.value.trim() : '', reply_to: pageCompany.data.lastIn ? pageCompany.data.lastIn.id : null });
        toast('Письмо отправлено'); rerender();
      });
    };
    if ($('#tr-draft')) $('#tr-draft').onclick = (e) => busy(e.currentTarget, async () => {
      const text = form.text.value.trim(); if (!text) { form.text.focus(); return; }
      const x = await post('/api/ai/translate-draft', { text, lang: c.lang });
      form.text.value = x.text; toast('Переведено — проверьте и отправьте');
    });
    $('#edit').onclick = () => editCompany(c);
    $('#notes').onclick = async () => {
      const x = await ask({ title: 'Заметка о компании', fields: [{ name: 'notes', label: 'Заметка (видна только вам)', type: 'textarea', value: c.notes }], ok: 'Сохранить' });
      if (x) { await put(`/api/contacts/${c.id}`, { notes: x.notes }).catch(fail); rerender(); }
    };
    $$('[data-st]').forEach((b) => b.onclick = () => busy(b, async () => { await put(`/api/contacts/${c.id}`, { status: b.dataset.st }); toast('Сохранено'); rerender(); }));
    $$('#queue1, #queue2').forEach((b) => b.onclick = () => busy(b, async () => {
      const x = await ask({ title: 'Письмо по шаблону', text: `Письмо на языке «${esc(lname(c.lang))}» встанет в очередь рассылки и уйдёт с обычной паузой.`, fields: [{ name: 'followup_days', label: 'Напоминание, если не ответят', type: 'select', value: '5', options: [['0', 'Не отправлять'], ['3', 'Через 3 дня'], ['5', 'Через 5 дней'], ['7', 'Через неделю']] }], ok: 'В очередь' });
      if (!x) return;
      await post(`/api/contacts/${c.id}/queue`, { followup_days: Number(x.followup_days) }); toast('Письмо в очереди'); rerender();
    }));
  };
  async function editCompany(c) {
    const langs = Object.entries(S.meta.langs);
    const x = await ask({ title: 'Компания', fields: [
      { name: 'company', label: 'Название', value: c.company, required: true },
      { name: 'email', label: 'Почта', value: c.email, required: true },
      { name: 'contact_name', label: 'Контактное лицо', value: c.contact_name, hint: 'Подставится в письмо вместо {{name}}' },
      { name: 'country', label: 'Страна', type: 'select', value: c.country, options: [['', 'Не указана'], ...S.meta.countries.map((k) => [k.code, `${k.flag} ${k.name}`])] },
      { name: 'lang', label: 'Язык писем', type: 'select', value: c.lang, options: langs },
      { name: 'website', label: 'Сайт', value: c.website },
      { name: 'info', label: 'Информация', type: 'textarea', value: c.info },
    ], ok: 'Сохранить' });
    if (!x) return;
    try { await put(`/api/contacts/${c.id}`, x); toast('Сохранено'); rerender(); } catch (e) { fail(e); }
  }

  // ================= Компании =================
  async function pageCompanies(r) {
    const q = r.q;
    const [d, fc] = await Promise.all([api(`/api/contacts${qs({ q: q.q, status: q.status, lang: q.lang, country: q.country, import_id: q.import_id, sort: q.sort, offset: q.offset, limit: 100 })}`), api('/api/contacts/facets')]);
    pageCompanies.data = { d, q };
    const cnt = (arr, k) => (arr.find((x) => x.k === k) || {}).n || 0;
    const statusOpts = Object.entries(STATUS).map(([k, t]) => `<option value="${k}" ${q.status === k ? 'selected' : ''}>${t} (${cnt(fc.statuses, k)})</option>`).join('');
    const langOpts = fc.langs.map((l) => `<option value="${l.k}" ${q.lang === l.k ? 'selected' : ''}>${esc(lname(l.k))} (${l.n})</option>`).join('');
    const ctrOpts = fc.countries.map((c) => `<option value="${c.k || '-'}" ${q.country === (c.k || '-') ? 'selected' : ''}>${flag(c.k)} ${esc(cname(c.k))} (${c.n})</option>`).join('');
    const impOpts = fc.imports.map((i) => `<option value="${i.id}" ${String(q.import_id) === String(i.id) ? 'selected' : ''}>${esc(i.filename)} · ${dOnly(i.created_at)}</option>`).join('');
    const rows = d.rows.map((c) => `<tr class="click" data-href="#/c/${c.id}"><td class="cb"><input type="checkbox" data-id="${c.id}" aria-label="Выбрать"></td>
      <td><b class="ell" style="display:block;max-width:280px">${esc(c.company)}</b><span class="small muted">${esc(c.email)}</span></td>
      <td><span class="flagc">${flag(c.country)}</span> <span class="small">${esc(cname(c.country))}</span></td><td>${langTag(c.lang)}</td>
      <td>${pill(c.status)}${c.replies ? ` <span class="tag">${ic('reply', 12)} ${c.replies}</span>` : ''}</td>
      <td class="small muted">${c.last_reply_at ? `ответ ${ago(c.last_reply_at)}` : c.last_sent_at ? `письмо ${ago(c.last_sent_at)}` : `добавлена ${dOnly(c.created_at)}`}</td></tr>`).join('');
    const filters = { q: q.q, status: q.status, lang: q.lang, country: q.country, import_id: q.import_id };
    const pages = d.total > d.limit ? `<div class="row between" style="margin-top:12px"><span class="small muted">Показаны ${d.offset + 1}–${Math.min(d.total, d.offset + d.limit)} из ${nf(d.total)}</span><div class="row">
      ${d.offset > 0 ? `<a class="btn sm soft" href="#/companies${qs({ ...filters, sort: q.sort, offset: Math.max(0, d.offset - d.limit) })}">← Назад</a>` : ''}
      ${d.offset + d.limit < d.total ? `<a class="btn sm soft" href="#/companies${qs({ ...filters, sort: q.sort, offset: d.offset + d.limit })}">Дальше →</a>` : ''}</div></div>` : '';
    return `${head('Компании', `${nf(d.total)} ${q.q || q.status || q.lang || q.country || q.import_id ? 'по фильтру' : 'в базе'}`,
      `<a class="btn soft" href="/api/contacts.csv${qs(filters)}">${ic('download')} Excel (CSV)</a><button class="btn soft" id="add">${ic('plus')} Добавить</button><a class="btn" href="#/import">${ic('upload')} Загрузить файл</a>`)}
      <form class="filters" id="ff">
        <input class="input" name="q" placeholder="Поиск: название, почта, информация" value="${esc(q.q || '')}">
        <select class="input" name="status"><option value="">Все статусы</option>${statusOpts}</select>
        <select class="input" name="lang"><option value="">Все языки</option>${langOpts}</select>
        <select class="input" name="country"><option value="">Все страны</option>${ctrOpts}</select>
        ${impOpts ? `<select class="input" name="import_id"><option value="">Все файлы</option>${impOpts}</select>` : ''}
        <select class="input" name="sort"><option value="">Новые сверху</option><option value="recent" ${q.sort === 'recent' ? 'selected' : ''}>По последнему действию</option><option value="company" ${q.sort === 'company' ? 'selected' : ''}>По названию</option><option value="country" ${q.sort === 'country' ? 'selected' : ''}>По стране</option></select>
      </form>
      <div class="bulk hidden" id="bulk"><b id="bn">0</b> выбрано
        <button class="btn sm soft" data-bulk="send">${ic('send', 15)} Разослать</button><button class="btn sm soft" data-bulk="lang">${ic('globe', 15)} Сменить язык</button>
        <button class="btn sm soft" data-bulk="reset">${ic('refresh', 15)} Сделать «новыми»</button><button class="btn sm soft" data-bulk="block">${ic('ban', 15)} В стоп-лист</button><button class="btn sm soft" data-bulk="delete">${ic('trash', 15)} Удалить</button></div>
      <div class="card flush"><div class="table-wrap"><table class="t"><thead><tr><th class="cb"><input type="checkbox" id="all" aria-label="Выбрать все"></th><th>Компания</th><th>Страна</th><th>Язык</th><th>Статус</th><th>Последнее</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6"><div class="empty">${ic('building', 32)}<p>${d.total ? '' : 'Компаний пока нет. '}${q.q || q.status || q.lang || q.country ? 'По фильтру ничего не нашлось.' : '<a class="link" href="#/import">Загрузите файл</a> со списком.'}</p></div></td></tr>`}</tbody></table></div></div>${pages}`;
  }
  pageCompanies.after = (r) => {
    bindRows();
    const f = $('#ff');
    const apply = () => go(`#/companies${qs({ q: f.q.value.trim(), status: f.status.value, lang: f.lang.value, country: f.country.value, import_id: f.import_id ? f.import_id.value : '', sort: f.sort.value })}`);
    f.onsubmit = (e) => { e.preventDefault(); apply(); };
    $$('select', f).forEach((s) => s.onchange = apply);
    const sel = () => $$('tbody input[data-id]:checked').map((x) => Number(x.dataset.id));
    const upd = () => { const n = sel().length; $('#bulk').classList.toggle('hidden', !n); $('#bn').textContent = n; };
    $$('tbody input[data-id]').forEach((x) => { x.onclick = (e) => e.stopPropagation(); x.onchange = upd; });
    $('#all').onchange = (e) => { $$('tbody input[data-id]').forEach((x) => { x.checked = e.target.checked; }); upd(); };
    $$('[data-bulk]').forEach((b) => b.onclick = async () => {
      const ids = sel(); const a = b.dataset.bulk;
      if (a === 'send') { sessionStorage.setItem('gm-ids', ids.join(',')); go('#/send/new?ids=1'); return; }
      let lang;
      if (a === 'lang') { const x = await ask({ title: `Язык писем для ${ids.length} компаний`, fields: [{ name: 'lang', label: 'Язык', type: 'select', value: 'en', options: Object.entries(S.meta.langs) }], ok: 'Сменить' }); if (!x) return; lang = x.lang; }
      if (a === 'delete' && !(await confirmBox('Удалить компании?', 'Компании, с которыми уже была переписка, не удаляются — чтобы не потерять ответы.', 'Удалить', true))) return;
      if (a === 'block' && !(await confirmBox('В стоп-лист?', 'Этим компаниям больше не будут уходить письма рассылки.', 'В стоп-лист', true))) return;
      await busy(b, async () => { const x = await post('/api/contacts/bulk', { ids, action: a, lang }); toast(`Готово: ${x.changed}`); rerender(); });
    });
    $('#add').onclick = async () => {
      const x = await ask({ title: 'Новая компания', fields: [
        { name: 'company', label: 'Название' }, { name: 'email', label: 'Почта', required: true, type: 'email' },
        { name: 'country', label: 'Страна', type: 'select', value: '', options: [['', 'Определить по почте'], ...S.meta.countries.map((k) => [k.code, `${k.flag} ${k.name}`])] },
        { name: 'contact_name', label: 'Контактное лицо' }, { name: 'website', label: 'Сайт' }, { name: 'info', label: 'Информация', type: 'textarea' }], ok: 'Добавить' });
      if (!x) return;
      try { const c = await post('/api/contacts', x); toast('Компания добавлена'); go(`#/c/${c.id}`); } catch (e) { fail(e); }
    };
  };

  // ================= Импорт файла =================
  const FIELDS = [['email', 'Почта', true], ['company', 'Название компании'], ['country', 'Страна'], ['lang', 'Язык (если есть в файле)'], ['contact_name', 'Контактное лицо'], ['website', 'Сайт']];
  let imp = null;
  async function pageImport() {
    imp = null;
    const list = await api('/api/imports');
    return `${head('Загрузить файл', 'Excel или CSV со списком компаний. Повторы по почте пропускаются автоматически.')}
      <div class="steps"><span class="on"><i>1</i>Файл</span><span><i>2</i>Колонки</span><span><i>3</i>Готово</span></div>
      <div id="imp">
        <label class="drop big" id="drop">${ic('upload', 34)}<b>Перетащите файл сюда или нажмите, чтобы выбрать</b><span class="small">.xlsx, .csv — до 20 МБ и 50 000 строк</span>
          <input type="file" id="file" accept=".xlsx,.xlsm,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden></label>
        <details class="card" style="margin-top:14px"><summary style="cursor:pointer;font-weight:600">Или вставить список текстом</summary>
          <p class="small muted" style="margin:10px 0">Скопируйте строки из таблицы (Ctrl+C в Excel/Google Таблицах) и вставьте сюда. Первая строка — заголовки.</p>
          <textarea class="input" id="paste" rows="8" style="height:auto;padding:12px" placeholder="Компания&#9;Страна&#9;Email&#10;Müller GmbH&#9;Germany&#9;info@mueller.de"></textarea>
          <div class="row" style="margin-top:10px"><button class="btn" id="pasteBtn">Разобрать</button></div></details>
        <div class="card" style="margin-top:14px"><h3>Что должно быть в файле</h3>
          <div class="help small muted"><ol><li><b>Почта</b> — обязательно. Если в ячейке несколько адресов, каждый станет отдельной строкой.</li>
          <li><b>Страна</b> — на любом языке: Germany, Deutschland, Германия, DE. По ней выбирается язык письма. Нет страны — определим по домену почты (.de, .fr, .es…).</li>
          <li><b>Название</b>, контакт, сайт и любые другие колонки — всё сохранится в карточке компании.</li></ol></div></div>
        ${list.length ? `<div class="card flush" style="margin-top:14px"><div class="card-h" style="padding:16px 18px 6px"><h3>Загруженные файлы</h3></div><table class="t"><tbody>${list.map((i) => `<tr class="click" data-href="#/companies?import_id=${i.id}"><td>${ic('doc', 16)} ${esc(i.filename)}</td><td class="small muted">${dt(i.created_at)}</td><td class="r small">добавлено <b>${nf(i.added)}</b>${i.dupes ? ` · повторов ${nf(i.dupes)}` : ''}${i.invalid ? ` · без почты ${nf(i.invalid)}` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
      </div>`;
  }
  pageImport.after = () => {
    bindRows();
    const drop = $('#drop'); const input = $('#file');
    const handle = async (file) => {
      if (!file) return;
      drop.innerHTML = `<span class="sk" style="width:44px;height:44px;border-radius:12px"></span><b>Читаю «${esc(file.name)}»…</b>`;
      try { const data = await readFile(file); imp = await post('/api/import/preview', { name: file.name, data }); showMapping(); } catch (e) { fail(e); rerender(); }
    };
    input.onchange = () => handle(input.files[0]);
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => handle(e.dataTransfer.files[0]));
    $('#pasteBtn').onclick = (e) => busy(e.currentTarget, async () => { const text = $('#paste').value.trim(); if (!text) return; imp = await post('/api/import/preview', { name: 'Вставленный список', text }); showMapping(); });
  };
  function showMapping() {
    const m = imp.mapping;
    $('.steps').innerHTML = '<span><i>1</i>Файл</span><span class="on"><i>2</i>Колонки</span><span><i>3</i>Готово</span>';
    const opt = (sel) => `<option value="-1">— нет —</option>${imp.headers.map((h, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(h)}</option>`).join('')}`;
    const sample = imp.sample.map((c) => (c.invalid ? `<tr><td colspan="4" class="muted small">${esc(c.company || 'строка')} — ${esc(c.reason)}, пропустим</td></tr>`
      : `<tr><td><b class="ell" style="display:block;max-width:240px">${esc(c.company)}</b><span class="small muted">${esc(c.email)}</span></td><td>${flag(c.country)} <span class="small">${esc(c.country ? cname(c.country) : c.country_raw || 'не определена')}</span></td><td>${langTag(c.lang)} <span class="small muted">${esc(lname(c.lang))}</span></td><td class="small muted ell" style="max-width:260px">${esc((c.info || '').replace(/\n/g, ' · '))}</td></tr>`)).join('');
    $('#imp').innerHTML = `<div class="card"><div class="card-h"><h3>${ic('doc')} Строк в файле: ${nf(imp.total)}</h3><span class="small muted">Проверьте, какая колонка что означает</span></div>
      <div class="map-grid">${FIELDS.map(([k, t, req]) => `<label class="field"><span>${t}${req ? ' *' : ''}</span><select class="input" data-map="${k}">${opt(m[k])}</select></label>`).join('')}</div>
      <div class="field" style="margin-top:14px"><span>Сохранить в «Информацию» о компании</span><div class="chips">${imp.headers.map((h, i) => `<label><input type="checkbox" data-info="${i}" ${m.info.includes(i) ? 'checked' : ''}>${esc(h)}</label>`).join('')}</div></div></div>
      <div class="card flush" style="margin-top:14px"><div class="card-h" style="padding:16px 18px 6px"><h3>Как это будет выглядеть</h3><span class="small muted">первые строки</span></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>Компания</th><th>Страна</th><th>Язык письма</th><th>Информация</th></tr></thead><tbody>${sample}</tbody></table></div></div>
      <div class="sticky-act row between"><button class="btn soft" id="back">${ic('arrowLeft')} Другой файл</button><button class="btn lg hl" id="commit">${ic('check')} Добавить компании</button></div>`;
    const collect = () => ({ ...Object.fromEntries($$('[data-map]').map((s) => [s.dataset.map, Number(s.value)])), info: $$('[data-info]:checked').map((x) => Number(x.dataset.info)) });
    $$('[data-map],[data-info]').forEach((el) => el.onchange = () => busy(null, async () => { imp = await post(`/api/import/${imp.id}/mapping`, { mapping: collect() }); showMapping(); }));
    $('#back').onclick = () => rerender();
    $('#commit').onclick = (e) => busy(e.currentTarget, async () => {
      const x = await post(`/api/import/${imp.id}/commit`, { mapping: collect() });
      $('.steps').innerHTML = '<span><i>1</i>Файл</span><span><i>2</i>Колонки</span><span class="on"><i>3</i>Готово</span>';
      $('#imp').innerHTML = `<div class="card empty" style="padding:40px 20px">${ic('checkCircle', 44)}<h2>Добавлено компаний: ${nf(x.added)}</h2>
        <p>${x.dupes ? `Уже были в базе: ${nf(x.dupes)} (пустые поля дополнены). ` : ''}${x.invalid ? `Без адреса почты: ${nf(x.invalid)}.` : ''}</p>
        <div class="row" style="justify-content:center">${x.added ? `<a class="btn hl lg" href="#/send/new?import_id=${x.id}">${ic('send')} Разослать этим компаниям</a>` : ''}<a class="btn soft lg" href="#/companies?import_id=${x.id}">Посмотреть список</a></div></div>`;
      window.scrollTo(0, 0);
    });
  }

  // ================= Рассылка =================
  async function pageSend() {
    const [s, camps, queue, schs] = await Promise.all([api('/api/sender'), api('/api/campaigns'), api('/api/queue'), api('/api/schedules')]);
    const cards = camps.map((c) => {
      const w = (n) => (c.total ? `${(n / c.total) * 100}%` : '0');
      return `<div class="card"><div class="card-h"><div><h3>${esc(c.name)}</h3><span class="small muted">${dt(c.created_at)}${c.followup_days ? ` · напоминание через ${c.followup_days} дн.` : ' · без напоминаний'}</span></div>${pill(c.status)}</div>
        <div class="bar" title="Отправлено ${c.sent} из ${c.total}"><span style="width:${w(c.sent - c.replied)}"></span><span class="r" style="width:${w(c.replied)}"></span><span class="f" style="width:${w(c.failed)}"></span></div>
        <div class="row small" style="margin-top:10px;gap:16px"><span>Отправлено <b>${nf(c.sent)}</b> из ${nf(c.total)}</span><span>Ответили <b>${nf(c.replied)}</b>${c.sent ? ` (${pct(c.replied, c.sent)})` : ''}</span>${c.followups ? `<span>Напоминаний <b>${nf(c.followups)}</b></span>` : ''}${c.queued ? `<span>В очереди <b>${nf(c.queued)}</b></span>` : ''}${c.failed ? `<span style="color:var(--danger)">Ошибок <b>${nf(c.failed)}</b></span>` : ''}</div>
        <div class="row" style="margin-top:12px">${c.status === 'running' ? `<button class="btn sm soft" data-cs="${c.id}" data-v="paused">${ic('pause', 15)} Пауза</button>` : ''}${c.status === 'paused' ? `<button class="btn sm" data-cs="${c.id}" data-v="running">${ic('play', 15)} Продолжить</button>` : ''}
          ${c.failed ? `<button class="btn sm soft" data-retry="${c.id}">${ic('refresh', 15)} Повторить ошибки</button>` : ''}
          ${['running', 'paused'].includes(c.status) && c.queued ? `<button class="btn sm danger" data-cs="${c.id}" data-v="cancelled">Отменить остаток</button>` : ''}</div></div>`;
    }).join('');
    const qrows = queue.map((m) => `<tr class="click" data-href="#/c/${m.contact_id}"><td><span class="flagc">${flag(m.country)}</span> <b>${esc(m.company)}</b><div class="small muted">${esc(m.email)}</div></td><td>${langTag(m.lang)}</td><td class="small">${esc(KIND[m.kind])}</td>
      <td>${m.status === 'sent' ? pill('sent', 'Отправлено') : m.status === 'failed' ? pill('failed', 'Ошибка') : pill('queued', m.scheduled_at && m.scheduled_at > Date.now() ? `с ${dOnly(m.scheduled_at)}` : 'Ждёт')}</td>
      <td class="small muted">${m.status === 'sent' ? ago(m.sent_at) : esc(m.error || '')}</td></tr>`).join('');
    return `${head('Рассылка', 'Письма уходят по одному с паузой — как будто их отправляет человек. Так почта не попадает в спам.', `<a class="btn hl" href="#/send/new">${ic('plus')} Новая рассылка</a>`)}
      ${senderCard(s.sender, s.inbox, s.next_schedule)}
      ${schs.length ? `<div class="card flush" style="margin-top:16px"><div class="card-h" style="padding:16px 18px 6px"><h3>${ic('clock')} Запланированные</h3><a class="link small" href="#/send/new">${ic('plus', 14)} Запланировать</a></div>
        <div class="list">${schs.map(schLi).join('')}</div></div>` : ''}
      <div class="grid-2" style="margin-top:16px;align-items:start">
        <div class="stack">${cards || `<div class="card empty">${ic('send', 32)}<p>Рассылок ещё не было.</p><a class="btn" href="#/send/new">Запустить первую</a></div>`}</div>
        <div class="card flush"><div class="card-h" style="padding:16px 18px 6px"><h3>Очередь и последние письма</h3><a class="link small" href="#/settings">Лимиты и время</a></div>
          <div class="table-wrap"><table class="t"><tbody>${qrows || '<tr><td class="muted">Очередь пуста</td></tr>'}</tbody></table></div></div>
      </div>`;
  }
  function schLi(x) {
    const f = x.filter || {};
    const who = f.ids ? `${String(f.ids).split(',').length} выбранных компаний` : [
      { new: 'кому ещё не писали', sent: 'кто не ответил', replied: 'кто ответил' }[String(f.status || 'new').split(',')[0]] || '',
      f.lang ? `языки: ${String(f.lang).toUpperCase()}` : '', f.country ? `страны: ${String(f.country).split(',').map((c) => flag(c === '-' ? '' : c)).join(' ')}` : '',
      f.gap_days ? `не чаще раза в ${f.gap_days} дн.` : ''].filter(Boolean).join(' · ');
    return `<div class="li" style="grid-template-columns:1fr auto"><div style="min-width:0;display:grid;gap:4px">
        <div class="t1">${esc(x.name)} ${x.active ? pill('running', x.repeat === 'once' ? 'Запланирована' : 'По расписанию') : pill('paused', x.next_run_at ? 'На паузе' : 'Выполнена')}</div>
        <div class="t2"><span>${ic('clock', 13)} ${esc(repeatText(x))}${x.ends_at ? `, до ${dOnly(x.ends_at)}` : ''}</span></div>
        <div class="t2">${x.active && x.next_run_at ? `<span>Следующий раз: <b style="color:var(--text)">${dWhen(x.next_run_at)}</b></span>` : ''}${x.active && x.audience_now != null ? `<span>· если бы сейчас — ${nf(x.audience_now)} писем</span>` : ''}</div>
        <div class="t2"><span>${esc(who)}</span>${x.followup_days ? `<span>· напоминание через ${x.followup_days} дн.</span>` : ''}</div>
        ${x.last_run_at ? `<div class="t2"><span>Последний запуск ${dt(x.last_run_at)}: ${esc(x.last_result)}</span></div>` : ''}</div>
      <div class="row" style="justify-content:flex-end">
        <button class="btn sm soft" data-srun="${x.id}" title="Поставить письма в очередь прямо сейчас">${ic('zap', 15)} Сейчас</button>
        <button class="btn sm soft" data-smove="${x.id}">${ic('clock', 15)} Перенести</button>
        ${x.active ? `<button class="btn sm soft" data-sact="pause" data-sid="${x.id}">${ic('pause', 15)}</button>` : x.next_run_at || x.repeat !== 'once' ? `<button class="btn sm" data-sact="resume" data-sid="${x.id}">${ic('play', 15)}</button>` : ''}
        <button class="btn sm danger" data-sact="delete" data-sid="${x.id}" aria-label="Удалить">${ic('trash', 15)}</button></div></div>`;
  }
  pageSend.after = () => {
    bindSender(); bindRows();
    $$('[data-srun]').forEach((b) => b.onclick = async () => {
      if (!(await confirmBox('Запустить сейчас?', 'Письма встанут в очередь прямо сейчас. Расписание не сдвинется.', 'Запустить'))) return;
      busy(b, async () => { const x = await post(`/api/schedules/${b.dataset.srun}/run`); toast(x.result); rerender(); });
    });
    $$('[data-smove]').forEach((b) => b.onclick = async () => {
      const x = await ask({ title: 'Перенести', fields: [{ name: 'at', label: 'Новая дата и время', type: 'datetime-local', value: localInput(Date.now() + 86400e3), required: true }], ok: 'Сохранить' });
      if (!x) return;
      busy(b, async () => { await post(`/api/schedules/${b.dataset.smove}`, { action: 'reschedule', run_at: new Date(x.at).getTime(), tz: myTz() }); toast('Перенесено'); rerender(); });
    });
    $$('[data-sact]').forEach((b) => b.onclick = async () => {
      if (b.dataset.sact === 'delete' && !(await confirmBox('Удалить расписание?', 'Уже отправленные письма останутся, новых запусков не будет.', 'Удалить', true))) return;
      busy(b, async () => { await post(`/api/schedules/${b.dataset.sid}`, { action: b.dataset.sact }); rerender(); });
    });
    $$('[data-cs]').forEach((b) => b.onclick = async () => {
      if (b.dataset.v === 'cancelled' && !(await confirmBox('Отменить остаток?', 'Неотправленные письма этой рассылки будут удалены из очереди. Компании вернутся в статус «Новая».', 'Отменить', true))) return;
      busy(b, async () => { await post(`/api/campaigns/${b.dataset.cs}/status`, { status: b.dataset.v }); rerender(); });
    });
    $$('[data-retry]').forEach((b) => b.onclick = () => busy(b, async () => { const x = await post(`/api/campaigns/${b.dataset.retry}/retry`); toast(`Снова в очереди: ${x.queued}`); rerender(); }));
    S.timers.push(setInterval(() => { if (document.visibilityState === 'visible') api('/api/sender').then((s) => { const el = $('.sender'); if (el) { const tmp = document.createElement('div'); tmp.innerHTML = senderCard(s.sender, s.inbox, s.next_schedule); el.replaceWith(tmp.firstElementChild); bindSenderButtons(); } }).catch(() => {}); }, 20000));
  };
  function bindSenderButtons() {
    $$('[data-sender]').forEach((b) => b.onclick = () => busy(b, async () => { await post('/api/sender', { enabled: b.dataset.sender === '1' }); rerender(); }));
    $$('[data-next-now]').forEach((b) => b.onclick = () => busy(b, async () => { const r = await post('/api/sender/next'); toast(r.result.sent ? `Отправлено: ${r.result.to}` : 'Не отправлено'); rerender(); }));
  }

  // ----- новая рассылка -----
  async function pageNewCampaign(r) {
    const [fc, st] = await Promise.all([api('/api/contacts/facets'), api('/api/settings')]);
    const ids = r.q.ids ? (sessionStorage.getItem('gm-ids') || '') : '';
    pageNewCampaign.ids = ids;
    const cnt = (arr, k) => (arr.find((x) => x.k === k) || {}).n || 0;
    const chip = (name, v, label, n, on) => `<label><input type="checkbox" name="${name}" value="${esc(v)}" ${on ? 'checked' : ''}>${label}${n != null ? ` <small>${nf(n)}</small>` : ''}</label>`;
    const fb = st.fallback_lang || 'en';
    return `${head('Новая рассылка', 'Выберите, кому писать. Язык письма подберётся для каждой компании сам.', '', '<a href="#/send">Рассылка</a> / Новая')}
      <form id="nf" class="stack">
        <div class="card stack">
          ${ids ? `<div class="note info">${ic('info')}<span>Выбрано вручную: <b>${ids.split(',').length}</b> компаний из списка. <a class="link" href="#/send/new">Выбрать по фильтру</a></span></div>` : `
          <div class="field"><span>Кому</span><div class="chips">
            ${chip('status', 'new', 'Ещё не писали', cnt(fc.statuses, 'new'), true)}${chip('status', 'sent', 'Писали, но не ответили', cnt(fc.statuses, 'sent'), false)}${chip('status', 'replied', 'Ответили', cnt(fc.statuses, 'replied'), false)}</div></div>
          <div class="field"><span>Языки <small class="faint">— не выбрано = все</small></span><div class="chips">${fc.langs.map((l) => chip('lang', l.k, `${esc(l.k.toUpperCase())} · ${esc(lname(l.k))}`, l.n, false)).join('')}</div></div>
          <div class="field"><span>Страны <small class="faint">— не выбрано = все</small></span><div class="chips">${fc.countries.map((c) => chip('country', c.k || '-', `${flag(c.k)} ${esc(cname(c.k))}`, c.n, false)).join('')}</div></div>
          ${fc.imports.length ? `<label class="field"><span>Из файла</span><select class="input" name="import_id"><option value="">Из всех файлов</option>${fc.imports.map((i) => `<option value="${i.id}" ${String(r.q.import_id) === String(i.id) ? 'selected' : ''}>${esc(i.filename)} · ${dOnly(i.created_at)} · ${nf(i.added)} комп.</option>`).join('')}</select></label>` : ''}`}
          <div class="form-grid">
            <label class="field"><span>Название рассылки</span><input class="input" name="name" placeholder="Например: Германия — оборудование" ></label>
            <label class="field"><span>Если нет письма на языке компании</span><select class="input" name="fallback">
              ${Object.entries(S.meta.langs).filter(([k]) => ['en', 'de', 'fr', 'es'].includes(k)).map(([k, t]) => `<option value="${k}" ${fb === k ? 'selected' : ''}>Отправить на языке: ${esc(t.toLowerCase())}</option>`).join('')}
              <option value="skip" ${fb === 'skip' ? 'selected' : ''}>Не отправлять такой компании</option></select></label>
            <label class="field"><span>Напоминание, если не ответят</span><select class="input" name="followup_days">
              <option value="0">Не отправлять</option><option value="3">Через 3 дня</option><option value="5" selected>Через 5 дней</option><option value="7">Через неделю</option><option value="10">Через 10 дней</option></select>
              <small class="hint">Короткое письмо в ту же переписку. Не уйдёт, если компания уже ответила.</small></label>
          </div>
        </div>
        <div class="card stack"><h3 style="margin:0">${ic('clock')} Когда отправить</h3>
          <div class="choice">
            <label><input type="radio" name="when" value="now" checked><span><b>Сейчас</b><small>Письма сразу встанут в очередь</small></span></label>
            <label><input type="radio" name="when" value="once"><span><b>В выбранную дату</b><small>Один раз, в указанный день и час</small></span></label>
            <label><input type="radio" name="when" value="repeat"><span><b>Повторять</b><small>Каждую неделю или каждый месяц</small></span></label>
          </div>
          <div id="whenx" class="stack hidden">
            <div class="form-grid">
              <label class="field"><span id="atl">Дата и время</span><input class="input" type="datetime-local" name="run_at" value="${localInput((() => { const d = new Date(Date.now() + 86400e3); d.setHours(10, 0, 0, 0); return d.getTime(); })())}"></label>
              <label class="field rep hidden"><span>Как часто</span><select class="input" name="repeat"><option value="monthly">Каждый месяц (в тот же день)</option><option value="biweekly">Каждые 2 недели</option><option value="weekly">Каждую неделю</option></select></label>
              <label class="field rep hidden"><span>Повторять до <small class="faint">— необязательно</small></span><input class="input" type="date" name="ends_at"></label>
            </div>
            <label class="sw rep hidden"><input type="checkbox" name="gap" checked><i></i><span>Не писать компании чаще, чем раз в период <small class="faint">(даже если она подходит под фильтр)</small></span></label>
            <div class="note info small">${ic('info')}<span id="whenhint"></span></div>
          </div>
        </div>
        <div class="card" id="pv"><div class="sk" style="height:120px"></div></div>
        <div class="sticky-act row between"><a class="btn soft" href="#/send">Отмена</a><button class="btn lg hl" id="go" disabled>${ic('send')} Запустить рассылку</button></div>
      </form>`;
  }
  pageNewCampaign.after = () => {
    const f = $('#nf');
    const body = () => {
      const vals = (n) => $$(`input[name=${n}]:checked`, f).map((x) => x.value).join(',');
      const filter = pageNewCampaign.ids ? { ids: pageNewCampaign.ids, status: 'new,sent,replied,queued' } : { status: vals('status') || 'new', lang: vals('lang'), country: vals('country'), import_id: f.import_id ? f.import_id.value : '' };
      const when = f.when.value;
      const per = { weekly: 7, biweekly: 14, monthly: 30 }[f.repeat.value];
      if (when === 'repeat') filter.gap_days = f.gap.checked ? per : 0;
      return { filter, fallback: f.fallback.value, followup_days: Number(f.followup_days.value), name: f.name.value.trim(), when,
        run_at: f.run_at.value ? new Date(f.run_at.value).getTime() : null, repeat: when === 'repeat' ? f.repeat.value : 'once',
        ends_at: when === 'repeat' && f.ends_at.value ? new Date(`${f.ends_at.value}T23:59`).getTime() : null, tz: myTz() };
    };
    const whenUI = () => {
      const w = f.when.value;
      $('#whenx').classList.toggle('hidden', w === 'now');
      $$('.rep', f).forEach((el) => el.classList.toggle('hidden', w !== 'repeat'));
      $('#atl').textContent = w === 'repeat' ? 'Первый раз' : 'Дата и время';
      const at = f.run_at.value ? new Date(f.run_at.value) : null;
      const day = at ? at.getDate() : '';
      $('#whenhint').innerHTML = w === 'once' ? 'Список получателей соберётся в момент запуска — компании, которые вы загрузите до этого дня, тоже получат письмо.'
        : `${f.repeat.value === 'monthly' ? `Каждый месяц ${day}-го числа` : f.repeat.value === 'weekly' ? 'Каждую неделю' : 'Раз в две недели'} письма получат компании, подходящие под выбор <b>в этот момент</b>. Например, «Ещё не писали» — значит, каждый раз письмо уйдёт новым компаниям из загруженных за это время файлов.${day > 28 && f.repeat.value === 'monthly' ? ' В коротких месяцах — в последний день.' : ''}`;
      if (w !== 'now') $('#whenhint').innerHTML += ' Сами письма уходят только в рабочее время из «Настроек → Отправка» — если запуск позже, они начнут уходить следующим рабочим утром.';
      $('#go').dataset.mode = w;
    };
    let seq = 0;
    const refresh = async () => {
      const my = ++seq;
      try {
        const p = await post('/api/campaigns/preview', body());
        if (my !== seq) return;
        $('#go').disabled = !p.will_send;
        const mode = f.when.value;
        $('#go').disabled = mode === 'now' ? !p.will_send : false;
        $('#go').innerHTML = mode === 'now' ? `${ic('send')} Запустить: ${nf(p.will_send)} писем` : `${ic('clock')} ${mode === 'repeat' ? 'Включить расписание' : 'Запланировать'}`;
        const rows = p.langs.map((l) => `<tr><td>${langTag(l.lang, !l.template)} ${esc(l.name)}</td><td class="r num"><b>${nf(l.count)}</b></td>
          <td>${l.template ? `<span style="color:var(--ok)">${ic('checkCircle', 15)} своё письмо</span>` : l.send_as ? `<span style="color:var(--warn)">${ic('alert', 15)} нет письма — уйдёт на ${esc(lname(l.send_as).toLowerCase())}</span> <a class="link small" href="#/templates/${l.lang}">создать</a>` : `<span style="color:var(--danger)">${ic('xCircle', 15)} пропустим</span> <a class="link small" href="#/templates/${l.lang}">создать письмо</a>`}</td>
          <td class="small muted">${l.send_as && body().followup_days ? (l.followup ? 'напоминание есть' : 'нет напоминания на этом языке') : ''}</td></tr>`).join('');
        $('#pv').innerHTML = p.total ? `<div class="card-h"><h3>${f.when.value === 'now' ? 'Получатели' : 'Если бы запуск был сейчас'}: ${nf(p.total)}</h3><span class="small muted">≈ ${nf(p.days)} дн. при лимите ${nf(p.daily_limit)} писем в сутки</span></div>
          <div class="table-wrap"><table class="t"><thead><tr><th>Язык компании</th><th class="r">Компаний</th><th>Какое письмо уйдёт</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
          ${p.skipped ? `<div class="note warn" style="margin-top:12px">${ic('alert')}<span>${nf(p.skipped)} компаниям письмо не уйдёт — нет шаблона на их языке.</span></div>` : ''}
          <p class="small faint" style="margin:12px 0 0">Компании из стоп-листа, с несуществующими адресами и уже стоящие в очереди исключены автоматически.</p>`
          : `<div class="empty">${ic('users', 30)}<p>По этому выбору ${f.when.value === 'now' ? 'некому писать' : 'сейчас некому писать — к моменту запуска могут появиться новые компании'}.</p><p class="small">Возможно, всем уже отправлено — выберите «Писали, но не ответили» или загрузите новый файл.</p></div>`;
      } catch (e) { fail(e); }
    };
    f.onchange = () => { whenUI(); refresh(); };
    whenUI(); refresh();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const s = await api('/api/sender');
      if (!s.sender.configured) { toast('Сначала подключите почту в «Настройках»', true); return; }
      const b = body();
      if (b.when !== 'now') {
        if (!b.run_at || b.run_at < Date.now() - 60e3) { toast('Выберите дату и время в будущем', true); f.run_at.focus(); return; }
        busy($('#go'), async () => {
          const x = await post('/api/schedules', b);
          sessionStorage.removeItem('gm-ids');
          toast(`Запланировано на ${dWhen(x.next_run_at)}`); go('#/send');
        });
        return;
      }
      busy($('#go'), async () => {
        const x = await post('/api/campaigns', b);
        sessionStorage.removeItem('gm-ids');
        toast(`Рассылка запущена: ${x.queued} писем в очереди`); go('#/send');
      });
    };
  };

  // ================= Шаблоны =================
  async function pageTemplates() {
    const [list, fc] = await Promise.all([api('/api/templates'), api('/api/contacts/facets')]);
    const langs = [...new Set([...list.map((t) => t.lang), ...fc.langs.map((l) => l.k)])];
    const order = ['en', 'de', 'fr', 'es', 'it'];
    langs.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));
    const cards = langs.map((l) => {
      const first = list.find((t) => t.lang === l && t.kind === 'first'); const fu = list.find((t) => t.lang === l && t.kind === 'followup');
      const n = (fc.langs.find((x) => x.k === l) || {}).n || 0;
      return `<a class="card tpl" href="#/templates/${l}"><div class="ln"><span class="row" style="gap:8px">${langTag(l, !first)}<b>${esc(lname(l))}</b></span><span class="small muted">${nf(n)} комп.</span></div>
        <div class="subj">${first ? esc(first.subject) : '<span style="color:var(--warn)">Письма нет — компании получат запасной вариант</span>'}</div>
        <div class="row small">${first ? `<span class="tag">${ic('check', 12)} первое письмо</span>` : ''}${fu ? `<span class="tag">${ic('check', 12)} напоминание</span>` : ''}${first && first.files.length ? `<span class="tag">${ic('clip', 12)} ${first.files.length}</span>` : ''}</div></a>`;
    }).join('');
    return `${head('Шаблоны писем', 'Для каждого языка — первое письмо и короткое напоминание. Данные компании подставляются сами.', `<button class="btn" id="addl">${ic('plus')} Добавить язык</button>`)}
      <div class="note info" style="margin-bottom:16px">${ic('info')}<span>Здесь уже есть черновики на английском, немецком, французском и испанском. <b>Замените их своими письмами</b> — просто вставьте текст. Вместо названия компании пишите <span class="mono">{{company}}</span>.</span></div>
      <div class="tpl-grid">${cards}</div>`;
  }
  pageTemplates.after = () => {
    $('#addl').onclick = async () => {
      const x = await ask({ title: 'Новый язык', fields: [{ name: 'lang', label: 'Язык', type: 'select', value: 'it', options: Object.entries(S.meta.langs) }], ok: 'Создать' });
      if (x) go(`#/templates/${x.lang}`);
    };
  };

  async function pageTemplate(r) {
    const lang = r.parts[1]; const kind = r.q.kind === 'followup' ? 'followup' : 'first';
    if (!S.meta.langs[lang]) throw new Error('Неизвестный язык');
    const list = await api('/api/templates');
    const t = list.find((x) => x.lang === lang && x.kind === kind);
    const others = [...new Set(list.filter((x) => x.lang !== lang && x.kind === kind).map((x) => x.lang))];
    const en = list.find((x) => x.lang === 'en' && x.kind === kind);
    pageTemplate.data = { lang, kind, t, list };
    const vars = S.meta.vars.map(([k, d]) => `<button type="button" data-var="${k}" title="${esc(d)}">{{${k}}}</button>`).join('');
    return `${head(`${langTag(lang)} ${esc(lname(lang))}`, kind === 'first' ? 'Первое письмо компании' : 'Напоминание, если компания не ответила', `${t ? `<button class="btn danger" id="del">${ic('trash')} Удалить</button>` : ''}`, `<a href="#/templates">Шаблоны</a> / ${esc(lname(lang))}`)}
      <div class="tabs" style="margin-bottom:16px;width:max-content"><a href="#/templates/${lang}" class="${kind === 'first' ? 'on' : ''}">Первое письмо</a><a href="#/templates/${lang}?kind=followup" class="${kind === 'followup' ? 'on' : ''}">Напоминание</a></div>
      ${!t ? `<div class="note warn" style="margin-bottom:16px">${ic('alert')}<span>Письма на этом языке ещё нет.${S.meta.ai && others.length ? ' Можно перевести существующее автоматически:' : ''}</span>${S.meta.ai && others.length ? `<span class="row" style="margin-left:auto">${others.map((o) => `<button class="btn sm" data-from="${o}">${ic('translate', 15)} из ${esc(lname(o).toLowerCase())}</button>`).join('')}</span>` : ''}</div>` : ''}
      <div class="editor">
        <form class="card stack" id="tf">
          ${kind === 'followup' ? '<div class="note small">Тема напоминания — «Re: тема первого письма», чтобы оно попало в ту же переписку. Поле темы ниже — запасное.</div>' : ''}
          <label class="field"><span>Тема письма</span><input class="input" name="subject" value="${esc(t ? t.subject : en ? en.subject : '')}" required></label>
          <label class="field"><span>Текст письма</span><textarea class="input" name="body" required>${esc(t ? t.body : en ? en.body : '')}</textarea></label>
          <div class="field"><span>Вставить данные</span><div class="vars">${vars}</div><small class="hint">Нажмите — подставится в текст. {{name|Sir or Madam}} — если имени нет, будет «Sir or Madam».</small></div>
          ${t && kind === 'first' ? `<div class="field"><span>Вложения</span><div class="row">${t.files.map((f) => `<span class="file-chip">${ic('clip', 14)} ${esc(f.name)} <span class="faint">${nf(f.size / 1024)} КБ</span> <button type="button" class="link-btn" data-rmf="${f.id}" aria-label="Убрать">${ic('x', 14)}</button></span>`).join('')}
            <label class="btn sm soft">${ic('clip', 15)} Прикрепить файл<input type="file" id="tfile" hidden accept=".pdf,.doc,.docx,.pptx,.jpg,.jpeg,.png"></label></div><small class="hint">Например, презентация компании в PDF. Лучше до 2–3 МБ.</small></div>` : ''}
          <div class="row between"><button type="button" class="btn soft" id="test">${ic('mail')} Отправить себе для проверки</button><button class="btn">${ic('check')} Сохранить</button></div>
        </form>
        <div class="stack" style="position:sticky;top:16px"><div class="row between"><h3 style="margin:0">Так увидит компания</h3><span class="small muted">пример: Müller Recycling GmbH</span></div><div id="pv" class="mail-preview"></div></div>
      </div>`;
  }
  pageTemplate.after = () => {
    const { lang, kind, t } = pageTemplate.data;
    const f = $('#tf');
    let timer; let lastFocus = f.body;
    const pv = async () => {
      try {
        const p = await post('/api/templates/preview', { subject: f.subject.value, body: f.body.value, lang });
        const [main, foot] = p.text.split('\n\n—\n');
        $('#pv').innerHTML = `<div class="ph"><span>Тема:</span><b>${esc(kind === 'followup' ? `Re: …` : p.subject)}</b></div><div class="pb">${esc(main)}</div>${foot ? `<div class="pf">${esc(foot)}</div>` : ''}`;
      } catch (e) { /* молча */ }
    };
    [f.subject, f.body].forEach((el) => { el.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(pv, 350); }); el.addEventListener('focus', () => { lastFocus = el; }); });
    pv();
    $$('[data-var]').forEach((b) => b.onclick = () => {
      const el = lastFocus; const ins = `{{${b.dataset.var}}}`;
      const s = el.selectionStart ?? el.value.length; const e = el.selectionEnd ?? s;
      el.value = el.value.slice(0, s) + ins + el.value.slice(e); el.focus(); el.selectionStart = el.selectionEnd = s + ins.length; pv();
    });
    f.onsubmit = (e) => { e.preventDefault(); busy($('button:not([type])', f), async () => { await put(`/api/templates/${lang}/${kind}`, { subject: f.subject.value, body: f.body.value }); toast('Шаблон сохранён'); rerender(); }); };
    $('#test').onclick = async (e) => {
      const st = await api('/api/settings');
      const x = await ask({ title: 'Проверочное письмо', text: 'Письмо уйдёт с вашего ящика на указанный адрес — посмотрите, как оно выглядит в почте.', fields: [{ name: 'to', label: 'Куда', type: 'email', value: st.mail_user || '', required: true }], ok: 'Отправить' });
      if (!x) return;
      busy(e.currentTarget, async () => { if (!t || t.subject !== f.subject.value || t.body !== f.body.value) await put(`/api/templates/${lang}/${kind}`, { subject: f.subject.value, body: f.body.value }); const r = await post('/api/templates/test', { to: x.to, lang }); toast(`Отправлено на ${r.to}`); });
    };
    if ($('#del')) $('#del').onclick = async () => { if (await confirmBox('Удалить шаблон?', 'Компании с этим языком получат письмо на запасном языке.', 'Удалить', true)) { await del(`/api/templates/${lang}/${kind}`).catch(fail); go('#/templates'); } };
    $$('[data-from]').forEach((b) => b.onclick = () => busy(b, async () => { const x = await post('/api/ai/translate-template', { from_lang: b.dataset.from, to_lang: lang, kind }); f.subject.value = x.subject; f.body.value = x.body; pv(); toast('Переведено — проверьте и сохраните'); }));
    if ($('#tfile')) $('#tfile').onchange = (e) => busy(null, async () => { const file = e.target.files[0]; if (!file) return; await post(`/api/templates/${t.id}/files`, { name: file.name, data: await readFile(file) }); toast('Файл прикреплён'); rerender(); });
    $$('[data-rmf]').forEach((b) => b.onclick = () => busy(b, async () => { await del(`/api/template-files/${b.dataset.rmf}`); rerender(); }));
  };

  // ================= Настройки =================
  const PROVIDERS = [['gmail', 'Gmail / Google Workspace'], ['outlook', 'Outlook / Hotmail'], ['yahoo', 'Yahoo'], ['zoho', 'Zoho Mail'], ['ukrnet', 'ukr.net'], ['custom', 'Другой (указать серверы)']];
  const TZ = ['Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome', 'Europe/London', 'Europe/Warsaw', 'Europe/Kyiv', 'Europe/Lisbon', 'Europe/Athens', 'Europe/Helsinki'];
  async function pageSettings(r) {
    const tab = r.parts[1] || 'mail';
    const st = await api('/api/settings'); pageSettings.st = st;
    const tabs = [['mail', 'Почта'], ['about', 'О нас в письмах'], ['sending', 'Отправка'], ['inbox', 'Входящие'], ['team', 'Команда'], ['profile', 'Профиль']];
    const lock = (k) => (st.env_locked.includes(k) ? 'readonly title="Задано на сервере"' : '');
    const num = (k, label, hint = '', min = 0, max = 9999) => `<label class="field"><span>${label}</span><input class="input" type="number" name="${k}" value="${esc(st[k])}" min="${min}" max="${max}" ${lock(k)}>${hint ? `<small class="hint">${hint}</small>` : ''}</label>`;
    const txt = (k, label, hint = '', ph = '', type = 'text') => `<label class="field"><span>${label}</span><input class="input" type="${type}" name="${k}" value="${esc(st[k])}" placeholder="${esc(ph)}" ${lock(k)}>${hint ? `<small class="hint">${hint}</small>` : ''}</label>`;
    const sw = (k, label) => `<label class="sw"><input type="checkbox" name="${k}" ${Number(st[k]) ? 'checked' : ''}><i></i>${label}</label>`;
    let body = '';
    if (tab === 'mail') {
      body = `<form class="card stack" id="sf">
        <div class="card-h"><h3>Почтовый ящик, с которого уходят письма</h3>${st.has_password ? `<span class="pill s-replied">Подключён</span>` : '<span class="pill s-queued">Не подключён</span>'}</div>
        <div class="form-grid">
          <label class="field"><span>Почтовый сервис</span><select class="input" name="provider">${PROVIDERS.map(([k, t]) => `<option value="${k}" ${st.provider === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          ${txt('mail_user', 'Адрес почты', '', 'company@gmail.com', 'email')}
          <label class="field"><span>Пароль приложения</span><input class="input" type="password" name="mail_pass" autocomplete="new-password" placeholder="${st.has_password ? '•••••••• сохранён — оставьте пустым' : 'xxxx xxxx xxxx xxxx'}" ${lock('mail_pass')}><small class="hint">Хранится в зашифрованном виде</small></label>
        </div>
        <div id="custom" class="form-grid ${st.provider === 'custom' ? '' : 'hidden'}">
          ${txt('smtp_host', 'Сервер отправки (SMTP)')}${num('smtp_port', 'Порт SMTP', '465 — SSL, 587 — STARTTLS', 1, 65535)}
          ${txt('imap_host', 'Сервер входящих (IMAP)')}${num('imap_port', 'Порт IMAP', '', 1, 65535)}
          <div class="stack" style="align-content:end">${sw('smtp_secure', 'SMTP через SSL')}${sw('imap_secure', 'IMAP через SSL')}</div>
        </div>
        <div class="form-grid">${txt('from_name', 'Имя отправителя', 'Так письмо подписано во «Входящих» у компании', 'Gobsek Metal')}${txt('reply_to', 'Отвечать на другой адрес (необязательно)', 'Если ответы должны приходить не на ящик отправки', '', 'email')}</div>
        <div class="note info help" style="display:grid">${ic('info')}<b>Как получить пароль приложения Gmail (2 минуты)</b>
          <ol><li>Включите двухэтапную проверку: <a class="link" href="https://myaccount.google.com/signinoptions/twosv" target="_blank" rel="noopener">myaccount.google.com → Безопасность</a>.</li>
          <li>Откройте <a class="link" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">myaccount.google.com/apppasswords</a>, введите название «Gobsek Mail» → «Создать».</li>
          <li>Скопируйте 16 символов и вставьте в поле «Пароль приложения». Обычный пароль от Gmail не подойдёт.</li></ol></div>
        <div class="row between"><button type="button" class="btn soft" id="test">${ic('plug')} Проверить подключение</button><button class="btn">${ic('check')} Сохранить</button></div>
        <div id="tres"></div></form>`;
    } else if (tab === 'about') {
      body = `<form class="card stack" id="sf"><div class="card-h"><h3>Эти данные подставляются в письма</h3></div>
        <div class="form-grid">${txt('my_company', 'Наша компания — {{my_company}}', '', 'Gobsek Metal')}${txt('sender_name', 'Кто пишет — {{sender_name}}', '', 'Иван Иванов')}${txt('sender_position', 'Должность — {{sender_position}}', '', 'Director')}${txt('phone', 'Телефон — {{phone}}', '', '+380 …')}${txt('website', 'Наш сайт — {{my_website}}', '', 'www.example.com')}</div>
        <label class="field"><span>Подпись — {{signature}}</span><textarea class="input" name="signature" rows="5" style="height:auto;padding:10px 14px" placeholder="Если пусто — соберётся из полей выше">${esc(st.signature)}</textarea><small class="hint">Подпись одна для всех языков. Пишите латиницей — так её прочитают в любой стране.</small></label>
        <div class="row" style="justify-content:flex-end"><button class="btn">${ic('check')} Сохранить</button></div></form>`;
    } else if (tab === 'sending') {
      body = `<form class="card stack" id="sf"><div class="card-h"><h3>Как часто отправлять</h3></div>
        <div class="note warn">${ic('alert')}<span>Gmail разрешает до ~500 писем в сутки, новым ящикам — меньше. Начните со 50–100 в день и пауз 1–3 минуты: так письма доходят во «Входящие», а не в спам, и ящик не заблокируют.</span></div>
        <div class="form-grid">${num('daily_limit', 'Писем в сутки (не больше)', 'Считаются последние 24 часа', 1, 2000)}${num('delay_min', 'Пауза между письмами от, сек', '', 5, 3600)}${num('delay_max', 'до, сек', 'Каждый раз случайная пауза в этих пределах', 5, 7200)}</div>
        <div class="form-grid">${num('window_from', 'Отправлять с (час)', '', 0, 23)}${num('window_to', 'до (час)', 'Письма в рабочее время читают чаще', 0, 24)}
          <label class="field"><span>Часовой пояс получателей</span><select class="input" name="timezone">${[...new Set([st.timezone, ...TZ])].map((z) => `<option ${z === st.timezone ? 'selected' : ''}>${z}</option>`).join('')}</select></label></div>
        <div class="stack">${sw('weekdays_only', 'Только в будни (пн–пт)')}${sw('unsub_link', 'Добавлять строку «ответьте unsubscribe, чтобы отписаться» на языке письма')}</div>
        <label class="field" style="max-width:360px"><span>Если нет письма на языке компании</span><select class="input" name="fallback_lang">${Object.entries(S.meta.langs).map(([k, t]) => `<option value="${k}" ${st.fallback_lang === k ? 'selected' : ''}>Отправить: ${esc(t.toLowerCase())}</option>`).join('')}<option value="skip" ${st.fallback_lang === 'skip' ? 'selected' : ''}>Не отправлять</option></select></label>
        <div class="row" style="justify-content:flex-end"><button class="btn">${ic('check')} Сохранить</button></div></form>`;
    } else if (tab === 'inbox') {
      body = `<form class="card stack" id="sf"><div class="card-h"><h3>Ответы компаний</h3></div>
        ${sw('imap_enabled', 'Проверять почту автоматически')}
        <div class="form-grid">${num('poll_sec', 'Как часто проверять, сек', 'Минимум 30', 30, 3600)}${txt('forward_to', 'Пересылать каждый ответ на почту', 'Например, руководителю. Нажмёт «Ответить» — письмо уйдёт прямо компании. Пусто — не пересылать.', 'boss@example.com', 'email')}</div>
        <div class="note small">${ic('info')}<span>Система читает только «Входящие» ящика и берёт оттуда <b>ответы на наши письма</b> (и уведомления о недоставке). Остальная почта остаётся нетронутой — ничего не удаляется и не помечается прочитанным. Если компания пишет «unsubscribe / abmelden / baja…», она автоматически попадает в стоп-лист.</span></div>
        <div class="row" style="justify-content:flex-end"><button class="btn">${ic('check')} Сохранить</button></div></form>`;
    } else if (tab === 'team') {
      const users = await api('/api/users');
      body = `<div class="card flush"><div class="card-h" style="padding:16px 18px 6px"><h3>Кто может входить</h3><button class="btn sm" id="adduser">${ic('plus', 15)} Добавить</button></div>
        <table class="t"><tbody>${users.map((u) => `<tr><td><b>${esc(u.name)}</b><div class="small muted">${esc(u.login)}</div></td><td class="small muted">${u.last_login ? `входил ${ago(u.last_login)}` : 'ещё не входил'}</td><td>${u.active ? '' : pill('blocked', 'Отключён')}</td>
          <td class="r">${u.id === S.me.id ? '<span class="small faint">это вы</span>' : `<button class="btn sm soft" data-ureset="${u.id}">Новый пароль</button> <button class="btn sm ${u.active ? 'danger' : 'soft'}" data-utoggle="${u.id}">${u.active ? 'Отключить' : 'Включить'}</button>`}</td></tr>`).join('')}</tbody></table></div>`;
    } else if (tab === 'profile') {
      body = `<form class="card stack" id="pf" style="max-width:520px"><h3>Смена пароля</h3>
        <label class="field"><span>Текущий пароль</span><input class="input" type="password" name="current" autocomplete="current-password"></label>
        <label class="field"><span>Новый пароль</span><input class="input" type="password" name="next" autocomplete="new-password"><small class="hint">Минимум 8 символов, буквы и цифры</small></label>
        <div class="row between"><button type="button" class="btn danger" id="logout">${ic('logout')} Выйти</button><button class="btn">Сменить пароль</button></div></form>
        <div class="card" style="max-width:520px;margin-top:16px"><h3>Тема оформления</h3><div class="theme-switch" style="max-width:320px">${themeButtons(document.documentElement.dataset.theme)}</div></div>`;
    }
    return `${head('Настройки')}<div class="tabs" style="margin-bottom:16px">${tabs.map(([k, t]) => `<a href="#/settings/${k}" class="${tab === k ? 'on' : ''}">${t}</a>`).join('')}</div>${body}`;
  }
  pageSettings.after = () => {
    const f = $('#sf');
    if (f) {
      if (f.provider) f.provider.onchange = () => $('#custom').classList.toggle('hidden', f.provider.value !== 'custom');
      const collect = () => {
        const out = {};
        $$('input,select,textarea', f).forEach((el) => { if (!el.name || el.readOnly) return; out[el.name] = el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value.trim(); });
        if (out.mail_pass === '') delete out.mail_pass;
        return out;
      };
      f.onsubmit = (e) => { e.preventDefault(); busy($('button:not([type])', f), async () => { await put('/api/settings', collect()); toast('Сохранено'); rerender(); }); };
      if ($('#test')) $('#test').onclick = (e) => busy(e.currentTarget, async () => {
        await put('/api/settings', collect());
        $('#tres').innerHTML = '<div class="sk" style="height:60px"></div>';
        const x = await post('/api/settings/test');
        const line = (ok, okText, label) => `<div class="note ${ok === 'ok' ? 'ok' : 'warn'}">${ic(ok === 'ok' ? 'checkCircle' : 'alert')}<span><b>${label}:</b> ${ok === 'ok' ? okText : esc(ok)}</span></div>`;
        $('#tres').innerHTML = `<div class="stack">${line(x.smtp, 'письма отправлять можно', 'Отправка')}${line(x.imap, `ответы читаются${x.messages != null ? ` (во «Входящих» ${nf(x.messages)} писем)` : ''}`, 'Входящие')}
          ${x.smtp !== 'ok' && /535|Username and Password|BadCredentials|auth/i.test(x.smtp) ? `<div class="small muted">Gmail не принял пароль. Нужен именно «пароль приложения» из 16 символов, а не обычный пароль.</div>` : ''}</div>`;
      });
    }
    if ($('#pf')) {
      $('#pf').onsubmit = (e) => { e.preventDefault(); const p = e.target; busy($('button:not([type])', p), async () => { await post('/api/password', { current: p.current.value, next: p.next.value }); toast('Пароль изменён'); p.reset(); }); };
      $('#logout').onclick = async () => { await post('/api/logout').catch(() => {}); S.me = null; location.hash = '#/'; render(); };
    }
    const showPw = (x) => modal(`<h2>Доступ для ${esc(x.login)}</h2><p>Передайте логин и временный пароль. При первом входе система попросит придумать свой.</p>
      <div class="note"><span>Логин: <b>${esc(x.login)}</b><br>Пароль: <b class="mono">${esc(x.password)}</b></span></div><div class="acts"><button class="btn" data-close>Готово</button></div>`).then(rerender);
    if ($('#adduser')) $('#adduser').onclick = async () => {
      const x = await ask({ title: 'Новый пользователь', fields: [{ name: 'name', label: 'Имя', required: true }, { name: 'login', label: 'Логин', required: true, hint: 'Латиницей, например: anna' }], ok: 'Добавить' });
      if (!x) return;
      try { showPw(await post('/api/users', x)); } catch (e) { fail(e); }
    };
    $$('[data-ureset]').forEach((b) => b.onclick = () => busy(b, async () => showPw(await post(`/api/users/${b.dataset.ureset}/reset`))));
    $$('[data-utoggle]').forEach((b) => b.onclick = () => busy(b, async () => { await post(`/api/users/${b.dataset.utoggle}/toggle`); rerender(); }));
  };

  function pageMore() {
    const items = [['/companies', 'building', 'Компании'], ['/templates', 'doc', 'Шаблоны писем'], ['/import', 'upload', 'Загрузить файл'], ['/send/new', 'send', 'Новая рассылка'], ['/settings', 'sliders', 'Настройки'], ['/settings/profile', 'user', 'Профиль']];
    return `${head('Ещё')}<div class="card flush"><div class="list">${items.map(([h, i, t]) => `<a class="li" href="#${h}"><div class="t1">${ic(i, 18)} ${t}</div><div>${ic('chevronRight', 18)}</div></a>`).join('')}</div></div>
      <div class="card" style="margin-top:16px"><div class="theme-switch">${themeButtons(document.documentElement.dataset.theme)}</div></div>`;
  }

  render();
})();
