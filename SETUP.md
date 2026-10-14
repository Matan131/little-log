# Setup guide — install on both Pixel phones

This app is a static Progressive Web App (PWA). You do not install an APK and do not need to operate a server. You do need a public HTTPS address for the app shell, plus Google's own OAuth and Drive APIs. The app itself does not send baby records to a third-party app server; it sends them directly from each browser to Google Drive.

## Part A — Publish the app on a free HTTPS host

1. On a computer, unzip this project.
2. Create a private GitHub repository, for example `little-log-baby`.
3. Upload all files and folders from this directory to the repository root (`index.html`, `app.js`, `styles.css`, `manifest.webmanifest`, `sw.js`, `icons/`, etc.).
4. In GitHub, open **Settings → Pages**. Under build/deployment, select **Deploy from a branch**, choose `main` and `/ (root)`, and save.
5. Wait for GitHub Pages to publish the site. Copy the exact HTTPS URL it provides, e.g. `https://YOUR-USERNAME.github.io/little-log-baby/`.
6. Treat the URL as the app's address. The app is not password-protected by its URL, but Drive data still requires Google authorization. Do not put private data directly in the repository.

Alternative: use another static host that serves HTTPS and supports the files unchanged. The OAuth origin must match the actual hostname, not the full path.

## Part B — Configure Google Cloud once

Use one Google account (ideally the account that will own the shared data folder).

1. Open https://console.cloud.google.com/ and create a project, e.g. `Little Log Family`.
2. In **APIs & Services → Library**, enable **Google Drive API**.
3. In **Google Auth Platform** (or **APIs & Services → OAuth consent screen**, depending on the current console layout), configure the app:
   - App name: `Little Log`
   - User support email: your email
   - Audience: **External** if the two Google accounts are personal accounts
   - Publishing status: **Testing**
   - Add both parents' Google account email addresses under **Test users**
   - Complete the required developer contact details and save.
4. Create an OAuth client: **Clients / Credentials → Create OAuth client ID → Web application**.
5. Under **Authorized JavaScript origins**, add the origin only, for example `https://YOUR-USERNAME.github.io` (no path and no trailing slash). If using a different host, add that host's origin.
6. Create the client and copy the **Client ID** ending in `apps.googleusercontent.com`. Do not create or embed a client secret; this browser app uses the Google Identity Services token model.
7. Keep the OAuth app in Testing and only use it with the two test accounts. Google may display an unverified-app warning and test-mode token/consent limitations. Follow the current Google console notices if they appear.

Official references:
- OAuth for browser apps: https://developers.google.com/identity/oauth2/web/guides/overview
- Token model: https://developers.google.com/identity/oauth2/web/guides/use-token-model
- Drive API: https://developers.google.com/workspace/drive/api/guides/about-sdk

## Part C — Create and share the data folder

1. Open the published app URL on your computer or first Pixel.
2. Tap the gear icon.
3. Paste the OAuth Client ID into **Google OAuth Client ID**.
4. Set the folder name to `Little Log Baby Data` (or another unique name) and set your caregiver name.
5. Save settings, then tap **Connect Drive**. Choose the Google account that will own the shared folder and approve Drive access.
6. If the folder does not already exist, the app creates it in that account's Google Drive. Open Google Drive, search for `Little Log Baby Data`, open the folder's **Share** menu, and add your partner's Google account as **Editor**. Do not choose “Anyone with the link”.
7. If a folder with that name already existed, confirm it is the correct folder and share that folder with the other parent as Editor.

## Part D — Install on your Pixel 11

Do these steps on **each phone**:

1. Open Chrome and visit the exact same HTTPS app URL.
2. Open the app's gear icon and enter the same OAuth Client ID and exact same folder name.
3. Enter that parent's own caregiver name (e.g. `Dad` and `Mom`) and save.
4. Tap **Connect Drive** and choose the Google account that was added as a test user and has Editor access to the shared folder. Approve the request.
5. On Chrome, tap the three-dot menu → **Install app** or **Add to Home screen** → **Install**. The exact wording can vary by Chrome version.
6. Open **Little Log** from the home screen. Add a test note on one phone, tap Sync, then open the app on the other phone and tap Sync. Confirm the test note appears. Delete the test note and sync again.

## Daily use

- Save an entry; it is saved to that phone first. When Drive is connected, it uploads in the background.
- The app checks for changes about every 45 seconds while open and when returning to the foreground. Tap **Sync** for an immediate check.
- If a phone has no connection, entries remain local and are uploaded when you reconnect and open the app.
- Reconnect Drive when the app reports an expired Google session.
- Use **Export JSON** regularly to download a backup. The export currently contains the locally synchronized records, so sync both phones before exporting.

## Troubleshooting

- **Origin not allowed:** add the exact HTTPS hostname in Google Cloud → OAuth client → Authorized JavaScript origins. Save, wait a minute, reload.
- **Access blocked / app not verified:** ensure the Google account is listed under OAuth Test users and the consent screen is still in Testing. Review the warning and current Google requirements; do not bypass unexpected security warnings on behalf of another person.
- **Partner sees no folder:** share the folder with the exact Google account used during the partner's OAuth flow, grant Editor access, then reconnect and sync.
- **Wrong folder / duplicate folder:** agree on one exact folder name and ensure only the intended shared folder exists with that name. If multiple results match, this MVP picks the first result; if that happens, rename the unintended folder and reconnect.
- **Entries remain pending:** reconnect Drive, confirm the phone has internet and Editor access, then tap Sync. Do not clear Chrome site data because that can erase the unsynced local copy.
- **App doesn't update after a code change:** fully close and reopen the installed PWA, or reload the website. If needed, clear only the site's cached files after confirming all entries are synced.

## Data and privacy notes

- Records are stored as one JSON file per event in the shared Google Drive folder.
- The `drive` OAuth scope is broad. Use this app only for your own family and only with the two intended accounts. Google can change its OAuth verification/testing policies; check the current console notices.
- Anyone with Editor access to the shared folder can potentially read, edit, download, or delete the event files.
- Do not use this as the only copy of important records. Export backups.
