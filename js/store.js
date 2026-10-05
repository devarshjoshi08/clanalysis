/* ============================================================
 * store.js — Daily activity store + date-range MAU report (Tab 4)
 *
 * The store is a plain folder (a Zoho WorkDrive folder synced to the laptop by
 * WorkDrive TrueSync) that the browser reads/writes through the File System
 * Access API. Layout:
 *
 *   manifest.json            index of stored days (rebuilt from daily/ if lost)
 *   daily/YYYY-MM-DD.csv     one file per IST day:  email,first_mau_ts,first_login_ts
 *   archive/YYYY-MM/...      created by an admin "Reset store"
 *
 * Only EARLIEST timestamps are kept per student per day, so adding the same raw
 * file twice (or overlapping files) can never double-count.
 *
 * All folder I/O goes through a small adapter (readText / writeText / exists /
 * dirExists / list / remove / probeWrite) so the same code runs in the browser
 * (FileSystemDirectoryHandle) and in Node tests (fs).
 *
 * Depends on (loaded earlier): Papa (PapaParse) and window.Processing
 * (parseLogTimestamp, buildReportFromActivity).
 * No credentials live here — the Zoho account is only used by TrueSync itself.
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
  const READ_ONLY_MSG = 'This folder is read-only for you (WorkDrive Viewer). Ask an admin with Editor access to do this.';

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

  /* ---------- adapter (browser) ---------- */
  function splitPath(p) { const parts = p.split('/'); return { dirs: parts.slice(0, -1), name: parts[parts.length - 1] }; }
  async function walkDir(root, dirs, create) {
    let d = root;
    for (const part of dirs) d = await d.getDirectoryHandle(part, { create: !!create });
    return d;
  }
  const isNotFound = e => e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError');

  function browserAdapter(root) {
    return {
      async readText(path) {
        const { dirs, name } = splitPath(path);
        try {
          const dir = await walkDir(root, dirs, false);
          const fh = await dir.getFileHandle(name);
          return await (await fh.getFile()).text();
        } catch (e) { if (isNotFound(e)) return null; throw e; }
      },
      async writeText(path, text) {
        const { dirs, name } = splitPath(path);
        const dir = await walkDir(root, dirs, true);
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(text);
        await w.close();
      },
      async exists(path) { return (await this.readText(path)) !== null; },
      async dirExists(path) {
        try { await walkDir(root, path.split('/'), false); return true; } catch (e) { if (isNotFound(e)) return false; throw e; }
      },
      async list(dirPath) {
        try {
          const dir = await walkDir(root, dirPath ? dirPath.split('/') : [], false);
          const out = [];
          for await (const [name, h] of dir.entries()) if (h.kind === 'file') out.push(name);
          return out;
        } catch (e) { if (isNotFound(e)) return []; throw e; }
      },
      async remove(path) {
        const { dirs, name } = splitPath(path);
        const dir = await walkDir(root, dirs, false);
        await dir.removeEntry(name);
      },
      /** Throws if this user can't write (e.g. WorkDrive Viewer). Creates an empty manifest if absent. */
      async probeWrite() {
        const fh = await root.getFileHandle(MANIFEST, { create: true });
        const w = await fh.createWritable({ keepExistingData: true });
        await w.abort();                                   // permission check only — no change
        if ((await fh.getFile()).size === 0) {
          const w2 = await fh.createWritable();
          await w2.write(JSON.stringify({ version: 1, days: {} }));
          await w2.close();
        }
      }
    };
  }

  /* ---------- connection state ---------- */
  let _adapter = null, _handle = null, _pendingHandle = null, _folderName = '';
  let _admin = false, _fails = 0, _lockUntil = 0;

  function setFolder(handle) {
    _handle = handle; _pendingHandle = null; _folderName = handle.name || '';
    _adapter = browserAdapter(handle);
  }
  function requireAdapter() {
    if (!_adapter) throw new StoreError('no-folder', 'Choose the store folder first.');
    return _adapter;
  }
  function requireAdmin() {
    if (!_admin) throw new StoreError('not-admin', 'Admin login required.');
  }
  function isWriteDenied(e) {
    const n = e && e.name, m = String((e && (e.message || e.code)) || '');
    return n === 'NotAllowedError' || n === 'NoModificationAllowedError' || n === 'SecurityError' ||
      /read-only|EACCES|EPERM|EROFS|not allowed/i.test(m);
  }
  /** Run a write operation; turn "not allowed" failures into the friendly Viewer message. */
  async function guardedWrite(fn) {
    try { return await fn(); }
    catch (e) { if (e instanceof StoreError) throw e; if (isWriteDenied(e)) throw new StoreError('read-only', READ_ONLY_MSG); throw e; }
  }

  /* ---------- IndexedDB: remember the chosen folder ---------- */
  function idb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
      const req = indexedDB.open('cla_store', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('handles');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGetHandle() {
    try {
      const db = await idb();
      return await new Promise(res => {
        const r = db.transaction('handles', 'readonly').objectStore('handles').get('storeDir');
        r.onsuccess = () => res(r.result || null); r.onerror = () => res(null);
      });
    } catch (_) { return null; }
  }
  async function idbPutHandle(h) {
    try {
      const db = await idb();
      await new Promise(res => {
        const r = db.transaction('handles', 'readwrite').objectStore('handles').put(h, 'storeDir');
        r.onsuccess = () => res(); r.onerror = () => res();
      });
    } catch (_) { /* remembering the folder is best-effort */ }
  }

  /* ---------- folder selection / permission ---------- */
  function isSupported() { return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'; }

  /** On page load: reconnect to the remembered folder. state: none | needs-permission | ready | unsupported */
  async function restoreFolder() {
    if (_adapter) return { state: 'ready', name: _folderName };
    if (!isSupported()) return { state: 'unsupported' };
    const h = await idbGetHandle();
    if (!h) return { state: 'none' };
    try {
      if ((await h.queryPermission({ mode: 'read' })) === 'granted') { setFolder(h); return { state: 'ready', name: h.name }; }
    } catch (_) { return { state: 'none' }; }
    _pendingHandle = h;
    return { state: 'needs-permission', name: h.name };
  }
  /** Must be called from a click (user gesture): the one-click "Reconnect store". */
  async function reconnect() {
    if (!_pendingHandle) return restoreFolder();
    const perm = await _pendingHandle.requestPermission({ mode: 'read' });
    if (perm !== 'granted') return { state: 'needs-permission', name: _pendingHandle.name };
    setFolder(_pendingHandle);
    return { state: 'ready', name: _folderName };
  }
  async function pickFolder() {
    if (!isSupported()) throw new StoreError('unsupported', 'This browser cannot open folders. Use Chrome or Edge on a desktop.');
    let h;
    try { h = await window.showDirectoryPicker({ id: 'cla-store', mode: 'read' }); }
    catch (e) { if (e && e.name === 'AbortError') return { state: 'cancelled' }; throw e; }
    await idbPutHandle(h);
    setFolder(h);
    return { state: 'ready', name: h.name };
  }
  /** Admin actions call this first, straight from the click handler (needs user activation). */
  async function ensureWritable() {
    requireAdapter();
    if (_handle) {
      let perm = 'prompt';
      try { perm = await _handle.queryPermission({ mode: 'readwrite' }); } catch (_) { /* fall through */ }
      if (perm !== 'granted') {
        try { perm = await _handle.requestPermission({ mode: 'readwrite' }); } catch (_) { perm = 'denied'; }
        if (perm !== 'granted') throw new StoreError('write-denied', 'Write access to the store folder was not granted.');
      }
    }
    await guardedWrite(() => _adapter.probeWrite());
    return true;
  }
  /** For tests / embedding: use any adapter object instead of a browser folder. */
  function useAdapter(adapter, name) { _adapter = adapter; _handle = null; _folderName = name || 'test-store'; }
  function isConnected() { return !!_adapter; }
  function folderName() { return _folderName; }

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

  /** Read manifest.json and reconcile it with what is really in daily/ (TrueSync can lag or conflict). */
  async function loadManifest() {
    const a = requireAdapter();
    let m = null;
    const txt = await a.readText(MANIFEST);
    if (txt && txt.trim()) { try { m = JSON.parse(txt); } catch (_) { m = null; } }
    if (!m || typeof m !== 'object' || !m.days || typeof m.days !== 'object') m = { version: 1, days: {} };
    const present = new Set();
    for (const n of await a.list(DAILY_DIR)) { const mm = DAY_FILE_RE.exec(n); if (mm) present.add(mm[1]); }
    for (const k of Object.keys(m.days)) if (!present.has(k)) delete m.days[k];
    for (const k of present) {
      if (m.days[k]) continue;
      const mp = parseDay(await a.readText(`${DAILY_DIR}/${k}.csv`));      // recovered from the file itself
      m.days[k] = { students: mp.size, mau: countMau(mp), rawRows: 0, files: [], minTs: null, maxTs: null, updatedAt: null, recovered: true };
    }
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
  async function getSummary() {
    const manifest = await loadManifest();
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
    const a = requireAdapter();
    const manifest = await loadManifest();
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
    return { ok: true, days: results, duplicateFiles: [...dup], perFile: parsed.perFile, guard };
  }

  /**
   * Admin: add one or many raw Content-Log CSVs. If the batch has rows from a different
   * month than the store, resolves {needsConfirm, guard, commit()} — call commit() to proceed.
   */
  async function ingestLogFiles(files, onProgress, opts) {
    requireAdmin();
    requireAdapter();
    const parsed = await parseLogFiles(files, onProgress);
    if (!parsed.days.size) throw new StoreError('no-rows', 'No usable rows found (need Action, Date and User Email columns).');
    const res = await commitParsed(parsed, opts);
    if (res.needsConfirm) return { ...res, parsed, commit: () => commitParsed(parsed, { confirmMixedMonths: true }) };
    return res;
  }

  /* ---------- reset (admin) ---------- */
  async function resetStore() {
    requireAdmin();
    const a = requireAdapter();
    await guardedWrite(() => a.probeWrite());
    const manifest = await loadManifest();
    const keys = Object.keys(manifest.days).sort();
    if (!keys.length) throw new StoreError('empty', 'The store is already empty — nothing to reset.');
    let folder = `${ARCHIVE_DIR}/${keys[0].slice(0, 7)}`, n = 2;
    while (await a.dirExists(folder)) folder = `${ARCHIVE_DIR}/${keys[0].slice(0, 7)}_${n++}`;
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
    return { archivedTo: folder, dayCount: keys.length, firstDay: keys[0], lastDay: keys[keys.length - 1], studentDayRows: summarize(manifest).studentDayRows };
  }

  /* ---------- read a range ---------- */
  /** Earliest MAU / login timestamp per student across the stored days in [fromKey, toKey]. */
  async function loadActivityForRange(fromKey, toKey, manifestOpt) {
    const a = requireAdapter();
    const manifest = manifestOpt || await loadManifest();
    const firstMau = new Map(), firstLogin = new Map(), missingDays = [], storedDays = [];
    for (const k of dayRange(fromKey, toKey)) {
      if (!manifest.days[k]) { missingDays.push(k); continue; }
      let txt;
      try { txt = await a.readText(`${DAILY_DIR}/${k}.csv`); }
      catch (e) { throw new StoreError('read-failed', `Could not read ${k}.csv (${e.message || e.name}). If you use WorkDrive TrueSync, make sure the store folder is set to "available offline".`); }
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
    // folder
    isSupported, restoreFolder, reconnect, pickFolder, ensureWritable, useAdapter, isConnected, folderName,
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
