/* Little Log: client-only PWA. Shared data is stored as one JSON file per event in a shared Google Drive folder. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const DB_NAME = 'little-log-local-v1';
  const STORE = 'events';
  const SETTINGS_KEY = 'little-log-settings-v1';
  const SYNC_KEY = 'little-log-sync-v1';
  const TOKEN_KEY = 'little-log-token-v1';
  const FEED_SESSION_KEY = 'little-log-feed-session-v1';
  const THEME_KEY = 'little-log-theme-v1';
  const AUTO_SAVE_MS = 15000;
  const TYPES = {
    feeding:{label:'Feeding',icon:'🍼'},sleep:{label:'Sleep',icon:'🌙'},diaper:{label:'Diaper',icon:'🧷'},solids:{label:'Solids',icon:'🥣'},pumping:{label:'Pumping',icon:'💧'},health:{label:'Health',icon:'🩺'},growth:{label:'Growth',icon:'📏'},milestone:{label:'Milestone',icon:'⭐'},tummy:{label:'Tummy time / play',icon:'🐣'},note:{label:'Note / routine',icon:'📝'}
  };
  const defaults = {clientId:'',folderName:'Little Log Baby Data',caregiver:''};
  let settings = {...defaults, ...readJson(localStorage.getItem(SETTINGS_KEY), {})};
  let db, token = null, tokenClient = null, folderId = null, syncBusy = false, lastSync = null, toastTimer, tokenWaiters = [];
  let folderEnsurePromise = null;
  let folderEnsureName = '';
  let currentTheme = localStorage.getItem(THEME_KEY) || 'dark';
  let events = [];
  let feedSession = null;
  let feedKind = 'breast';
  let breastWhen = 'now';
  let diaperKinds = new Set();
  let feedTick = null;
  let feedAutoSave = null;
  let skipFeedInputSync = {left:false, right:false};

  function readJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
  function uid() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
  function openDb() { return new Promise((resolve,reject)=>{ const req=indexedDB.open(DB_NAME,1); req.onupgradeneeded=()=>{const d=req.result;if(!d.objectStoreNames.contains(STORE)){const s=d.createObjectStore(STORE,{keyPath:'id'});s.createIndex('start','start',{unique:false});}};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error); }); }
  function allLocal() { return new Promise((resolve,reject)=>{const r=db.transaction(STORE).objectStore(STORE).getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error);}); }
  function putLocal(event) { return new Promise((resolve,reject)=>{const r=db.transaction(STORE,'readwrite').objectStore(STORE).put(event);r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);}); }
  function formatDateTime(value, withDate=false) { if(!value)return '';const d=new Date(value);return new Intl.DateTimeFormat(undefined,withDate?{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}:{hour:'numeric',minute:'2-digit'}).format(d); }
  function localInputValue(date=new Date()) { const d=new Date(date.getTime()-date.getTimezoneOffset()*60000);return d.toISOString().slice(0,16); }
  function todayStart() { const d=new Date();d.setHours(0,0,0,0);return d; }
  function isToday(iso) { const d=new Date(iso);return d>=todayStart()&&d<new Date(todayStart().getTime()+86400000); }
  function last24Start() { return Date.now() - 86400000; }
  function inLast24h(iso) { return iso && new Date(iso).getTime() >= last24Start(); }
  function showToast(msg) { const el=$('toast');el.textContent=msg;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),2800); }
  function setStatus(title, detail, state='') {
    const titleEl = $('syncTitle');
    const detailEl = $('syncDetail');
    const dotEl = $('statusDot');
    const card = $('statusCard');
    if (titleEl) titleEl.textContent = title;
    if (detailEl) detailEl.textContent = detail;
    if (dotEl) dotEl.className = 'status-dot' + (state ? ' ' + state : '');
    if (card) card.classList.toggle('hidden', !title && !detail && !state);
  }
  function setSettingsMessage(msg) { const el = $('settingsMessage'); if (el) el.textContent = msg; }
  function saveSettings() {
    const previousSync = readJson(localStorage.getItem(SYNC_KEY), null);
    const currentName = (settings.folderName || defaults.folderName || '').trim();
    const previousFolderName = (previousSync?.folderName || '').trim();

    if (previousSync?.folderId && previousFolderName && previousFolderName !== currentName) {
      localStorage.removeItem(SYNC_KEY);
      folderId = null;
    }

    localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings));
  }
  function readStoredAuth() { return readJson(localStorage.getItem(TOKEN_KEY), null); }
  function previouslyGranted() { return !!readStoredAuth()?.granted; }
  function persistToken(resp) {
    token = resp.access_token;
    const expiresIn = Number(resp.expires_in) || 3600;
    localStorage.setItem(TOKEN_KEY, JSON.stringify({
      access_token: resp.access_token,
      expires_at: Date.now() + expiresIn * 1000,
      granted: true
    }));
    updateConnectUi();
  }
  async function restoreDriveSessionSilently() {
    if (!settings.clientId || !previouslyGranted()) return false;
    if (applyStoredToken()) {
      setStatus('Connected','Restored your saved Drive session.','good');
      await syncNow();
      return true;
    }
    const ready = await whenGoogleReady(15000);
    if (!ready || !window.google?.accounts?.oauth2) return false;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: settings.clientId,
      scope: 'https://www.googleapis.com/auth/drive',
      callback: async (resp) => {
        if (resp.error) {
          clearAccessTokenKeepGrant();
          setStatus('Not connected', 'Tap Connect Drive to sign in again.', 'pending');
          return;
        }
        persistToken(resp);
        try { await ensureFolder(false); await syncNow(); }
        catch (err) { console.error(err); setStatus('Drive error', err.message, 'pending'); }
      }
    });
    tokenClient.requestAccessToken({ prompt: 'none' });
    return true;
  }
  function clearAccessTokenKeepGrant() {
    token = null;
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ granted: true, expires_at: 0 }));
    updateConnectUi();
  }
  function applyStoredToken() {
    const stored = readStoredAuth();
    if (stored?.access_token && stored.expires_at && Date.now() < stored.expires_at - 30000) {
      token = stored.access_token;
      updateConnectUi();
      return true;
    }
    return false;
  }
  function restoreFolderId() {
    const syncMeta = readJson(localStorage.getItem(SYNC_KEY), null);
    if (syncMeta?.folderId) folderId = syncMeta.folderId;
  }
  function updateConnectUi() {
    const btn = $('connectBtn');
    if (!btn) return;
    btn.textContent = token ? 'Reconnect' : 'Connect Drive';
  }
  function whenGoogleReady(timeoutMs=8000) {
    return new Promise((resolve) => {
      if (window.google?.accounts?.oauth2) { resolve(true); return; }
      const started = Date.now();
      const timer = setInterval(() => {
        if (window.google?.accounts?.oauth2) { clearInterval(timer); resolve(true); }
        else if (Date.now() - started > timeoutMs) { clearInterval(timer); resolve(false); }
      }, 50);
    });
  }
  function notifyTokenWaiters(ok) {
    const waiters = tokenWaiters;
    tokenWaiters = [];
    waiters.forEach((resolve) => resolve(ok));
  }
  function openDialog(id) { const d=$(id);if(!d.open)d.showModal(); }
  function closeDialog(id) { const d=$(id);if(d.open)d.close(); }
  function formatDuration(ms) {
    const whole = Math.max(0, Math.round((Number(ms)||0)/1000));
    const m = Math.floor(whole/60);
    const s = whole % 60;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
  function formatMinutesSeconds(ms) {
    const totalSeconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}m ${secs}s`;
  }
  function relativeTimeText(iso) {
    if (!iso) return 'No feeding logged yet';
    const diffMs = Date.now() - new Date(iso).getTime();
    if (diffMs <= 0) return 'just now';
    const totalMinutes = Math.round(diffMs / 60000);
    if (totalMinutes < 60) return `${totalMinutes} min ago`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours < 24) return minutes ? `${hours}h ${minutes}m ago` : `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
  function getRecommendedBreastSide() {
    const latest = [...events].filter(e => e.type === 'feeding' && e.subtype === 'breast' && !e.deleted).sort((a, b) => new Date(b.start) - new Date(a.start))[0];
    if (!latest) return { text: 'No feeding logged yet', side: null };
    const left = Number(latest.leftSeconds || 0);
    const right = Number(latest.rightSeconds || 0);
    const total = left + right;
    if (!total) return { text: `${relativeTimeText(latest.start)} · no feed time logged`, side: null };
    let side = 'right';
    if (left === 0 && right > 0) side = 'left';
    else if (right === 0 && left > 0) side = 'right';
    else if (left !== right) side = left > right ? 'right' : 'left';
    const sideLabel = side === 'left' ? 'left' : 'right';
    return {
      text: `${relativeTimeText(latest.start)} · ${sideLabel} side next`,
      side: sideLabel
    };
  }
  function renderNextFeedBanner() {
    const el = $('nextFeedBanner');
    if (!el) return;
    const summary = getRecommendedBreastSide();
    el.textContent = summary.text;
    el.classList.toggle('warning', !summary.side);
  }
  function applyTheme(themeName) {
    currentTheme = themeName === 'light' ? 'light' : 'dark';
    document.body.classList.toggle('light', currentTheme === 'light');
    localStorage.setItem(THEME_KEY, currentTheme);
    const themeBtn = $('themeBtn');
    if (themeBtn) themeBtn.textContent = currentTheme === 'light' ? '☾' : '☀';
  }
  function secondsToMs(sec) { return Math.max(0, Math.round(Number(sec)||0) * 1000); }
  function emptySide(ms=0) { return { acc: ms, running: false, startedAt: null }; }
  function sideElapsed(side) {
    if (!side) return 0;
    return (Number(side.acc)||0) + (side.running && side.startedAt ? Date.now() - side.startedAt : 0);
  }
  function persistFeedSession() {
    if (feedSession?.isLive) localStorage.setItem(FEED_SESSION_KEY, JSON.stringify(feedSession));
  }
  function clearLiveSession() {
    feedSession = null;
    localStorage.removeItem(FEED_SESSION_KEY);
  }
  function readLiveSession() {
    return readJson(localStorage.getItem(FEED_SESSION_KEY), null);
  }
  function feedingDetail(e) {
    if ((e.subtype||'') === 'bottle' || (e.amount && !e.leftSeconds && !e.rightSeconds && e.subtype !== 'breast')) {
      return [e.amount, e.unit].filter(Boolean).join(' ') || 'Bottle';
    }
    const parts = [];
    if (e.leftSeconds) parts.push(`L ${formatMinutesSeconds(e.leftSeconds * 1000)}`);
    if (e.rightSeconds) parts.push(`R ${formatMinutesSeconds(e.rightSeconds * 1000)}`);
    if (!parts.length && e.durationSeconds) parts.push(formatDuration(e.durationSeconds * 1000));
    else if (!parts.length && e.durationMinutes) parts.push(`${e.durationMinutes} min`);
    if (e.inProgress) parts.push('timing');
    return parts.join(' · ') || 'Breastfeed';
  }
  function diaperLabel(e) {
    const raw = (e.subtype||'').toLowerCase();
    if (raw.includes('wet') && raw.includes('dirty')) return 'Wet + dirty';
    if (raw.includes('wet')) return 'Wet';
    if (raw.includes('dirty')) return 'Dirty';
    if (raw.includes('dry')) return 'Dry';
    return e.subtype || 'Diaper';
  }
  function last24Feeds() {
    return events.filter(e => e.type==='feeding' && inLast24h(e.start)).sort((a,b)=>new Date(b.start)-new Date(a.start));
  }
  function last24Diapers() {
    return events.filter(e => e.type==='diaper' && inLast24h(e.start)).sort((a,b)=>new Date(b.start)-new Date(a.start));
  }
  function renderLast24Lists() {
    const feeds = last24Feeds();
    const feedHtml = feeds.length
      ? feeds.map(e => `<div class="last24-item"><strong>${escapeHtml(formatDateTime(e.start,true))}</strong><span>${escapeHtml(feedingDetail(e))}</span></div>`).join('')
      : '<div class="empty">No feeds in the last 24 hours.</div>';
    $('feeds24').innerHTML = feedHtml;
    $('dialogFeeds24').innerHTML = feedHtml;
    $('feeds24Total').textContent = `${feeds.length} feed${feeds.length===1?'':'s'}`;
    $('dialogFeeds24Total').textContent = `${feeds.length}`;

    const diapers = last24Diapers();
    let wet=0, dirty=0, dry=0;
    for (const e of diapers) {
      const label = diaperLabel(e).toLowerCase();
      if (label.includes('wet')) wet += 1;
      if (label.includes('dirty')) dirty += 1;
      if (label === 'dry') dry += 1;
    }
    const summary = diapers.length
      ? `<span class="pill">${wet} wet</span><span class="pill">${dirty} dirty</span><span class="pill">${dry} dry</span>`
      : '';
    const diaperHtml = diapers.length
      ? diapers.map(e => `<div class="last24-item"><strong>${escapeHtml(formatDateTime(e.start,true))}</strong><span>${escapeHtml(diaperLabel(e))}</span></div>`).join('')
      : '<div class="empty">No diapers in the last 24 hours.</div>';
    $('diapers24').innerHTML = diaperHtml;
    $('dialogDiapers24').innerHTML = diaperHtml;
    $('diapers24Summary').innerHTML = summary;
    $('dialogDiapers24Summary').innerHTML = summary;
    $('diapers24Total').textContent = `${diapers.length} diaper${diapers.length===1?'':'s'}`;
    $('dialogDiapers24Total').textContent = `${diapers.length}`;
  }

  function render() {
    events=events.filter(e=>!e.deleted).sort((a,b)=>new Date(b.start)-new Date(a.start));
    if ($('todayLabel')) $('todayLabel').textContent = 'LAST FEED';
    $('todayDate').textContent = window.LittleLogFolderSelection?.buildMainScreenSummary?.(events) || new Intl.DateTimeFormat(undefined,{weekday:'long',month:'long',day:'numeric'}).format(new Date());
    renderNextFeedBanner();
    const todays=events.filter(e=>isToday(e.start));
    const feeds=todays.filter(e=>e.type==='feeding').length;
    const diapers=todays.filter(e=>e.type==='diaper').length;
    const pumps=todays.filter(e=>e.type==='pumping').length;
    const sleepMs=todays.filter(e=>e.type==='sleep'&&e.end).reduce((n,e)=>n+Math.max(0,new Date(e.end)-new Date(e.start)),0);
    $('daySummary').textContent=`${feeds} feed${feeds===1?'':'s'} · ${diapers} diaper${diapers===1?'':'s'} · ${Math.round(sleepMs/3600000*10)/10}h logged sleep`;
    $('stats').innerHTML=`<div><strong>${feeds}</strong><span>Feeds</span></div><div><strong>${sleepMs?`${Math.floor(sleepMs/3600000)}h ${Math.floor(sleepMs%3600000/60000)}m`:'0h'}</strong><span>Sleep logged</span></div><div><strong>${diapers}</strong><span>Diapers</span></div><div><strong>${pumps}</strong><span>Pumping</span></div>`;
    renderLast24Lists();
    updateLiveFeedBar();
    const timeline=$('timeline');
    if(!events.length){timeline.innerHTML='<div class="empty">No activities yet. Add the first entry above.</div>';return;}
    timeline.innerHTML=events.slice(0,60).map(e=>{
      const type=TYPES[e.type]||TYPES.note;const range=e.end?`${formatDateTime(e.start)}–${formatDateTime(e.end)}`:formatDateTime(e.start);
      let extra = '';
      if (e.type==='feeding') extra = feedingDetail(e);
      else if (e.type==='diaper') extra = diaperLabel(e);
      else extra = [e.subtype,e.amount?[e.amount,e.unit].filter(Boolean).join(' '):'',e.durationMinutes?`${e.durationMinutes} min`:'',e.notes].filter(Boolean).join(' · ');
      const titleBits = e.type==='feeding'
        ? `${type.label}${e.inProgress?' · in progress':''}${(e.subtype||'')==='bottle'?' · bottle':''}`
        : `${type.label}${e.subtype && e.type!=='diaper'?` · ${e.subtype}`:''}`;
      return `<article class="event"><div class="event-icon">${type.icon}</div><div class="event-main"><strong>${escapeHtml(titleBits)}</strong><p>${escapeHtml(extra||'No extra details')}${e.caregiver?` · by ${escapeHtml(e.caregiver)}`:''}</p><div class="event-actions"><button data-edit="${escapeHtml(e.id)}">Edit</button><button data-delete="${escapeHtml(e.id)}">Delete</button></div></div><div class="event-meta">${escapeHtml(range)}${e.syncState==='pending'?'<br>Pending sync':''}</div></article>`;
    }).join('');
  }
  function escapeHtml(s) { return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function startGoogleClient() {
    if(!settings.clientId){showToast('Add your Google OAuth Client ID in Settings first.');openDialog('settingsDialog');return false;}
    if(!window.google?.accounts?.oauth2){showToast('Google sign-in library is still loading. Try again in a moment.');return false;}
    tokenClient=google.accounts.oauth2.initTokenClient({client_id:settings.clientId,scope:'https://www.googleapis.com/auth/drive',callback:async(resp)=>{
      if(resp.error){setStatus('Connection failed',resp.error);showToast('Google authorization failed.');return;}
      persistToken(resp);
      try{await ensureFolder(false);await syncNow();}catch(e){setStatus('Drive error',e.message);showToast(e.message);}
    }});
    return true;
  }
  function connect() {
    if (!startGoogleClient()) return;
    if (previouslyGranted() && !token) {
      tokenClient.requestAccessToken({ prompt: 'none' });
      return;
    }
    tokenClient.requestAccessToken({ prompt: token ? 'consent' : 'consent' });
  }
  async function driveFetch(path, options={}) {
    if(!token)throw new Error('Connect Google Drive first.');
    const response=await fetch(`https://www.googleapis.com/drive/v3/${path}`,{...options,headers:{Authorization:`Bearer ${token}`,...(options.headers||{})}});
    if(response.status===401){token=null;throw new Error('Google session expired. Tap Connect Drive to reconnect.');}
    if(!response.ok){let body='';try{body=(await response.json()).error?.message||'';}catch{}throw new Error(body||`Google Drive request failed (${response.status}).`);}
    if(response.status===204)return null;
    return response.json();
  }
  async function ensureFolder(showMessage=true) {
    const name = window.LittleLogFolderSelection?.getRequestedFolderName?.(settings, defaults) || settings.folderName.trim() || defaults.folderName;

    if (folderEnsurePromise && folderEnsureName === name) {
      return folderEnsurePromise;
    }

    folderEnsureName = name;
    folderEnsurePromise = (async () => {
      const stored = readJson(localStorage.getItem(SYNC_KEY), null);

      if (stored?.folderId && !window.LittleLogFolderSelection?.shouldReuseStoredFolderId?.({ settings, defaults, syncMeta: stored })) {
        console.warn('Ignoring stale saved Drive folder because the configured folder name changed.');
        localStorage.removeItem(SYNC_KEY);
        folderId = null;
      }

      const currentStored = readJson(localStorage.getItem(SYNC_KEY), null);
      if (currentStored?.folderId && window.LittleLogFolderSelection?.shouldReuseStoredFolderId?.({ settings, defaults, syncMeta: currentStored })) {
        try {
          const meta = await driveFetch(`files/${currentStored.folderId}?fields=id,name,trashed,shared`);
          if (meta?.id && !meta.trashed) {
            folderId = currentStored.folderId;
            localStorage.setItem(SYNC_KEY, JSON.stringify({ folderId, folderName: name }));
            if (showMessage) setSettingsMessage(`Using shared folder “${name}”.`);
            return folderId;
          }
        } catch (err) {
          console.warn('Stored folder id was not usable:', err);
        }
      }

      const q=`name = '${name.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
      const found=await driveFetch(`files?q=${encodeURIComponent(q)}&pageSize=100&fields=files(id,name,mimeType,webViewLink,parents,shared)`);
      if(found.files?.length){
        const preferred = found.files.find(f => f.shared) || found.files[0];
        folderId=preferred.id;
        localStorage.setItem(SYNC_KEY,JSON.stringify({folderId,folderName:name}));
        if(showMessage)setSettingsMessage(`Found folder “${name}”. Make sure it is shared with your partner as Editor.`);
        return folderId;
      }

      const created=await driveFetch('files?fields=id,name,mimeType',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,mimeType:'application/vnd.google-apps.folder'})});
      folderId=created.id;localStorage.setItem(SYNC_KEY,JSON.stringify({folderId,folderName:name}));if(showMessage)setSettingsMessage(`Created “${name}”. Now share this folder with your partner in Google Drive and give Editor access.`);return folderId;
    })();

    try {
      return await folderEnsurePromise;
    } finally {
      if (folderEnsureName === name) {
        folderEnsurePromise = null;
        folderEnsureName = '';
      }
    }
  }
  async function listDriveEvents() {
    const all=[];let pageToken='';
    do {const q=`'${folderId}' in parents and trashed = false and mimeType = 'application/json'`;let url=`files?q=${encodeURIComponent(q)}&pageSize=1000&orderBy=createdTime&fields=nextPageToken,files(id,name,mimeType,modifiedTime)`;if(pageToken)url+=`&pageToken=${encodeURIComponent(pageToken)}`;const data=await driveFetch(url);for(const f of (data.files||[])){if(!f.name?.startsWith('little-log-event-'))continue;try{const file=await driveFetch(`files/${f.id}?alt=media`);file._driveId=f.id;file.syncState='synced';all.push(file);}catch(err){console.warn('Could not read event',f.id,err);}}pageToken=data.nextPageToken||'';}while(pageToken);
    return all;
  }
  async function createDriveEvent(event) {
    const metadata={name:`little-log-event-${event.id}.json`,mimeType:'application/json',parents:[folderId],appProperties:{littleLogEventId:event.id}};
    const boundary='littlelog_boundary_'+uid().replace(/-/g,'');
    const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(event)}\r\n--${boundary}--`;
    const result=await driveFetch('files?uploadType=multipart&fields=id,name',{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body});
    return result;
  }
  async function updateDriveEvent(event, driveId) {
    const boundary='littlelog_boundary_'+uid().replace(/-/g,'');
    const metadata={name:`little-log-event-${event.id}.json`,mimeType:'application/json'};
    const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(event)}\r\n--${boundary}--`;
    await driveFetch(`files/${driveId}?uploadType=multipart`,{method:'PATCH',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body});
  }
  async function syncNow() {
    if(syncBusy)return; if(!token){setStatus('Not connected','Tap Connect Drive to sync with your partner.');return;}
    syncBusy=true;setStatus('Syncing…','Reading shared events and uploading changes.','pending');$('syncBtn').disabled=true;
    try {
      await ensureFolder(false);
      const remote=await listDriveEvents();
      const local=await allLocal();const localById=new Map(local.map(e=>[e.id,e]));const remoteById=new Map(remote.map(e=>[e.id,e]));
      for(const r of remote){const l=localById.get(r.id);if(!l||new Date(r.modifiedAt||r.start)>=new Date(l.modifiedAt||l.start)){await putLocal({...r,driveId:r._driveId,syncState:'synced'});} }
      const refreshed=await allLocal();
      for(const l of refreshed){if(l.syncState==='pending'||!remoteById.has(l.id)){
        try {if(remoteById.has(l.id)){const remoteEntry=remoteById.get(l.id);await updateDriveEvent(l,remoteEntry._driveId);await putLocal({...l,driveId:remoteEntry._driveId,syncState:'synced'});}else{const created=await createDriveEvent(l);await putLocal({...l,driveId:created.id,syncState:'synced'});}}
        catch(err){console.warn('Pending event remains local',l.id,err);}
      }}
      const finalLocal=await allLocal();
      const finalRemote=await listDriveEvents();
      const syncHealth = window.LittleLogFolderSelection?.getDriveSyncHealth?.({ localEvents: finalLocal, remoteEvents: finalRemote });
      if (syncHealth?.hasUploadProblem) {
        throw new Error(`Drive folder “${settings.folderName}” is still empty after sync. Check that you are signed into the correct Google account and that the folder is shared with Editor access.`);
      }
      events=finalLocal;lastSync=new Date();setStatus('Synced','Shared Drive data is up to date · '+formatDateTime(lastSync,true),'good');render();
    } catch(err){console.error(err);setStatus('Sync needs attention',err.message,'pending');showToast(err.message);}
    finally{syncBusy=false;$('syncBtn').disabled=false;}
  }

  function adaptFields() {
    const type = $('eventType').value;
    const isFeed = type === 'feeding';
    const isDiaper = type === 'diaper';
    $('fieldsFeeding').hidden = !isFeed;
    $('fieldsDiaper').hidden = !isDiaper;
    $('fieldsGeneric').hidden = isFeed || isDiaper;
    $('eventSaveBtn').textContent = isFeed ? 'Save feed' : isDiaper ? 'Save diaper' : 'Save activity';
  }
  function setSeg(selector, attr, value) {
    document.querySelectorAll(selector).forEach(btn => btn.classList.toggle('selected', btn.getAttribute(attr) === value));
  }
  function setFeedKind(kind) {
    feedKind = kind;
    setSeg('[data-feed-kind]', 'data-feed-kind', kind);
    $('breastPanel').hidden = kind !== 'breast';
    $('bottlePanel').hidden = kind !== 'bottle';
    if (kind === 'bottle') {
      if (!$('bottleUnit').value) $('bottleUnit').value = 'ml';
      if (!$('bottleStart').value) $('bottleStart').value = localInputValue();
    }
  }
  function setBreastWhen(when) {
    breastWhen = when;
    setSeg('[data-breast-when]', 'data-breast-when', when);
    const timing = when === 'now';
    $('leftToggle').hidden = !timing;
    $('rightToggle').hidden = !timing;
    $('feedAutoHint').textContent = timing
      ? 'Start a side to time. Saved automatically every 15 seconds, and when you tap Save.'
      : 'Enter minutes and seconds for each side, and when the feed happened.';
    if (!timing && feedSession) {
      ['left','right'].forEach(name => {
        const side = feedSession[name];
        if (side.running) {
          side.acc = sideElapsed(side);
          side.running = false;
          side.startedAt = null;
        }
      });
      persistFeedSession();
      renderFeedTimers();
    }
  }
  function newFeedSession(event, isLive=true) {
    const leftMs = secondsToMs(event?.leftSeconds);
    const rightMs = secondsToMs(event?.rightSeconds);
    return {
      eventId: event?.id || uid(),
      startIso: event?.start || new Date().toISOString(),
      left: emptySide(leftMs),
      right: emptySide(rightMs),
      notes: event?.notes || '',
      caregiver: event?.caregiver || settings.caregiver || '',
      createdAt: event?.createdAt,
      driveId: event?.driveId,
      isLive: isLive && (!event || event.inProgress || !event.id),
      startedOnce: !!(event && event.start)
    };
  }
  function restoreFeedSession() {
    const stored = readLiveSession();
    const pending = events.find(e => e.type==='feeding' && e.inProgress && !e.deleted);
    if (stored?.eventId) {
      feedSession = {...stored, isLive:true};
      if (pending && pending.id !== stored.eventId) {
        feedSession = newFeedSession(pending, true);
        persistFeedSession();
      }
    } else if (pending) {
      feedSession = newFeedSession(pending, true);
      persistFeedSession();
    }
    ensureFeedTimers();
  }
  function ensureFeedTimers() {
    if (!feedTick) feedTick = setInterval(renderFeedTimers, 250);
    if (!feedAutoSave) feedAutoSave = setInterval(() => {
      if (feedSession && (feedSession.left.running || feedSession.right.running)) saveBreastFeed({final:false, quiet:true});
    }, AUTO_SAVE_MS);
  }
  function fillMmss(prefix, ms) {
    if (skipFeedInputSync[prefix]) return;
    const active = document.activeElement;
    if (active && (active.id === prefix+'Min' || active.id === prefix+'Sec')) return;
    const whole = Math.max(0, Math.round(ms/1000));
    $(prefix+'Min').value = Math.floor(whole/60);
    $(prefix+'Sec').value = whole % 60;
  }
  function renderFeedTimers() {
    updateLiveFeedBar();
    if (!feedSession || $('fieldsFeeding').hidden) return;
    const l = sideElapsed(feedSession.left);
    const r = sideElapsed(feedSession.right);
    $('leftDisplay').textContent = formatDuration(l);
    $('rightDisplay').textContent = formatDuration(r);
    $('leftToggle').textContent = feedSession.left.running ? 'Stop' : 'Start';
    $('rightToggle').textContent = feedSession.right.running ? 'Stop' : 'Start';
    $('leftToggle').classList.toggle('running', feedSession.left.running);
    $('rightToggle').classList.toggle('running', feedSession.right.running);
    $('leftCard').classList.toggle('running', feedSession.left.running);
    $('rightCard').classList.toggle('running', feedSession.right.running);
    fillMmss('left', l);
    fillMmss('right', r);
  }
  function updateLiveFeedBar() {
    const bar = $('liveFeedBar');
    const active = feedSession && (feedSession.left.running || feedSession.right.running);
    if (!active) { bar.hidden = true; return; }
    bar.hidden = false;
    $('liveFeedTimes').textContent = `L ${formatDuration(sideElapsed(feedSession.left))} · R ${formatDuration(sideElapsed(feedSession.right))}`;
  }
  function toggleSide(name) {
    if (!feedSession) feedSession = newFeedSession();
    breastWhen = 'now';
    setBreastWhen('now');
    const otherName = name === 'left' ? 'right' : 'left';
    const side = feedSession[name];
    const other = feedSession[otherName];
    if (side.running) {
      side.acc = sideElapsed(side);
      side.running = false;
      side.startedAt = null;
    } else {
      if (other.running) {
        other.acc = sideElapsed(other);
        other.running = false;
        other.startedAt = null;
      }
      if (!feedSession.startedOnce) {
        feedSession.startIso = new Date().toISOString();
        $('feedStart').value = localInputValue(new Date(feedSession.startIso));
        feedSession.startedOnce = true;
      }
      side.running = true;
      side.startedAt = Date.now();
    }
    persistFeedSession();
    renderFeedTimers();
    saveBreastFeed({final:false, quiet:true});
  }
  function applyEditedDuration(name) {
    if (!feedSession) feedSession = newFeedSession();
    let m = Math.max(0, Number($(name+'Min').value) || 0);
    let s = Number($(name+'Sec').value) || 0;
    if (s > 59) { m += Math.floor(s/60); s = s % 60; $(name+'Min').value = m; $(name+'Sec').value = s; }
    if (s < 0) s = 0;
    const ms = (m * 60 + s) * 1000;
    const side = feedSession[name];
    side.acc = ms;
    if (side.running) side.startedAt = Date.now();
    persistFeedSession();
    renderFeedTimers();
  }
  function readFeedStart() {
    const raw = $('feedStart').value;
    const d = raw ? new Date(raw) : new Date();
    return Number.isNaN(d.getTime()) ? new Date() : d;
  }
  async function saveBreastFeed({final, quiet}) {
    if (!feedSession) feedSession = newFeedSession();
    if ($('feedStart').value) feedSession.startIso = readFeedStart().toISOString();
    if ($('feedNotes')) feedSession.notes = $('feedNotes').value.trim();
    const leftMs = sideElapsed(feedSession.left);
    const rightMs = sideElapsed(feedSession.right);
    const leftSeconds = Math.round(leftMs/1000);
    const rightSeconds = Math.round(rightMs/1000);
    const totalSeconds = leftSeconds + rightSeconds;
    if (final && totalSeconds <= 0) {
      showToast('Add time on a side, or enter minutes and seconds.');
      return false;
    }
    if (!final && totalSeconds <= 0 && !feedSession.left.running && !feedSession.right.running) return true;
    const previous = events.find(e => e.id === feedSession.eventId);
    const start = new Date(feedSession.startIso);
    const stillTiming = feedSession.left.running || feedSession.right.running;
    const end = stillTiming && !final ? new Date().toISOString() : new Date(start.getTime() + Math.max(leftMs + rightMs, 1000)).toISOString();
    const event = {
      id: feedSession.eventId,
      type: 'feeding',
      subtype: 'breast',
      start: start.toISOString(),
      end,
      leftSeconds,
      rightSeconds,
      durationSeconds: totalSeconds,
      durationMinutes: totalSeconds ? Math.max(1, Math.round(totalSeconds/60)) : null,
      amount: '',
      unit: '',
      notes: feedSession.notes || '',
      caregiver: feedSession.caregiver || settings.caregiver || 'Parent',
      createdAt: previous?.createdAt || feedSession.createdAt || new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      deleted: false,
      inProgress: !final,
      syncState: 'pending',
      driveId: previous?.driveId || feedSession.driveId
    };
    await putLocal(event);
    events = await allLocal();
    render();
    if (final) {
      const wasLive = feedSession.isLive;
      if (wasLive) clearLiveSession();
      else feedSession = readLiveSession() ? {...readLiveSession(), isLive:true} : null;
      closeDialog('eventDialog');
      showToast(token ? 'Feed saved; syncing…' : 'Feed saved on this phone.');
      if (token) syncNow();
    } else {
      persistFeedSession();
      if (!quiet) showToast('Feed saved.');
      if (token) syncNow();
    }
    return true;
  }
  async function saveBottleFeed() {
    const start = new Date($('bottleStart').value || localInputValue());
    if (Number.isNaN(start.getTime())) { showToast('Please enter a valid time.'); return; }
    const amount = $('bottleAmount').value.trim();
    const id = $('eventId').value || uid();
    const previous = events.find(e => e.id === id);
    const event = {
      id, type:'feeding', subtype:'bottle', start:start.toISOString(), end:null,
      leftSeconds:0, rightSeconds:0, durationSeconds:null, durationMinutes:null,
      amount, unit: $('bottleUnit').value.trim() || 'ml',
      notes: $('feedNotes').value.trim(), caregiver: settings.caregiver || 'Parent',
      createdAt: previous?.createdAt || new Date().toISOString(), modifiedAt: new Date().toISOString(),
      deleted:false, inProgress:false, syncState:'pending', driveId: previous?.driveId
    };
    await putLocal(event); events=await allLocal(); render(); closeDialog('eventDialog');
    showToast(token?'Saved locally; syncing…':'Saved on this phone. Connect Drive to share.');
    if (token) syncNow();
  }
  function parseDiaperKinds(subtype) {
    const raw = (subtype||'').toLowerCase();
    const set = new Set();
    if (raw.includes('wet')) set.add('wet');
    if (raw.includes('dirty')) set.add('dirty');
    if (raw.includes('dry')) set.add('dry');
    return set;
  }
  function renderDiaperChoices() {
    document.querySelectorAll('[data-diaper]').forEach(btn => {
      btn.setAttribute('aria-pressed', diaperKinds.has(btn.dataset.diaper) ? 'true' : 'false');
    });
  }
  function toggleDiaperKind(kind) {
    if (kind === 'dry') {
      if (diaperKinds.has('dry')) diaperKinds.delete('dry');
      else { diaperKinds = new Set(['dry']); }
    } else {
      diaperKinds.delete('dry');
      if (diaperKinds.has(kind)) diaperKinds.delete(kind);
      else diaperKinds.add(kind);
    }
    renderDiaperChoices();
  }
  function diaperSubtype() {
    if (diaperKinds.has('dry')) return 'dry';
    const parts = [];
    if (diaperKinds.has('wet')) parts.push('wet');
    if (diaperKinds.has('dirty')) parts.push('dirty');
    return parts.join(' + ');
  }
  async function saveDiaper() {
    const kind = diaperSubtype();
    if (!kind) { showToast('Choose wet, dirty, or dry.'); return; }
    const start = new Date($('diaperStart').value || localInputValue());
    if (Number.isNaN(start.getTime())) { showToast('Please enter a valid time.'); return; }
    const id = $('eventId').value || uid();
    const previous = events.find(e => e.id === id);
    const event = {
      id, type:'diaper', subtype:kind, start:start.toISOString(), end:null,
      amount:'', unit:'', notes:$('diaperNotes').value.trim(), caregiver: settings.caregiver || 'Parent',
      durationMinutes:null, createdAt: previous?.createdAt || new Date().toISOString(),
      modifiedAt: new Date().toISOString(), deleted:false, syncState:'pending', driveId: previous?.driveId
    };
    await putLocal(event); events=await allLocal(); render(); closeDialog('eventDialog');
    showToast(token?'Saved locally; syncing…':'Saved on this phone. Connect Drive to share.');
    if (token) syncNow();
  }

  function openNew(type='note', event=null) {
    $('eventForm').reset();
    $('eventId').value = event?.id || '';
    $('eventType').value = event?.type || type;
    $('eventStart').value = localInputValue(event ? new Date(event.start) : new Date());
    $('eventEnd').value = event?.end ? localInputValue(new Date(event.end)) : '';
    $('eventSubtype').value = event?.subtype || '';
    $('eventAmount').value = event?.amount || '';
    $('eventUnit').value = event?.unit || '';
    $('eventNotes').value = event?.notes || '';
    $('eventCaregiver').value = event?.caregiver || settings.caregiver || '';
    $('eventDuration').value = event?.durationMinutes ?? '';
    $('eventTitle').textContent = event ? 'Edit activity' : 'New ' + (TYPES[$('eventType').value]?.label || 'activity');
    adaptFields();

    if ($('eventType').value === 'feeding') {
      const isBottle = event && ((event.subtype||'') === 'bottle' || (event.amount && event.subtype !== 'breast'));
      setFeedKind(isBottle ? 'bottle' : 'breast');
      $('feedNotes').value = event?.notes || '';
      if (isBottle) {
        $('bottleStart').value = localInputValue(event ? new Date(event.start) : new Date());
        $('bottleAmount').value = event?.amount || '';
        $('bottleUnit').value = event?.unit || 'ml';
        if (!event) $('eventId').value = uid();
      } else {
        if (!event && feedSession?.isLive) {
          $('eventId').value = feedSession.eventId;
          $('feedStart').value = localInputValue(new Date(feedSession.startIso));
          $('feedNotes').value = feedSession.notes || '';
          setBreastWhen(feedSession.left.running || feedSession.right.running ? 'now' : 'now');
        } else {
          const live = event && feedSession?.isLive && feedSession.eventId !== event.id ? feedSession : (event ? readLiveSession() : null);
          feedSession = newFeedSession(event || undefined, !event || !!event.inProgress);
          if (feedSession.isLive) persistFeedSession();
          else if (live) localStorage.setItem(FEED_SESSION_KEY, JSON.stringify({...live, isLive:true}));
          $('eventId').value = feedSession.eventId;
          $('feedStart').value = localInputValue(new Date(feedSession.startIso));
          setBreastWhen(event && !event.inProgress ? 'past' : 'now');
        }
        ensureFeedTimers();
        renderFeedTimers();
      }
      $('eventTitle').textContent = event ? 'Edit feed' : 'Feeding';
    } else if ($('eventType').value === 'diaper') {
      diaperKinds = event ? parseDiaperKinds(event.subtype) : new Set();
      renderDiaperChoices();
      $('diaperStart').value = localInputValue(event ? new Date(event.start) : new Date());
      $('diaperNotes').value = event?.notes || '';
      $('eventTitle').textContent = event ? 'Edit diaper' : 'Diaper';
    }
    renderLast24Lists();
    openDialog('eventDialog');
  }
  async function saveEvent() {
    const type = $('eventType').value;
    if (type === 'feeding') {
      if (feedKind === 'bottle') return saveBottleFeed();
      return saveBreastFeed({final:true, quiet:false});
    }
    if (type === 'diaper') return saveDiaper();
    const id=$('eventId').value||uid();const previous=events.find(e=>e.id===id);const start=new Date($('eventStart').value);if(Number.isNaN(start.getTime())){showToast('Please enter a valid time.');return;}
    const end=$('eventEnd').value?new Date($('eventEnd').value).toISOString():null;
    const event={id,type,start:start.toISOString(),end,subtype:$('eventSubtype').value.trim(),amount:$('eventAmount').value.trim(),unit:$('eventUnit').value.trim(),notes:$('eventNotes').value.trim(),caregiver:$('eventCaregiver').value.trim()||settings.caregiver||'Parent',durationMinutes:$('eventDuration').value?Number($('eventDuration').value):null,createdAt:previous?.createdAt||new Date().toISOString(),modifiedAt:new Date().toISOString(),deleted:false,syncState:'pending',driveId:previous?.driveId};
    await putLocal(event);events=await allLocal();render();closeDialog('eventDialog');showToast(token?'Saved locally; syncing…':'Saved on this phone. Connect Drive to share.');if(token)syncNow();
  }
  async function deleteEvent(id) {
    const e=events.find(x=>x.id===id);if(!e)return;if(!confirm('Delete this activity for both phones?'))return;
    e.deleted=true;e.modifiedAt=new Date().toISOString();e.syncState='pending';await putLocal(e);
    if (feedSession?.eventId === id) {
      if (feedSession.isLive) clearLiveSession();
      else feedSession = readLiveSession() ? {...readLiveSession(), isLive:true} : null;
    }
    events=await allLocal();render();if(token)syncNow();else showToast('Delete saved locally; connect Drive to sync it.');
  }
  function exportJson() {const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),app:'Little Log',events:events.filter(e=>!e.deleted)},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`little-log-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(url);}
  function shareHelp() {alert('On the phone that created the folder: open Google Drive → search for “'+settings.folderName+'” → tap ⋮ → Share → add your partner’s Google account as Editor. Then on the other phone, open the same app URL, enter the same OAuth Client ID and folder name, connect Drive, and tap Sync. Do not set access to “Anyone with the link”.');}

  function closeEventDialog() {
    if (feedSession && (feedSession.left.running || feedSession.right.running || sideElapsed(feedSession.left)+sideElapsed(feedSession.right)>0)) {
      saveBreastFeed({final:false, quiet:true});
      showToast('Feed kept. Timers keep running in the background.');
    }
    closeDialog('eventDialog');
  }

  function wireEvents() {
    $('connectBtn').addEventListener('click',connect);$('syncBtn').addEventListener('click',syncNow);$('settingsBtn').addEventListener('click',()=>{ $('clientIdInput').value=settings.clientId;$('folderNameInput').value=settings.folderName;$('caregiverInput').value=settings.caregiver;openDialog('settingsDialog');});$('themeBtn').addEventListener('click',()=>applyTheme(currentTheme === 'dark' ? 'light' : 'dark'));
    document.querySelectorAll('[data-type]').forEach(b=>b.addEventListener('click',()=>openNew(b.dataset.type)));
    document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>{
      if (b.dataset.close === 'eventDialog') closeEventDialog();
      else closeDialog(b.dataset.close);
    }));
    $('eventForm').addEventListener('submit',async e=>{e.preventDefault();await saveEvent();});
    $('eventType').addEventListener('change', () => { adaptFields(); if ($('eventType').value==='feeding' && !feedSession) { feedSession = newFeedSession(); $('eventId').value = feedSession.eventId; $('feedStart').value = localInputValue(); setFeedKind('breast'); setBreastWhen('now'); renderFeedTimers(); } if ($('eventType').value==='diaper') { diaperKinds = new Set(); renderDiaperChoices(); $('diaperStart').value = localInputValue(); }});
    document.querySelectorAll('[data-feed-kind]').forEach(btn => btn.addEventListener('click', () => setFeedKind(btn.dataset.feedKind)));
    document.querySelectorAll('[data-breast-when]').forEach(btn => btn.addEventListener('click', () => setBreastWhen(btn.dataset.breastWhen)));
    $('leftToggle').addEventListener('click', () => toggleSide('left'));
    $('rightToggle').addEventListener('click', () => toggleSide('right'));
    ['left','right'].forEach(name => {
      ['Min','Sec'].forEach(part => {
        const el = $(name+part);
        el.addEventListener('focus', () => { skipFeedInputSync[name] = true; });
        el.addEventListener('blur', () => { skipFeedInputSync[name] = false; applyEditedDuration(name); saveBreastFeed({final:false, quiet:true}); });
        el.addEventListener('change', () => applyEditedDuration(name));
      });
    });
    $('feedStart').addEventListener('change', () => {
      if (!feedSession) return;
      feedSession.startIso = readFeedStart().toISOString();
      persistFeedSession();
    });
    $('diaperChoices').addEventListener('click', e => {
      const btn = e.target.closest('[data-diaper]');
      if (btn) toggleDiaperKind(btn.dataset.diaper);
    });
    $('liveFeedBar').addEventListener('click', () => openNew('feeding'));
    $('settingsForm').addEventListener('submit',e=>{e.preventDefault();settings.clientId=$('clientIdInput').value.trim();settings.folderName=$('folderNameInput').value.trim()||defaults.folderName;settings.caregiver=$('caregiverInput').value.trim();saveSettings();closeDialog('settingsDialog');showToast('Settings saved. Tap Connect Drive.');});
    $('createFolderBtn').addEventListener('click',async()=>{settings.clientId=$('clientIdInput').value.trim();settings.folderName=$('folderNameInput').value.trim()||defaults.folderName;settings.caregiver=$('caregiverInput').value.trim();saveSettings();if(!startGoogleClient())return;tokenClient.requestAccessToken({prompt:'consent'});});
    $('shareHelpBtn').addEventListener('click',shareHelp);$('exportBtn').addEventListener('click',exportJson);
    $('timeline').addEventListener('click',e=>{const edit=e.target.closest('[data-edit]');const del=e.target.closest('[data-delete]');if(edit){const ev=events.find(x=>x.id===edit.dataset.edit);if(ev)openNew(ev.type,ev);}if(del)deleteEvent(del.dataset.delete);});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden&&token)syncNow();});
  }
  async function init() {
    try{
      applyTheme(currentTheme);
      restoreFolderId();
      applyStoredToken();
      db=await openDb();
      events=await allLocal();
      restoreFeedSession();
      render();
      wireEvents();
      const isLocalDev = ['localhost','127.0.0.1','[::1]'].includes(location.hostname);
      if('serviceWorker' in navigator && location.protocol.startsWith('http') && !isLocalDev) navigator.serviceWorker.register('./sw.js').catch(console.warn);
      if(settings.clientId){
        if(token){ setStatus('Connected','Restored your saved Drive session.','good'); }
        else if(previouslyGranted()){ setStatus('Restoring Drive…','Checking the saved sign-in again.'); }
        else { setStatus('Ready to connect','Tap Connect Drive to load the shared folder.'); }
      }
      if (settings.clientId && previouslyGranted()) restoreDriveSessionSilently();
      setInterval(()=>{if(token&&!document.hidden)syncNow();},45000);
    }catch(e){console.error(e);setStatus('Local storage unavailable',e.message,'pending');}
  }
  init();
})();
