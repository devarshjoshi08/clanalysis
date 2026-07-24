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

  runPaBtn.addEventListener('click', async () => {
    if (!paFiles.length) return;

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
        msg => { setStatus(paStatus, msg); paLog(msg, 'info'); }
      );

      const cutoffLines = result.mauDist
        .slice(0, -1)
        .map(r => `  ${r['MAU % Range']}: ${r['No. of Schools']}`)
        .join('\n');

      const outcome = await Processing.saveBlob(result.blob, result.filename, saveHandle);
      const savedNote = outcome === 'saved'
        ? `\n\nSaved as: ${saveHandle.name}`
        : "\n\nThis browser can't open a folder picker (only Chrome or Edge over http/https can), " +
          "so the file was downloaded to your browser's Downloads folder instead.";
      if (outcome === 'saved') paLog(`Saved as: ${saveHandle.name}`, 'success');

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
        `Marked Logged In: ${result.logStudents.toLocaleString()}\n\n` +
        `MAU % cutoff (schools):\n${cutoffLines}`;

      paLog(result.rosterFromCache ? 'Roster loaded from cache (no re-download).' : 'Roster parsed fresh and cached for next time.', 'info');
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

})();
