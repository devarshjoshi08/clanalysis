/* ============================================================
 * app.js — UI controller (tabs, file pickers, progress, modal)
 * Delegates all data work to window.Processing
 * ============================================================ */

(() => {

  /* ---------- Tab switching ---------- */
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  /* ---------- Modal ---------- */
  const modal = document.getElementById('modal');
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');
  const modalClose = document.getElementById('modalClose');
  const modalOk = document.getElementById('modalOk');
  const modalDownload = document.getElementById('modalDownload');
  let pendingDownload = null;

  function showModal(title, body, downloadInfo) {
    modalTitle.textContent = title;
    modalBody.textContent = body;
    if (downloadInfo) {
      pendingDownload = downloadInfo;
      modalDownload.classList.remove('hidden');
      modalDownload.textContent = `Save ${downloadInfo.filename}`;
    } else {
      pendingDownload = null;
      modalDownload.classList.add('hidden');
    }
    modal.classList.remove('hidden');
  }
  function hideModal() {
    modal.classList.add('hidden');
    pendingDownload = null;
  }
  modalClose.addEventListener('click', hideModal);
  modalOk.addEventListener('click', hideModal);
  modal.addEventListener('click', e => { if (e.target === modal) hideModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) hideModal();
  });
  modalDownload.addEventListener('click', async () => {
    if (!pendingDownload) return;
    const { blob, filename } = pendingDownload;
    // Fresh user gesture here, so the picker can run inline
    const handle = await Processing.pickSaveHandle(filename);
    if (handle === null) return;   // cancelled
    await Processing.saveBlob(blob, filename, handle);
  });

  /* ---------- Status helpers ---------- */
  function setStatus(el, text, type = '') {
    el.textContent = text;
    el.className = 'status' + (type ? ' ' + type : '');
  }
  function setProgress(el, pct) {
    el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }

  /* ============================================================
   * TAB 1 — Email Extractor
   * ============================================================ */
  let emailFiles = [];
  const emailFilesInput = document.getElementById('emailFiles');
  const emailFileList = document.getElementById('emailFileList');
  const clearEmailBtn = document.getElementById('clearEmailFiles');
  const processEmailBtn = document.getElementById('processEmailFiles');
  const emailProgress = document.getElementById('emailProgress');
  const emailStatus = document.getElementById('emailStatus');
  const emailLogBox = document.getElementById('emailLogBox');

  function addLogEntry(msg, type = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const timestamp = new Date().toLocaleTimeString();
    entry.textContent = `[${timestamp}] ${msg}`;
    emailLogBox.appendChild(entry);
    emailLogBox.scrollTop = emailLogBox.scrollHeight;
  }

  function clearLog() {
    emailLogBox.innerHTML = '';
  }

  function refreshEmailList() {
    emailFileList.innerHTML = '';
    for (const f of emailFiles) {
      const li = document.createElement('li');
      li.textContent = f.name;
      emailFileList.appendChild(li);
    }
    processEmailBtn.disabled = emailFiles.length === 0;
  }

  emailFilesInput.addEventListener('change', e => {
    const newFiles = Array.from(e.target.files || []);
    if (!newFiles.length) return;
    emailFiles = emailFiles.concat(newFiles);
    refreshEmailList();
    setStatus(emailStatus, `${emailFiles.length} file(s) selected. Ready to process.`, 'success');
    emailFilesInput.value = '';
  });

  clearEmailBtn.addEventListener('click', () => {
    emailFiles = [];
    refreshEmailList();
    setProgress(emailProgress, 0);
    clearLog();
    setStatus(emailStatus, 'File list cleared');
  });

  processEmailBtn.addEventListener('click', async () => {
    if (!emailFiles.length) return;

    // Ask where to save BEFORE processing — the folder picker needs a fresh
    // user gesture that expires once async work starts.
    const pickerSupported = Processing.saveFolderPickerSupported();
    const saveHandle = await Processing.pickSaveHandle(Processing.emailDefaultFilename());
    if (saveHandle === null) {
      setStatus(emailStatus, 'Save cancelled — nothing was processed');
      return;
    }

    processEmailBtn.disabled = true;
    clearEmailBtn.disabled = true;
    setProgress(emailProgress, 0);
    clearLog();
    addLogEntry('Starting email extraction...', 'info');
    addLogEntry(`Processing ${emailFiles.length} file(s)`, 'info');
    if (!pickerSupported) {
      addLogEntry("Folder picker unavailable in this browser — output will download to your Downloads folder. Use Chrome or Edge over http/https to choose a folder.", 'error');
    }

    try {
      const result = await Processing.extractEmails(
        emailFiles,
        pct => setProgress(emailProgress, pct),
        msg => {
          setStatus(emailStatus, msg);
          addLogEntry(msg, 'info');
        }
      );

      let summary = `Processing Complete!\n\nFiles Processed: ${emailFiles.length}\n\n`;
      let totalValid = 0;
      for (const s of result.fileStats) {
        summary += `${s.file}:\n`;
        if (s.error) {
          summary += `  ERROR: ${s.error}\n\n`;
          addLogEntry(`✗ ${s.file}: ERROR - ${s.error}`, 'error');
          continue;
        }
        summary += `  Rows read: ${s.total.toLocaleString()}\n`;
        summary += `  Valid rows: ${s.valid.toLocaleString()}\n`;
        summary += `  Skipped: ${s.skipped.toLocaleString()}\n`;
        summary += `  Created: ${s.created.toLocaleString()}\n`;
        summary += `  Other: ${s.other.toLocaleString()}\n\n`;
        totalValid += s.valid;
        addLogEntry(`✓ ${s.file}: ${s.valid.toLocaleString()} valid rows (${s.created.toLocaleString()} Created, ${s.other.toLocaleString()} Other)`, 'success');
      }
      summary += `FINAL TOTALS:\n`;
      summary += `Total valid rows: ${totalValid.toLocaleString()}\n`;
      summary += `Created/Public Link: ${result.createdList.length.toLocaleString()} unique emails\n`;
      summary += `Other Actions: ${result.otherList.length.toLocaleString()} unique emails\n`;
      summary += `TOTAL: ${(result.createdList.length + result.otherList.length).toLocaleString()} unique emails`;

      addLogEntry('', 'info');
      addLogEntry(`TOTAL UNIQUE EMAILS: ${(result.createdList.length + result.otherList.length).toLocaleString()}`, 'success');

      const outcome = await Processing.saveBlob(result.blob, result.filename, saveHandle);
      const savedNote = outcome === 'saved'
        ? `\n\nSaved as: ${saveHandle.name}`
        : "\n\nThis browser can't open a folder picker (only Chrome or Edge over http/https can), " +
          "so the file was downloaded to your browser's Downloads folder instead.";
      if (outcome === 'saved') addLogEntry(`Saved as: ${saveHandle.name}`, 'success');

      setStatus(emailStatus,
        outcome === 'saved' ? 'Processing complete — file saved!' : 'Processing complete — file downloaded to Downloads folder.',
        'success');
      showModal('Processing Complete', summary + savedNote, { blob: result.blob, filename: result.filename });

    } catch (err) {
      console.error(err);
      addLogEntry(`ERROR: ${err.message}`, 'error');
      setStatus(emailStatus, `Error: ${err.message}`, 'error');
      showModal('Error', `Error during processing:\n\n${err.message}\n\n${err.stack || ''}`);
    } finally {
      processEmailBtn.disabled = emailFiles.length === 0;
      clearEmailBtn.disabled = false;
    }
  });

  /* ============================================================
   * TAB 2 — Adobe Data Preparation
   * ============================================================ */
  let adobeFile = null;
  const adobeFileInput = document.getElementById('adobeFile');
  const adobeFileLabel = document.getElementById('adobeFileLabel');
  const prepareAdobeBtn = document.getElementById('prepareAdobe');
  const adobeProgress = document.getElementById('adobeProgress');
  const adobeStatus = document.getElementById('adobeStatus');

  adobeFileInput.addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (!f) {
      adobeFile = null;
      adobeFileLabel.textContent = 'No Adobe data file selected';
      prepareAdobeBtn.disabled = true;
      return;
    }
    adobeFile = f;
    adobeFileLabel.textContent = `Selected: ${f.name}  (${(f.size / 1024).toFixed(1)} KB)`;
    prepareAdobeBtn.disabled = false;
    setStatus(adobeStatus, 'Ready to prepare');
  });

  prepareAdobeBtn.addEventListener('click', async () => {
    if (!adobeFile) return;

    // Ask where to save BEFORE processing — the picker needs a fresh user
    // gesture, and the gesture expires while the workbook is being built.
    const pickerSupported = Processing.saveFolderPickerSupported();
    const saveHandle = await Processing.pickSaveHandle(Processing.adobeDefaultFilename());
    if (saveHandle === null) {
      setStatus(adobeStatus, 'Save cancelled — nothing was processed');
      return;
    }
    // saveHandle === undefined → the browser can't show a folder picker, so the
    // file will be downloaded instead. Tell the user why up front rather than
    // silently downloading.
    if (!pickerSupported) {
      setStatus(adobeStatus,
        "This browser can't open a folder picker — the file will download to your Downloads folder. Open the app in Chrome or Edge (over http/https, not a file:// double-click) to choose a folder.",
        'error');
    }

    prepareAdobeBtn.disabled = true;
    setProgress(adobeProgress, 0);

    try {
      const result = await Processing.prepareAdobeData(
        adobeFile,
        pct => setProgress(adobeProgress, pct),
        msg => setStatus(adobeStatus, msg)
      );

      const { stateDf, licDf, leadDf, mgrDf } = result.summaries;
      const cutoffLines = result.mauDist
        .slice(0, -1)
        .map(r => `  ${r['MAU % Range']}: ${r['No. of Schools']}`)
        .join('\n');

      const msg =
        'Adobe Summary Created!\n\n' +
        `File: ${result.filename}\n\n` +
        `Raw rows: ${result.totalStudents.toLocaleString()}\n` +
        `MAU completed: ${result.mauStudents.toLocaleString()}\n` +
        `Logged in: ${result.logStudents.toLocaleString()}\n\n` +
        `States: ${stateDf.length - 1}\n` +
        `LIC rows: ${licDf.length}\n` +
        `Project Leads: ${leadDf.length - 1}\n` +
        `Associate Managers: ${mgrDf.length - 1}\n\n` +
        `MAU % cutoff (schools):\n${cutoffLines}`;

      const outcome = await Processing.saveBlob(result.blob, result.filename, saveHandle);
      const savedNote = outcome === 'saved'
        ? `\n\nSaved as: ${saveHandle.name}`
        : "\n\nThis browser can't open a folder picker (only Chrome or Edge over http/https can), " +
          "so the file was downloaded to your browser's Downloads folder instead.";

      setStatus(adobeStatus,
        outcome === 'saved' ? 'Adobe summary saved!' : 'Adobe summary downloaded to your Downloads folder.',
        'success');
      showModal('Adobe Data Prepared', msg + savedNote, { blob: result.blob, filename: result.filename });

    } catch (err) {
      console.error(err);
      setStatus(adobeStatus, `Error: ${err.message}`, 'error');
      showModal('Error', `Error preparing Adobe data:\n\n${err.message}\n\n${err.stack || ''}`);
    } finally {
      prepareAdobeBtn.disabled = !adobeFile;
    }
  });

  /* ============================================================
   * TAB 3 — Process + Adobe Data Preparation
   * Chains email extraction -> template roster -> Adobe summaries.
   * ============================================================ */
  let paFiles = [];
  const paFilesInput = document.getElementById('paFiles');
  const paFileList   = document.getElementById('paFileList');
  const clearPaBtn   = document.getElementById('clearPaFiles');
  const runPaBtn     = document.getElementById('runPaAdobe');
  const paProgress   = document.getElementById('paProgress');
  const paStatus     = document.getElementById('paStatus');
  const paLogBox     = document.getElementById('paLogBox');

  function paLog(msg, type = 'info') {
    if (msg === '') { return; }
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    paLogBox.appendChild(entry);
    paLogBox.scrollTop = paLogBox.scrollHeight;
  }

  function refreshPaList() {
    paFileList.innerHTML = '';
    for (const f of paFiles) {
      const li = document.createElement('li');
      li.textContent = f.name;
      paFileList.appendChild(li);
    }
    runPaBtn.disabled = paFiles.length === 0;
  }

  paFilesInput.addEventListener('change', e => {
    const newFiles = Array.from(e.target.files || []);
    if (!newFiles.length) return;
    paFiles = paFiles.concat(newFiles);
    refreshPaList();
    setStatus(paStatus, `${paFiles.length} file(s) selected. Ready.`, 'success');
    paFilesInput.value = '';
  });

  clearPaBtn.addEventListener('click', () => {
    paFiles = [];
    refreshPaList();
    setProgress(paProgress, 0);
    paLogBox.innerHTML = '';
    setStatus(paStatus, 'File list cleared');
  });

  // Repeated-user analysis (compare this week to last week's MAU).
  const paRepeatChk = document.getElementById('paRepeatChk');
  const paRepeatRow = document.getElementById('paRepeatRow');
  const paLastWeekInput = document.getElementById('paLastWeek');
  const paLastWeekLabel = document.getElementById('paLastWeekLabel');
  let paLastWeekFile = null;

  paRepeatChk.addEventListener('change', () => {
    paRepeatRow.classList.toggle('hidden', !paRepeatChk.checked);
  });
  paLastWeekInput.addEventListener('change', e => {
    paLastWeekFile = (e.target.files && e.target.files[0]) || null;
    paLastWeekLabel.textContent = paLastWeekFile ? `Selected: ${paLastWeekFile.name}` : 'No last-week file selected';
  });

  runPaBtn.addEventListener('click', async () => {
    if (!paFiles.length) return;
    if (paRepeatChk.checked && !paLastWeekFile) {
      setStatus(paStatus, "Repeated analysis is on — please choose last week's report file first.", 'error');
      return;
    }

    // Ask where to save the FINAL file first — the picker needs a fresh user
    // gesture that would expire during the (long) template load.
    const pickerSupported = Processing.saveFolderPickerSupported();
    const saveHandle = await Processing.pickSaveHandle(Processing.adobeDefaultFilename());
    if (saveHandle === null) {
      setStatus(paStatus, 'Save cancelled — nothing was processed');
      return;
    }

    runPaBtn.disabled = true;
    clearPaBtn.disabled = true;
    setProgress(paProgress, 0);
    paLogBox.innerHTML = '';
    paLog('Starting: Process + Adobe Data Preparation', 'info');
    paLog(`Content-log files: ${paFiles.length}`, 'info');
    if (!pickerSupported) {
      paLog("Folder picker unavailable in this browser — the final file will download to your Downloads folder. Use Chrome or Edge over http/https to choose a folder.", 'error');
    }

    try {
      const result = await Processing.processAndPrepareAdobe(
        paFiles,
        pct => setProgress(paProgress, pct),
        msg => { setStatus(paStatus, msg); paLog(msg, 'info'); },
        undefined,
        (paRepeatChk.checked && paLastWeekFile) ? { lastWeekFile: paLastWeekFile } : {}
      );

      const cutoffLines = result.mauDist
        .slice(0, -1)
        .map(r => `  ${r['MAU % Range']}: ${r['No. of Schools']}`)
        .join('\n');

      const repeatLines = result.repeated
        ? '\n\nRepeated-user analysis (vs last week):\n' +
          `  New MAU (this week only): ${result.repeated.newMau.toLocaleString()}\n` +
          `  Repeated MAU (both weeks, excluded from MAU count): ${result.repeated.repeated.toLocaleString()}\n` +
          `  Pending (never completed either week — follow up): ${result.repeated.pending.toLocaleString()}\n` +
          `  Last week's MAU total: ${result.repeated.lastWeekMauCount.toLocaleString()}`
        : '';

      const outcome = await Processing.saveBlob(result.blob, result.filename, saveHandle);
      const savedNote = outcome === 'saved'
        ? `\n\nSaved as: ${saveHandle.name}`
        : "\n\nThis browser can't open a folder picker (only Chrome or Edge over http/https can), " +
          "so the file was downloaded to your browser's Downloads folder instead.";
      if (outcome === 'saved') paLog(`Saved as: ${saveHandle.name}`, 'success');

      // The pending (never-MAU) follow-up list ships as a companion CSV.
      let pendingNote = '';
      if (result.pendingCsvBlob) {
        Processing.triggerDownload(result.pendingCsvBlob, result.pendingCsvName);
        pendingNote = `\n\nPending follow-up list downloaded separately as ${result.pendingCsvName} (in your Downloads).`;
        paLog(`Pending follow-up list saved as ${result.pendingCsvName} (Downloads).`, 'info');
      }

      const rosterNote = result.rosterFromCache
        ? 'Roster: loaded from cache (fast — no re-download)'
        : 'Roster: parsed fresh (first run for this template version)';

      const msg =
        'Process + Adobe Preparation complete!\n\n' +
        `File: ${result.filename}\n` +
        `${rosterNote}\n\n` +
        `Content-log files: ${paFiles.length}\n` +
        `Emails → Completed MAU (Mapping col A): ${result.createdCount.toLocaleString()}\n` +
        `Emails → Logged In (Mapping col C): ${result.otherCount.toLocaleString()}\n\n` +
        `Students in roster: ${result.totalStudents.toLocaleString()}\n` +
        `Marked Completed MAU: ${result.mauStudents.toLocaleString()}\n` +
        `First MAU Date filled: ${(result.mauWithDate ?? 0).toLocaleString()}\n` +
        `Marked Logged In: ${result.logStudents.toLocaleString()}\n\n` +
        `MAU % cutoff (schools):\n${cutoffLines}` +
        repeatLines + pendingNote;

      paLog(result.rosterFromCache ? 'Roster loaded from cache (no re-download).' : 'Roster parsed fresh and cached for next time.', 'info');
      if (result.repeated) {
        paLog(`Repeated: ${result.repeated.repeated.toLocaleString()} · New: ${result.repeated.newMau.toLocaleString()} · Pending (follow-up): ${result.repeated.pending.toLocaleString()}`, 'success');
      }
      paLog(`Done — ${result.mauStudents.toLocaleString()} MAU / ${result.logStudents.toLocaleString()} logged-in of ${result.totalStudents.toLocaleString()} students`, 'success');
      setStatus(paStatus,
        outcome === 'saved' ? 'Final summary saved!' : 'Final summary downloaded to your Downloads folder.',
        'success');
      showModal('Process + Adobe Data Prepared', msg + savedNote, { blob: result.blob, filename: result.filename });

    } catch (err) {
      console.error(err);
      paLog(`ERROR: ${err.message}`, 'error');
      setStatus(paStatus, `Error: ${err.message}`, 'error');
      showModal('Error', `Error during Process + Adobe preparation:\n\n${err.message}\n\n${err.stack || ''}`);
    } finally {
      runPaBtn.disabled = paFiles.length === 0;
      clearPaBtn.disabled = false;
    }
  });

  /* ============================================================
   * TAB 4 — Date-Range MAU Report  (persistent daily store)
   * All data work lives in window.Store (store.js); this is only the screen.
   * ============================================================ */
  const T4 = {
    summary: null,      // Store.summarize(...) of the current store
    manifest: null,
    addList: [],        // raw content-log files queued for "Add to store"
    busy: false,        // an add / report / reset is running
    wasAdmin: false,    // was this page in admin mode a moment ago (to notice a session that ran out)
    seq: 0,             // refresh counter (ignore out-of-order answers)
    lastRead: 0,        // when the manifest was last read (ms)
    loadError: ''       // why the last read failed, if it did
  };
  const r$ = id => document.getElementById(id);

  const storeSource = r$('storeSource'), storeLabel = r$('storeLabel');
  const storeCoverage = r$('storeCoverage'), storeLegend = r$('storeLegend'), storeRefresh = r$('storeRefresh');
  const adminLoginBtn = r$('adminLoginBtn'), adminOn = r$('adminOn'), adminExitBtn = r$('adminExitBtn'), connectBtn = r$('connectBtn');
  const resetStoreBtn = r$('resetStoreBtn'), storeMsg = r$('storeMsg');
  const addCard = r$('addCard'), addFilesInput = r$('addFiles'), addClearBtn = r$('addClear'), addRunBtn = r$('addRun');
  const addFileList = r$('addFileList'), addProgress = r$('addProgress'), addStatus = r$('addStatus'), addResult = r$('addResult');
  const rptFrom = r$('rptFrom'), rptTo = r$('rptTo'), rptLookback = r$('rptLookback');
  const rptRepeatBox = r$('rptRepeatBox'), rptWindow = r$('rptWindow'), rptMsgs = r$('rptMsgs');
  const rptBuildBtn = r$('rptBuild'), rptProgress = r$('rptProgress'), rptStatus = r$('rptStatus'), rptLogBox = r$('rptLogBox');

  function rptLog(msg, type = 'info') {
    if (!msg) return;
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    rptLogBox.appendChild(entry);
    rptLogBox.scrollTop = rptLogBox.scrollHeight;
  }
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

  /* ---------- small form dialog (login / confirm / reset) ---------- */
  const dlg = r$('dlg'), dlgTitle = r$('dlgTitle'), dlgBody = r$('dlgBody'), dlgMsg = r$('dlgMsg');
  const dlgOk = r$('dlgOk'), dlgCancel = r$('dlgCancel'), dlgClose = r$('dlgClose');
  let dlgState = null;

  /**
   * Show the dialog. `body` is a string or a DOM node. `onOk` (optional, async) runs when OK is pressed:
   * return false to keep the dialog open (it should have set a message with `say`), anything else closes it
   * and becomes the resolved value (undefined → true). Cancel / Esc / × resolve null.
   */
  function openDialog({ title, body, okText = 'OK', cancelText = 'Cancel', danger = false, onOk, onOpen }) {
    return new Promise(resolve => {
      if (dlgState) dlgState.finish(null);
      dlgTitle.textContent = title;
      dlgBody.textContent = '';
      if (typeof body === 'string') dlgBody.appendChild(el('p', '', body)); else if (body) dlgBody.appendChild(body);
      dlgMsg.textContent = ''; dlgMsg.className = 'dlg-msg';
      dlgOk.textContent = okText; dlgOk.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary'); dlgOk.disabled = false;
      dlgCancel.textContent = cancelText || 'Cancel';
      dlgCancel.classList.toggle('hidden', !cancelText);
      dlg.classList.remove('hidden');
      const say = (text, type = 'error') => { dlgMsg.textContent = text; dlgMsg.className = 'dlg-msg ' + type; };
      let cleanup = null;
      const finish = value => {
        if (!dlgState) return;
        dlgState = null;
        if (cleanup) { try { cleanup(); } catch (_) { /* ignore */ } }
        dlg.classList.add('hidden');
        resolve(value);
      };
      dlgState = {
        finish, say, busy: false,
        submit: async () => {
          if (dlgOk.disabled || (dlgState && dlgState.busy)) return;
          dlgState.busy = true; dlgOk.disabled = true;
          let out;
          try { out = onOk ? await onOk(say) : true; }
          catch (e) { say(e && e.message ? e.message : String(e)); out = false; }
          if (!dlgState) return;          // closed while running
          dlgState.busy = false;
          if (out === false) { if (!dlgState.locked) dlgOk.disabled = false; return; }
          finish(out === undefined ? true : out);
        }
      };
      if (onOpen) cleanup = onOpen({ say, ok: dlgOk, body: dlgBody, submit: () => dlgState && dlgState.submit() }) || null;
    });
  }
  dlgOk.addEventListener('click', () => { if (dlgState) dlgState.submit(); });
  dlgCancel.addEventListener('click', () => { if (dlgState && !dlgState.busy) dlgState.finish(null); });
  dlgClose.addEventListener('click', () => { if (dlgState && !dlgState.busy) dlgState.finish(null); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && dlgState && !dlgState.busy) dlgState.finish(null);
  });

  /* ---------- store card ---------- */
  function setStoreMsg(text, type = '') { setStatus(storeMsg, text, type); }

  /** Errors that mean "the store service itself isn't set up / isn't the right address" → open Check connection. */
  const CONNECTION_CODES = ['not-configured', 'bad-service', 'not-a-service', 'no-database', 'not-set-up'];
  const needsConnection = e => !!e && CONNECTION_CODES.includes(e.code);
  /** The admin session ended (12 hours passed, or the passwords were changed): show the page as a visitor's and say so. */
  function sessionEnded(e) {
    if (!e || e.code !== 'session-expired') return false;
    T4.wasAdmin = false; T4.addList = []; renderAddList(); renderAdmin(); storeSource.textContent = '';
    setStoreMsg('Your admin session has ended. Log in again to continue.', 'error');
    return true;
  }
  const hostOf = u => String(u || '').replace(/^https?:\/\//, '');

  function renderLabel() {
    storeLabel.className = 'store-label';
    const st = Store.status();
    if (!st.configured) {
      storeLabel.classList.add('warn');
      storeLabel.textContent = Store.isAdmin()
        ? "The shared store isn't connected yet. Click “Check connection” to enter the store service address."
        : "The shared store isn't set up yet. Please ask an admin to finish the one-time setup.";
      return;
    }
    if (T4.loadError) { storeLabel.classList.add('error'); storeLabel.textContent = `Could not read the store: ${T4.loadError}`; return; }
    if (!T4.summary) { storeLabel.textContent = 'Reading the store…'; return; }
    storeLabel.textContent = Store.formatLabel(T4.summary);
    storeLabel.classList.add(T4.summary.empty || T4.summary.missingDays.length ? 'warn' : 'ok');
  }

  function renderCoverage() {
    storeCoverage.textContent = '';
    const grid = T4.manifest ? Store.coverageGrid(T4.manifest) : [];
    storeLegend.classList.toggle('hidden', grid.length === 0);
    for (const m of grid) {
      const box = el('div', 'cov-month');
      box.appendChild(el('div', 'cov-month-label', m.label));
      const g = el('div', 'cov-grid');
      for (const d of m.days) {
        const c = el('i', 'cov-cell ' + (d.stored ? 'stored' : (d.inRange ? 'gap' : 'out')), String(+d.day.slice(8)));
        c.title = d.stored
          ? `${Store.fmtDMY(d.day)} — ${d.students.toLocaleString()} students, ${d.mau.toLocaleString()} MAU`
          : (d.inRange ? `${Store.fmtDMY(d.day)} — no data (missing)` : `${Store.fmtDMY(d.day)} — outside stored dates`);
        g.appendChild(c);
      }
      box.appendChild(g);
      storeCoverage.appendChild(box);
    }
  }

  /** Hint the pickers with the stored range, and pre-fill From/To (1st of the latest stored month → latest day) while empty. */
  function applyDateHints() {
    const s = T4.summary, has = !!(s && !s.empty);
    for (const i of [rptFrom, rptTo]) { i.min = has ? s.firstDay : ''; i.max = has ? s.lastDay : ''; }
    if (has && !rptFrom.value && !rptTo.value) {
      const monthStart = s.lastDay.slice(0, 7) + '-01';
      rptFrom.value = monthStart > s.firstDay ? monthStart : s.firstDay;
      rptTo.value = s.lastDay;
    }
  }

  /** Re-read the store (manifest) and redraw the label, coverage strip and report checks. Anyone can do this — no login. */
  async function refreshStore(quiet, force) {
    const st = Store.status();
    storeRefresh.disabled = !st.configured;
    storeSource.textContent = Store.isAdmin() && st.service ? `— ${hostOf(st.service)}` : '';
    const seq = ++T4.seq;
    if (!st.configured) { T4.summary = null; T4.manifest = null; T4.loadError = ''; }
    else {
      try {
        const { manifest, summary } = await Store.getSummary({ force: !!force });
        if (seq !== T4.seq) return;                       // a newer refresh is already running
        T4.manifest = manifest; T4.summary = summary; T4.loadError = '';
        T4.lastRead = Date.now();
        if (!quiet) setStoreMsg('');
      } catch (e) {
        if (seq !== T4.seq) return;
        T4.manifest = null; T4.summary = null; T4.loadError = e.message || String(e);
      }
    }
    applyDateHints();
    renderLabel(); renderCoverage(); renderAdmin(); renderValidation();
  }

  storeRefresh.addEventListener('click', async () => {
    storeRefresh.disabled = true;
    await refreshStore(true, true);                  // Refresh = look for the newest published data right now
    if (Store.status().configured && T4.summary) setStoreMsg('Store re-read.', 'success');     // else the label already explains why not
  });
  // Pick up days an admin published while this page sat open: when the tab is opened or the window regains focus.
  const refreshIfStale = () => { if (Store.status().configured && !T4.busy && !dlgState && Date.now() - T4.lastRead > 30000) refreshStore(true); };
  window.addEventListener('focus', refreshIfStale);
  document.querySelector('button[data-tab="range"]').addEventListener('click', refreshIfStale);

  /* ---------- admin mode ---------- */
  function renderAdmin() {
    const admin = Store.isAdmin(), st = Store.status();
    adminLoginBtn.classList.toggle('hidden', admin);
    adminOn.classList.toggle('hidden', !admin);
    resetStoreBtn.classList.toggle('hidden', !(admin && st.configured));
    addCard.classList.toggle('hidden', !(admin && st.configured));
    addRunBtn.disabled = T4.busy || !T4.addList.length;
  }
  // An admin session lasts 12 hours and can run out while the page sits open: notice it and say so.
  setInterval(() => {
    if (T4.wasAdmin && !Store.isAdmin() && !T4.busy) {
      Store.exitAdmin();
      T4.addList = []; renderAddList(); storeSource.textContent = '';
      setStoreMsg('Your admin session has ended. Log in again to continue.', 'error');
    }
    T4.wasAdmin = Store.isAdmin();
    renderAdmin();
  }, 30000);

  async function openLogin() {
    if (!Store.status().configured) {                       // nothing to log in to yet → the address comes first
      setStoreMsg('Enter the store service address first, then log in.', 'info');
      await openConnection();
      if (!Store.status().configured) return;
    }
    const wrap = el('div');
    wrap.appendChild(el('p', '', 'Enter the admin password to add daily logs or reset the store.'));
    const input = el('input'); input.type = 'password'; input.autocomplete = 'off'; input.placeholder = 'Admin password';
    wrap.appendChild(input);
    wrap.appendChild(el('p', 'muted', 'Admin mode lasts 12 hours, or until you close this tab. The password is checked by the store service — it is never kept on this page.'));
    const ok = await openDialog({
      title: 'Admin login', body: wrap, okText: 'Log in',
      onOpen: ({ say, ok: okBtn, submit }) => {
        setTimeout(() => input.focus(), 30);
        let timer = null;
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
        dlgState.lock = secs => {
          dlgState.locked = true; okBtn.disabled = true; input.disabled = true;
          const until = Date.now() + secs * 1000;
          const tick = () => {
            const left = Math.ceil((until - Date.now()) / 1000);
            if (left <= 0) { clearInterval(timer); timer = null; if (dlgState) dlgState.locked = false; okBtn.disabled = false; input.disabled = false; say('You can try again now.', 'info'); input.focus(); }
            else say(`Too many wrong tries. Try again in ${left}s.`);
          };
          clearInterval(timer); timer = setInterval(tick, 500); tick();
        };
        return () => { if (timer) clearInterval(timer); };
      },
      onOk: async say => {
        say('Checking…', 'info');
        const res = await Store.adminLogin(input.value);
        if (res.ok) return true;
        input.value = '';
        if (res.locked) { dlgState.lock(res.secondsLeft || 120); return false; }
        const left = Number.isInteger(res.triesLeft) && res.triesLeft <= 2 ? ` ${res.triesLeft} ${res.triesLeft === 1 ? 'try' : 'tries'} left before a short lock.` : '';
        say((res.message || 'Incorrect admin password.') + left);
        input.focus();
        return false;
      }
    });
    if (ok) {
      T4.wasAdmin = true;
      renderAdmin(); refreshStore(true);
      setStoreMsg('Admin mode is on (12 hours, or until you close this tab).', 'success');
    }
  }
  adminLoginBtn.addEventListener('click', openLogin);
  adminExitBtn.addEventListener('click', () => {
    Store.exitAdmin();
    T4.wasAdmin = false; T4.addList = []; renderAddList();
    renderAdmin(); storeSource.textContent = '';
    setStoreMsg('Admin mode is off.');
    refreshStore(true);
  });

  /* ---------- connection (the store service's address) + "Check connection" ---------- */
  async function openConnection() {
    const field = (label, input) => { const l = el('label', 'field stacked', label); l.appendChild(input); return l; };
    const wrap = el('div', 'settings-form');
    wrap.appendChild(el('p', '', 'The shared store lives in a small free service on Cloudflare, and this page finds it through the address below. Only an admin has to enter it, once.'));
    const input = el('input'); input.type = 'text'; input.id = 'setService'; input.value = Store.getSettings().service || '';
    input.placeholder = 'https://your-name.workers.dev'; input.autocomplete = 'off'; input.spellcheck = false;
    wrap.appendChild(field('Store service address', input));

    const diag = el('ul', 'diag-list'); diag.id = 'setDiag';
    wrap.appendChild(diag);
    const showDiag = d => {
      diag.textContent = '';
      for (const s of d.steps) {
        const li = el('li', s.ok ? 'ok' : 'bad');
        li.appendChild(el('span', 'mark', s.ok ? '✓' : '✗'));
        li.appendChild(el('span', '', ' ' + s.label));
        if (s.detail) li.appendChild(el('div', 'diag-detail', s.detail));
        diag.appendChild(li);
      }
    };

    const useFile = el('button', 'link-btn', 'Use the address from the website instead (forget this browser’s own copy)');
    useFile.type = 'button'; useFile.id = 'setUseFile';
    wrap.appendChild(useFile);
    const cfgBox = el('div', 'cfg-box');
    const cfgNote = el('p', '', ''); cfgNote.id = 'setCfgNote';
    const cfgPre = el('pre', 'cfg-text'); cfgPre.id = 'setCfgText';
    cfgBox.appendChild(cfgNote); cfgBox.appendChild(cfgPre);
    wrap.appendChild(cfgBox);
    const typedService = () => { try { return Store.normalizeService(input.value); } catch (_) { return ''; } };
    const drawCfg = () => {
      const gs = Store.getSettings(), typed = typedService();
      const same = !!typed && gs.fileService === typed;
      cfgPre.textContent = JSON.stringify({ service: typed || 'https://your-name.workers.dev' }, null, 2);
      cfgNote.textContent = same
        ? '✓ Everyone’s page already uses this address, so visitors can read the store without any setup.'
        : 'For everyone else to see the store, the website must contain a file named store-config.json (next to index.html) with exactly this:';
      cfgBox.classList.toggle('ok', same);
      useFile.classList.toggle('hidden', !(gs.cfgSource === 'local' && gs.fileService));
    };
    input.addEventListener('input', drawCfg); drawCfg();
    useFile.addEventListener('click', () => {
      Store.clearSettings();
      input.value = Store.getSettings().service || ''; drawCfg(); diag.textContent = '';
      if (dlgState) dlgState.say('Now using the address from the website.', 'info');
    });

    const res = await openDialog({
      title: 'Check connection', body: wrap, okText: 'Save and check', cancelText: 'Close',
      onOpen: ({ say, submit }) => {
        setTimeout(() => input.focus(), 30);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
        if (Store.getSettings().service || Store.isConnected()) {       // already set up → check right away
          say('Checking the connection…', 'info');
          Store.diagnose().then(d => { if (dlgState) { showDiag(d); say(d.ok ? 'Everything is working.' : 'Something needs attention — see the list above.', d.ok ? 'success' : 'error'); } });
        }
      },
      onOk: async say => {
        const saved = Store.saveSettings({ service: input.value });       // a malformed address shows its message here
        input.value = saved.service;                                       // show it cleaned up (no /v1/ping, no trailing slash)
        say('Checking the connection…', 'info');
        const d = await Store.diagnose();
        showDiag(d); drawCfg();
        if (!d.ok) { say('Something needs attention — see the list above.', 'error'); return false; }
        if (!(Store.getSettings().fileService === saved.service)) { say('Connected ✓. So that everyone else can use it too, put the text from the box above into the website’s store-config.json (see HOW_TO_PUSH.md), then press Close.', 'success'); return false; }
        return { ok: true };
      }
    });
    await refreshStore(true);
    renderAdmin();
    if (res && res.ok) setStoreMsg('Connected to the shared store.', 'success');
    return res;
  }
  connectBtn.addEventListener('click', () => openConnection());

  /* ---------- add daily logs (admin) ---------- */
  function renderAddList() {
    addFileList.textContent = '';
    for (const f of T4.addList) addFileList.appendChild(el('li', '', f.name));
    addRunBtn.disabled = T4.busy || !T4.addList.length;
  }
  addFilesInput.addEventListener('change', e => {
    const picked = Array.from(e.target.files || []);
    if (!picked.length) return;
    for (const f of picked) if (!T4.addList.some(x => x.name === f.name && x.size === f.size)) T4.addList.push(f);
    renderAddList();
    addResult.textContent = '';
    setStatus(addStatus, `${plural(T4.addList.length, 'file')} selected. Click “Add to store”.`, 'success');
    addFilesInput.value = '';
  });
  addClearBtn.addEventListener('click', () => {
    T4.addList = []; renderAddList(); addResult.textContent = '';
    setProgress(addProgress, 0); setStatus(addStatus, 'File list cleared');
  });

  function renderAddResult(res) {
    addResult.textContent = '';
    const tbl = el('table', 'result-table');
    const head = el('tr');
    for (const h of ['Day (IST)', 'Students', 'MAU', 'Files']) head.appendChild(el('th', '', h));
    tbl.appendChild(head);
    for (const d of res.days) {
      const tr = el('tr');
      [Store.fmtDMY(d.day), d.students.toLocaleString(), d.mau.toLocaleString(), String(d.files)].forEach(t => tr.appendChild(el('td', '', t)));
      tbl.appendChild(tr);
    }
    addResult.appendChild(el('div', '', `Added ${plural(res.days.length, 'day')} to the store:`));
    addResult.appendChild(tbl);
    for (const f of res.perFile) {
      const skipped = [];
      if (f.system) skipped.push(`${f.system.toLocaleString()} Adobe/guest`);
      if (f.noEmail) skipped.push(`${f.noEmail.toLocaleString()} blank`);
      if (f.badDate) skipped.push(`${f.badDate.toLocaleString()} bad date`);
      addResult.appendChild(el('div', 'result-note',
        `${f.name}: ${f.kept.toLocaleString()} of ${f.rows.toLocaleString()} rows used` +
        (skipped.length ? ` (skipped ${skipped.join(', ')})` : '') +
        (f.days.length ? ` → ${Store.compressDays(f.days)}` : '')));
    }
    if (res.duplicateFiles && res.duplicateFiles.length) {
      addResult.appendChild(el('div', 'result-note warn',
        `Already added earlier: ${res.duplicateFiles.join(', ')} — re-adding never double-counts, so nothing changed for those rows.`));
    }
    addResult.appendChild(el('div', 'result-note', 'Published to the shared store — everyone can use the new days straight away.'));
  }

  addRunBtn.addEventListener('click', async () => {
    if (!T4.addList.length || T4.busy) return;
    if (!Store.isAdmin()) { setStatus(addStatus, 'Admin login required.', 'error'); return; }
    T4.busy = true; renderAdmin();
    addClearBtn.disabled = true; addResult.textContent = '';
    setProgress(addProgress, 0);
    try {
      await Store.ensureWritable();        // confirms the admin session before any heavy reading
      const parsed = await Store.parseLogFiles(T4.addList, ({ fileIndex, fileCount, name, pct }) => {
        setProgress(addProgress, ((fileIndex + pct / 100) / fileCount) * 90);
        setStatus(addStatus, `Reading ${name} (${fileIndex + 1} of ${fileCount}) — ${Math.round(pct)}%`);
      });
      if (!parsed.days.size) throw new Error('No usable rows found. The files need Action, Date and User Email columns.');
      setStatus(addStatus, 'Publishing to the shared store…'); setProgress(addProgress, 94);
      let res = await Store.commitParsed(parsed);
      if (res.needsConfirm) {
        const go = await openDialog({ title: 'Different month in these files', body: res.guard.message, okText: 'Continue anyway', cancelText: 'Cancel' });
        if (!go) { setStatus(addStatus, 'Cancelled — nothing was added.'); setProgress(addProgress, 0); return; }
        res = await Store.commitParsed(parsed, { confirmMixedMonths: true });
      }
      setProgress(addProgress, 100);
      setStatus(addStatus, `Done — ${plural(res.days.length, 'day')} published.`, 'success');
      renderAddResult(res);
      T4.addList = []; renderAddList();
      await refreshStore(true);
    } catch (e) {
      console.error(e);
      setStatus(addStatus, `Error: ${e.message}`, 'error');
      setProgress(addProgress, 0);
      if (!sessionEnded(e) && needsConnection(e)) setTimeout(openConnection, 0);     // the service isn't set up / wrong address → open Check connection
    } finally {
      T4.busy = false; addClearBtn.disabled = false; renderAdmin();
    }
  });

  /* ---------- reset (admin) ---------- */
  resetStoreBtn.addEventListener('click', async () => {
    if (!Store.isAdmin() || T4.busy) return;
    try { await Store.ensureWritable(); }
    catch (e) { if (!sessionEnded(e)) { setStoreMsg(e.message, 'error'); if (needsConnection(e)) openConnection(); } return; }
    let manifest;
    try { manifest = await Store.loadManifest(); } catch (e) { setStoreMsg(e.message, 'error'); return; }
    const s = Store.summarize(manifest);
    if (s.empty) { setStoreMsg('The store is already empty — nothing to reset.'); return; }
    const month = s.firstDay.slice(0, 7);

    const wrap = el('div');
    wrap.appendChild(el('p', '', `This archives all ${plural(s.dayCount, 'stored day')} (${Store.fmtDMY(s.firstDay)} to ${Store.fmtDMY(s.lastDay)}) into the archive/${month} folder inside the store and empties it for everyone. Nothing is deleted — the archived data stays in the store service.`));
    wrap.appendChild(el('p', '', 'Type RESET to confirm:'));
    const input = el('input'); input.type = 'text'; input.autocomplete = 'off'; input.placeholder = 'RESET';
    wrap.appendChild(input);

    T4.busy = true;
    const done = await openDialog({
      title: 'Reset the store', body: wrap, okText: 'Archive and reset', danger: true,
      onOpen: ({ ok: okBtn, submit }) => {
        okBtn.disabled = true;
        setTimeout(() => input.focus(), 30);
        input.addEventListener('input', () => { okBtn.disabled = input.value.trim() !== 'RESET'; });
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (!okBtn.disabled) submit(); } });
      },
      onOk: async say => {
        if (input.value.trim() !== 'RESET') { say('Type RESET (capitals) to confirm.'); return false; }
        say('Archiving and publishing…', 'info');
        try { return await Store.resetStore(); }
        catch (e) { if (sessionEnded(e)) return { expired: true }; throw e; }
      }
    });
    T4.busy = false;
    if (done && done.archivedTo) {
      rptFrom.value = ''; rptTo.value = ''; rptLookback.value = '';     // the old dates no longer exist in the store
      await refreshStore(true);
      setStoreMsg(`Store reset. ${plural(done.dayCount, 'day')} archived to ${done.archivedTo}.`, 'success');
      showModal('Store reset',
        `Archived ${plural(done.dayCount, 'day')} (${Store.fmtDMY(done.firstDay)} to ${Store.fmtDMY(done.lastDay)}) to:\n  ${done.archivedTo}\n\n` +
        'The store is now empty for everyone — add the new month\'s files to start again. The archive stays in the store service.');
    }
    renderAdmin();
  });

  /* ---------- report form ---------- */
  function readParams() {
    const mode = (document.querySelector('input[name="rptMode"]:checked') || {}).value === 'repeated' ? 'repeated' : 'normal';
    return { mode, from: rptFrom.value, to: rptTo.value, lookbackFrom: rptLookback.value };
  }

  /** Live checks: red = blocked, amber = allowed after a confirm. */
  function renderValidation() {
    const p = readParams();
    rptRepeatBox.classList.toggle('hidden', p.mode !== 'repeated');
    const connected = Store.isConnected() && !!T4.summary;
    const v = Store.validateRange(p, connected ? T4.summary : null, Store.todayKey());
    rptMsgs.textContent = '';
    if (!connected) {
      const st = Store.status();
      rptMsgs.appendChild(el('div', 'msg error', !st.configured ? "The shared store isn't set up yet." : (T4.loadError ? 'The store could not be read — press Refresh.' : 'Reading the store…')));
    } else {
      // Don't shout about empty fields before the user has touched the form (an empty store is always shown).
      const touched = !!(p.from || p.to || p.lookbackFrom);
      for (const e of v.errors) if (touched || e.code === 'store-empty') rptMsgs.appendChild(el('div', 'msg error', e.msg));
      for (const w of v.warnings) rptMsgs.appendChild(el('div', 'msg warn', w.msg));
    }

    const days = w => Store.dayRange(w.from, w.to).length;
    let note = '';
    if (v.windows.report && v.windows.report.from <= v.windows.report.to) {
      note = `Report: ${Store.fmtDMY(v.windows.report.from)} to ${Store.fmtDMY(v.windows.report.to)} (${plural(days(v.windows.report), 'day')})`;
      if (p.mode === 'repeated' && v.windows.lookback) note += `  ·  Look-back: ${Store.fmtDMY(v.windows.lookback.from)} to ${Store.fmtDMY(v.windows.lookback.to)} (${plural(days(v.windows.lookback), 'day')})`;
    }
    rptWindow.textContent = note;
    document.querySelectorAll('#rptRepeatBox .btn-chip').forEach(b => { b.disabled = !Store.isDayKey(p.from); });
    rptBuildBtn.disabled = T4.busy || !connected || v.errors.length > 0;
    return v;
  }

  [rptFrom, rptTo, rptLookback].forEach(i => { i.addEventListener('input', renderValidation); i.addEventListener('change', renderValidation); });
  document.querySelectorAll('input[name="rptMode"]').forEach(r => r.addEventListener('change', renderValidation));
  document.querySelectorAll('#rptRepeatBox .btn-chip').forEach(b => b.addEventListener('click', () => {
    const k = Store.lookbackPreset(b.dataset.preset, rptFrom.value, T4.summary);
    if (!k) { rptWindow.textContent = 'That shortcut starts on or after the report’s From date — pick the look-back date yourself.'; return; }
    rptLookback.value = k;
    renderValidation();
  }));

  rptBuildBtn.addEventListener('click', async () => {
    if (T4.busy) return;
    const p = readParams();
    const v = renderValidation();
    if (v.errors.length) return;

    if (v.warnings.length) {
      const list = el('ul');
      for (const w of v.warnings) list.appendChild(el('li', '', w.msg));
      const wrap = el('div');
      wrap.appendChild(el('p', '', 'Please check before building:'));
      wrap.appendChild(list);
      const go = await openDialog({ title: 'Check your date range', body: wrap, okText: 'Build anyway', cancelText: 'Go back' });
      if (!go) return;
    }

    // Save location first: the picker needs a fresh click, which the long build would outlive.
    const filename = Store.reportFilename(p);
    const pickerSupported = Processing.saveFolderPickerSupported();
    const saveHandle = await Processing.pickSaveHandle(filename);
    if (saveHandle === null) { setStatus(rptStatus, 'Save cancelled — nothing was built'); return; }

    T4.busy = true; rptBuildBtn.disabled = true;
    setProgress(rptProgress, 0);
    rptLogBox.textContent = '';
    rptLog(`Starting: ${p.mode === 'repeated' ? 'MAU report with Repeated' : 'MAU report'} for ${Store.fmtDMY(p.from)} to ${Store.fmtDMY(p.to)}`, 'info');
    if (!pickerSupported) rptLog('Folder picker unavailable in this browser — the file will download to your Downloads folder.', 'error');

    try {
      const result = await Store.runRangeReport(
        p,
        msg => { setStatus(rptStatus, msg); rptLog(msg, 'info'); },
        pct => setProgress(rptProgress, pct)
      );
      const rg = result.range;

      const cutoffLines = result.mauDist.slice(0, -1).map(r => `  ${r['MAU % Range']}: ${r['No. of Schools']}`).join('\n');
      const rep = result.repeated;
      const repeatLines = rep
        ? `\n\nRepeated analysis (look-back ${Store.fmtDMY(rg.lookbackFrom)} to ${Store.fmtDMY(rg.lookbackTo)}):\n` +
          `  New MAU (in report period only): ${rep.newMau.toLocaleString()}\n` +
          `  Repeated (MAU in both periods): ${rep.repeated.toLocaleString()}\n` +
          `  Completed earlier (look-back only): ${(rep.completedEarlier || 0).toLocaleString()}\n` +
          `  Pending (no MAU in either period): ${rep.pending.toLocaleString()}`
        : '';

      const outcome = await Processing.saveBlob(result.blob, result.filename, saveHandle);
      const savedNote = outcome === 'saved'
        ? `\n\nSaved as: ${saveHandle.name}`
        : '\n\nThis browser can\'t open a folder picker (only Chrome or Edge over http/https can), so the file was downloaded to your Downloads folder instead.';
      if (outcome === 'saved') rptLog(`Saved as: ${saveHandle.name}`, 'success');

      let pendingNote = '';
      if (result.pendingCsvBlob) {
        Processing.triggerDownload(result.pendingCsvBlob, result.pendingCsvName);
        pendingNote = `\n\nPending follow-up list downloaded separately as ${result.pendingCsvName} (in your Downloads).`;
        rptLog(`Pending follow-up list saved as ${result.pendingCsvName} (Downloads).`, 'info');
      }

      const gapNote = (label, m) => {
        if (!m) return '';
        const parts = [];
        if (m.gaps.length) parts.push(`no data for ${Store.compressDays(m.gaps)}`);
        if (m.outside.length) parts.push(`outside the store: ${Store.compressDays(m.outside)}`);
        return parts.length ? `\n  ${label}: ${parts.join('; ')}` : '';
      };
      const gaps = gapNote('Report period', rg.missingCurrent) + gapNote('Look-back', rg.missingLookback);

      const msg =
        'Date-range report complete!\n\n' +
        `File: ${result.filename}\n` +
        `Report period: ${Store.fmtDMY(rg.from)} to ${Store.fmtDMY(rg.to)} (${plural(rg.storedDays, 'stored day')} used)\n` +
        (rg.lookbackFrom ? `Look-back: ${Store.fmtDMY(rg.lookbackFrom)} to ${Store.fmtDMY(rg.lookbackTo)}\n` : '') +
        (gaps ? `Note:${gaps}\n` : '') +
        `\nStudents in roster: ${result.totalStudents.toLocaleString()}\n` +
        (rep
          ? `MAU in report period: ${result.mauStudents.toLocaleString()} (New ${rep.newMau.toLocaleString()} + Repeated ${rep.repeated.toLocaleString()})\n`
          : `Marked Completed MAU: ${result.mauStudents.toLocaleString()}\n`) +
        `First MAU Date filled: ${(result.mauWithDate ?? 0).toLocaleString()}\n` +
        `Marked Logged In: ${result.logStudents.toLocaleString()}\n\n` +
        `MAU % cutoff (schools${rep ? ', New MAU only' : ''}):\n${cutoffLines}` +
        repeatLines + pendingNote;

      rptLog(rep
        ? `Done — ${rep.newMau.toLocaleString()} new + ${rep.repeated.toLocaleString()} repeated MAU, ${result.logStudents.toLocaleString()} logged-in, of ${result.totalStudents.toLocaleString()} students`
        : `Done — ${result.mauStudents.toLocaleString()} MAU / ${result.logStudents.toLocaleString()} logged-in of ${result.totalStudents.toLocaleString()} students`, 'success');
      setStatus(rptStatus, outcome === 'saved' ? 'Report saved!' : 'Report downloaded to your Downloads folder.', 'success');
      showModal('Date-Range MAU Report', msg + savedNote, { blob: result.blob, filename: result.filename });
    } catch (err) {
      console.error(err);
      rptLog(`ERROR: ${err.message}`, 'error');
      setStatus(rptStatus, `Error: ${err.message}`, 'error');
      showModal('Error', `Error building the report:\n\n${err.message}`);
    } finally {
      T4.busy = false;
      renderValidation();
    }
  });

  /* ---------- start-up: open the shared store for everyone ---------- */
  (async () => {
    renderAdmin(); renderValidation(); renderLabel();
    try { await Store.init(); }
    catch (e) { console.error(e); }
    T4.wasAdmin = Store.isAdmin();          // an admin session from earlier in this tab carries over a reload
    await refreshStore(true);
  })();

})();
