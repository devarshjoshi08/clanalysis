/* ============================================================
 * processing.js — port of excel_automation_tool_ULTRA_ROBUST.py
 * Two features:
 *   1. extractEmails(files)       → email extractor
 *   2. prepareAdobeData(file)     → adobe summaries
 * Excel output uses ExcelJS for styling (matches openpyxl output).
 * ============================================================ */

/* ---------- shared helpers ---------- */

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

/**
 * Robust file reader. Returns array of row objects keyed by header.
 * CSV: PapaParse with skipEmptyLines + dynamicTyping off (we want strings).
 * XLSX/XLS: SheetJS — first sheet or 'Raw_Data' if present.
 */
async function readTabularFile(file, preferredSheet) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv')) {
    const text = await readFileAsText(file);
    const parsed = Papa.parse(text, {
      header: true,
      skipEmptyLines: 'greedy',
      dynamicTyping: false,
      transformHeader: h => h.trim()
    });
    return parsed.data;
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.xlsm')) {
    const buf = await readFileAsArrayBuffer(file);
    const wb = XLSX.read(buf, { type: 'array' });
    const sheetName = (preferredSheet && wb.SheetNames.includes(preferredSheet))
      ? preferredSheet
      : wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    return XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  }
  throw new Error(`Unsupported file type: ${file.name}`);
}

function isBlank(v) {
  if (v === null || v === undefined) return true;
  const s = String(v).trim().toLowerCase();
  return s === '' || s === 'nan' || s === 'n/a';
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Ask the user which folder / filename to save to, via the File System Access
 * API (Chrome/Edge, secure context). Returns a file handle, null if the user
 * cancelled, or undefined if the API isn't usable here.
 *
 * Call this straight from the click handler — the picker needs transient user
 * activation, which expires while a long processing step runs.
 */
async function pickSaveHandle(suggestedName) {
  if (!window.showSaveFilePicker) return undefined;
  try {
    return await window.showSaveFilePicker({
      suggestedName,
      types: [{
        description: 'Excel Workbook',
        accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] }
      }]
    });
  } catch (e) {
    if (e && e.name === 'AbortError') return null;   // user cancelled
    return undefined;                                 // unavailable (e.g. file://)
  }
}

/**
 * Write blob to a handle from pickSaveHandle; falls back to a browser download
 * when no handle is available. Returns 'saved' | 'downloaded'.
 */
async function saveBlob(blob, filename, handle) {
  if (!handle) {
    triggerDownload(blob, filename);
    return 'downloaded';
  }
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  return 'saved';
}

/** Default output name for the Adobe summary — known before processing runs. */
function adobeDefaultFilename() {
  return `Adobe_LoggedinDetais(${dateStamp()}).xlsx`;
}

/** Default output name for the email extractor — known before processing runs. */
function emailDefaultFilename() {
  return `Processed_User_Emails_${dateStamp()}.xlsx`;
}

/**
 * True when the browser can show a native "choose folder / save as" dialog.
 * Only Chromium browsers (Chrome, Edge, Opera) over http(s) expose this;
 * Firefox, Safari, and pages opened via file:// cannot, and will fall back to
 * a normal download. Used to warn the user up front instead of silently
 * downloading.
 */
function saveFolderPickerSupported() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}

/* ============================================================
 * FEATURE 1 — Email extractor
 * Required columns: 'Action', 'User Email'
 * Outputs xlsx with cols: Created+Public Link emails | (blank) | Other emails
 * ============================================================ */

async function extractEmails(files, onProgress, onStatus) {
  const allCreated = new Set();
  const allOther = new Set();
  const fileStats = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onStatus(`Processing: ${file.name}`);
    let rows;
    try {
      rows = await readTabularFile(file);
    } catch (e) {
      fileStats.push({ file: file.name, error: e.message, total: 0, valid: 0, skipped: 0, created: 0, other: 0 });
      onProgress(((i + 1) / files.length) * 100);
      continue;
    }

    if (!rows.length || !('Action' in rows[0]) || !('User Email' in rows[0])) {
      fileStats.push({ file: file.name, error: 'Missing required columns (Action, User Email)', total: rows.length, valid: 0, skipped: rows.length, created: 0, other: 0 });
      onProgress(((i + 1) / files.length) * 100);
      continue;
    }

    let valid = 0, skipped = 0;
    const fileCreated = new Set();
    const fileOther = new Set();

    for (const row of rows) {
      const email = String(row['User Email'] ?? '').trim();
      const action = String(row['Action'] ?? '').trim();
      if (isBlank(email) || isBlank(action)) { skipped++; continue; }
      valid++;
      if (action === 'Created' || action === 'Created public link') {
        fileCreated.add(email);
        allCreated.add(email);
      } else {
        fileOther.add(email);
        allOther.add(email);
      }
    }

    fileStats.push({
      file: file.name,
      total: rows.length,
      valid, skipped,
      created: fileCreated.size,
      other: fileOther.size
    });
    onProgress(((i + 1) / files.length) * 100);
  }

  // Remove cross-list duplicates (Created wins, same as Python where they're separate columns)
  const createdList = [...allCreated].sort();
  const otherList = [...allOther].sort();

  // Build styled .xlsx
  const blob = await buildEmailWorkbook(createdList, otherList);
  const filename = `Processed_User_Emails_${dateStamp()}.xlsx`;

  return { createdList, otherList, fileStats, blob, filename };
}

