import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRequestedFolderName,
  hasFolderNameMismatch,
  shouldReuseStoredFolderId,
  buildMainScreenSummary,
  getLast24WetDiapers,
  getRecommendedNextSide,
} from '../sync-folder.mjs';

test('requested folder name trims whitespace and falls back to default', () => {
  const defaults = { folderName: 'Little Log Baby Data' };
  assert.equal(getRequestedFolderName({ folderName: '  Family Folder  ' }, defaults), 'Family Folder');
  assert.equal(getRequestedFolderName({ folderName: '' }, defaults), 'Little Log Baby Data');
});

test('stored folder id is only reused when it still matches the configured folder name', () => {
  const defaults = { folderName: 'Little Log Baby Data' };

  assert.equal(shouldReuseStoredFolderId({
    settings: { folderName: 'Little Log Baby Data' },
    defaults,
    syncMeta: { folderId: 'abc123', folderName: 'Little Log Baby Data' }
  }), true);

  assert.equal(shouldReuseStoredFolderId({
    settings: { folderName: 'New Folder Name' },
    defaults,
    syncMeta: { folderId: 'abc123', folderName: 'Little Log Baby Data' }
  }), false);

  assert.equal(hasFolderNameMismatch({
    settings: { folderName: 'New Folder Name' },
    defaults,
    syncMeta: { folderId: 'abc123', folderName: 'Little Log Baby Data' }
  }), true);
});

test('stale sync metadata is treated as a folder-name mismatch until it is replaced', () => {
  const defaults = { folderName: 'Little Log Baby Data' };

  assert.equal(hasFolderNameMismatch({
    settings: { folderName: 'Reused Folder' },
    defaults,
    syncMeta: { folderId: 'old-folder', folderName: 'Little Log Baby Data' }
  }), true);

  assert.equal(shouldReuseStoredFolderId({
    settings: { folderName: 'Reused Folder' },
    defaults,
    syncMeta: { folderId: 'old-folder', folderName: 'Reused Folder' }
  }), true);
});

test('hero summary tells you how long since the last feed, which side is next, and wet diaper count', () => {
  const now = Date.now();
  const events = [
    { id: '1', type: 'feeding', subtype: 'breast', start: new Date(now - 2 * 60 * 60 * 1000 - 15 * 60 * 1000).toISOString(), leftSeconds: 30, rightSeconds: 90, deleted: false },
    { id: '2', type: 'diaper', subtype: 'wet', start: new Date(now - 45 * 60 * 1000).toISOString(), deleted: false },
    { id: '3', type: 'diaper', subtype: 'wet', start: new Date(now - 19 * 60 * 60 * 1000).toISOString(), deleted: false },
    { id: '4', type: 'diaper', subtype: 'dry', start: new Date(now - 2 * 60 * 60 * 1000).toISOString(), deleted: false },
  ];

  assert.equal(getRecommendedNextSide(events), 'left');
  assert.equal(getLast24WetDiapers(events), 2);
  assert.match(buildMainScreenSummary(events), /2h 15m since last feed/i);
  assert.match(buildMainScreenSummary(events), /left side next/i);
  assert.match(buildMainScreenSummary(events), /2 wet in 24h/i);
});
