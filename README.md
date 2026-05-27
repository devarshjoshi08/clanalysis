# Content Logs Analyzer (Web)

Browser version of the desktop Excel automation tool.
All processing happens locally in the user's browser — files never leave the user's machine.

**Live URL (after deploy):** `https://devarshjoshi08.github.io/<repo-name>/`

## Features

1. **Email Extractor** — Reads CSV / XLSX content-log files, splits into:
   - "Created" + "Created public link" emails
   - All other action emails
   - Outputs a styled `.xlsx` with two columns and a blank separator.

2. **Adobe Data Preparation** — Reads an Adobe student data file and produces a 6-sheet workbook:
   - `Raw_Data`
   - `State_wise`
   - `LIC_Mapping`
   - `Lead_Level`
   - `Manager_Level`
   - `MAU_Cutoff` (school distribution by MAU completion %)

Same case-normalization, totals rows, `0.0%` formatting and styling as the Python `openpyxl` output.

## Tech stack

- Pure HTML / CSS / vanilla JavaScript — no build step, no framework.
- [PapaParse](https://www.papaparse.com/) for robust CSV parsing.
- [SheetJS](https://sheetjs.com/) for reading `.xlsx` / `.xls` / `.xlsm`.
- [ExcelJS](https://github.com/exceljs/exceljs) for writing styled `.xlsx`.

All three libraries are loaded from jsDelivr CDN — no `npm install` needed.

## File layout

```
web-app/
├── index.html          single-page UI
├── css/styles.css      theme (matches #A21E01 primary)
├── js/
│   ├── processing.js   data logic + Excel writer
│   └── app.js          UI controller (tabs, modal, progress)
└── README.md
```

## Run locally

Any static file server works. Easiest options:

**Python (already installed):**
```
python -m http.server 8000
```
then open <http://localhost:8000>.

**VS Code:** install the "Live Server" extension → right-click `index.html` → "Open with Live Server".

You can also just double-click `index.html`, but some browsers block local file reads when opened via `file://` — using a server is safer.

## Deploy to GitHub Pages

### One-time setup

1. Create a new GitHub repo (suggested name: `clanalysis` or `content-logs-analyzer`).
2. Copy everything inside this `web-app/` folder into the repo root.
3. Push to `main`:
   ```
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/devarshjoshi08/<repo-name>.git
   git push -u origin main
   ```
4. On GitHub: **Settings → Pages**
   - Source: **Deploy from a branch**
   - Branch: **main**, Folder: **/ (root)**
   - Save
5. Wait ~1 minute. Your live URL appears at the top of the Pages settings:
   `https://devarshjoshi08.github.io/<repo-name>/`

### Future updates

```
git add .
git commit -m "Describe change"
git push
```
GitHub redeploys in ~30 seconds.

## Differences vs the desktop Python app

| Feature | Desktop (Python) | Web |
|---|---|---|
| Email extraction | Yes | Yes |
| Adobe data prep | Yes | Yes |
| Styled `.xlsx` output | openpyxl | ExcelJS (same styling) |
| Auto-open output | `os.startfile` | Browser download |
| Zoho WorkDrive upload | Yes | Not included (use desktop app for uploads) |
| Save to specific folder | Folder picker dialog | Browser download folder |