async function buildEmailWorkbook(createdList, otherList) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Processed Data');

  ws.columns = [
    { header: 'Created & Created Public Link Emails', key: 'created', width: 40 },
    { header: '', key: 'blank', width: 5 },
    { header: 'Other Actions Emails', key: 'other', width: 40 }
  ];

  const maxLen = Math.max(createdList.length, otherList.length);
  for (let i = 0; i < maxLen; i++) {
    ws.addRow({
      created: createdList[i] || null,
      blank: null,
      other: otherList[i] || null
    });
  }

  // Header styling — matches Python (#A21E01 fill, white bold, centered)
  const headerRow = ws.getRow(1);
  headerRow.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFA21E01' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.alignment = { horizontal: 'center', vertical: 'center' };
  });
  headerRow.height = 22;

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/* ============================================================
 * FEATURE 2 — Adobe Data Preparation
 * Generates 6 sheets: Raw_Data, State_wise, LIC_Mapping,
 *   Lead_Level, Manager_Level, MAU_Cutoff
 * ============================================================ */

const ADOBE_REQUIRED = [
  'LIC_Name', 'Project Lead_Name', 'Associate Manager_Name',
  'state', 'district', 'schoolCode',
  'Completed MAU?', 'Logged In?'
];

async function prepareAdobeData(file, onProgress, onStatus) {
  onStatus(`Reading ${file.name}...`);
  onProgress(10);

  let rows = await readTabularFile(file, 'Raw_Data');
  if (!rows.length) throw new Error('File is empty.');

  onStatus(`Loaded ${rows.length.toLocaleString()} rows. Validating columns...`);
  onProgress(25);

  const headers = Object.keys(rows[0]);
  const missing = ADOBE_REQUIRED.filter(c => !headers.includes(c));
  if (missing.length) {
    throw new Error(`Missing required columns:\n  • ${missing.join('\n  • ')}`);
  }

  onStatus('Normalizing text columns (consolidating case variants)...');
  rows = normalizeGroupingColumns(rows);
  onProgress(40);

  onStatus('Computing State / LIC / Lead / Manager summaries...');
  const summaries = computeSummaries(rows);
  onProgress(60);

  onStatus('Computing MAU % cutoff distribution...');
  const mauDist = computeSchoolDistribution(rows);
  onProgress(75);

  onStatus('Building Excel file...');
  const blob = await buildAdobeWorkbook(rows, summaries, mauDist);
  onProgress(100);

  const filename = adobeDefaultFilename();

  const totalStudents = rows.length;
  const mauStudents = rows.filter(r => isYes(r['Completed MAU?'])).length;
  const logStudents = rows.filter(r => isYes(r['Logged In?'])).length;

  return {
    blob, filename,
    totalStudents, mauStudents, logStudents,
    summaries, mauDist
  };
}

function isYes(v) {
  return String(v ?? '').trim().toLowerCase() === 'yes';
}

/**
 * Consolidate case/whitespace variants in grouping columns.
 * 'RAJASTHAN' and 'Rajasthan' → most-frequent original spelling.
 */
function normalizeGroupingColumns(rows) {
  const cols = ['state', 'district', 'LIC_Name', 'Project Lead_Name', 'Associate Manager_Name', 'Project Name'];
  for (const col of cols) {
    if (!(col in rows[0])) continue;
    // Build key → {origCounts}
    const counts = new Map();
    for (const r of rows) {
      const orig = r[col];
      if (orig === null || orig === undefined || String(orig).trim() === '') continue;
      const cleaned = String(orig).trim().replace(/\s+/g, ' ');
      const key = cleaned.toLowerCase();
      if (!counts.has(key)) counts.set(key, new Map());
      const m = counts.get(key);
      m.set(cleaned, (m.get(cleaned) || 0) + 1);
    }
    // Pick most-frequent spelling per key
    const canonical = new Map();
    for (const [key, m] of counts) {
      let best = null, bestN = -1;
      for (const [spelling, n] of m) {
        if (n > bestN) { best = spelling; bestN = n; }
      }
      canonical.set(key, best);
    }
    // Apply
    for (const r of rows) {
      const orig = r[col];
      if (orig === null || orig === undefined || String(orig).trim() === '') {
        r[col] = null;
        continue;
      }
      const key = String(orig).trim().replace(/\s+/g, ' ').toLowerCase();
      r[col] = canonical.get(key) || orig;
    }
  }
  return rows;
}

