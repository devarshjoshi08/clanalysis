/* ============================================================
 * store.js — Daily activity store + date-range MAU report (Tab 4)
 *
 * The store is a small public GitHub "data repo". Everyone reads it over plain HTTPS (no login, no Zoho);
 * admins add days / reset it from the page, which publishes one atomic commit (see "where the store lives").
 * Layout inside the data repo:
 *
 *   manifest.json            index of stored days
 *   daily/YYYY-MM-DD.csv     one file per IST day:  email,first_mau_ts,first_login_ts
 *   archive/YYYY-MM/...      created by an admin "Reset store" (nothing is ever deleted — git keeps history too)
 *
 * Only EARLIEST timestamps are kept per student per day, so adding the same raw
 * file twice (or overlapping files) can never double-count.
 *
 * All storage I/O goes through a small adapter (readText / writeText / exists / remove / probeWrite,
 * optional list / flush / discard) so the same code runs in the browser (HTTP + GitHub API) and in
 * Node tests (fs).
 *
 * Depends on (loaded earlier): Papa (PapaParse) and window.Processing
 * (parseLogTimestamp, buildReportFromActivity).
 * No credential is stored in the code: an admin's GitHub token lives only in that admin's browser.
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- constants ---------- */
  // SHA-256 of the lower-cased admin passwords (the plain values are NOT in the code).
  const ADMIN_HASHES = [
    'c7bcbc30c7637ba219cf01ac67038bb82dd7dd02d046f3ff5a49dbdb02f8fb09',
    '33abca26a552dc051412d73810df2e91fb8a58e09a53e56549b424dd7d660de4'
  ];
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
  // Readers (everyone, no login): plain HTTPS GET of  <base>manifest.json  and  <base>daily/YYYY-MM-DD.csv
  //   from a public GitHub "data repo" (served by raw.githubusercontent.com unless dataBaseUrl says otherwise).
  // Admins: one atomic commit per Add / Reset through the GitHub Git Data API, using a fine-grained token
  //   that lives only in that admin's browser (localStorage) — never in the code.
  const DEFAULT_CFG = { repo: '', branch: 'main', dataBaseUrl: '', apiBase: 'https://api.github.com', rawBase: 'https://raw.githubusercontent.com' };
  const LS_KEY = 'cla_publish';
  const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  let _cfg = { ...DEFAULT_CFG };          // effective settings
  let _token = '';
  let _fetch = (...a) => fetch(...a);     // overridable (tests)
  let _override = null;                   // tests: one ready-made adapter used for reads AND writes
  let _reader = null, _writer = null, _storeName = '', _cfgSource = 'none', _shared = '', _siteRepo = '';     // _shared = the repo every visitor gets by default
  let _admin = false, _fails = 0, _lockUntil = 0;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const encPath = p => p.split('/').map(encodeURIComponent).join('/');
  function lsGet() { try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (_) { return null; } }
  function lsSet(o) { try { if (o) localStorage.setItem(LS_KEY, JSON.stringify(o)); else localStorage.removeItem(LS_KEY); return true; } catch (_) { return false; } }
  const withCb = u => u + (u.includes('?') ? '&' : '?') + 'cb=' + Date.now();      // busts browser/proxy caches (NOT GitHub's file CDN — that is why reads are pinned to a commit)

  function requireAdapter() {
    const a = _override || _reader;
    if (!a) throw new StoreError('not-configured', "The shared store isn't set up yet. An admin needs to finish the one-time setup (see Publishing settings).");
    return a;
  }
  function requireWriter() {
    if (_override) return _override;
    if (!_cfg.repo || !REPO_RE.test(_cfg.repo)) throw new StoreError('not-configured', 'Publishing settings are incomplete: enter the data repository as owner/name.');
    if (!_token) throw new StoreError('no-token', 'Add your GitHub token in Publishing settings first.');
    if (!_writer) _writer = githubWriter();
    return _writer;
  }
  function requireAdmin() {
    if (!_admin) throw new StoreError('not-admin', 'Admin login required.');
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

  /* ---------- reading (everyone) ---------- */
  /** GET text; 404 → null. Retries a few times on network errors / 429 / 5xx. */
  async function httpGetText(url) {
    let last = null;
    for (let i = 0; i < 3; i++) {
      let res;
      try { res = await _fetch(withCb(url), { cache: 'no-store' }); }
      catch (e) { last = e; await sleep(300 * (i + 1)); continue; }
      if (res.status === 404) return null;
      if (res.ok) return await res.text();
      if (res.status === 429 || res.status >= 500) { last = new Error(`HTTP ${res.status}`); await sleep(600 * (i + 1)); continue; }
      throw new StoreError('http', `Could not load ${url.split('/').slice(-2).join('/')} (HTTP ${res.status}).`);
    }
    throw new StoreError('network', `Could not reach the store (${(last && last.message) || 'network error'}). Check your internet connection and press Refresh.`);
  }
  function readBase() {
    let b = _cfg.dataBaseUrl || (_cfg.repo ? `${_cfg.rawBase}/${_cfg.repo}/${encPath(_cfg.branch || 'main')}/` : '');
    if (b && !b.endsWith('/')) b += '/';
    return b;
  }
  /**
   * Reader for everyone (no login). raw.githubusercontent.com keeps every file for ~5 minutes and ignores ?query
   * strings, so reading "the main branch" can show yesterday's data right after an admin published. To avoid that,
   * a GitHub repo is read at an exact COMMIT: the latest commit id is looked up first (one tiny API call), then every
   * file is fetched from that commit's own URL — those never go stale and the manifest + day files always match.
   * If the lookup fails (e.g. GitHub's anonymous rate limit), it quietly falls back to the branch URL.
   * `pin` = { repo, branch } for a GitHub repo, or null for a plain base URL.
   */
  function remoteReader(base, pin) {
    let head = null, headAt = 0, known = null;                // head = commit id currently read; known = our own latest publish
    const HEAD_TTL = 60 * 1000, KNOWN_TTL = 90 * 1000;
    const pinned = sha => `${_cfg.rawBase}/${pin.repo}/${sha}/`;
    const make = root => ({
      remote: true,
      async readText(path) { return httpGetText(root() + encPath(path)); },
      async exists(path) { return (await this.readText(path)) !== null; }
    });
    const r = make(() => (pin && head) ? pinned(head) : base);
    /** Find the newest commit. `force` skips the 60-second memory (Refresh button). Returns the commit id or null. */
    r.resolveHead = async function (force) {
      if (!pin) return null;
      const now = Date.now();
      if (known && now < known.until) { head = known.sha; headAt = now; return head; }
      if (!force && head && now - headAt < HEAD_TTL) return head;
      try {
        const res = await _fetch(`${_cfg.apiBase}/repos/${pin.repo}/commits/${encodeURIComponent(pin.branch)}`, {
          cache: 'no-store',
          headers: { Accept: 'application/vnd.github.sha', ...(_token ? { Authorization: `Bearer ${_token}` } : {}) }
        });
        if (res.ok) {
          const t = (await res.text()).trim();
          if (/^[0-9a-f]{40}$/i.test(t)) { head = t; headAt = Date.now(); return head; }
        }
      } catch (_) { /* fall back below */ }
      head = null; headAt = 0;
      return null;
    };
    r.head = () => head;
    /** The admin's own publish: show it right away instead of waiting for GitHub's caches. */
    r.note = sha => { if (pin && /^[0-9a-f]{40}$/i.test(sha || '')) { known = { sha, until: Date.now() + KNOWN_TTL }; head = sha; headAt = Date.now(); } };
    /** A reader fixed to one commit (so a report reads exactly the data its manifest described). */
    r.at = sha => (pin && sha) ? make(() => pinned(sha)) : r;
    return r;
  }

  /* ---------- publishing (admins) ---------- */
  async function ghError(res, what) {
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch (_) { /* not json */ }
    const repo = _cfg.repo;
    if (res.status === 401) return new StoreError('bad-token', "GitHub didn't accept the token (wrong or expired). Open Publishing settings and paste a new one.");
    if (res.status === 403) {
      if (res.headers && res.headers.get && res.headers.get('x-ratelimit-remaining') === '0') return new StoreError('rate-limit', 'GitHub is rate-limiting requests right now. Wait a few minutes and try again.');
      return new StoreError('no-write', `The token isn't allowed to ${what || 'change'} ${repo}. It needs access to that repository with "Contents: Read and write".`);
    }
    if (res.status === 404) return new StoreError('no-repo', `GitHub can't find ${repo}, or the token has no access to it. Check the name and token in Publishing settings.`);
    if (res.status === 409 || (res.status === 422 && /fast.?forward/i.test(msg))) return new StoreError('conflict', 'Someone else published at the same moment.');
    return new StoreError('github', `GitHub said: ${msg || ('HTTP ' + res.status)}${what ? ` (while trying to ${what})` : ''}`);
  }

  /** Write adapter: reads are authenticated and fresh; writes are buffered and pushed by flush() as ONE commit. */
  function githubWriter() {
    const repo = _cfg.repo, branch = _cfg.branch || 'main';
    const pending = new Map();                          // path → {content} | {del:true}
    async function api(method, path, body, accept) {
      try {
        return await _fetch(`${_cfg.apiBase}${path}`, {
          method, cache: 'no-store',
          headers: {
            Authorization: `Bearer ${_token}`, Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
            ...(body ? { 'Content-Type': 'application/json' } : {})
          },
          body: body ? JSON.stringify(body) : undefined
        });
      } catch (e) { throw new StoreError('network', `Could not reach GitHub (${e.message || 'network error'}). Check your internet connection.`); }
    }
    const must = async (res, what) => { if (!res.ok) throw await ghError(res, what); return res.json(); };
    const refPath = `/repos/${repo}/git/refs/heads/${encPath(branch)}`;
    return {
      remote: true,
      async readText(path) {
        if (pending.has(path)) { const v = pending.get(path); return v.del ? null : v.content; }
        const res = await api('GET', `/repos/${repo}/contents/${encPath(path)}?ref=${encodeURIComponent(branch)}`, null, 'application/vnd.github.raw+json');
        if (res.status === 404) return null;
        if (!res.ok) throw await ghError(res, 'read');
        return res.text();
      },
      async exists(path) { return (await this.readText(path)) !== null; },
      async writeText(path, text) { pending.set(path, { content: text }); },
      async remove(path) { pending.set(path, { del: true }); },
      /** Checks the token can reach the repo and (when GitHub says) push to it. No change is made. */
      async probeWrite() {
        const res = await api('GET', `/repos/${repo}`);
        const info = await must(res, 'access');
        if (info && info.permissions && info.permissions.push === false) throw new StoreError('no-write', `The token can read ${repo} but not change it. It needs "Contents: Read and write".`);
        return info;
      },
      async flush(message) {
        if (!pending.size) return null;
        let res = await api('GET', `/repos/${repo}/git/ref/heads/${encPath(branch)}`);
        if (res.status === 404 || res.status === 409) throw new StoreError('no-branch', `Branch “${branch}” doesn't exist in ${repo}. Create the repository with a README so it has a ${branch} branch.`);
        const head = (await must(res, 'read the branch')).object.sha;
        const baseTree = (await must(await api('GET', `/repos/${repo}/git/commits/${head}`), 'read the branch')).tree.sha;
        const dels = [...pending].filter(([, v]) => v.del).map(([p]) => p);
        let existing = new Set();
        if (dels.length) existing = new Set((await must(await api('GET', `/repos/${repo}/git/trees/${baseTree}?recursive=1`), 'read the store')).tree.map(t => t.path));
        const tree = [];
        for (const [p, v] of pending) {
          if (v.del) { if (existing.has(p)) tree.push({ path: p, mode: '100644', type: 'blob', sha: null }); }
          else tree.push({ path: p, mode: '100644', type: 'blob', content: v.content });
        }
        if (!tree.length) { pending.clear(); return null; }
        const newTree = (await must(await api('POST', `/repos/${repo}/git/trees`, { base_tree: baseTree, tree }), 'write')).sha;
        const commit = (await must(await api('POST', `/repos/${repo}/git/commits`, { message, tree: newTree, parents: [head] }), 'write')).sha;
        res = await api('PATCH', refPath, { sha: commit, force: false });
        if (!res.ok) throw await ghError(res, 'write');
        pending.clear();
        if (_reader && _reader.note) _reader.note(commit);        // our own page shows the new data immediately
        return { commit };
      },
      discard() { pending.clear(); }
    };
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
  /**
   * A site hosted on GitHub Pages lives at https://<owner>.github.io/<repo>/ — so its own repository can be worked out
   * from the address, with no setup. (Used only when store-config.json doesn't name a repository.)
   */
  function inferSiteRepo(loc) {
    try {
      loc = loc || (typeof location !== 'undefined' ? location : null);
      if (!loc) return '';
      const m = /^([a-z0-9-]+)\.github\.io$/.exec(String(loc.hostname || '').toLowerCase());
      if (!m) return '';
      const seg = String(loc.pathname || '/').split('/').filter(Boolean)[0];
      const repo = (!seg || /\.html?$/i.test(seg)) ? `${m[1]}.github.io` : decodeURIComponent(seg);     // a "user site" lives at the root
      const full = `${m[1]}/${repo}`;
      return REPO_RE.test(full) ? full : '';
    } catch (_) { return ''; }
  }
  function status() {
    return {
      configured: !!(_override || _reader), canPublish: !!(_override || (_cfg.repo && REPO_RE.test(_cfg.repo) && _token)),
      repo: _cfg.repo, branch: _cfg.branch, hasToken: !!_token, source: _cfg.dataBaseUrl ? 'url' : (_cfg.repo ? 'repo' : 'none'), cfgSource: _cfgSource
    };
  }
  function rebuild() {
    _writer = null; _reader = null;
    const base = readBase();
    if (base) _reader = remoteReader(base, (!_cfg.dataBaseUrl && _cfg.repo && REPO_RE.test(_cfg.repo)) ? { repo: _cfg.repo, branch: _cfg.branch || 'main' } : null);
  }
  /**
   * Called once on page load. Settings come from store-config.json (next to index.html, committed with the site)
   * and, for admins, from this browser's own saved Publishing settings.
   */
  async function init(opts) {
    opts = opts || {};
    if (opts.fetch) _fetch = opts.fetch;
    _cfgSource = 'none';
    const fileCfg = {};
    try {
      const txt = opts.configUrl === null ? null : await httpGetText(opts.configUrl || 'store-config.json');
      if (txt) {
        const j = JSON.parse(txt);
        for (const k of ['repo', 'branch', 'dataBaseUrl']) if (typeof j[k] === 'string' && j[k].trim()) fileCfg[k] = j[k].trim();
        if (Object.keys(fileCfg).length) _cfgSource = 'file';
      }
    } catch (_) { /* no / bad config file → fall through */ }
    const local = lsGet() || {};
    _token = typeof local.token === 'string' ? local.token : '';
    _cfg = { ...DEFAULT_CFG, ...(opts.defaults || {}), ...fileCfg };
    _siteRepo = opts.noInfer ? '' : inferSiteRepo(opts.location);
    if (!_cfg.repo && !_cfg.dataBaseUrl && _siteRepo) { _cfg.repo = _siteRepo; _cfgSource = 'site'; }     // nothing in store-config.json → the site's own repository
    _shared = (_cfg.repo || _cfg.dataBaseUrl) ? _cfg.repo : '';
    if (local.repo && REPO_RE.test(local.repo)) { _cfg.repo = local.repo; _cfgSource = 'local'; }
    if (local.branch) _cfg.branch = local.branch;
    rebuild();
    return status();
  }
  /** Direct configuration (tests / embedding). */
  function configure(o) {
    o = o || {};
    if (o.fetch) _fetch = o.fetch;
    for (const k of ['repo', 'branch', 'dataBaseUrl', 'apiBase', 'rawBase']) if (o[k] !== undefined) _cfg[k] = o[k];
    if (o.token !== undefined) _token = o.token;
    rebuild();
    return status();
  }
  function getSettings() { return { repo: _cfg.repo, branch: _cfg.branch, hasToken: !!_token, fileRepo: _shared, siteRepo: _siteRepo }; }
  /** Save this browser's Publishing settings. token === '' keeps the saved token; token === null removes it. */
  function saveSettings(s) {
    const repo = String((s && s.repo) || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    const branch = String((s && s.branch) || '').trim() || 'main';
    if (!REPO_RE.test(repo)) throw new StoreError('bad-repo', 'Enter the data repository as owner/name, for example myorg/clanalysis-data.');
    const token = s && s.token === null ? '' : (s && s.token ? String(s.token).trim() : _token);
    _token = token; _cfg.repo = repo; _cfg.branch = branch; _cfgSource = 'local';
    const saved = lsSet({ repo, branch, token });
    rebuild();
    return { saved, ...status() };
  }
  function clearToken() { _token = ''; const l = lsGet() || {}; lsSet({ repo: l.repo || _cfg.repo, branch: l.branch || _cfg.branch, token: '' }); rebuild(); }
  /** The one line everyone else's page needs (commit it as store-config.json next to index.html). */
  function configFileText() { return JSON.stringify({ repo: _cfg.repo, branch: _cfg.branch }, null, 2) + '\n'; }
  /** Admin actions call this first: confirms there is a token and that it can reach the repo. */
  async function ensureWritable() {
    const a = requireWriter();
    await guardedWrite(() => a.probeWrite());
    return true;
  }
  /** For tests / embedding: use any adapter object (reads AND writes) instead of the network. */
  function useAdapter(adapter, name) { _override = adapter; _storeName = name || 'test-store'; }
  function isConnected() { return !!(_override || _reader); }
  function storeName() { return _storeName || _cfg.repo || ''; }

  /* ---------- admin ---------- */
  async function sha256Hex(str) {
    const c = globalThis.crypto;
    if (!c || !c.subtle) throw new StoreError('no-crypto', 'Admin login needs a secure page (https or localhost).');
    const buf = await c.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function verifyAdminPassword(input) {
    return ADMIN_HASHES.includes(await sha256Hex(String(input == null ? '' : input).trim().toLowerCase()));
  }
  /** Check the password with a 3-tries / 30-second lockout. Admin mode lasts until exitAdmin() or page close. */
  async function adminLogin(input) {
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
  function exitAdmin() { _admin = false; }
  function isAdmin() { return _admin; }

  /* ---------- manifest + summary ---------- */
  const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.csv$/;

  /**
   * Read manifest.json (a missing one = an empty store). Adapters that can list a folder (tests / fs) also have the
   * manifest reconciled with what is really in daily/; over HTTP the manifest is trusted (commits are atomic).
   */
  async function loadManifest(adapterOpt, force) {
    const a = adapterOpt || requireAdapter();
    if (!adapterOpt && typeof a.resolveHead === 'function') await a.resolveHead(!!force);     // newest commit (see remoteReader)
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
    if (a.head) Object.defineProperty(m, '_head', { value: a.head(), enumerable: false, configurable: true });     // which commit this manifest came from
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
    const a = (manifest._head && a0.at) ? a0.at(manifest._head) : a0;      // read the same commit the manifest came from
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
    const manifest = await loadManifest();
    const summary = summarize(manifest);
    const v = validateRange({ ...p, mode }, summary, todayKey());
    if (v.errors.length) throw new StoreError('invalid', v.errors[0].msg);

    st('Reading stored activity…'); pr(4);
    const cur = await loadActivityForRange(p.from, p.to, manifest);
    let prev = null, lbEnd = null;
    if (mode === 'repeated') {
      lbEnd = addDays(p.from, -1);
      st('Reading look-back activity…'); pr(8);
      prev = await loadActivityForRange(p.lookbackFrom, lbEnd, manifest);
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
    StoreError, ADMIN_HASHES,
    _now: () => Date.now(),                    // overridable clock (tests)
    // where the store lives / publishing settings
    init, configure, getSettings, saveSettings, clearToken, configFileText, ensureWritable, useAdapter, isConnected, storeName, status,
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
