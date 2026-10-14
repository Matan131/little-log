export function addDriveScopeFlags(path = '') {
  if (!path) {
    return 'supportsAllDrives=true&includeItemsFromAllDrives=true';
  }

  if (path.includes('supportsAllDrives=') && path.includes('includeItemsFromAllDrives=')) {
    return path;
  }

  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}supportsAllDrives=true&includeItemsFromAllDrives=true`;
}

export function getRequestedFolderName(settings = {}, defaults = {}) {
  const requested = (settings.folderName ?? defaults.folderName ?? '').trim();
  return requested || (defaults.folderName || 'Little Log Baby Data');
}

export function normalizeFolderName(value = '') {
  return String(value).trim().toLowerCase();
}

export function hasFolderNameMismatch({ settings = {}, defaults = {}, syncMeta = {} } = {}) {
  const storedFolderId = syncMeta?.folderId;
  if (!storedFolderId) return false;

  const storedFolderName = normalizeFolderName(syncMeta.folderName || '');
  if (!storedFolderName) return false;

  return storedFolderName !== normalizeFolderName(getRequestedFolderName(settings, defaults));
}

export function shouldReuseStoredFolderId({ settings = {}, defaults = {}, syncMeta = {} } = {}) {
  const storedFolderId = syncMeta?.folderId;
  if (!storedFolderId) return false;

  return !hasFolderNameMismatch({ settings, defaults, syncMeta });
}

export function getLastFeed(events = []) {
  return [...events]
    .filter((event) => event?.type === 'feeding' && !event?.deleted)
    .sort((a, b) => new Date(b.start) - new Date(a.start))[0] || null;
}

export function getLast24WetDiapers(events = []) {
  return [...events].filter((event) => event?.type === 'diaper' && !event?.deleted && event.start).filter((event) => {
    const time = new Date(event.start).getTime();
    return Number.isFinite(time) && Date.now() - time <= 24 * 60 * 60 * 1000;
  }).filter((event) => /wet/i.test(String(event.subtype || ''))).length;
}

export function getRecommendedNextSide(events = []) {
  const latest = getLastFeed(events);
  if (!latest) return null;
  const left = Number(latest.leftSeconds || 0);
  const right = Number(latest.rightSeconds || 0);
  if (!latest.leftSeconds && !latest.rightSeconds) return null;
  if (left === right) return 'left';
  return left > right ? 'right' : 'left';
}

export function buildMainScreenSummary(events = []) {
  const latest = getLastFeed(events);
  if (!latest) return 'No feeding logged yet';

  const diffMinutes = Math.max(0, Math.round((Date.now() - new Date(latest.start).getTime()) / 60000));
  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  const timeSince = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  const nextSide = getRecommendedNextSide(events);
  const sideText = nextSide ? `${nextSide} side next` : 'No side guidance';
  const wetCount = getLast24WetDiapers(events);
  return `${timeSince} since last feed • ${sideText} • ${wetCount} wet in 24h`;
}

export function getDriveSyncHealth({ localEvents = [], remoteEvents = [] } = {}) {
  const remoteIds = new Set((remoteEvents || []).filter((event) => event && event.id).map((event) => event.id));
  const pending = (localEvents || []).filter((event) => !event?.deleted && (event.syncState === 'pending' || !remoteIds.has(event.id)));

  return {
    remoteCount: (remoteEvents || []).length,
    pendingCount: pending.length,
    hasUploadProblem: (remoteEvents || []).length === 0 && pending.length > 0,
    pendingIds: pending.map((event) => event.id),
  };
}

export function pickFolderCandidate(matches = [], requestedName = '') {
  const list = (matches || []).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];

  const shared = list.filter((folder) => folder.shared);
  if (shared.length === 1) return shared[0];
  if (shared.length > 1) return { ambiguous: true, candidates: shared.map((folder) => ({ id: folder.id, name: folder.name, shared: folder.shared })) };

  const exactName = list.filter((folder) => String(folder.name || '').trim() === String(requestedName || '').trim());
  if (exactName.length === 1) return exactName[0];

  const newest = [...list].sort((a, b) => new Date(b.createdTime || 0) - new Date(a.createdTime || 0))[0];
  return newest || null;
}

export const LittleLogFolderSelection = {
  addDriveScopeFlags,
  getRequestedFolderName,
  normalizeFolderName,
  hasFolderNameMismatch,
  shouldReuseStoredFolderId,
  getLastFeed,
  getLast24WetDiapers,
  getRecommendedNextSide,
  buildMainScreenSummary,
  getDriveSyncHealth,
  pickFolderCandidate,
};

if (typeof window !== 'undefined') {
  window.LittleLogFolderSelection = LittleLogFolderSelection;
}