/**
 * Group rows by one or more keys; run agg functions per group.
 * agg: { outputName: ['col', 'count'|'sum'|'nunique'] }
 * 'count' counts non-null rows of that col; for 'count' on first column we use total row count.
 */
function groupAgg(rows, keys, agg) {
  if (!Array.isArray(keys)) keys = [keys];
  const groups = new Map();
  for (const r of rows) {
    const k = keys.map(c => r[c] === undefined ? null : r[c]).join('||~||');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const result = [];
  for (const [k, groupRows] of groups) {
    const keyVals = k.split('||~||');
    const row = {};
    keys.forEach((c, i) => {
      row[c] = keyVals[i] === '' ? null : keyVals[i];
      if (row[c] === 'null') row[c] = null;
    });
    for (const [outName, [col, fn]] of Object.entries(agg)) {
      if (fn === 'count') {
        row[outName] = groupRows.length;
      } else if (fn === 'sum') {
        let s = 0;
        for (const gr of groupRows) {
          const v = Number(gr[col]);
          if (!isNaN(v)) s += v;
        }
        row[outName] = s;
      } else if (fn === 'nunique') {
        const set = new Set();
        for (const gr of groupRows) {
          const v = gr[col];
          if (v !== null && v !== undefined && String(v).trim() !== '') set.add(v);
        }
        row[outName] = set.size;
      }
    }
    result.push(row);
  }
  return result;
}

function safePct(num, den) {
  return (den && den !== 0) ? (num / den) : null;
}

function sortBy(rows, key, descending = true) {
  return rows.slice().sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return descending ? (bv - av) : (av - bv);
  });
}

function appendTotalsRow(rows, labelCol, blankCols = []) {
  if (!rows.length) return rows;
  const totals = { [labelCol]: 'Total' };
  for (const c of blankCols) totals[c] = '';
  const sample = rows[0];
  for (const c of Object.keys(sample)) {
    if (c === labelCol || blankCols.includes(c) || c.startsWith('%')) continue;
    let s = 0;
    for (const r of rows) {
      const v = Number(r[c]);
      if (!isNaN(v)) s += v;
    }
    totals[c] = s;
  }
  const totalStudents = totals['Total Students'] || 0;
  const mau = totals["MAU's Students"] || 0;
  const log = totals['Logged in students'] || 0;
  totals['% MAU Completion'] = safePct(mau, totalStudents);
  totals['% logged in'] = safePct(log, totalStudents);
  return [...rows, totals];
}

