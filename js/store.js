/* ============================================================
 * store.js — Daily activity store + date-range MAU report (Tab 4)
 *
 * The store is kept by a small "store service" (a free Cloudflare Worker with a database — see SETUP_CLOUDFLARE.md).
 * Everyone reads it over plain HTTPS (no login, no Zoho); admins log in with a password that the SERVICE checks, then add
 * days / reset it from the page (each is one all-or-nothing commit). Inside the store:
 *
 *   manifest.json            index of stored days
 *   daily/YYYY-MM-DD.csv     one file per IST day:  email,first_mau_ts,first_login_ts
 *   archive/YYYY-MM/...      created by an admin "Reset store" (nothing is ever deleted)
 *
 * Only EARLIEST timestamps are kept per student per day, so adding the same raw
 * file twice (or overlapping files) can never double-count.
 *
 * All storage I/O goes through a small adapter (readText / writeText / exists / remove / probeWrite,
 * optional list / flush / discard) so the same code runs in the browser (HTTP to the service) and in
 * Node tests (fs).
 *
 * Depends on (loaded earlier): Papa (PapaParse) and window.Processing
 * (parseLogTimestamp, buildReportFromActivity).
 * No password and no key is stored in the code or in the page: the admin password lives only in the service.
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- constants ---------- */
  const MANIFEST = 'manifest.json';
  const DAILY_DIR = 'daily';
  const ARCHIVE_DIR = 'archive';
  const IST_OFFSET_MS = 330 * 60000;            // UTC+5:30
  const LOCK_MS = 30000, MAX_TRIES = 3;
  const MAU_ACTIONS = new Set(['Created', 'Created public link']);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const READ_ONLY_MSG = "You don't have permission to change the store. Ask an admin to do this.";

  class StoreError extends Error {
    constructor(code, message) { super(message); this.name = 'StoreError'; this.code = code; }
  }

  /* ---------- date helpers (all day keys are IST 'YYYY-MM-DD') ---------- */
  function dayKeyFromTs(ts) { return new Date(ts + IST_OFFSET_MS).toISOString().slice(0, 10); }
  function todayKey() { return dayKeyFromTs(Store._now()); }
  function isDayKey(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')); }
  function addDays(key, n) { const d = new Date(key + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  /** Inclusive list of day keys (capped so a typo like year 0001 can't hang the page). */
  function dayRange(from, to) {
    const out = [];
    for (let k = from, n = 0; k <= to && n < 4000; k = addDays(k, 1), n++) out.push(k);
    return out;
  }
  function fmtDMY(key) { const [y, m, d] = key.split('-'); return `${d}-${m}-${y}`; }
  function fmtShort(key) { const [, m, d] = key.split('-'); return `${+d} ${MON[+m - 1]}`; }
  /** ['2026-08-14','2026-08-15','2026-08-24',…] → "14–15 Aug, 24 Aug" (max 8 runs shown). */
  function compressDays(keys) {
    const ks = [...new Set(keys)].sort();
    const runs = [];
    for (const k of ks) {
      const last = runs[runs.length - 1];
      if (last && addDays(last[1], 1) === k) last[1] = k; else runs.push([k, k]);
    }
    const txt = runs.map(([a, b]) => {
      if (a === b) return fmtShort(a);
      return a.slice(0, 7) === b.slice(0, 7) ? `${+a.slice(8)}–${fmtShort(b)}` : `${fmtShort(a)}–${fmtShort(b)}`;
    });
    return txt.length > 8 ? txt.slice(0, 8).join(', ') + ` (+${txt.length - 8} more)` : txt.join(', ');
  }
  function monthLabel(ym) { const [y, m] = ym.split('-'); return `${MONTHS_LONG[+m - 1]} ${y}`; }
  function fmtIst(iso) {
    const t = Date.parse(iso);
    if (isNaN(t)) return '';
    const d = new Date(t + IST_OFFSET_MS), p = n => String(n).padStart(2, '0');
    return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }

  /* ---------- day-file (de)serialisation ---------- */
  const DAY_HEADER = 'email,first_mau_ts,first_login_ts';
  /** Map(email → {mau, login}) → CSV text (sorted by email, so output is deterministic). */
  function serializeDay(map) {
    const lines = [DAY_HEADER];
    for (const e of [...map.keys()].sort()) {
      const v = map.get(e);
      lines.push(e + ',' + (v.mau == null ? '' : v.mau) + ',' + (v.login == null ? '' : v.login));
    }
    return lines.join('\n') + '\n';
  }
  function parseDay(text) {
    const map = new Map();
    if (!text) return map;
    const lines = text.split('\n');
    for (let i = 1; i < lines.length; i++) {
      const ln = lines[i].trim();
      if (!ln) continue;
      const p = ln.split(',');
      if (!p[0]) continue;
      map.set(p[0], { mau: p[1] ? +p[1] : null, login: p[2] ? +p[2] : null });
    }
    return map;
  }
  function minTs(a, b) { return a == null ? b : (b == null ? a : Math.min(a, b)); }
  function mergeEntry(map, email, mau, login) {
    const cur = map.get(email);
    if (!cur) { map.set(email, { mau: mau == null ? null : mau, login: login == null ? null : login }); return; }
    cur.mau = minTs(cur.mau, mau);
    cur.login = minTs(cur.login, login);
  }
  function countMau(map) { let n = 0; for (const v of map.values()) if (v.mau != null) n++; return n; }

  /* ---------- where the store lives ---------- */
  // Everyone reads — and admins change — ONE shared store kept by a small "store service" (a Cloudflare Worker with a
  // database: see SETUP_CLOUDFLARE.md). The only setting is the service's web address; it is committed as
  // store-config.json next to index.html, so every visitor's page picks it up by itself.
  //   readers : plain GET  <service>/v1/file/manifest.json  and  <service>/v1/file/daily/YYYY-MM-DD.csv    (no login)
  //   admins  : log in with a password that the SERVICE checks (the page holds no password and no key) and get a
  //             12-hour session for this browser tab; each Add / Reset is sent as ONE all-or-nothing commit.
  const LS_KEY = 'cla_service';             // this browser's own copy of the service address (used only when store-config.json has none)
  const SS_KEY = 'cla_admin_session';       // this tab's admin session  { token, exp, service }
  const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;
  let _cfg = { service: '' };               // effective settings
  let _token = '', _exp = 0;                // admin session (token + when it ends, by THIS computer's clock)
  let _fetch = (...a) => fetch(...a);       // overridable (tests)
  let _override = null;                     // tests: one ready-made adapter used for reads AND writes
  let _reader = null, _writer = null, _storeName = '', _cfgSource = 'none', _fileService = '', _cfgProblem = '';
  let _admin = false, _fails = 0, _lockUntil = 0;           // _fails/_lockUntil: only the built-in test login uses them

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const encPath = p => p.split('/').map(encodeURIComponent).join('/');
  function lsGet() { try { return String(localStorage.getItem(LS_KEY) || ''); } catch (_) { return ''; } }
  function lsSet(v) { try { if (v) localStorage.setItem(LS_KEY, v); else localStorage.removeItem(LS_KEY); return true; } catch (_) { return false; } }
  function ssGet() { try { return JSON.parse(sessionStorage.getItem(SS_KEY) || 'null'); } catch (_) { return null; } }
  function ssSet(o) { try { if (o) sessionStorage.setItem(SS_KEY, JSON.stringify(o)); else sessionStorage.removeItem(SS_KEY); } catch (_) { /* private mode etc. — the session just won't survive a reload */ } }
  const withCb = u => u + (u.includes('?') ? '&' : '?') + 'cb=' + Date.now();      // only for the small config file (same site)

  /** "https://x.workers.dev/", "x.workers.dev", "https://x.workers.dev/v1/ping" → "https://x.workers.dev". */
  function normalizeService(raw) {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    s = s.replace(/[?#].*$/, '').replace(/\/v1(\/.*)?$/i, '').replace(/\/+$/, '');
    const m = /^(https?):\/\/([^/]+)$/i.exec(s);
    if (!m || !HOST_RE.test(m[2])) throw new StoreError('bad-service', 'That doesn’t look like a web address. It should look like https://your-name.workers.dev');
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(m[2]);
    if (m[1].toLowerCase() === 'http' && !local) throw new StoreError('bad-service', 'The address must start with https://');
    return m[1].toLowerCase() + '://' + m[2].toLowerCase();
  }

  function requireAdapter() {
    const a = _override || _reader;
    if (!a) throw new StoreError('not-configured', "The shared store isn't connected yet. An admin needs to enter the store service address once (Check connection).");
    return a;
  }
  function endSession() { _token = ''; _exp = 0; _admin = false; _writer = null; ssSet(null); }
  function requireWriter() {
    if (_override) return _override;
    if (!_cfg.service) throw new StoreError('not-configured', "The shared store isn't connected yet. Enter the store service address with “Check connection” first.");
    requireAdmin();
    if (!_writer) _writer = serviceWriter();
    return _writer;
  }
  function requireAdmin() {
    if (isAdmin()) return;
    if (_token || _admin) { endSession(); throw new StoreError('session-expired', 'Your admin session has ended. Log in again.'); }
    throw new StoreError('not-admin', 'Admin login required.');
  }
  function isWriteDenied(e) {
    const n = e && e.name, m = String((e && (e.message || e.code)) || '');
    return n === 'NotAllowedError' || n === 'NoModificationAllowedError' || n === 'SecurityError' ||
      /read-only|EACCES|EPERM|EROFS|not allowed/i.test(m);
  }
  /** Run a write operation; turn "not allowed" failures into the friendly read-only message. */
  async function guardedWrite(fn) {
    try { return await fn(); }
    catch (e) { if (e instanceof StoreError) throw e; if (isWriteDenied(e)) throw new StoreError('read-only', READ_ONLY_MSG); throw e; }
  }

  /* ---------- talking to the service ---------- */
  /** One request. Network failures become a friendly StoreError. */
  async function svc(path, init) {
    try { return await _fetch(_cfg.service + path, { cache: 'no-store', ...init }); }
    catch (e) { throw new StoreError('network', `Could not reach the store service (${(e && e.message) || 'network error'}). Check your internet connection, then press Refresh.`); }
  }
  async function bodyJson(res) { try { return await res.json(); } catch (_) { return null; } }
  const authHeader = () => (_token ? { Authorization: 'Bearer ' + _token } : {});
  const NOT_A_SERVICE = "That address answered, but it isn't the store service. Check the address under “Check connection”.";

  /** The service's refusal → a StoreError with a plain-English message (body = its JSON, if any). */
  function serviceError(res, body, what) {
    const code = body && body.code, msg = body && body.message;
    if (res.status === 401) {
      if (code === 'admin-only') return new StoreError('admin-only', msg || 'Only an admin can read that.');
      endSession();
      return new StoreError('session-expired', 'Your admin session has ended. Log in again.');
    }
    if (res.status === 409) return new StoreError('conflict', 'Someone else changed the store at the same moment.');
    if (res.status === 413) return new StoreError('too-big', msg || 'That is too much data for the store in one go.');
    if (res.status === 429) return new StoreError('rate-limit', msg || 'The service is busy — wait a minute and try again.');
    if (res.status === 503 && (code === 'no-database' || code === 'not-set-up')) return new StoreError(code, `The store service isn't finished being set up. ${msg || ''}`.trim());
    if (res.status === 404 && !code) return new StoreError('not-a-service', NOT_A_SERVICE);
    if (res.status >= 500 && !code) return new StoreError('network', `The store service isn't answering right now (HTTP ${res.status}). Please try again in a minute.`);
    return new StoreError('service', (msg || `The store service answered HTTP ${res.status}`) + (what ? ` (while trying to ${what})` : ''));
  }

  /**
   * Fetch one stored file.  → { text | null (not stored), version }.  Every answer from the service carries the store's
   * version number; an answer without one did not come from the service (e.g. a wrong address), so it is refused rather
   * than mistaken for "empty store".
   */
  async function fetchFile(path, auth) {
    let last = null;
    for (let i = 0; i < 3; i++) {
      let res;
      try { res = await svc('/v1/file/' + encPath(path), { headers: auth ? authHeader() : {} }); }
      catch (e) { last = e; await sleep(300 * (i + 1)); continue; }
      const v = res.headers.get('x-store-version');
      if (res.status === 200 || res.status === 404) {
        if (v === null || !/^\d+$/.test(v)) throw new StoreError('not-a-service', NOT_A_SERVICE);
        return { text: res.status === 200 ? await res.text() : null, version: parseInt(v, 10) };
      }
      const body = await bodyJson(res);
      if ((res.status === 429 || res.status >= 500) && !(body && (body.code === 'no-database' || body.code === 'not-set-up'))) {
        last = new Error(`HTTP ${res.status}`); await sleep(600 * (i + 1)); continue;
      }
      throw serviceError(res, body, 'read ' + path.split('/').pop());
    }
    throw new StoreError('network', `Could not reach the store service (${(last && last.message) || 'network error'}). Check your internet connection, then press Refresh.`);
  }

  /**
   * Reader for everyone (no login).  head() = the store version the latest manifest came from; at(v) = a reader that
   * insists every file belongs to that same version (so a report never mixes two states of the store — if an admin
   * publishes in the middle, it throws 'changed' and the report simply reads again).
   */
  function serviceReader() {
    let manifestVersion = null;
    const make = pinned => ({
      remote: true,
      async readText(path) {
        const r = await fetchFile(path, false);
        if (pinned != null && r.version !== pinned) throw new StoreError('changed', 'The store was updated while this was loading.');
        if (pinned == null && path === MANIFEST) manifestVersion = r.version;
        return r.text;
      },
      async exists(path) { return (await this.readText(path)) !== null; }
    });
    const r = make(null);
    r.head = () => manifestVersion;
    r.at = v => (v == null ? r : make(v));
    return r;
  }

  /** Write adapter for an admin: reads are authenticated; writes are buffered and sent by flush() as ONE commit. */
  function serviceWriter() {
    const pending = new Map();                          // path → text | null (null = remove)
    let base = null;                                    // the store version everything we read belongs to
    const note = v => {
      if (base === null) base = v;
      else if (base !== v) throw new StoreError('conflict', 'Someone else changed the store while this was running.');
    };
    return {
      remote: true,
      async readText(path) {
        if (pending.has(path)) return pending.get(path);
        const r = await fetchFile(path, true);
        note(r.version);
        return r.text;
      },
      async exists(path) { return (await this.readText(path)) !== null; },
      async writeText(path, text) { pending.set(path, text); },
      async remove(path) { pending.set(path, null); },
      /** Confirms the admin session is still valid. No change is made. */
      async probeWrite() {
        const res = await svc('/v1/whoami', { headers: authHeader() });
        const body = await bodyJson(res);
        if (!res.ok) throw serviceError(res, body, 'check your admin session');
        return body;
      },
      async flush(message) {
        if (!pending.size) return null;
        if (base === null) {                            // nothing was read first: take the current version
          const res = await svc('/v1/whoami', { headers: authHeader() });
          const body = await bodyJson(res);
          if (!res.ok) throw serviceError(res, body, 'publish');
          base = body.version;
        }
        // 1) upload each file on its own (small requests — the free Cloudflare plan allows little work per request);
        //    nothing is visible to anyone yet.  2) one small commit makes all of them live at once, or none of them.
        const cid = newCommitId();
        const writes = [...pending].filter(([, t]) => t !== null), deletes = [...pending].filter(([, t]) => t === null).map(([p]) => p);
        let next = 0;
        const upload = async () => {
          while (next < writes.length) {
            const [p, t] = writes[next++];
            await sendStaged(cid, p, t);
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, writes.length) }, upload));
        const res = await svc('/v1/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() },
          body: JSON.stringify({ base, cid, message, files: writes.map(([p]) => p), deletes }) });
        const body = await bodyJson(res);
        if (!res.ok || !body || !body.ok) throw serviceError(res, body, 'publish');
        pending.clear(); base = null;
        return { commit: body.version };
      },
      discard() { pending.clear(); base = null; }
    };
  }
  function newCommitId() {
    const b = new Uint8Array(16);
    (globalThis.crypto && globalThis.crypto.getRandomValues) ? globalThis.crypto.getRandomValues(b) : b.forEach((_, i) => { b[i] = Math.floor(Math.random() * 256); });
    return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  /** Upload one file into the service's holding area (retried a few times on network trouble — uploading twice is harmless). */
  async function sendStaged(cid, path, text) {
    let last = null;
    for (let i = 0; i < 3; i++) {
      let res;
      try {
        res = await svc(`/v1/stage?cid=${cid}&path=${encodeURIComponent(path)}`, { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8', ...authHeader() }, body: text });
      } catch (e) { last = e; await sleep(400 * (i + 1)); continue; }
      if (res.ok) return;
      const body = await bodyJson(res);
      if (res.status >= 500 && !(body && (body.code === 'no-database' || body.code === 'not-set-up'))) { last = new Error(`HTTP ${res.status}`); await sleep(600 * (i + 1)); continue; }
      throw serviceError(res, body, 'upload ' + path.split('/').pop());
    }
    throw last instanceof StoreError ? last : new StoreError('network', `Could not reach the store service (${(last && last.message) || 'network error'}). Check your internet connection and try again.`);
  }
  /** Re-run a read-modify-write when someone else published in between (idempotent merges make this safe). */
  async function withConflictRetry(a, fn) {
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (e) {
        if (a.discard) a.discard();
        if (e && e.code === 'conflict' && i < 3) { await sleep(400 * (i + 1)); continue; }
        throw e;
      }
    }
  }

  /* ---------- settings / start-up ---------- */
  function status() {
    return {
      configured: !!(_override || _reader), canPublish: !!(_override || (_cfg.service && isAdmin())),
      service: _cfg.service, fileService: _fileService, cfgSource: _cfgSource, hasSession: !!(_override ? _admin : _token)
    };
  }
  function rebuild() {
    _writer = null; _reader = null;
    if (_cfg.service) _reader = serviceReader();
  }
  /**
   * Called once on page load. The service address comes from store-config.json (next to index.html, committed with the
   * site — so everyone gets it) or, only when that file has none, from this browser's own saved copy.
   * An admin session that is still valid for this tab (sessionStorage) is picked up again after a reload.
   */
  async function init(opts) {
    opts = opts || {};
    if (opts.fetch) _fetch = opts.fetch;
    _cfgSource = 'none'; _fileService = ''; _cfgProblem = ''; _cfg = { service: '' };
    try { localStorage.removeItem('cla_publish'); } catch (_) { /* the old GitHub version kept a token here — never needed again */ }
    let txt = null;
    try { txt = opts.configUrl === null ? null : await configText(opts.configUrl || 'store-config.json'); } catch (_) { txt = null; }
    if (txt) {                                    // a missing file is fine; a file that can't be read is worth saying out loud
      try {
        const j = JSON.parse(txt);
        if (j && typeof j.service === 'string' && j.service.trim()) _fileService = normalizeService(j.service);
      } catch (e) {
        _fileService = '';
        _cfgProblem = 'The website’s store-config.json could not be read' + (e && e.code === 'bad-service' ? ' (the address in it is not valid)' : '') +
          '. It must look exactly like {"service": "https://your-name.workers.dev"} with straight quotes.';
      }
    }
    if (_fileService) { _cfg.service = _fileService; _cfgSource = 'file'; }
    else if (opts.service) { _cfg.service = normalizeService(opts.service); _cfgSource = 'local'; }
    else {
      const local = lsGet();
      if (local) { try { _cfg.service = normalizeService(local); _cfgSource = 'local'; } catch (_) { lsSet(''); } }
    }
    _token = ''; _exp = 0; _admin = false;
    const s = ssGet();
    if (_cfg.service && s && s.token && s.service === _cfg.service && s.exp > Store._now()) { _token = s.token; _exp = s.exp; _admin = true; }
    else if (s) ssSet(null);
    rebuild();
    if (_admin && !opts.noVerify) {               // is that session still good? (a service restart / password change ends sessions)
      try { const r = await svc('/v1/whoami', { headers: authHeader() }); if (r.status === 401) endSession(); } catch (_) { /* offline: keep it; the first admin action will say what is wrong */ }
    }
    return status();
  }
  /** store-config.json is a small file on the same site; one cache-busted read, no retries needed. */
  async function configText(url) {
    const res = await _fetch(withCb(url), { cache: 'no-store' });
    return res.ok ? await res.text() : null;
  }
  /** Direct configuration (tests / embedding). */
  function configure(o) {
    o = o || {};
    if (o.fetch) _fetch = o.fetch;
    if (o.service !== undefined) { _cfg.service = normalizeService(o.service); _cfgSource = _cfg.service ? 'local' : 'none'; }
    if (o.token !== undefined) { _token = o.token || ''; _exp = _token ? Store._now() + 12 * 3600 * 1000 : 0; _admin = !!_token; }
    rebuild();
    return status();
  }
  function getSettings() { return { service: _cfg.service, fileService: _fileService, cfgSource: _cfgSource }; }
  /** Save this browser's copy of the service address (everyone else gets it from store-config.json). */
  function saveSettings(s) {
    const service = normalizeService(s && s.service);
    if (!service) throw new StoreError('bad-service', 'Enter the store service address (it looks like https://your-name.workers.dev).');
    if (service !== _cfg.service) endSession();
    _cfg.service = service;
    let saved;
    if (service === _fileService) { _cfgSource = 'file'; lsSet(''); saved = true; }      // the website already says this — no private copy needed
    else { _cfgSource = 'local'; saved = lsSet(service); }
    rebuild();
    return { saved, service, ...status() };
  }
  /** Forget this browser's own copy (the page then uses store-config.json again, if it names a service). */
  function clearSettings() {
    lsSet('');
    if (_cfgSource === 'local') { endSession(); _cfg.service = _fileService; _cfgSource = _fileService ? 'file' : 'none'; rebuild(); }
  }
  /** The one line everyone else's page needs (committed as store-config.json next to index.html). */
  function configFileText() { return JSON.stringify({ service: _cfg.service }, null, 2) + '\n'; }
  /** Admin actions call this first: confirms the admin session is still valid. */
  async function ensureWritable() {
    const a = requireWriter();
    await guardedWrite(() => a.probeWrite());
    return true;
  }
  /** For tests / embedding: use any adapter object (reads AND writes) instead of the network. */
  function useAdapter(adapter, name) { _override = adapter; _storeName = name || 'test-store'; }
  function isConnected() { return !!(_override || _reader); }
  function storeName() { return _storeName || (_cfg.service ? _cfg.service.replace(/^https?:\/\//, '') : ''); }

  /**
   * "Check connection" for the page: walks through what has to be true and says which step is broken.
   * → { ok, steps:[{ok,label,detail}], version }
   */
  async function diagnose() {
    const steps = [];
    const add = (ok, label, detail) => steps.push({ ok: !!ok, label, detail: detail || '' });
    const done = () => ({ ok: steps.every(s => s.ok), steps, version });
    let version = null;
    if (_override) { add(true, 'Using a built-in test store'); return done(); }
    if (_cfgProblem) add(false, 'The website’s store-config.json', _cfgProblem);
    if (!_cfg.service) { add(false, 'Store service address', 'Not entered yet — paste the address from Cloudflare into the box above.'); return done(); }
    add(true, 'Store service address', _cfg.service);
    let info = null;
    try {
      const res = await svc('/v1/ping');
      info = await bodyJson(res);
      if (!res.ok || !info || info.service !== 'cla-store') { add(false, 'It is the store service', NOT_A_SERVICE); return done(); }
    } catch (e) {
      add(false, 'This browser can reach the service', e.message + ' If the address is right, the service may be switched off or blocked by your network.');
      return done();
    }
    add(true, 'This browser can reach the service');
    version = info.version;
    add(info.database, 'Database is connected', info.database ? '' : (info.problems || []).find(p => /database|D1/i.test(p)) || 'In Cloudflare, add the D1 database to the Worker (variable name DB).');
    add(info.passwords, 'Admin passwords are set', info.passwords ? '' : 'In Cloudflare, add the secret ADMIN_PASSWORDS to the Worker.');
    if (info.database) {
      try {
        const m = await loadManifest();
        const n = Object.keys(m.days).length;
        add(true, 'The store can be read', n ? `${n} day${n === 1 ? '' : 's'} stored` : 'It is empty — an admin can add files.');
      } catch (e) { add(false, 'The store can be read', e.message); }
    }
    return done();
  }

  /* ---------- admin ---------- */
  async function sha256Hex(str) {
    const c = globalThis.crypto;
    if (!c || !c.subtle) throw new StoreError('no-crypto', 'Admin login needs a secure page (https or localhost).');
    const buf = await c.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  /** Only used when a ready-made adapter is plugged in (the automated tests); the real password is checked by the service. */
  async function verifyAdminPassword(input) {
    return Store._testAdminHashes.includes(await sha256Hex(String(input == null ? '' : input).trim().toLowerCase()));
  }
  async function localLogin(input) {
    const now = Store._now();
    if (now < _lockUntil) {
      const s = Math.ceil((_lockUntil - now) / 1000);
      return { ok: false, locked: true, secondsLeft: s, message: `Too many wrong tries. Try again in ${s}s.` };
    }
    if (await verifyAdminPassword(input)) { _admin = true; _fails = 0; return { ok: true }; }
    if (++_fails >= MAX_TRIES) {
      _fails = 0; _lockUntil = now + LOCK_MS;
      return { ok: false, locked: true, secondsLeft: LOCK_MS / 1000, message: 'Too many wrong tries. Locked for 30 seconds.' };
    }
    return { ok: false, message: 'Incorrect admin password.' };
  }
  /**
   * Log in as admin. The password goes to the store service over https and is checked THERE (3-5 wrong tries lock that
   * visitor out for a couple of minutes). Success gives a 12-hour session for this browser tab.
   * → { ok } | { ok:false, message, locked?, secondsLeft?, triesLeft? }
   */
  async function adminLogin(input) {
    if (_override) return localLogin(input);
    if (!_cfg.service) return { ok: false, code: 'not-configured', message: 'The store service address is not set yet. Use “Check connection” first.' };
    let res;
    try { res = await svc('/v1/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: String(input == null ? '' : input) }) }); }
    catch (e) { return { ok: false, code: 'network', message: e.message }; }
    const body = await bodyJson(res);
    if (res.ok && body && body.token) {
      _token = body.token; _exp = Store._now() + (Number(body.expiresIn) || 43200) * 1000; _admin = true; _writer = null;
      ssSet({ token: _token, exp: _exp, service: _cfg.service });
      return { ok: true };
    }
    if (res.status === 429) {
      const s = Number(body && body.retryAfter) || Number(res.headers.get('retry-after')) || 60;
      return { ok: false, locked: true, secondsLeft: s, message: (body && body.message) || `Too many wrong tries. Try again in ${s}s.` };
    }
    if (res.status === 401) return { ok: false, message: 'Incorrect admin password.', triesLeft: body && body.triesLeft };
    if (res.status === 404 && !(body && body.code)) return { ok: false, code: 'not-a-service', message: NOT_A_SERVICE };
    if (body && body.message) return { ok: false, code: body.code, message: body.message };
    return { ok: false, message: `The store service answered HTTP ${res.status}.` };
  }
  function exitAdmin() { endSession(); }
  /** True while this page holds a valid admin session (no side effects: an ended session is cleared by the next admin action or by exitAdmin()). */
  function isAdmin() {
    if (_override) return _admin;
    return _admin && !(_exp && Store._now() >= _exp);
  }

  /* ---------- manifest + summary ---------- */
  const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.csv$/;

  /**
   * Read manifest.json (a missing one = an empty store). Adapters that can list a folder (tests / fs) also have the
   * manifest reconciled with what is really in daily/; over HTTP the manifest is trusted (commits are atomic).
   */
  async function loadManifest(adapterOpt, force) {
    const a = adapterOpt || requireAdapter();
    let m = null;
    const txt = await a.readText(MANIFEST);
    if (txt && txt.trim()) { try { m = JSON.parse(txt); } catch (_) { m = null; } }
    if (!m || typeof m !== 'object' || !m.days || typeof m.days !== 'object') m = { version: 1, days: {} };
    if (typeof a.list === 'function') {
      const present = new Set();
      for (const n of await a.list(DAILY_DIR)) { const mm = DAY_FILE_RE.exec(n); if (mm) present.add(mm[1]); }
      for (const k of Object.keys(m.days)) if (!present.has(k)) delete m.days[k];
      for (const k of present) {
        if (m.days[k]) continue;
        const mp = parseDay(await a.readText(`${DAILY_DIR}/${k}.csv`));      // recovered from the file itself
        m.days[k] = { students: mp.size, mau: countMau(mp), rawRows: 0, files: [], minTs: null, maxTs: null, updatedAt: null, recovered: true };
      }
    }
    if (a.head) Object.defineProperty(m, '_head', { value: a.head(), enumerable: false, configurable: true });     // which store version this manifest came from
    return m;
  }

  function summarize(manifest) {
    const keys = Object.keys((manifest && manifest.days) || {}).sort();
    const base = { lastAddedAt: (manifest && manifest.lastAddedAt) || null, lastAddBatch: (manifest && manifest.lastAddBatch) || [] };
    if (!keys.length) return { empty: true, firstDay: null, lastDay: null, dayCount: 0, missingDays: [], months: [], storedDays: [], studentDayRows: 0, ...base };
    const first = keys[0], last = keys[keys.length - 1];
    return {
      empty: false, firstDay: first, lastDay: last, dayCount: keys.length,
      missingDays: dayRange(first, last).filter(k => !manifest.days[k]),
      months: [...new Set(keys.map(k => k.slice(0, 7)))],
      storedDays: keys,
      studentDayRows: keys.reduce((n, k) => n + (manifest.days[k].students || 0), 0),
      ...base
    };
  }
  async function getSummary(opts) {
    const manifest = await loadManifest(null, !!(opts && opts.force));
    return { manifest, summary: summarize(manifest) };
  }
  function formatLabel(s) {
    if (!s || s.empty) return 'Store is empty — an admin needs to add files.';
    const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    let t = `Store has data from ${fmtDMY(s.firstDay)} to ${fmtDMY(s.lastDay)} · ${pl(s.dayCount, 'day')}`;
    if (s.lastAddedAt) {
      t += ` · last added ${fmtIst(s.lastAddedAt)}`;
      if (s.lastAddBatch && s.lastAddBatch.length) t += ` (${pl(s.lastAddBatch.length, 'file')})`;
    }
    if (s.missingDays.length) t += ` · ${pl(s.missingDays.length, 'day')} missing (${compressDays(s.missingDays)})`;
    return t;
  }
  /** Month grids for the coverage strip: [{month:'2026-08', label, days:[{day,stored,students,mau}]}]. */
  function coverageGrid(manifest) {
    const s = summarize(manifest);
    if (s.empty) return [];
    const out = [];
    let [y, m] = s.firstDay.split('-').map(Number);
    const [ly, lm] = s.lastDay.split('-').map(Number);
    while (y < ly || (y === ly && m <= lm)) {
      const ym = `${y}-${String(m).padStart(2, '0')}`;
      const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const days = [];
      for (let d = 1; d <= n; d++) {
        const k = `${ym}-${String(d).padStart(2, '0')}`;
        const e = manifest.days[k];
        days.push({ day: k, stored: !!e, students: e ? e.students : 0, mau: e ? e.mau : 0, inRange: k >= s.firstDay && k <= s.lastDay });
      }
      out.push({ month: ym, label: monthLabel(ym), days });
      if (++m > 12) { m = 1; y++; }
    }
    return out;
  }

  /* ---------- ingest (admin) ---------- */
  function isBlankVal(v) {
    if (v === null || v === undefined) return true;
    const s = String(v).trim().toLowerCase();
    return s === '' || s === 'nan' || s === 'n/a';
  }
  function parseOne(file, onRows, onPct) {
    return new Promise((resolve, reject) => {
      const input = file.nodeStream ? file.nodeStream() : file;
      Papa.parse(input, {
        header: true, skipEmptyLines: 'greedy', dynamicTyping: false,
        transformHeader: h => h.trim(),
        chunk: res => {
          onRows(res.data);
          if (onPct && file.size && res.meta && res.meta.cursor) onPct(Math.min(99, Math.round(res.meta.cursor * 100 / file.size)));
        },
        complete: () => resolve(),
        error: e => reject(e instanceof Error ? e : new Error(String(e && e.message || e)))
      });
    });
  }

  /**
   * Stream every file and collect per-IST-day activity in memory (nothing is written).
   * @returns {{days:Map<string,Map<string,{mau,login}>>, perFile:Array, perDay:Map, fileNames:string[]}}
   */
  async function parseLogFiles(files, onProgress) {
    const P = (typeof window !== 'undefined' && window.Processing) || {};
    if (typeof P.parseLogTimestamp !== 'function') throw new Error('processing.js must be loaded before store.js');
    const days = new Map();           // day → Map(email → {mau, login})
    const perDay = new Map();         // day → {rowsByFile: Map(file → n), minTs, maxTs}
    const perFile = [];
    const list = Array.from(files);
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      const st = { name: file.name, rows: 0, kept: 0, noEmail: 0, system: 0, badDate: 0, days: new Set() };
      const say = pct => onProgress && onProgress({ fileIndex: i, fileCount: list.length, name: file.name, pct });
      say(0);
      await parseOne(file, rows => {
        for (const row of rows) {
          st.rows++;
          const email = String(row['User Email'] == null ? '' : row['User Email']).trim().toLowerCase();
          const action = String(row['Action'] == null ? '' : row['Action']).trim();
          if (isBlankVal(email) || isBlankVal(action)) { st.noEmail++; continue; }
          const at = email.indexOf('@');
          const domain = email.slice(at + 1);
          // D6: Adobe system accounts and 'guest email' placeholders never match the roster.
          if (at < 1 || /[\s,"]/.test(email) || domain === 'adobe.com' || domain.endsWith('.adobe.com')) { st.system++; continue; }
          const ts = P.parseLogTimestamp(row['Date']);
          if (ts === null) { st.badDate++; continue; }
          const day = dayKeyFromTs(ts);
          let dm = days.get(day);
          if (!dm) { dm = new Map(); days.set(day, dm); perDay.set(day, { rowsByFile: new Map(), minTs: null, maxTs: null }); }
          const pd = perDay.get(day);
          pd.rowsByFile.set(file.name, (pd.rowsByFile.get(file.name) || 0) + 1);
          pd.minTs = minTs(pd.minTs, ts); pd.maxTs = pd.maxTs == null ? ts : Math.max(pd.maxTs, ts);
          if (MAU_ACTIONS.has(action)) mergeEntry(dm, email, ts, null); else mergeEntry(dm, email, null, ts);
          st.kept++; st.days.add(day);
        }
      }, say);
      say(100);
      perFile.push({ ...st, days: [...st.days].sort() });
    }
    return { days, perDay, perFile, fileNames: list.map(f => f.name) };
  }

  /** Warn when a batch has rows from a month the store doesn't hold yet. */
  function checkMonthGuard(parsed, manifest) {
    const storeMonths = new Set(Object.keys(manifest.days).map(k => k.slice(0, 7)));
    if (!storeMonths.size) return { warn: false };
    const batchDays = [...parsed.days.keys()].sort();
    const newMonths = [...new Set(batchDays.map(k => k.slice(0, 7)))].filter(m => !storeMonths.has(m));
    if (!newMonths.length) return { warn: false };
    const newDays = batchDays.filter(k => newMonths.includes(k.slice(0, 7)));
    const sm = [...storeMonths].sort();
    return {
      warn: true, storeMonths: sm, newMonths, newDays,
      message: `Store holds ${sm.map(monthLabel).join(' + ')} data; these files have ${newMonths.map(monthLabel).join(' + ')} rows (${compressDays(newDays)}). ` +
        'Ask an admin to reset first, or Continue to mix months.'
    };
  }

  /** Merge parsed days into the store files + manifest (idempotent: earliest timestamps win). */
  async function commitParsed(parsed, opts) {
    requireAdmin();
    const a = requireWriter();
    try {
      return await withConflictRetry(a, async () => {
        const manifest = await loadManifest(a);                    // fresh (authenticated) read
        const guard = checkMonthGuard(parsed, manifest);
        if (guard.warn && !(opts && opts.confirmMixedMonths)) return { needsConfirm: true, guard };
        await guardedWrite(() => a.probeWrite());

        const nowIso = new Date(Store._now()).toISOString();
        const dup = new Set();
        const results = [];
        for (const day of [...parsed.days.keys()].sort()) {
          const merged = parseDay(await a.readText(`${DAILY_DIR}/${day}.csv`));
          for (const [email, v] of parsed.days.get(day)) mergeEntry(merged, email, v.mau, v.login);
          await guardedWrite(() => a.writeText(`${DAILY_DIR}/${day}.csv`, serializeDay(merged)));

          const pd = parsed.perDay.get(day);
          const e = manifest.days[day] || { students: 0, mau: 0, rawRows: 0, files: [], minTs: null, maxTs: null };
          for (const [fname, n] of pd.rowsByFile) {
            if (e.files.includes(fname)) dup.add(fname); else { e.files.push(fname); e.rawRows = (e.rawRows || 0) + n; }
          }
          e.students = merged.size; e.mau = countMau(merged);
          e.minTs = minTs(e.minTs, pd.minTs); e.maxTs = e.maxTs == null ? pd.maxTs : Math.max(e.maxTs, pd.maxTs);
          e.updatedAt = nowIso; delete e.recovered;
          manifest.days[day] = e;
          results.push({ day, students: e.students, mau: e.mau, files: pd.rowsByFile.size, rows: [...pd.rowsByFile.values()].reduce((x, y) => x + y, 0) });
        }
        manifest.version = 1;
        manifest.lastAddedAt = nowIso;
        manifest.lastAddBatch = parsed.fileNames.slice();
        await guardedWrite(() => a.writeText(MANIFEST, JSON.stringify(manifest, null, 1)));
        // Remote store: everything above was buffered; this publishes it as ONE commit (all-or-nothing).
        if (typeof a.flush === 'function') await guardedWrite(() => a.flush(`Add ${results.length} day(s): ${compressDays(results.map(r => r.day))} (${parsed.fileNames.length} file(s))`));
        return { ok: true, days: results, duplicateFiles: [...dup], perFile: parsed.perFile, guard, published: typeof a.flush === 'function' };
      });
    } finally { if (a.discard) a.discard(); }
  }

  /**
   * Admin: add one or many raw Content-Log CSVs. If the batch has rows from a different
   * month than the store, resolves {needsConfirm, guard, commit()} — call commit() to proceed.
   */
  async function ingestLogFiles(files, onProgress, opts) {
    requireAdmin();
    const parsed = await parseLogFiles(files, onProgress);
    if (!parsed.days.size) throw new StoreError('no-rows', 'No usable rows found (need Action, Date and User Email columns).');
    const res = await commitParsed(parsed, opts);
    if (res.needsConfirm) return { ...res, parsed, commit: () => commitParsed(parsed, { confirmMixedMonths: true }) };
    return res;
  }

  /* ---------- reset (admin) ---------- */
  async function resetStore() {
    requireAdmin();
    const a = requireWriter();
    try {
      return await withConflictRetry(a, async () => {
        await guardedWrite(() => a.probeWrite());
        const manifest = await loadManifest(a);
        const keys = Object.keys(manifest.days).sort();
        if (!keys.length) throw new StoreError('empty', 'The store is already empty — nothing to reset.');
        let folder = `${ARCHIVE_DIR}/${keys[0].slice(0, 7)}`, n = 2;
        while (await a.exists(`${folder}/${MANIFEST}`)) folder = `${ARCHIVE_DIR}/${keys[0].slice(0, 7)}_${n++}`;
        // 1) copy everything to the archive, 2) verify, 3) only then remove the originals.
        for (const k of keys) {
          const t = await a.readText(`${DAILY_DIR}/${k}.csv`);
          if (t != null) await guardedWrite(() => a.writeText(`${folder}/${DAILY_DIR}/${k}.csv`, t));
        }
        await guardedWrite(() => a.writeText(`${folder}/${MANIFEST}`, JSON.stringify(manifest, null, 1)));
        for (const k of keys) {
          if ((await a.exists(`${DAILY_DIR}/${k}.csv`)) && !(await a.exists(`${folder}/${DAILY_DIR}/${k}.csv`)))
            throw new StoreError('archive-failed', `Could not archive ${k}; nothing was deleted.`);
        }
        for (const k of keys) await guardedWrite(() => a.remove(`${DAILY_DIR}/${k}.csv`));
        await guardedWrite(() => a.writeText(MANIFEST, JSON.stringify({ version: 1, days: {}, resetAt: new Date(Store._now()).toISOString(), archivedTo: folder }, null, 1)));
        // Remote store: publish the whole move as ONE commit (the archive and the empty store appear together).
        if (typeof a.flush === 'function') await guardedWrite(() => a.flush(`Archive ${keys[0].slice(0, 7)} to ${folder} and reset the store`));
        return { archivedTo: folder, dayCount: keys.length, firstDay: keys[0], lastDay: keys[keys.length - 1], studentDayRows: summarize(manifest).studentDayRows };
      });
    } finally { if (a.discard) a.discard(); }
  }

  /* ---------- read a range ---------- */
  /** Earliest MAU / login timestamp per student across the stored days in [fromKey, toKey]. */
  async function loadActivityForRange(fromKey, toKey, manifestOpt) {
    const a0 = requireAdapter();
    const manifest = manifestOpt || await loadManifest();
    const a = (manifest._head != null && a0.at) ? a0.at(manifest._head) : a0;      // read the same store version the manifest came from
    const firstMau = new Map(), firstLogin = new Map(), missingDays = [], storedDays = [];
    const days = dayRange(fromKey, toKey);
    const wanted = days.filter(k => manifest.days[k]);
    const texts = new Map();
    let next = 0;                                              // small worker pool: ≤ 6 downloads at a time
    const worker = async () => {
      while (next < wanted.length) {
        const k = wanted[next++];
        try { texts.set(k, await a.readText(`${DAILY_DIR}/${k}.csv`)); }
        catch (e) {
          if (e instanceof StoreError) throw e;
          throw new StoreError('read-failed', `Could not read ${k}.csv (${e.message || e.name}).`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, wanted.length) }, worker));
    for (const k of days) {
      if (!manifest.days[k]) { missingDays.push(k); continue; }
      const txt = texts.get(k);
      if (txt == null) { missingDays.push(k); continue; }
      storedDays.push(k);
      for (const [email, v] of parseDay(txt)) {
        if (v.mau != null) { const p = firstMau.get(email); if (p === undefined || v.mau < p) firstMau.set(email, v.mau); }
        if (v.login != null) { const p = firstLogin.get(email); if (p === undefined || v.login < p) firstLogin.set(email, v.login); }
      }
    }
    return { firstMau, firstLogin, missingDays, storedDays };
  }

  /* ---------- validation (pure) ---------- */
  /**
   * @param p  {mode:'normal'|'repeated', from, to, lookbackFrom}  (day keys or '')
   * @returns {{errors:{code,msg}[], warnings:{code,msg}[], windows:{report, lookback}}}
   */
  function validateRange(p, summary, today) {
    const errors = [], warnings = [];
    const E = (code, msg) => errors.push({ code, msg });
    const W = (code, msg) => warnings.push({ code, msg });
    const mode = p && p.mode === 'repeated' ? 'repeated' : 'normal';
    const from = (p && p.from) || '', to = (p && p.to) || '', lb = (p && p.lookbackFrom) || '';
    const windows = { report: null, lookback: null };
    const storeEmpty = !summary || summary.empty;

    if (!isDayKey(from) || !isDayKey(to)) E('range-empty', 'Pick both From and To dates.');
    else {
      windows.report = { from, to };
      if (from > to) E('range-order', 'From date must be on or before To date.');
      if (from > today || to > today) E('future', "Dates after today aren't allowed.");
    }
    if (storeEmpty) E('store-empty', 'The store is empty — an admin needs to add files first.');
    else if (windows.report && from <= to) {
      const { firstDay, lastDay } = summary;
      if (to < firstDay || from > lastDay) {
        E('outside-store', `No data stored for ${compressDays(dayRange(from, to))}. Store has data from ${fmtDMY(firstDay)} to ${fmtDMY(lastDay)}.`);
      } else {
        const outside = dayRange(from, to).filter(k => k < firstDay || k > lastDay);
        if (outside.length) W('partly-outside', `Store only covers ${fmtDMY(firstDay)} to ${fmtDMY(lastDay)}. Days outside this (${compressDays(outside)}) count as no activity, so MAU will be understated.`);
        const miss = summary.missingDays.filter(k => k >= from && k <= to);
        if (miss.length) W('missing-in-range', `No data for ${compressDays(miss)}.`);
      }
    }
    if (mode === 'repeated') {
      if (!isDayKey(lb)) E('lookback-empty', 'Pick the look-back start date.');
      else if (windows.report && from <= to) {
        if (lb >= from) E('lookback-order', 'Look-back must start before the report period.');
        else {
          const lbEnd = addDays(from, -1);
          windows.lookback = { from: lb, to: lbEnd };
          if (!storeEmpty) {
            const { firstDay, lastDay } = summary;
            if (lb < firstDay) W('lookback-before-store', `Look-back starts before stored data (${fmtDMY(firstDay)}); earlier days count as no activity.`);
            const miss = summary.missingDays.filter(k => k >= lb && k <= lbEnd && k >= firstDay && k <= lastDay);
            if (miss.length) W('missing-in-lookback', `Look-back has no data for ${compressDays(miss)}.`);
          }
        }
      }
    }
    return { errors, warnings, windows };
  }
  /** Quick-pick look-back start dates: 'month-start' | '7d' | '30d' | 'all' → day key or null. */
  function lookbackPreset(name, from, summary) {
    if (!isDayKey(from)) return null;
    let k = null;
    if (name === 'month-start') k = from.slice(0, 7) + '-01';
    else if (name === '7d') k = addDays(from, -7);
    else if (name === '30d') k = addDays(from, -30);
    else if (name === 'all') k = summary && !summary.empty ? summary.firstDay : null;
    return k && k < from ? k : null;
  }

  /* ---------- range report (Normal / With Repeated) ---------- */
  /** Output file name for a report — known before processing so the UI can open the save picker first. */
  function reportFilename(p) {
    return `Adobe_MAU_${fmtDMY(p.from)}_to_${fmtDMY(p.to)}${p.mode === 'repeated' ? '_with_Repeated' : ''}.xlsx`;
  }
  async function runRangeReport(p, status, progress, templateArrayBuffer) {
    const P = window.Processing;
    const st = status || (() => {}), pr = progress || (() => {});
    const mode = p.mode === 'repeated' ? 'repeated' : 'normal';
    // Read the manifest, then every day it lists, from ONE state of the store. If an admin publishes right in the middle
    // the service says so ('changed') and we just start the reading again (at most twice).
    let manifest, summary, cur, prev = null, lbEnd = null;
    for (let attempt = 0; ; attempt++) {
      try {
        manifest = await loadManifest();
        summary = summarize(manifest);
        const v = validateRange({ ...p, mode }, summary, todayKey());
        if (v.errors.length) throw new StoreError('invalid', v.errors[0].msg);
        st('Reading stored activity…'); pr(4);
        cur = await loadActivityForRange(p.from, p.to, manifest);
        if (mode === 'repeated') {
          lbEnd = addDays(p.from, -1);
          st('Reading look-back activity…'); pr(8);
          prev = await loadActivityForRange(p.lookbackFrom, lbEnd, manifest);
        }
        break;
      } catch (e) {
        if (e && e.code === 'changed' && attempt < 2) { st('The store was just updated — reading it again…'); continue; }
        throw e;
      }
    }
    const createdList = [...cur.firstMau.keys()].sort();
    const otherList = [...cur.firstLogin.keys()].sort();
    const activity = { createdList, otherList, createdSet: new Set(createdList), otherSet: new Set(otherList), firstMau: cur.firstMau, fileStats: [] };
    const opts = { mode: 'range' };
    if (prev) {
      opts.earlierMauMap = prev.firstMau;
      opts.earlierLabel = 'MAU in Look-back';
      opts.repeatedTitle = `Repeated / New / Pending — look-back ${fmtDMY(p.lookbackFrom)} to ${fmtDMY(lbEnd)} vs report ${fmtDMY(p.from)} to ${fmtDMY(p.to)}`;
    }
    const res = await P.buildReportFromActivity(activity, opts, st, pr, templateArrayBuffer);
    res.filename = reportFilename({ ...p, mode });
    if (res.pendingCsvBlob) res.pendingCsvName = `Pending_Students_${fmtDMY(p.from)}_to_${fmtDMY(p.to)}.csv`;
    const split = days => ({
      gaps: days.filter(k => !summary.empty && k >= summary.firstDay && k <= summary.lastDay),
      outside: days.filter(k => summary.empty || k < summary.firstDay || k > summary.lastDay)
    });
    res.range = {
      mode, from: p.from, to: p.to, lookbackFrom: mode === 'repeated' ? p.lookbackFrom : null, lookbackTo: lbEnd,
      storedDays: cur.storedDays.length, studentsWithActivity: createdList.length + otherList.length,
      missingCurrent: split(cur.missingDays), missingLookback: prev ? split(prev.missingDays) : null
    };
    return res;
  }

  /* ---------- public API ---------- */
  const Store = {
    StoreError,
    _now: () => Date.now(),                    // overridable clock (tests)
    _testAdminHashes: [],                      // only for the automated tests' built-in login (see adminLogin)
    // where the store lives / connection settings
    init, configure, getSettings, saveSettings, clearSettings, configFileText, normalizeService, ensureWritable, diagnose, useAdapter, isConnected, storeName, status,
    // admin
    verifyAdminPassword, adminLogin, exitAdmin, isAdmin,
    // data
    parseLogFiles, commitParsed, ingestLogFiles, resetStore, loadManifest, getSummary, summarize, formatLabel, coverageGrid,
    loadActivityForRange, validateRange, lookbackPreset, runRangeReport, reportFilename,
    // helpers (exported for the UI + tests)
    dayKeyFromTs, todayKey, addDays, dayRange, fmtDMY, fmtShort, compressDays, monthLabel, fmtIst, isDayKey,
    parseDay, serializeDay, checkMonthGuard
  };
  window.Store = Store;
})();
