# NWO Sip Boyz — League History

The league's history site: every season, every game's box score, every owner's career, and the leaderboards. It's built from the league's Google Sheet and hosted free on GitHub Pages.

```
Google Sheet (Apps Script refresh, Tue ~6 AM)
   │  notify_site.gs pings GitHub (or the Tue 8:30 AM fallback runs)
   ▼
GitHub Action
   1. npm run export   every tab → data/raw/*.csv        (committed: one diffable snapshot per week)
   2. npm run shape    DuckDB runs sql/views.sql → src/generated/*.json   (one file per page)
   3. astro build      ~1,300 static pages → dist/  → GitHub Pages
```

## One-time setup

### 1. Get the code
Already done: the code is in this repository. To work on it locally, use GitHub Desktop's **File › Clone repository**, or run `git clone https://github.com/Tlrose522/nwo-sip-boyz-history.git`.

### 2. Create a service account that can read the Sheet
1. Go to <https://console.cloud.google.com/> and create a project, for example `nwo-site`.
2. **APIs & Services › Library**: search for **Google Sheets API** and click **Enable**.
3. **IAM & Admin › Service Accounts › Create service account**. Name it `nwo-site`. Skip the optional steps.
4. Open the new account, go to **Keys › Add key › Create new key › JSON**. A `.json` file downloads. Keep it private and out of this folder.
5. Copy the account's email address (`nwo-site@…iam.gserviceaccount.com`). In the Sheet, click **Share**, paste that address and give it **Viewer** access.

### 3. Give the repository the key and turn on Pages
In the repository on GitHub:

- **Settings › Secrets and variables › Actions › New repository secret**. Add two secrets:
  - `SHEET_ID` = `18N-oK3UOv6MQKSB7x-7xugAplExZLO7ybLury2GYsoY`
  - `GOOGLE_SERVICE_ACCOUNT_JSON` = the **entire contents** of the downloaded `.json` file
- **Settings › Pages › Build and deployment › Source**: choose **GitHub Actions**.
- **Actions › Refresh data and deploy › Run workflow**.

When the run finishes (about 2 minutes), the site is live at `https://<your-username>.github.io/nwo-sip-boyz-history/`.

### 4. (Optional) Rebuild the moment the Sheet refreshes
Without this step, the site updates at 8:30 AM ET every Tuesday. To rebuild as soon as the Sheet's refresh finishes:

1. Copy `apps-script/notify_site.gs` into the Sheet's Apps Script project as a new file.
2. Add `if (typeof notifySite === 'function') notifySite();` as the last line of `weeklyRefresh()`.
3. Follow the setup notes at the top of that file. It needs a fine-grained GitHub token for this repository with **Contents: Read and write**.

## Working on the site locally

You need Node 22 or newer (`node -v`).

```sh
npm install
cp .env.example .env      # then set GOOGLE_APPLICATION_CREDENTIALS to your key file's path
npm run export            # pull the Sheet into data/raw/
npm run dev               # shape + live preview at http://localhost:4321
```

Pushing to `main` rebuilds the site from the committed snapshot. It does not pull the Sheet.

## Where things live

| Path | What it is |
| --- | --- |
| `scripts/export-sheet.mjs` | Sheet → `data/raw/*.csv`. Skips Checks, Wins Check, Run Log and NFL Weeks. |
| `sql/views.sql` | All the shaping logic, as DuckDB views named `out_*` (one per page module). |
| `scripts/shape.mjs` | Loads the CSVs, runs the SQL, and writes `src/generated/*.json`. |
| `src/pages/` | One file per route: `seasons/[season]/`, `…/week-[week]/`, `…/week-[week]/[game]/`, `owners/[slug]/`, `leaderboards/`. |
| `src/components/` | Meter (ratings bars), PosBoxes (position ranks), Spark, VsAvg (box-score bars), Avatar. |
| `src/styles/global.css` | Every color, font and layout rule. The NFL Street scale is `--s-1` … `--s-8`. |
| `src/assets/wall.svg` | The concrete-wall background (original art). |
| `.github/workflows/deploy.yml` | Refresh → build → deploy. |

**URLs** use each person's name from the Owner Map, for example `/owners/tyler-rose/`. Game pages use the two owners in alphabetical order, for example `/seasons/2019/week-6/billy-rose-vs-tyler-rose/`.

**Lore** comes straight from the Lore tab:
- `recap` rows become the season's "How it was won" section.
- `summary` rows become the one-liner on each season tile.
- `punishment` text appears on the last-place card.
- Rows whose status isn't `edited` show a small DRAFT tag.

**GitHub Actions versions.** If the Actions tab warns that an action is deprecated, bump its version number in `deploy.yml`, for example `actions/checkout@v5` → `@v6`.