function computeSummaries(rows) {
  // Add helper bools
  const enriched = rows.map(r => ({
    ...r,
    _mau: isYes(r['Completed MAU?']) ? 1 : 0,
    _log: isYes(r['Logged In?']) ? 1 : 0
  }));

  const firstCol = Object.keys(rows[0])[0];

  // State-wise
  let stateDf = groupAgg(enriched, ['state'], {
    'Total Students': [firstCol, 'count'],
    "MAU's Students": ['_mau', 'sum'],
    'Logged in students': ['_log', 'sum'],
    'LICs Managed': ['LIC_Name', 'nunique'],
    'Schools Managed': ['schoolCode', 'nunique'],
    'Districts Covered': ['district', 'nunique']
  });
  stateDf = stateDf.map(r => ({
    States: r.state,
    'Total Students': r['Total Students'],
    "MAU's Students": r["MAU's Students"],
    'Logged in students': r['Logged in students'],
    'LICs Managed': r['LICs Managed'],
    'Schools Managed': r['Schools Managed'],
    'Districts Covered': r['Districts Covered'],
    '% MAU Completion': safePct(r["MAU's Students"], r['Total Students']),
    '% logged in': safePct(r['Logged in students'], r['Total Students'])
  }));
  stateDf = sortBy(stateDf, '% MAU Completion');
  stateDf = appendTotalsRow(stateDf, 'States');

  // Manager-wise
  let mgrDf = groupAgg(enriched, ['Associate Manager_Name'], {
    'Total Students': [firstCol, 'count'],
    "MAU's Students": ['_mau', 'sum'],
    'Logged in students': ['_log', 'sum'],
    'LICs Managed': ['LIC_Name', 'nunique'],
    'Schools Managed': ['schoolCode', 'nunique'],
    'Districts Covered': ['district', 'nunique']
  });
  mgrDf = mgrDf.map(r => ({
    ...r,
    '% MAU Completion': safePct(r["MAU's Students"], r['Total Students']),
    '% logged in': safePct(r['Logged in students'], r['Total Students'])
  }));
  mgrDf = sortBy(mgrDf, '% MAU Completion');
  mgrDf = appendTotalsRow(mgrDf, 'Associate Manager_Name');

  // Lead-wise
  let leadDf = groupAgg(enriched, ['Project Lead_Name', 'Associate Manager_Name'], {
    'Total Students': [firstCol, 'count'],
    "MAU's Students": ['_mau', 'sum'],
    'Logged in students': ['_log', 'sum'],
    'LICs Under Management': ['LIC_Name', 'nunique'],
    'Total Schools': ['schoolCode', 'nunique']
  });
  leadDf = leadDf.map(r => ({
    ...r,
    '% MAU Completion': safePct(r["MAU's Students"], r['Total Students']),
    '% logged in': safePct(r['Logged in students'], r['Total Students'])
  }));
  leadDf = sortBy(leadDf, '% MAU Completion');
  leadDf = appendTotalsRow(leadDf, 'Project Lead_Name', ['Associate Manager_Name']);

  // LIC-wise
  const licCols = ['LIC_Name', 'Project Lead_Name', 'Associate Manager_Name'];
  if ('Project Name' in enriched[0]) licCols.push('Project Name');
  let licDf = groupAgg(enriched, licCols, {
    'Total Students': [firstCol, 'count'],
    "MAU's Students": ['_mau', 'sum'],
    'Logged in students': ['_log', 'sum']
  });
  licDf = licDf.map(r => ({
    ...r,
    '% MAU Completion': safePct(r["MAU's Students"], r['Total Students']),
    '% logged in': safePct(r['Logged in students'], r['Total Students'])
  }));
  licDf = sortBy(licDf, '% MAU Completion');

  return { stateDf, licDf, leadDf, mgrDf };
}

function computeSchoolDistribution(rows) {
  // Group by schoolCode → {total, mau}, then bucket
  const bySchool = new Map();
  for (const r of rows) {
    const sc = r['schoolCode'];
    if (sc === null || sc === undefined || String(sc).trim() === '') continue;
    if (!bySchool.has(sc)) bySchool.set(sc, { total: 0, mau: 0 });
    const s = bySchool.get(sc);
    s.total++;
    if (isYes(r['Completed MAU?'])) s.mau++;
  }
  const labels = ['0% to 20%', '20% to 40%', '40% to 60%', '60% to 80%', '80% to 100%'];
  const buckets = [0, 0, 0, 0, 0];
  for (const { total, mau } of bySchool.values()) {
    const pct = total === 0 ? 0 : (mau / total);
    let idx;
    if (pct <= 0.20) idx = 0;
    else if (pct <= 0.40) idx = 1;
    else if (pct <= 0.60) idx = 2;
    else if (pct <= 0.80) idx = 3;
    else idx = 4;
    buckets[idx]++;
  }
  const total = buckets.reduce((a, b) => a + b, 0);
  const out = labels.map((label, i) => ({ 'MAU % Range': label, 'No. of Schools': buckets[i] }));
  out.push({ 'MAU % Range': 'Total', 'No. of Schools': total });
  return out;
}

/* ---- shared Excel styling constants for the summary workbooks ---- */
const XL_SUMMARY_HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
const XL_SUMMARY_HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const XL_TITLE_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFA21E01' } };
const XL_TITLE_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 14 };
const XL_THIN_BORDER = {
  top:    { style: 'thin', color: { argb: 'FF808080' } },
  bottom: { style: 'thin', color: { argb: 'FF808080' } },
  left:   { style: 'thin', color: { argb: 'FF808080' } },
  right:  { style: 'thin', color: { argb: 'FF808080' } }
};
const XL_CENTER = { horizontal: 'center', vertical: 'center' };

/**
 * Add the styled summary sheets (merged title row + column header + data rows)
 * to `wb`. Shared by the standalone Adobe workbook and the Feature-3 workbook.
 */
