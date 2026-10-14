# Little Log — Shared Baby Tracker (Option 2)

A lightweight installable PWA. Each phone stores a local IndexedDB copy and synchronizes event records as separate JSON files in a shared Google Drive folder. Separate event files avoid two phones overwriting one common JSON log when they create different activities at the same time.

## Included in this first implementation

- Feeding, sleep, diaper, solids, pumping, health/medication/vaccine, growth, milestones, tummy time/play, notes/routines/appointments.
- Start/end time, subtype, amount/value, unit, duration, notes, caregiver attribution.
- Local-first save, pending/synced status, background sync every 45 seconds while the app is open, soft delete, editing, today's summary, export to JSON.
- PWA manifest and service worker for installability and caching the app shell.

## Important limitations in this MVP

- Google OAuth and Drive must be configured before shared sync works. See `SETUP.md`.
- Google Drive access token is in memory only; reconnect when the token expires or after closing the app.
- Drive sync currently downloads the event JSON files on each sync. This is intentionally simple for a small family log, but should be optimized with `modifiedTime` cursors before the data becomes very large.
- If both parents edit the exact same event simultaneously, the latest synced version can win. Separate newly created events do not overwrite each other.
- Photos, push notifications, automated vaccine schedules, pediatric growth charts, and Nara's proprietary algorithms are not implemented in this first pass.
- The browser app requests the broad Google Drive `drive` OAuth scope. Keep the app private and add only your two Google accounts as OAuth test users. Google may show an unverified-app warning while the OAuth app is in Testing. Do not publish it publicly with this scope without reviewing Google's verification requirements.
- Do not treat this app as a medical record system or rely on it for urgent care decisions. Export backups regularly.

## Deploy

Serve the contents of this directory from any HTTPS static host. GitHub Pages is the simplest free option. Follow `SETUP.md`.
