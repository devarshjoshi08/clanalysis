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

  const today = dateStamp();
  const filename = `Adobe_LoggedinDetais(${today}).xlsx`;

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

async function buildAdobeWorkbook(rawRows, summaries, mauDist) {
  const wb = new ExcelJS.Workbook();

  const summaryHeaderFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  const summaryHeaderFont = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  const rawHeaderFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFA21E01' } };
  const rawHeaderFont = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  const thinBorder = {
    top:    { style: 'thin', color: { argb: 'FF808080' } },
    bottom: { style: 'thin', color: { argb: 'FF808080' } },
    left:   { style: 'thin', color: { argb: 'FF808080' } },
    right:  { style: 'thin', color: { argb: 'FF808080' } }
  };
  const center = { horizontal: 'center', vertical: 'center' };

  // ----- Raw_Data sheet (header styling only, for speed) -----
  const wsRaw = wb.addWorksheet('Raw_Data', { views: [{ state: 'frozen', ySplit: 1 }] });
  const rawHeaders = Object.keys(rawRows[0] || {});
  wsRaw.columns = rawHeaders.map(h => ({ header: h, key: h, width: 18 }));
  const rawHeaderRow = wsRaw.getRow(1);
  rawHeaderRow.eachCell(cell => {
    cell.fill = rawHeaderFill;
    cell.font = rawHeaderFont;
    cell.alignment = center;
  });
  // Bulk add via array-of-arrays is fastest
  const rawData = rawRows.map(r => rawHeaders.map(h => {
    const v = r[h];
    return (v === undefined || v === null || v === '') ? null : v;
  }));
  wsRaw.addRows(rawData);

  // ----- Summary sheets -----
  const summarySheets = [
    ['State_wise', summaries.stateDf],
    ['LIC_Mapping', summaries.licDf],
    ['Lead_Level', summaries.leadDf],
    ['Manager_Level', summaries.mgrDf],
    ['MAU_Cutoff', mauDist]
  ];

  for (const [sheetName, dfRows] of summarySheets) {
    if (!dfRows.length) continue;
    const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
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
    ws.columns = headers.map((h, i) => ({ header: h, key: h, width: widths[i] }));

    // Header styling
    const headerRow = ws.getRow(1);
    headerRow.eachCell(cell => {
      cell.fill = summaryHeaderFill;
      cell.font = summaryHeaderFont;
      cell.alignment = center;
      cell.border = thinBorder;
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
        cell.alignment = center;
        cell.border = thinBorder;
        if (pctIdx.has(colNumber - 1)) cell.numFmt = '0.0%';
        if (totalRow) {
          cell.fill = summaryHeaderFill;
          cell.font = summaryHeaderFont;
        }
      });
    });
  }

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
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
  triggerDownload
};
