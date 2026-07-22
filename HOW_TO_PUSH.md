# How to push these changes to `clanalysis`

This sandbox has no GitHub credentials, so push from your own machine. Pick **one**
of the two paths below. Both assume you already have the repo cloned locally and
authenticated with GitHub.

This bundle contains **two change sets** (both already validated and included in
`changes.patch`):

1. **Harden the save flow** — the Adobe & Email tabs now tell you clearly when a
   browser can't show a folder picker instead of silently downloading; the Email
   tab now also asks where to save.
2. **New third tab: "Process + Adobe Data Preparation"** — one click turns your
   content logs into the final Adobe summary using the repo template.

## Files changed (only these three)
- `index.html`
- `js/app.js`
- `js/processing.js`

The template `Adobe_Reporting_Template.xlsm` is already in your repo and is **not
modified** — no need to touch it.

> Ignore the leftover files in this folder that I couldn't delete from here:
> `styles.css` (at the root), `.DS_Store`, and
> `0001-Harden-save-flow-*.patch` (superseded — `changes.patch` now contains
> everything). The real CSS lives in `css/styles.css` and is unchanged.

---

## Path A — replace the three files (simplest)

1. Copy these over your local clone:
   - `index.html` → `<your-clone>/index.html`
   - `js/app.js` → `<your-clone>/js/app.js`
   - `js/processing.js` → `<your-clone>/js/processing.js`
2. Then:

   ```bash
   git checkout main
   git pull
   git add index.html js/app.js js/processing.js
   git commit -m "Harden save flow + add Process + Adobe Data Preparation tab"
   git push origin main
   ```

## Path B — apply the patch

```bash
git checkout main
git pull
git apply /path/to/clanalysis-update/changes.patch
git add index.html js/app.js js/processing.js
git commit -m "Harden save flow + add Process + Adobe Data Preparation tab"
git push origin main
```

---

## After you push
- GitHub Pages redeploys `main` in ~30–60s. **Hard-refresh** the live site
  (Cmd/Ctrl+Shift+R) so you're not seeing the cached old version.
- The new tab appears next to "Adobe Data Preparation".

## Using the new "Process + Adobe Data Preparation" tab
- Select the **same content-log files** you use for the Email Extractor, then
  click **Process + Prepare**.
- It splits emails (Created / "Created public link" → **Completed MAU?**; all
  other actions → **Logged In?**), auto-loads a fresh copy of
  `Adobe_Reporting_Template.xlsm`, marks all ~200k students by matching their
  `Adobe Email`, and produces the final summary + a filled `Mapping` sheet.
- Your template is never changed and no temp files are left behind.

**Important — this tab is heavy** (~24 MB / 200k-row template):
- Use **Chrome or Edge on a desktop**, served over **http/https** (the deployed
  site or a local server — *not* a `file://` double-click).
- Expect **~15–40 seconds** and high memory (~1.5–2 GB) while it runs. Low-RAM
  machines may struggle; a normal desktop that can open the template in Excel is
  fine.
- The output intentionally does **not** include the 200k-row `Raw_Data` sheet
  (writing it in the browser runs out of memory, and you already have the roster
  in the template). It contains the styled State / LIC / Lead / Manager / MAU
  summaries plus the filled `Mapping` sheet.

## Test data in this folder
- `demo_content_logs.csv` — sample content log whose emails match real roster
  entries.
- `Feature3_demo_output.xlsx` — the exact output the new tab produced from that
  input against the real template (20 MAU / 20 logged-in of 201,099 students).
- `demo_adobe.csv` / `Adobe_demo_output.xlsx` — sample for the standalone Adobe tab.