function addSummarySheets(wb, summaries, mauDist) {
  const summarySheets = [
    ['State_wise',    summaries.stateDf, 'State Level Summary'],
    ['LIC_Mapping',   summaries.licDf,   'LIC Level Summary'],
    ['Lead_Level',    summaries.leadDf,  'Lead Level Summary'],
    ['Manager_Level', summaries.mgrDf,   'Manager Level Summary'],
    ['MAU_Cutoff',    mauDist,           'School MAU % Cutoff Summary']
  ];

  for (const [sheetName, dfRows, title] of summarySheets) {
    if (!dfRows || !dfRows.length) continue;
    // ySplit 2 → title + header rows both stay visible while scrolling
    const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 2 }] });
    const headers = Object.keys(dfRows[0]);
    const pctIdx = new Set(headers.map((h, i) => h.startsWith('%') ? i : -1).filter(i => i >= 0));

    // Column widths
    const widths = headers.map(h => Math.min(Math.max(String(h).length + 3, 12), 38));
    for (const r of dfRows) {
      headers.forEach((h, i) => {
        const v = r[h];
        if (v === null || v === undefined) return;
        const len = pctIdx.has(i) ? 6 : String(v).length;
        if (len + 3 > widths[i]) widths[i] = Math.min(len + 3, 38);
      });
    }
    // No `header` here — row 1 is the merged title, row 2 is the column header
    ws.columns = headers.map((h, i) => ({ key: h, width: widths[i] }));

    // Merged summary title across the full table width
    const titleRow = ws.addRow([title]);
    if (headers.length > 1) ws.mergeCells(1, 1, 1, headers.length);
    titleRow.height = 28;
    const titleCell = ws.getCell(1, 1);
    titleCell.fill = XL_TITLE_FILL;
    titleCell.font = XL_TITLE_FONT;
    titleCell.alignment = XL_CENTER;
    titleCell.border = XL_THIN_BORDER;

    // Header styling
    const headerRow = ws.addRow(headers);
    headerRow.eachCell(cell => {
      cell.fill = XL_SUMMARY_HEADER_FILL;
      cell.font = XL_SUMMARY_HEADER_FONT;
      cell.alignment = XL_CENTER;
      cell.border = XL_THIN_BORDER;
    });

    // Data rows
    const isTotalRow = (idx) => {
      const v = dfRows[idx][headers[0]];
      return idx === dfRows.length - 1 && v === 'Total';
    };
    dfRows.forEach((r, ri) => {
      const row = ws.addRow(r);
      const totalRow = isTotalRow(ri);
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.alignment = XL_CENTER;
        cell.border = XL_THIN_BORDER;
        if (pctIdx.has(colNumber - 1)) cell.numFmt = '0.0%';
        if (totalRow) {
          cell.fill = XL_SUMMARY_HEADER_FILL;
          cell.font = XL_SUMMARY_HEADER_FONT;
        }
      });
    });
  }
}

/**
 * Add a 'Mapping' sheet mirroring the template layout: col A = Completed-MAU
 * emails (Created / public link), col C = Logged-in emails (other actions),
 * col B a blank separator. Row 1 is a merged title, row 2 the header,
 * emails from row 3. Included in the Feature-3 output for reference.
 */
function addMappingSheet(wb, createdList, otherList) {
  const ws = wb.addWorksheet('Mapping', { views: [{ state: 'frozen', ySplit: 2 }] });
  ws.columns = [
    { key: 'a', width: 42 },
    { key: 'b', width: 4 },
    { key: 'c', width: 42 }
  ];

  const titleRow = ws.addRow(['Mapping — emails written into the template this run']);
  ws.mergeCells(1, 1, 1, 3);
  titleRow.height = 26;
  const tc = ws.getCell(1, 1);
  tc.fill = XL_TITLE_FILL; tc.font = XL_TITLE_FONT; tc.alignment = XL_CENTER; tc.border = XL_THIN_BORDER;

  const headerRow = ws.addRow(['Completed MAU emails (Col A)', '', 'Logged in emails (Col C)']);
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    if (col === 2) return; // blank separator column
    cell.fill = XL_SUMMARY_HEADER_FILL; cell.font = XL_SUMMARY_HEADER_FONT;
    cell.alignment = XL_CENTER; cell.border = XL_THIN_BORDER;
  });

  const n = Math.max(createdList.length, otherList.length);
  for (let i = 0; i < n; i++) {
    ws.addRow([createdList[i] || null, null, otherList[i] || null]);
  }
}

