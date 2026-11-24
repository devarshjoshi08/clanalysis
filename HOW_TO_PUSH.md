# Monthly MAU Report tab — how to put it live

## What it does
New top tab **Monthly MAU Report** (next to Date-Range MAU Report).
Pick the cycle start (defaults to the current cycle set on the store's /admin page), the number of weeks (4/5/6) and the
look-back (default 28 days). Each week of 7 days is checked against the 28 days before it starts:

| Week | Report period | Look-back (Repeated check) |
|---|---|---|
| 1 | 31 Oct – 6 Nov | 3 Oct – 30 Oct |
| 2 | 7 Nov – 13 Nov | 10 Oct – 6 Nov |
| 3 | 14 Nov – 20 Nov | 17 Oct – 13 Nov |
| 4 | 21 Nov – 27 Nov | 24 Oct – 20 Nov |

MAU in the week and in its look-back = **Repeated**; MAU in the week only = **New**.
**Monthly New MAU** = students New in any week (counted once; equals the sum of weekly New).

One Excel file: Week_Overview (per week New / Repeated / Completed earlier / Pending + cumulative New),
Weekly_State (state-wise New and Repeated for each week + monthly totals), State_wise / LIC_Mapping / Lead_Level /
Manager_Level (New MAU, Repeated, Total active, %), MAU_Cutoff (New MAU only), Raw_Data (each student's status per week,
New MAU Week, Monthly Status).

**Log in as admin for exact numbers.** Week look-backs reach into the previous cycle, which is in the store's archive, and
only an admin can read the archive. A visitor can still build the file, but the page warns that students MAU only in
the previous cycle will count as New.

Weeks with no data yet are left out; a week still running is marked "x of 7 days".

## Upload (same as before, GitHub website)
1. Open https://github.com/devarshjoshi08/clanalysis → **Add file → Upload files**.
2. Drag `index.html`, the **`css` folder** and the **`js` folder** from this folder onto the page.
3. Commit message: `Add Monthly MAU Report tab (rolling 28-day look-back per week)` → **Commit changes**.
4. Wait 1–2 minutes, open the site, press Cmd+Shift+R. The header shows **Version 2026.11.24**.

Do not upload the patch, this guide or the sample file. No change is needed on the Cloudflare worker.

`Sample_Monthly_report_test_data.xlsx` was built from made-up test data (11 students) only to show the layout.
