/**
 * NWO Sip Boyz — tell the website the Sheet just refreshed.
 *
 * Add this as its own script file next to the loader, then add one line to the end of
 * weeklyRefresh() in the loader:
 *
 *     if (typeof notifySite === 'function') notifySite();
 *
 * Setup (once):
 *   1. On GitHub, create a fine-grained personal access token limited to the
 *      nwo-sip-boyz-history repository, with "Contents: Read and write" permission.
 *   2. Project Settings (gear icon) > Script Properties > add:
 *        GITHUB_TOKEN = that token
 *        GITHUB_REPO  = <your-github-username>/nwo-sip-boyz-history
 *
 * The site's workflow also runs on a Tuesday schedule, so if this ping ever fails the site
 * still updates a couple of hours later.
 */
function notifySite() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('GITHUB_TOKEN');
  const repo = props.getProperty('GITHUB_REPO');
  if (!token || !repo) {
    writeLog_('site', [['GitHub', '', 'SKIPPED', 'GITHUB_TOKEN or GITHUB_REPO not set in Script Properties']]);
    return;
  }
  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/dispatches', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
    payload: JSON.stringify({ event_type: 'sheet-refreshed' }),
    muteHttpExceptions: true,
  });
  const ok = res.getResponseCode() === 204;
  writeLog_('site', [['GitHub', '', ok ? 'OK' : 'ERROR',
    ok ? 'Site rebuild requested' : 'HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200)]]);
}