async function buildAdobeWorkbook(rawRows, summaries, mauDist) {
  const wb = new ExcelJS.Workbook();
  const rawHeaderFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFA21E01' } };
  const rawHeaderFont = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };

  // ----- Raw_Data sheet (header styling only, for speed) -----
  const wsRaw = wb.addWorksheet('Raw_Data', { views: [{ state: 'frozen', ySplit: 1 }] });
  const rawHeaders = Object.keys(rawRows[0] || {});
  wsRaw.columns = rawHeaders.map(h => ({ header: h, key: h, width: 18 }));
  const rawHeaderRow = wsRaw.getRow(1);
  rawHeaderRow.eachCell(cell => {
    cell.fill = rawHeaderFill;
    cell.font = rawHeaderFont;
    cell.alignment = XL_CENTER;
  });
  // Bulk add via array-of-arrays is fastest
  const rawData = rawRows.map(r => rawHeaders.map(h => {
    const v = r[h];
    return (v === undefined || v === null || v === '') ? null : v;
  }));
  wsRaw.addRows(rawData);

  addSummarySheets(wb, summaries, mauDist);

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** Student-level Raw_Data sheet (one row per student, with MAU/Login flags). */
const PA_RAW_COLS = ['LIC_Name', 'Project Lead_Name', 'Associate Manager_Name', 'Project Name', 'schoolCode', 'district', 'state', 'Adobe Email', 'Completed MAU?', 'Logged In?'];
function addRawDataSheet(wb, rows) {
  const ws = wb.addWorksheet('Raw_Data', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = PA_RAW_COLS.map(h => ({ header: h, key: h, width: Math.min(Math.max(h.length + 2, 12), 30) }));
  const hr = ws.getRow(1);
  hr.eachCell(cell => { cell.fill = XL_TITLE_FILL; cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }; cell.alignment = XL_CENTER; });
  const data = rows.map(r => PA_RAW_COLS.map(c => { const v = r[c]; return (v === undefined || v === null || v === '') ? null : v; }));
  ws.addRows(data);
}

/**
 * Feature-3 output workbook: styled summary sheets + the full student-level
 * Raw_Data sheet + the filled Mapping sheet. (Raw_Data is ~200k rows but only
 * 10 columns, which stays within a desktop browser's memory budget.)
 */
