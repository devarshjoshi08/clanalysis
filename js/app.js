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
      modalDownload.textContent = `Download ${downloadInfo.filename}`;
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
  modalDownload.addEventListener('click', () => {
    if (pendingDownload) {
      Processing.triggerDownload(pendingDownload.blob, pendingDownload.filename);
    }
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
    setStatus(emailStatus, 'File list cleared');
  });

  processEmailBtn.addEventListener('click', async () => {
    if (!emailFiles.length) return;
    processEmailBtn.disabled = true;
    clearEmailBtn.disabled = true;
    setProgress(emailProgress, 0);

    try {
      const result = await Processing.extractEmails(
        emailFiles,
        pct => setProgress(emailProgress, pct),
        msg => setStatus(emailStatus, msg)
      );

      let summary = `Processing Complete!\n\nFiles Processed: ${emailFiles.length}\n\n`;
      let totalValid = 0;
      for (const s of result.fileStats) {
        summary += `${s.file}:\n`;
        if (s.error) {
          summary += `  ERROR: ${s.error}\n\n`;
          continue;
        }
        summary += `  Rows read: ${s.total.toLocaleString()}\n`;
        summary += `  Valid rows: ${s.valid.toLocaleString()}\n`;
        summary += `  Skipped: ${s.skipped.toLocaleString()}\n`;
        summary += `  Created: ${s.created.toLocaleString()}\n`;
        summary += `  Other: ${s.other.toLocaleString()}\n\n`;
        totalValid += s.valid;
      }
      summary += `FINAL TOTALS:\n`;
      summary += `Total valid rows: ${totalValid.toLocaleString()}\n`;
      summary += `Created/Public Link: ${result.createdList.length.toLocaleString()} unique emails\n`;
      summary += `Other Actions: ${result.otherList.length.toLocaleString()} unique emails\n`;
      summary += `TOTAL: ${(result.createdList.length + result.otherList.length).toLocaleString()} unique emails`;

      setStatus(emailStatus, 'Processing completed successfully!', 'success');
      showModal('Processing Complete', summary, { blob: result.blob, filename: result.filename });

      // Auto-trigger download too (mirrors os.startfile behavior in spirit)
      Processing.triggerDownload(result.blob, result.filename);

    } catch (err) {
      console.error(err);
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

      setStatus(adobeStatus, 'Adobe summary created!', 'success');
      showModal('Adobe Data Prepared', msg, { blob: result.blob, filename: result.filename });

      Processing.triggerDownload(result.blob, result.filename);

    } catch (err) {
      console.error(err);
      setStatus(adobeStatus, `Error: ${err.message}`, 'error');
      showModal('Error', `Error preparing Adobe data:\n\n${err.message}\n\n${err.stack || ''}`);
    } finally {
      prepareAdobeBtn.disabled = !adobeFile;
    }
  });

})();
