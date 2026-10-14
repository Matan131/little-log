/* Little Log: client-only PWA. Shared data is stored as one JSON file per event in a shared Google Drive folder. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const DB_NAME = 'little-log-local-v1';
  const STORE = 'events';
  const SETTINGS_KEY = 'little-log-settings-v1';
  const SYNC_KEY = 'little-log-sync-v1';
  const TYPES = {
    feeding:{label:'Feeding',icon:'🍼'},sleep:{label:'Sleep',icon:'🌙'},diaper:{label:'Diaper',icon:'🧷'},solids:{label:'Solids',icon:'🥣'},pumping:{label:'Pumping',icon:'💧'},health:{label:'Health',icon:'🩺'},growth:{label:'Growth',icon:'📏'},milestone:{label:'Milestone',icon:'⭐'},tummy:{label:'Tummy time / play',icon:'🐣'},note:{label:'Note / routine',icon:'📝'}
  };
  const defaults = {clientId:'',folderName:'Little Log Baby Data',caregiver:''};
  let settings = {...defaults, ...readJson(localStorage.getItem(SETTINGS_KEY), {})};
  let db, token = null, tokenClient = null, folderId = null, syncBusy = false, lastSync = null, toastTimer;
  let events = [];

  function readJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
  function uid() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
  function openDb() { return new Promise((resolve,reject)=>{ const req=indexedDB.open(DB_NAME,1); req.onupgradeneeded=()=>{const d=req.result;if(!d.objectStoreNames.contains(STORE)){const s=d.createObjectStore(STORE,{keyPath:'id'});s.createIndex('start','start',{unique:false});}};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error); }); }
  function allLocal() { return new Promise((resolve,reject)=>{const r=db.transaction(STORE).objectStore(STORE).getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error);}); }
  function putLocal(event) { return new Promise((resolve,reject)=>{const r=db.transaction(STORE,'readwrite').objectStore(STORE).put(event);r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);}); }
  function formatDateTime(value, withDate=false) { if(!value)return '';const d=new Date(value);return new Intl.DateTimeFormat(undefined,withDate?{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}:{hour:'numeric',minute:'2-digit'}).format(d); }
  function localInputValue(date=new Date()) { const d=new Date(date.getTime()-date.getTimezoneOffset()*60000);return d.toISOString().slice(0,16); }
  function todayStart() { const d=new Date();d.setHours(0,0,0,0);return d; }
  function isToday(iso) { const d=new Date(iso);return d>=todayStart()&&d<new Date(todayStart().getTime()+86400000); }
  function showToast(msg) { const el=$('toast');el.textContent=msg;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),2800); }
  function setStatus(title, detail, state='') { $('syncTitle').textContent=title;$('syncDetail').textContent=detail;$('statusDot').className='status-dot'+(state?' '+state:''); }
  function setSettingsMessage(msg) { $('settingsMessage').textContent=msg; }
  function saveSettings() { localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings)); }
  function openDialog(id) { const d=$(id);if(!d.open)d.showModal(); }
  function closeDialog(id) { const d=$(id);if(d.open)d.close(); }

  function render() {
    events=events.filter(e=>!e.deleted).sort((a,b)=>new Date(b.start)-new Date(a.start));
    $('todayDate').textContent=new Intl.DateTimeFormat(undefined,{weekday:'long',month:'long',day:'numeric'}).format(new Date());
    const todays=events.filter(e=>isToday(e.start));
    const feeds=todays.filter(e=>e.type==='feeding').length;
    const diapers=todays.filter(e=>e.type==='diaper').length;
    const pumps=todays.filter(e=>e.type==='pumping').length;
    const sleepMs=todays.filter(e=>e.type==='sleep'&&e.end).reduce((n,e)=>n+Math.max(0,new Date(e.end)-new Date(e.start)),0);
    $('daySummary').textContent=`${feeds} feed${feeds===1?'':'s'} · ${diapers} diaper${diapers===1?'':'s'} · ${Math.round(sleepMs/3600000*10)/10}h logged sleep`;
    $('stats').innerHTML=`<div><strong>${feeds}</strong><span>Feeds</span></div><div><strong>${sleepMs?`${Math.floor(sleepMs/3600000)}h ${Math.floor(sleepMs%3600000/60000)}m`:'0h'}</strong><span>Sleep logged</span></div><div><strong>${diapers}</strong><span>Diapers</span></div><div><strong>${pumps}</strong><span>Pumping</span></div>`;
    const timeline=$('timeline');
    if(!events.length){timeline.innerHTML='<div class="empty">No activities yet. Add the first entry above.</div>';return;}
    timeline.innerHTML=events.slice(0,60).map(e=>{
      const type=TYPES[e.type]||TYPES.note;const range=e.end?`${formatDateTime(e.start)}–${formatDateTime(e.end)}`:formatDateTime(e.start);
      const detail=[e.subtype,e.amount?[e.amount,e.unit].filter(Boolean).join(' '):'',e.durationMinutes?`${e.durationMinutes} min`:'',e.notes].filter(Boolean).join(' · ');
      return `<article class="event"><div class="event-icon">${type.icon}</div><div class="event-main"><strong>${escapeHtml(type.label)}${e.subtype?` · ${escapeHtml(e.subtype)}`:''}</strong><p>${escapeHtml(detail||'No extra details')}${e.caregiver?` · by ${escapeHtml(e.caregiver)}`:''}</p><div class="event-actions"><button data-edit="${escapeHtml(e.id)}">Edit</button><button data-delete="${escapeHtml(e.id)}">Delete</button></div></div><div class="event-meta">${escapeHtml(range)}${e.syncState==='pending'?'<br>Pending sync':''}</div></article>`;
    }).join('');
  }
  function escapeHtml(s) { return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function startGoogleClient() {
    if(!settings.clientId){showToast('Add your Google OAuth Client ID in Settings first.');openDialog('settingsDialog');return false;}
    if(!window.google?.accounts?.oauth2){showToast('Google sign-in library is still loading. Try again in a moment.');return false;}
    tokenClient=google.accounts.oauth2.initTokenClient({client_id:settings.clientId,scope:'https://www.googleapis.com/auth/drive',callback:async(resp)=>{
      if(resp.error){setStatus('Connection failed',resp.error);showToast('Google authorization failed.');return;}
      token=resp.access_token;
      try{await ensureFolder(false);await syncNow();}catch(e){setStatus('Drive error',e.message);showToast(e.message);}
    }});
    return true;
  }
  function connect() { if(startGoogleClient())tokenClient.requestAccessToken({prompt:token?'':'consent'}); }
  async function driveFetch(path, options={}) {
    if(!token)throw new Error('Connect Google Drive first.');
    const response=await fetch(`https://www.googleapis.com/drive/v3/${path}`,{...options,headers:{Authorization:`Bearer ${token}`,...(options.headers||{})}});
    if(response.status===401){token=null;throw new Error('Google session expired. Tap Connect Drive to reconnect.');}
    if(!response.ok){let body='';try{body=(await response.json()).error?.message||'';}catch{}throw new Error(body||`Google Drive request failed (${response.status}).`);}
    if(response.status===204)return null;
    return response.json();
  }
  async function ensureFolder(showMessage=true) {
    const name=settings.folderName.trim()||defaults.folderName;
    const q=`name = '${name.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const found=await driveFetch(`files?q=${encodeURIComponent(q)}&pageSize=100&fields=files(id,name,mimeType,webViewLink,parents)`);
    if(found.files?.length){folderId=found.files[0].id;localStorage.setItem(SYNC_KEY,JSON.stringify({folderId,folderName:name}));if(showMessage)setSettingsMessage(`Found folder “${name}”. Make sure it is shared with your partner as Editor.`);return folderId;}
    const created=await driveFetch('files?fields=id,name,mimeType',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,mimeType:'application/vnd.google-apps.folder'})});
    folderId=created.id;localStorage.setItem(SYNC_KEY,JSON.stringify({folderId,folderName:name}));if(showMessage)setSettingsMessage(`Created “${name}”. Now share this folder with your partner in Google Drive and give Editor access.`);return folderId;
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
      // First merge remote entries. Local pending edits win only when their local modifiedAt is newer.
      for(const r of remote){const l=localById.get(r.id);if(!l||new Date(r.modifiedAt||r.start)>=new Date(l.modifiedAt||l.start)){await putLocal({...r,driveId:r._driveId,syncState:'synced'});} }
      const refreshed=await allLocal();
      for(const l of refreshed){if(l.syncState==='pending'||!remoteById.has(l.id)){
        try {if(remoteById.has(l.id)){const remoteEntry=remoteById.get(l.id);await updateDriveEvent(l,remoteEntry._driveId);await putLocal({...l,driveId:remoteEntry._driveId,syncState:'synced'});}else{const created=await createDriveEvent(l);await putLocal({...l,driveId:created.id,syncState:'synced'});}}
        catch(err){console.warn('Pending event remains local',l.id,err);}
      }}
      events=await allLocal();lastSync=new Date();setStatus('Synced','Shared Drive data is up to date · '+formatDateTime(lastSync,true),'good');render();
    } catch(err){console.error(err);setStatus('Sync needs attention',err.message,'pending');showToast(err.message);}
    finally{syncBusy=false;$('syncBtn').disabled=false;}
  }
  function openNew(type='note',event=null) {
    $('eventForm').reset();$('eventId').value=event?.id||'';$('eventType').value=event?.type||type;$('eventStart').value=localInputValue(event?new Date(event.start):new Date());$('eventEnd').value=event?.end?localInputValue(new Date(event.end)):'';$('eventSubtype').value=event?.subtype||'';$('eventAmount').value=event?.amount||'';$('eventUnit').value=event?.unit||'';$('eventNotes').value=event?.notes||'';$('eventCaregiver').value=event?.caregiver||settings.caregiver||'';$('eventDuration').value=event?.durationMinutes??'';$('eventTitle').textContent=event?'Edit activity':'New '+(TYPES[type]?.label||'activity');openDialog('eventDialog');
  }
  async function saveEvent() {
    const id=$('eventId').value||uid();const previous=events.find(e=>e.id===id);const start=new Date($('eventStart').value);if(Number.isNaN(start.getTime())){showToast('Please enter a valid time.');return;}
    const end=$('eventEnd').value?new Date($('eventEnd').value).toISOString():null;
    const event={id,type:$('eventType').value,start:start.toISOString(),end,subtype:$('eventSubtype').value.trim(),amount:$('eventAmount').value.trim(),unit:$('eventUnit').value.trim(),notes:$('eventNotes').value.trim(),caregiver:$('eventCaregiver').value.trim()||settings.caregiver||'Parent',durationMinutes:$('eventDuration').value?Number($('eventDuration').value):null,createdAt:previous?.createdAt||new Date().toISOString(),modifiedAt:new Date().toISOString(),deleted:false,syncState:'pending',driveId:previous?.driveId};
    await putLocal(event);events=await allLocal();render();closeDialog('eventDialog');showToast(token?'Saved locally; syncing…':'Saved on this phone. Connect Drive to share.');if(token)syncNow();
  }
  async function deleteEvent(id) {const e=events.find(x=>x.id===id);if(!e)return;if(!confirm('Delete this activity for both phones?'))return;e.deleted=true;e.modifiedAt=new Date().toISOString();e.syncState='pending';await putLocal(e);events=await allLocal();render();if(token)syncNow();else showToast('Delete saved locally; connect Drive to sync it.');}
  function exportJson() {const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),app:'Little Log',events:events.filter(e=>!e.deleted)},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`little-log-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(url);}
  function shareHelp() {alert('On the phone that created the folder: open Google Drive → search for “'+settings.folderName+'” → tap ⋮ → Share → add your partner’s Google account as Editor. Then on the other phone, open the same app URL, enter the same OAuth Client ID and folder name, connect Drive, and tap Sync. Do not set access to “Anyone with the link”.');}
  function wireEvents() {
    $('connectBtn').addEventListener('click',connect);$('syncBtn').addEventListener('click',syncNow);$('settingsBtn').addEventListener('click',()=>{ $('clientIdInput').value=settings.clientId;$('folderNameInput').value=settings.folderName;$('caregiverInput').value=settings.caregiver;openDialog('settingsDialog');});
    document.querySelectorAll('[data-type]').forEach(b=>b.addEventListener('click',()=>openNew(b.dataset.type)));
    document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>closeDialog(b.dataset.close)));
    $('eventForm').addEventListener('submit',async e=>{e.preventDefault();await saveEvent();});
    $('settingsForm').addEventListener('submit',e=>{e.preventDefault();settings.clientId=$('clientIdInput').value.trim();settings.folderName=$('folderNameInput').value.trim()||defaults.folderName;settings.caregiver=$('caregiverInput').value.trim();saveSettings();closeDialog('settingsDialog');showToast('Settings saved. Tap Connect Drive.');});
    $('createFolderBtn').addEventListener('click',async()=>{settings.clientId=$('clientIdInput').value.trim();settings.folderName=$('folderNameInput').value.trim()||defaults.folderName;settings.caregiver=$('caregiverInput').value.trim();saveSettings();if(!startGoogleClient())return;tokenClient.requestAccessToken({prompt:'consent'});});
    $('shareHelpBtn').addEventListener('click',shareHelp);$('exportBtn').addEventListener('click',exportJson);
    $('timeline').addEventListener('click',e=>{const edit=e.target.closest('[data-edit]');const del=e.target.closest('[data-delete]');if(edit){const ev=events.find(x=>x.id===edit.dataset.edit);if(ev)openNew(ev.type,ev);}if(del)deleteEvent(del.dataset.delete);});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden&&token)syncNow();});
  }
  async function init() {
    try{db=await openDb();events=await allLocal();render();wireEvents();if('serviceWorker' in navigator&&location.protocol.startsWith('http'))navigator.serviceWorker.register('./sw.js').catch(console.warn);if(settings.clientId)setStatus('Ready to connect','Tap Connect Drive to load the shared folder.');setInterval(()=>{if(token&&!document.hidden)syncNow();},45000);}catch(e){console.error(e);setStatus('Local storage unavailable',e.message,'pending');}
  }
  init();
})();