async function buildProcessedAdobeWorkbook(summaries, mauDist, createdList, otherList, studentRows) {
  const wb = new ExcelJS.Workbook();
  addSummarySheets(wb, summaries, mauDist);
  if (studentRows && studentRows.length) addRawDataSheet(wb, studentRows);
  addMappingSheet(wb, createdList, otherList);
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/* ============================================================
 * FEATURE 3 — Process content logs + Adobe Data Preparation
 * Chains the email extractor into the Adobe prep using the repo's
 * template roster (Adobe_Reporting_Template.xlsm):
 *   1. split content-log emails into Created (→MAU) / Other (→Login),
 *   2. fetch a FRESH copy of the template each run (old data never carried
 *      over; the repo file is never modified),
 *   3. mark every student's 'Completed MAU?' / 'Logged In?' by matching their
 *      'Adobe Email' against those sets — this replicates the template's
 *      VLOOKUP formulas in JS, because browsers can't recalc Excel formulas,
 *   4. build the styled summaries + filled Mapping sheet.
 * Everything runs in memory; nothing is written to disk except the final file
 * the user saves.
 * ============================================================ */

const ADOBE_TEMPLATE_URL    = 'Adobe_Reporting_Template.xlsm';
const TEMPLATE_ROSTER_SHEET = 'Raw_Data';
const TEMPLATE_EMAIL_COL    = 'Adobe Email';

// Compact roster columns kept for the summaries. Everything the Adobe prep needs
// except the MAU/Login flags, which are recomputed per run from the content logs.
const ROSTER_COLS = [
  'LIC_Name', 'Project Lead_Name', 'Associate Manager_Name', 'Project Name',
  'schoolCode', 'district', 'state', TEMPLATE_EMAIL_COL
];

/* ------------------------------------------------------------------
 * Roster cache — the template is a static 24 MB / 200k-row workbook, so
 * parsing it every run is the slow part. We parse it once into a compact
 * TSV and cache that (in memory for the session, and in IndexedDB across
 * reloads) keyed by the template's version. Repeat runs then skip both the
 * 24 MB download and the ~10 s parse. Cache is best-effort: any failure
 * falls back to a normal download + parse, so results are never affected.
 * ------------------------------------------------------------------ */
const ROSTER_IDB_NAME  = 'cla_roster_cache';
const ROSTER_IDB_STORE = 'roster';
let _rosterMemCache = null; // { key, tsv } for this page session

function idbOpenRoster() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
    const req = indexedDB.open(ROSTER_IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(ROSTER_IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGetRoster(key) {
  try {
    const db = await idbOpenRoster();
    return await new Promise((resolve) => {
      const r = db.transaction(ROSTER_IDB_STORE, 'readonly').objectStore(ROSTER_IDB_STORE).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    });
  } catch (_) { return null; }
}
async function idbPutRoster(key, tsv) {
  try {
    const db = await idbOpenRoster();
    await new Promise((resolve) => {
      const store = db.transaction(ROSTER_IDB_STORE, 'readwrite').objectStore(ROSTER_IDB_STORE);
      store.clear();                 // keep only the latest template version
      const p = store.put(tsv, key);
      p.onsuccess = () => resolve();
      p.onerror = () => resolve();
    });
  } catch (_) { /* caching is best-effort */ }
}

/** Cheap version tag for the template (ETag → Last-Modified → Content-Length). */
async function rosterValidator() {
  if (typeof fetch !== 'function') return null;
  try {
    const h = await fetch(ADOBE_TEMPLATE_URL, { method: 'HEAD', cache: 'no-store' });
    if (!h.ok) return null;
    return h.headers.get('ETag') || h.headers.get('Last-Modified') || h.headers.get('Content-Length') || null;
  } catch (_) { return null; }
}

async function fetchAdobeTemplate(onStatus) {
  if (typeof fetch !== 'function') throw new Error('This browser cannot download the template (no fetch API).');
  onStatus && onStatus('Downloading Adobe template roster (~24 MB, first time for this version)…');
  let res;
  try {
    res = await fetch(ADOBE_TEMPLATE_URL, { cache: 'no-store' });
  } catch (e) {
    throw new Error(`Could not download '${ADOBE_TEMPLATE_URL}'. Open the app from the deployed site or a local server (not a file:// double-click), with the template next to index.html. (${e.message})`);
  }
  if (!res.ok) throw new Error(`Could not load template '${ADOBE_TEMPLATE_URL}' (HTTP ${res.status}).`);
  return await res.arrayBuffer();
}

/**
 * Parse the template bytes into a compact TSV of ROSTER_COLS. Uses fast read
 * options (skip formulas/styles/number-formats/HTML/VBA) that roughly halve the
 * parse time versus a default read.
 */
function templateBytesToRosterTSV(buf) {
  const data = (buf instanceof ArrayBuffer) ? new Uint8Array(buf) : buf;
  const wb = XLSX.read(data, {
    type: 'array', sheets: [TEMPLATE_ROSTER_SHEET],
    cellFormula: false, cellHTML: false, cellText: false,
    cellNF: false, cellStyles: false, cellDates: false, bookVBA: false
  });
  const ws = wb.Sheets[TEMPLATE_ROSTER_SHEET];
  if (!ws) throw new Error(`Template is missing the '${TEMPLATE_ROSTER_SHEET}' sheet.`);
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
  if (aoa.length < 2) throw new Error('Template roster has no data rows.');

  const header = aoa[0].map(h => String(h == null ? '' : h).trim());
  const idx = name => header.indexOf(name);
  const need = ['LIC_Name', 'Project Lead_Name', 'Associate Manager_Name', 'state', 'district', 'schoolCode'];
  const missing = need.filter(n => idx(n) < 0);
  if (missing.length) throw new Error(`Template roster is missing columns: ${missing.join(', ')}`);
  if (idx(TEMPLATE_EMAIL_COL) < 0) throw new Error(`Template roster is missing the '${TEMPLATE_EMAIL_COL}' column.`);
  const colIdx = ROSTER_COLS.map(c => idx(c)); // -1 allowed only for optional cols

  const out = new Array(aoa.length);
  out[0] = ROSTER_COLS.join('\t');
  for (let i = 1; i < aoa.length; i++) {
    const a = aoa[i];
    let line = '';
    for (let c = 0; c < colIdx.length; c++) {
      const ci = colIdx[c];
      let v = ci >= 0 ? a[ci] : '';
      v = (v == null) ? '' : String(v);
      if (v.indexOf('\t') >= 0) v = v.replace(/\t/g, ' ');
      if (v.indexOf('\n') >= 0 || v.indexOf('\r') >= 0) v = v.replace(/[\r\n]+/g, ' ');
      line += (c ? '\t' : '') + v;
    }
    out[i] = line;
  }
  return out.join('\n');
}

/** Hand-parse the compact roster TSV back into row objects (~0.1 s for 200k). */
function rosterTSVToRows(tsv) {
  const lines = tsv.split('\n');
  const cols = lines[0].split('\t');
  const rows = new Array(lines.length - 1);
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split('\t');
    const o = {};
    for (let j = 0; j < cols.length; j++) o[cols[j]] = f[j];
    rows[i - 1] = o;
  }
  return rows;
}

/**
 * Obtain the compact roster TSV, using (in order): this session's memory cache,
 * the persistent IndexedDB cache (keyed by the template version), then a fresh
 * download + parse. Returns { tsv, fromCache }.
 */
async function loadRosterTSV(status, templateArrayBuffer) {
  if (templateArrayBuffer) {                        // explicit-bytes path (tests)
    return { tsv: templateBytesToRosterTSV(templateArrayBuffer), fromCache: false };
  }
  const key = await rosterValidator();
  if (key) {
    if (_rosterMemCache && _rosterMemCache.key === key) {
      status('Using cached roster — no re-download needed.');
      return { tsv: _rosterMemCache.tsv, fromCache: true };
    }
    const cached = await idbGetRoster(key);
    if (cached) {
      status('Using cached roster — no re-download needed.');
      _rosterMemCache = { key, tsv: cached };
      return { tsv: cached, fromCache: true };
    }
  }
  // Cache miss — download + parse once, then remember it.
  const buf = await fetchAdobeTemplate(status);
  status('Reading template roster (one-time for this version)…');
  const tsv = templateBytesToRosterTSV(buf);
  if (key) { _rosterMemCache = { key, tsv }; idbPutRoster(key, tsv); }
  return { tsv, fromCache: false };
}

/**
 * @param files  content-log CSV/XLSX files (same input as the email extractor)
 * @param templateArrayBuffer  optional pre-loaded template bytes (used by tests);
 *        when omitted, the roster is loaded (and cached) from ADOBE_TEMPLATE_URL.
 */
async function processAndPrepareAdobe(files, onProgress, onStatus, templateArrayBuffer) {
  const status = onStatus || (() => {});
  const progress = onProgress || (() => {});

  // 1. Split content-log emails: Created → MAU (Mapping A), Other → Login (Mapping C)
  status('Extracting emails from content logs…'); progress(6);
  const emailRes = await extractEmails(files, () => {}, () => {});
  const validFiles = emailRes.fileStats.filter(s => !s.error).length;
  if (!validFiles) {
    const firstErr = emailRes.fileStats.find(s => s.error);
    throw new Error(`No usable content-log rows found.${firstErr ? ' e.g. ' + firstErr.file + ': ' + firstErr.error : ''}`);
  }
  const createdList = emailRes.createdList;   // → Mapping col A → 'Completed MAU?'
  const otherList   = emailRes.otherList;     // → Mapping col C → 'Logged In?'
  const createdSet  = new Set(createdList.map(e => e.trim().toLowerCase()));
  const otherSet    = new Set(otherList.map(e => e.trim().toLowerCase()));

  // 2. Load the roster (cached across runs; downloads + parses only when the
  //    template version changes).
  progress(16);
  const { tsv, fromCache } = await loadRosterTSV(status, templateArrayBuffer);
  const rosterRows = rosterTSVToRows(tsv);
  if (rosterRows.length < 1) throw new Error('Template roster has no data rows.');
  progress(48);

  // 3. Mark MAU / Login per student (replicates the template VLOOKUPs, case-insensitive).
  status('Marking Completed MAU? / Logged In? for each student…'); progress(56);
  let mauYes = 0, logYes = 0;
  for (const r of rosterRows) {
    const em = String(r[TEMPLATE_EMAIL_COL] == null ? '' : r[TEMPLATE_EMAIL_COL]).trim().toLowerCase();
    const mau = em !== '' && createdSet.has(em);
    const log = em !== '' && otherSet.has(em);
    if (mau) mauYes++;
    if (log) logYes++;
    r['Completed MAU?'] = mau ? 'Yes' : 'No';
    r['Logged In?'] = log ? 'Yes' : 'No';
  }

  // 4. Aggregate (reuses the Adobe-prep logic) and build the output workbook.
  status('Normalizing and computing summaries…'); progress(72);
  const normRows = normalizeGroupingColumns(rosterRows);
  const summaries = computeSummaries(normRows);
  const mauDist = computeSchoolDistribution(normRows);

  status('Building final Excel file (incl. student-level Raw_Data)…'); progress(90);
  const blob = await buildProcessedAdobeWorkbook(summaries, mauDist, createdList, otherList, normRows);
  progress(100);

  return {
    blob,
    filename: adobeDefaultFilename(),
    totalStudents: rosterRows.length,
    mauStudents: mauYes,
    logStudents: logYes,
    createdCount: createdList.length,
    otherCount: otherList.length,
    rosterFromCache: fromCache,
    summaries,
    mauDist,
    emailFileStats: emailRes.fileStats
  };
}

function dateStamp() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

/* expose globals used by app.js */
window.Processing = {
  extractEmails,
  prepareAdobeData,
  triggerDownload,
  saveBlob,
  pickSaveHandle,
  adobeDefaultFilename,
  emailDefaultFilename,
  saveFolderPickerSupported,
  processAndPrepareAdobe,
  fetchAdobeTemplate
};
