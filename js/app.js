// Interface (DOM). Toute la logique protocole/sécurité est dans protocol.js, eds-session.js et tuning.js.
import { DEVICE_NAME_TX, indexToGear, gearToIndex } from './protocol.js';
import { EdsSession, DisconnectedError, TimeoutError } from './eds-session.js';
import { isWebBluetoothAvailable, requestEdsDevice, connectTransport } from './web-bluetooth.js';
import { createSimulatedTx } from './simulator.js';
import { applyRearValues, validateTarget } from './tuning.js';
import { createStorage, toDrEdsExport, fromDrEdsImport, exportFileName, PROFILE_NAMES } from './storage.js';

const $ = (id) => document.getElementById(id);
const storage = createStorage(safeLocalStorage());

const app = {
  device: null, // BluetoothDevice choisi
  sim: null, // dérailleur simulé (mode démo)
  session: null,
  deviceName: null,
  state: null, // dernier état lu (extractTxState)
  busy: false,
  userDisconnect: false,
  demo: localStorage.getItem('wheeltop.demo') === '1',
  logLines: [],
  liveNum: null,
  liveChainring: null,
  batteries: null,
};

// ---------------------------------------------------------------------------------------------
// Utilitaires
function safeLocalStorage() {
  try { localStorage.setItem('wheeltop.test', '1'); localStorage.removeItem('wheeltop.test'); return localStorage; } catch {
    const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  }
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtDate(iso) { if (!iso) return '?'; const d = new Date(iso); return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }); }
function log(s) {
  const line = `${new Date().toLocaleTimeString('fr-FR')} ${s}`;
  app.logLines.push(line);
  if (app.logLines.length > 800) app.logLines.splice(0, app.logLines.length - 800);
  if ($('set-log').checked) { const el = $('log'); el.textContent = app.logLines.join('\n'); el.scrollTop = el.scrollHeight; }
}
function download(obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function errorText(e) {
  if (e instanceof DisconnectedError) return 'Le dérailleur s’est déconnecté.';
  if (e instanceof TimeoutError) return e.message + '.';
  if (e?.name === 'NotFoundError') return 'Aucun dérailleur choisi.';
  if (e?.name === 'NetworkError') return 'Connexion Bluetooth impossible (dérailleur endormi ? secouez le vélo pour le réveiller).';
  return e?.message || String(e);
}

// ---------------------------------------------------------------------------------------------
// Dialogue modal générique. buttons : [{ label, value, ghost }] ; renvoie la valeur choisie.
function dialog(title, bodyHtml, buttons) {
  return new Promise((resolve) => {
    const d = $('dialog');
    $('dialog-title').textContent = title;
    $('dialog-body').innerHTML = bodyHtml;
    const bar = $('dialog-buttons');
    bar.innerHTML = '';
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      if (b.ghost) btn.className = 'ghost';
      btn.addEventListener('click', () => { if (b.keepOpen) { b.onClick?.(); return; } d.close(); resolve(b.value); });
      bar.appendChild(btn);
    }
    d.oncancel = () => resolve(null);
    d.showModal();
  });
}
const alertDialog = (title, html) => dialog(title, html, [{ label: 'OK', value: true }]);

// ---------------------------------------------------------------------------------------------
// Connexion
async function openTransport(fresh) {
  if (app.demo) {
    if (!app.sim) app.sim = createSimulatedTx({ latency: 30 });
    return app.sim.state.connected ? app.sim.transport : app.sim.reconnect();
  }
  if (!isWebBluetoothAvailable()) throw new Error('Web Bluetooth indisponible dans ce navigateur.');
  if (fresh || !app.device) app.device = await requestEdsDevice();
  return connectTransport(app.device, log);
}

// Garantit une session prête (clé obtenue + données lues). `fresh` : forcer le choix d'un appareil.
async function ensureConnected({ fresh = false } = {}) {
  if (app.session?.connected && app.session.key !== null && !fresh) return app.session;
  setStatus('Connexion…', 'busy');
  const transport = await openTransport(fresh);
  app.userDisconnect = false;
  const session = new EdsSession(transport, { log });
  app.session = session;
  app.deviceName = transport.name;
  session.on(onSessionEvent);
  await session.handshake();
  await readState();
  return session;
}

async function readState() {
  const r = await app.session.readAll({ onProgress: (n, t) => setProgress(`Lecture des données ${n}/${t}…`) });
  setProgress(null);
  if (app.deviceName !== DEVICE_NAME_TX) {
    app.state = null;
    renderAll();
    throw new Error(`Matériel détecté : « ${app.deviceName} ». Cette appli ne gère que l’EDS TX : aucune écriture ne sera faite.`);
  }
  if (!r.state) {
    app.state = null;
    renderAll();
    throw new Error(`Données du dérailleur illisibles : ${r.stateError}`);
  }
  app.state = r.state;
  app.liveNum = r.state.num;
  app.liveChainring = r.state.chainring;
  app.batteries = { rd: r.state.power.rd, fd: r.state.power.fd, left: r.state.power.left, right: r.state.power.right };
  storage.setLastState({ date: new Date().toISOString(), rear: r.state.rear, front: r.state.front, fw: r.state.versions.rd });
  renderAll();
  return r.state;
}

function onSessionEvent(evt) {
  if (evt.type === 'gear') { app.liveNum = evt.num; renderLive(); }
  if (evt.type === 'front') { app.liveChainring = evt.chainring; renderLive(); }
  if (evt.type === 'disconnect') {
    renderStatus();
    if (!app.userDisconnect) autoReconnect();
  }
}

// Reconnexion automatique (sans geste utilisateur, appareil déjà choisi). Ne relance JAMAIS une écriture :
// si une écriture a été interrompue, le bandeau propose de reprendre ou de restaurer.
let reconnecting = false;
async function autoReconnect() {
  if (reconnecting || (!app.device && !app.demo)) return;
  reconnecting = true;
  try {
    // Laisse l'opération en cours se terminer (elle échoue avec DisconnectedError)
    while (app.busy) await sleep(100);
    for (const delay of [1000, 3000, 6000]) {
      if (app.userDisconnect || app.session?.connected) break;
      setStatus(`Déconnecté. Nouvelle tentative dans ${delay / 1000} s…`, 'busy');
      await sleep(delay);
      try {
        await runExclusive(() => ensureConnected());
        log('Reconnecté');
        break;
      } catch (e) { log('Reconnexion échouée : ' + errorText(e)); }
    }
  } finally {
    reconnecting = false;
    renderStatus();
  }
}

// Exécute une opération en bloquant les boutons.
async function runExclusive(fn) {
  if (app.busy) throw new Error('Une opération est déjà en cours.');
  app.busy = true; renderButtons();
  try { return await fn(); } finally { app.busy = false; setProgress(null); renderButtons(); renderStatus(); }
}

// ---------------------------------------------------------------------------------------------
// Application d'un réglage (profil, vitesse unique, reprise, restauration)
async function applyFlow(label, target) {
  showResult(null);
  try {
    const result = await runExclusive(async () => {
      await ensureConnected();
      return applyRearValues({
        session: app.session,
        deviceName: app.deviceName,
        target,
        label,
        storage,
        settings: storage.getSettings(),
        onStep: (s) => setProgress(s),
        confirm: (changes, state) => confirmChanges(label, changes, state),
      });
    });
    if (result.after) { app.state = result.after; app.liveNum = result.after.num; }
    renderAll();
    showApplyResult(label, result);
    return result;
  } catch (e) {
    log('Erreur : ' + errorText(e));
    renderAll();
    showInterrupted(label, e);
    return null;
  }
}

async function confirmChanges(label, changes, state) {
  const items = changes.map((c) => `<li>Vitesse ${indexToGear(c.index, state.total)} : ${c.from} → <strong>${c.to}</strong> (${c.to - c.from > 0 ? '+' : ''}${c.to - c.from})</li>`).join('');
  const backupNow = { rear: state.rear, front: state.front };
  const choice = await dialog(`Écrire « ${label} » ?`,
    `<p>${changes.length} vitesse(s) vont être modifiées :</p><ul>${items}</ul>
     <p class="hint">Les valeurs actuelles seront sauvegardées dans l’appli avant l’écriture. Vous pouvez aussi télécharger cette sauvegarde maintenant.</p>`,
    [
      { label: 'Télécharger la sauvegarde', ghost: true, keepOpen: true, onClick: () => downloadBackup(backupNow, 'avant-' + label) },
      { label: 'Annuler', value: false, ghost: true },
      { label: 'Écrire', value: true },
    ]);
  return choice === true;
}

function showApplyResult(label, r) {
  const total = (r.after || r.before)?.total;
  if (r.status === 'cancelled') { showResult('warn', 'Annulé', '<p>Rien n’a été écrit.</p>'); return; }
  if (r.status === 'refused') {
    showResult('err', `Écriture refusée : ${esc(label)}`, `<ul>${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul><p>Rien n’a été écrit.</p>`);
    return;
  }
  if (r.status === 'ok' && r.unchanged) {
    showResult('ok', `✅ ${esc(label)} : déjà à jour`, '<p>Le dérailleur contient déjà exactement ces valeurs (relues et vérifiées). Aucune écriture.</p>');
    return;
  }
  const changed = `<ul>${r.changes.map((c) => `<li>Vitesse ${indexToGear(c.index, total)} : ${c.from} → ${c.to}</li>`).join('')}</ul>`;
  const backupBtn = `<div class="row"><button type="button" class="ghost" data-dl-backup="${esc(r.backup.id)}">Télécharger la sauvegarde d’avant</button></div>`;
  if (r.status === 'ok') {
    const engaged = r.engagedChanged
      ? '<p><strong>La vitesse engagée a été modifiée</strong> : utilisez « Preview » (écran Test) pour que le dérailleur se repositionne.</p>' : '';
    showResult('ok', `✅ ${esc(label)} : écrit et vérifié`, `<p>Toutes les vitesses relues sont conformes.</p>${changed}${engaged}${backupBtn}`);
  } else {
    const mm = r.mismatches.map((m) => `<li>Écart sur la vitesse ${m.gear} : attendu ${m.expected}, lu ${m.actual}</li>`).join('');
    showResult('warn', `⚠️ ${esc(label)} : écart après relecture`, `<ul>${mm}</ul>
      <p>L’écriture reste marquée « en attente » : vous pouvez réessayer ou restaurer la sauvegarde (bandeau en haut).</p>${backupBtn}`);
  }
}

function showInterrupted(label, e) {
  const p = e.partial;
  const pending = storage.getPending();
  let html = `<p>${esc(errorText(e))}</p>`;
  if (p) {
    html += `<p>${p.written.length} vitesse(s) sur ${p.changes.length} écrite(s) avant l’interruption.</p>`;
    if (pending) html += '<p>Dès la reconnexion, l’appli relit le dérailleur et vous propose de <strong>reprendre</strong> l’écriture ou de <strong>restaurer la sauvegarde</strong>.</p>';
  }
  showResult('err', `❌ ${esc(label)} : interrompu`, html);
}

function showResult(kind, title, html) {
  const el = $('result');
  if (!kind) { el.hidden = true; return; }
  el.className = `card result ${kind}`;
  el.innerHTML = `<h3>${title}</h3>${html}`;
  el.hidden = false;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function downloadBackup(b, suffix) {
  const name = exportFileName().replace('.json', `-${suffix.replace(/[^\w-]+/g, '_')}.json`);
  download(toDrEdsExport({ profiles: storage.data().profiles, current: { rear: b.rear, front: b.front }, backups: storage.listBackups(), settings: storage.getSettings() }), name);
}

// ---------------------------------------------------------------------------------------------
// Actions
async function onApplyProfile(name) {
  const p = storage.getProfile(name);
  if (!p) {
    await alertDialog(`Profil « ${name} » vide`, '<p>Réglez le dérailleur, puis utilisez « Mémoriser la position actuelle » pour remplir ce profil (ou importez un fichier).</p>');
    return;
  }
  await applyFlow(`Profil ${name}`, p.rear);
}

async function onMemorize() {
  const name = $('memo-profile').value;
  showResult(null);
  try {
    const state = await runExclusive(async () => { await ensureConnected(); return readState(); });
    const existing = storage.getProfile(name);
    const list = state.rear.map((v, i) => `${indexToGear(i + 1, state.total)}:${v}`).reverse().join(', ');
    if (existing) {
      const ok = await dialog(`Remplacer le profil « ${name} » ?`,
        `<p>Enregistré le ${fmtDate(existing.savedAt)}. Il sera remplacé par les valeurs actuelles du dérailleur :</p><p class="hint">${list}</p>`,
        [{ label: 'Annuler', value: false, ghost: true }, { label: 'Remplacer', value: true }]);
      if (!ok) return;
    }
    storage.setProfile(name, { rear: state.rear, front: state.front, fw: state.versions.rd });
    renderAll();
    showResult('ok', `✅ Profil « ${esc(name)} » mémorisé`, `<p class="hint">${esc(list)}${state.front ? `<br>Limites FD : ${state.front.join(', ')}` : ''}</p>`);
  } catch (e) {
    showResult('err', 'Lecture impossible', `<p>${esc(errorText(e))}</p>`);
  }
}

async function onWriteSingle(index, value) {
  const total = app.state.total;
  const gear = indexToGear(index, total);
  await applyFlow(`Vitesse ${gear}`, (fresh) => fresh.rear.map((v, i) => (i === index - 1 ? value : v)));
}

async function onPendingResume() {
  const p = storage.getPending();
  if (!p) return;
  await applyFlow(`Reprise : ${p.label}`, p.target);
  renderPending();
}
async function onPendingRestore() {
  const p = storage.getPending();
  const b = p && storage.getBackup(p.backupId);
  if (!b) { await alertDialog('Sauvegarde introuvable', '<p>La sauvegarde liée à cette écriture n’existe plus.</p>'); return; }
  const r = await applyFlow(`Restauration du ${fmtDate(b.date)}`, b.rear);
  if (r && r.status === 'ok') storage.clearPending();
  renderPending();
}
async function onPendingIgnore() {
  const ok = await dialog('Ignorer l’écriture interrompue ?', '<p>Le dérailleur garde ses valeurs actuelles (éventuellement à moitié modifiées). La sauvegarde reste disponible dans « Données ».</p>',
    [{ label: 'Annuler', value: false, ghost: true }, { label: 'Ignorer', value: true }]);
  if (ok) { storage.clearPending(); renderPending(); }
}

async function onRestoreBackup(id) {
  const b = storage.getBackup(id);
  if (!b) return;
  showScreen('profiles');
  await applyFlow(`Restauration du ${fmtDate(b.date)}`, b.rear);
}

async function shiftAndWait(fn) {
  const before = app.liveNum;
  const done = new Promise((resolve) => {
    const off = app.session.on((e) => { if (e.type === 'gear' && !e.moving) { off(); resolve(true); } });
    setTimeout(() => { off(); resolve(false); }, 3000);
  });
  await fn();
  const ok = await done;
  if (!ok) log(`Pas de confirmation de changement de vitesse (avant : ${before})`);
}

async function onShift(dir) {
  try {
    await runExclusive(async () => {
      await ensureConnected();
      await shiftAndWait(() => (dir === 'up' ? app.session.shiftUp() : app.session.shiftDown()));
    });
  } catch (e) { await alertDialog('Changement impossible', `<p>${esc(errorText(e))}</p>`); }
}

// Preview : aller-retour d'une vitesse (comme drEDS, functions.js:394-414)
async function onPreview() {
  try {
    await runExclusive(async () => {
      await ensureConnected();
      const atSmallest = app.liveNum === 1; // H_GEA[1] = plus petit pignon : impossible de monter
      const s = app.session;
      await shiftAndWait(() => (atSmallest ? s.shiftDown() : s.shiftUp()));
      await sleep(300);
      await shiftAndWait(() => (atSmallest ? s.shiftUp() : s.shiftDown()));
    });
  } catch (e) { await alertDialog('Preview impossible', `<p>${esc(errorText(e))}</p>`); }
}

async function onFront() {
  try {
    await runExclusive(async () => {
      await ensureConnected();
      if (!app.liveChainring) throw new Error('Position du dérailleur avant inconnue (FD absent ou endormi).');
      await app.session.shiftFront(app.liveChainring);
      await sleep(800);
    });
  } catch (e) { await alertDialog('Changement de plateau impossible', `<p>${esc(errorText(e))}</p>`); }
}

async function onBattery() {
  try {
    const b = await runExclusive(async () => { await ensureConnected(); return app.session.getBatteries(); });
    if (b) app.batteries = { rd: b.rd, fd: b.fd, left: b.leftShifter, right: b.rightShifter };
    renderBatteries();
  } catch (e) { log('Batteries : ' + errorText(e)); }
}

function onExport() {
  const current = app.state ? { rear: app.state.rear, front: app.state.front } : null;
  download(toDrEdsExport({ profiles: storage.data().profiles, current, backups: storage.listBackups(), settings: storage.getSettings() }), exportFileName());
}

async function onImportFile(file) {
  try {
    const imp = fromDrEdsImport(JSON.parse(await file.text()));
    const names = Object.keys(imp.profiles);
    const hasCurrent = !!imp.current;
    if (!names.length && !hasCurrent) throw new Error('Aucun réglage « EDS TX » dans ce fichier.');
    const overwrite = names.filter((n) => storage.getProfile(n));
    const choice = await dialog('Importer ?',
      `<p>Profils/préréglages trouvés : ${names.length ? names.map(esc).join(', ') : 'aucun'}.</p>
       ${overwrite.length ? `<p><strong>Seront remplacés :</strong> ${overwrite.map(esc).join(', ')}</p>` : ''}
       ${hasCurrent ? '<p>Le fichier contient aussi des « valeurs actuelles » : elles seront importées comme profil « drEDS (actuel) ».</p>' : ''}
       ${imp.ignoredDevices.length ? `<p class="hint">Ignorés (autre matériel) : ${imp.ignoredDevices.map(esc).join(', ')}</p>` : ''}
       <p class="hint">Rien n’est envoyé au dérailleur.</p>`,
      [{ label: 'Annuler', value: false, ghost: true }, { label: 'Importer', value: true }]);
    if (!choice) return;
    const profiles = { ...imp.profiles };
    if (hasCurrent) profiles['drEDS (actuel)'] = { ...imp.current, note: 'importé (valeurs actuelles)' };
    storage.mergeImport({ profiles, backups: imp.backups });
    renderAll();
    await alertDialog('Import terminé', `<p>${Object.keys(profiles).length} profil(s) importé(s).</p>`);
  } catch (e) {
    await alertDialog('Import impossible', `<p>${esc(errorText(e))}</p>`);
  }
}

async function onCopyProfile(from) {
  const to = await dialog(`Copier « ${from} » vers…`, '<p>Le profil de destination sera remplacé.</p>',
    [...PROFILE_NAMES.filter((n) => n !== from).map((n) => ({ label: n, value: n })), { label: 'Annuler', value: null, ghost: true }]);
  if (!to) return;
  const p = storage.getProfile(from);
  storage.setProfile(to, { ...p, note: `copié de ${from}` });
  renderAll();
}
async function onDeleteProfile(name) {
  const ok = await dialog(`Supprimer « ${name} » ?`, '', [{ label: 'Annuler', value: false, ghost: true }, { label: 'Supprimer', value: true }]);
  if (ok) { storage.deleteProfile(name); renderAll(); }
}

// ---------------------------------------------------------------------------------------------
// Rendu
function setStatus(text, kind) {
  $('status-text').textContent = text;
  $('status-dot').className = 'dot ' + (kind || '');
}
function setProgress(text) {
  const el = $('progress');
  el.hidden = !text;
  el.textContent = text || '';
}
function renderStatus() {
  const connected = app.session?.connected;
  if (app.busy) setStatus('Opération en cours…', 'busy');
  else if (connected) setStatus(`Connecté : ${app.deviceName}`, 'on');
  else setStatus(reconnecting ? 'Reconnexion…' : 'Non connecté', reconnecting ? 'busy' : '');
  const s = app.state;
  $('status-details').textContent = s
    ? `RD firmware ${s.versions.rd ?? '?'} · ${s.total} vitesses · vitesse engagée ${app.liveNum ? indexToGear(app.liveNum, s.total) : '?'}`
    : (app.deviceName && app.deviceName !== DEVICE_NAME_TX ? `Matériel non pris en charge : ${app.deviceName}` : '');
  $('btn-connect').textContent = connected ? 'Déconnecter' : 'Connecter';
}
function renderButtons() {
  document.querySelectorAll('main button, #pending-banner button, #btn-connect').forEach((b) => {
    if (b.id === 'btn-export' || b.id === 'btn-import' || b.id === 'btn-copy-log' || b.dataset.dlBackup) return;
    b.disabled = app.busy;
  });
}
function renderProfilesInfo() {
  for (const n of PROFILE_NAMES) {
    const p = storage.getProfile(n);
    $(`info-${n}`).textContent = p ? `mémorisé le ${fmtDate(p.savedAt)}` : 'vide';
  }
}
function renderPending() {
  const p = storage.getPending();
  $('pending-banner').hidden = !p;
  if (p) $('pending-text').innerHTML = `<strong>Écriture interrompue</strong> : « ${esc(p.label)} » (${fmtDate(p.startedAt)}). Le dérailleur est peut-être à moitié écrit.`;
}
function renderGears() {
  const body = $('gears-body');
  const s = app.state;
  if (!s) { body.innerHTML = '<tr><td colspan="5" class="hint">Connectez-vous pour lire les valeurs.</td></tr>'; $('front-values').textContent = ''; return; }
  const roue = storage.getProfile('Roue');
  const trainer = storage.getProfile('Trainer');
  let html = '';
  for (let gear = 1; gear <= s.total; gear++) {
    const idx = gearToIndex(gear, s.total);
    const v = s.rear[idx - 1];
    const cell = (p) => {
      if (!p || p.rear.length !== s.total) return '<td class="prof hint">–</td>';
      const pv = p.rear[idx - 1];
      return `<td class="prof ${pv !== v ? 'diff' : ''}">${pv}</td>`;
    };
    html += `<tr>
      <td class="num ${idx === app.liveNum ? 'engaged' : ''}">${gear}${idx === app.liveNum ? ' ●' : ''}</td>
      <td><div class="stepper"><button type="button" data-step="-1" data-idx="${idx}">−</button><input type="number" inputmode="numeric" data-idx="${idx}" data-orig="${v}" value="${v}"><button type="button" data-step="1" data-idx="${idx}">+</button></div></td>
      <td><button type="button" class="write" data-write="${idx}">Écrire</button></td>
      ${cell(roue)}${cell(trainer)}</tr>`;
  }
  body.innerHTML = html;
  $('front-values').textContent = s.front ? `Limites du dérailleur avant (lecture seule, enregistrées dans les profils) : ${s.front.join(', ')}` : 'Limites du dérailleur avant : non disponibles.';
  renderButtons();
}
function renderLive() {
  const s = app.state;
  $('live-gear').textContent = s && app.liveNum ? indexToGear(app.liveNum, s.total) : '–';
  $('live-total').textContent = s ? ` / ${s.total}` : '';
  $('live-chainring').textContent = app.liveChainring === 1 ? 'Grand plateau' : app.liveChainring === 2 ? 'Petit plateau' : '';
  document.querySelectorAll('#gears-body td.num').forEach((td, i) => {
    if (!s) return;
    const idx = gearToIndex(i + 1, s.total);
    td.classList.toggle('engaged', idx === app.liveNum);
    td.textContent = `${i + 1}${idx === app.liveNum ? ' ●' : ''}`;
  });
  renderStatus();
}
function renderBatteries() {
  const b = app.batteries;
  const items = [['Dérailleur arrière', b?.rd, true], ['Dérailleur avant', b?.fd, true], ['Manette gauche', b?.left, false], ['Manette droite', b?.right, false]];
  $('batteries').innerHTML = items.map(([label, v, isPack]) => {
    let txt = '–', pct = '';
    if (Number.isFinite(v) && v > 0) {
      txt = (v / 100).toFixed(2) + ' V';
      // Estimation grossière pour les batteries 2S (6,9 V ≈ vide, 8,2 V ≈ plein)
      if (isPack) pct = ` · ≈${Math.round(Math.max(0, Math.min(1, (v - 690) / 130)) * 100)}\u00a0%`;
    }
    return `<div class="battery"><div class="v">${txt}</div><div class="l">${label}${pct}</div></div>`;
  }).join('');
}
function renderDataLists() {
  const profiles = storage.data().profiles;
  const names = Object.keys(profiles);
  $('profiles-list').innerHTML = names.length ? names.map((n) => {
    const p = profiles[n];
    return `<div class="list-item"><div><strong>${esc(n)}</strong><div class="meta">${p.rear.length} vitesses · ${fmtDate(p.savedAt)}${p.fw ? ' · FW ' + esc(p.fw) : ''}${p.note ? ' · ' + esc(p.note) : ''}</div>
      <div class="meta">${[...p.rear].reverse().join(' · ')}</div></div>
      <div class="row"><button type="button" class="ghost" data-copy="${esc(n)}">Copier vers…</button><button type="button" class="ghost" data-del="${esc(n)}">Supprimer</button></div></div>`;
  }).join('') : '<p class="hint">Aucun profil.</p>';
  const backups = storage.listBackups();
  $('backups-list').innerHTML = backups.length ? backups.map((b) => `<div class="list-item"><div><strong>${fmtDate(b.date)}</strong><div class="meta">${esc(b.reason)}</div>
      <div class="meta">${[...b.rear].reverse().join(' · ')}</div></div>
      <div class="row"><button type="button" class="ghost" data-dl-backup="${esc(b.id)}">Télécharger</button><button type="button" data-restore="${esc(b.id)}">Restaurer</button></div></div>`).join('')
    : '<p class="hint">Aucune sauvegarde pour l’instant.</p>';
  renderButtons();
}
function renderAll() {
  renderStatus(); renderProfilesInfo(); renderPending(); renderGears(); renderLive(); renderBatteries(); renderDataLists(); renderButtons();
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== `screen-${name}`; });
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.screen === name));
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------------------------
// Événements
function bind() {
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showScreen(b.dataset.screen)));
  document.querySelectorAll('[data-apply]').forEach((b) => b.addEventListener('click', () => onApplyProfile(b.dataset.apply)));

  $('btn-connect').addEventListener('click', async () => {
    if (app.session?.connected) { app.userDisconnect = true; await app.session.disconnect(); renderAll(); return; }
    try { await runExclusive(() => ensureConnected({ fresh: true })); } catch (e) { setStatus('Non connecté'); await alertDialog('Connexion impossible', `<p>${esc(errorText(e))}</p>`); }
  });
  $('btn-memorize').addEventListener('click', onMemorize);
  $('btn-read').addEventListener('click', async () => {
    try { await runExclusive(async () => { await ensureConnected(); await readState(); }); } catch (e) { await alertDialog('Lecture impossible', `<p>${esc(errorText(e))}</p>`); }
  });
  $('gears-body').addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.dataset.step) {
      const input = document.querySelector(`#gears-body input[data-idx="${t.dataset.idx}"]`);
      input.value = Math.max(0, (parseInt(input.value, 10) || 0) + Number(t.dataset.step));
      input.classList.toggle('changed', input.value !== input.dataset.orig);
    } else if (t.dataset.write) {
      const idx = Number(t.dataset.write);
      const input = document.querySelector(`#gears-body input[data-idx="${idx}"]`);
      const v = Number(input.value);
      if (!Number.isInteger(v)) { alertDialog('Valeur invalide', '<p>Entrez un nombre entier.</p>'); return; }
      onWriteSingle(idx, v);
    }
  });
  $('gears-body').addEventListener('input', (ev) => { if (ev.target.dataset.orig) ev.target.classList.toggle('changed', ev.target.value !== ev.target.dataset.orig); });

  $('btn-up').addEventListener('click', () => onShift('up'));
  $('btn-down').addEventListener('click', () => onShift('down'));
  $('btn-preview').addEventListener('click', onPreview);
  $('btn-front').addEventListener('click', onFront);
  $('btn-battery').addEventListener('click', onBattery);

  $('btn-pending-resume').addEventListener('click', onPendingResume);
  $('btn-pending-restore').addEventListener('click', onPendingRestore);
  $('btn-pending-ignore').addEventListener('click', onPendingIgnore);

  $('btn-export').addEventListener('click', onExport);
  $('btn-import').addEventListener('click', () => $('file-import').click());
  $('file-import').addEventListener('change', (ev) => { const f = ev.target.files[0]; ev.target.value = ''; if (f) onImportFile(f); });

  document.body.addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.dataset.dlBackup) { const b = storage.getBackup(t.dataset.dlBackup); if (b) downloadBackup(b, 'sauvegarde'); }
    if (t.dataset.restore) onRestoreBackup(t.dataset.restore);
    if (t.dataset.copy) onCopyProfile(t.dataset.copy);
    if (t.dataset.del) onDeleteProfile(t.dataset.del);
  });

  const maxd = $('set-maxdelta');
  maxd.value = storage.getSettings().maxDelta;
  maxd.addEventListener('change', () => {
    const v = Math.max(10, Math.min(1000, parseInt(maxd.value, 10) || 150));
    maxd.value = v; storage.setSettings({ maxDelta: v });
  });

  $('set-demo').checked = app.demo;
  $('set-demo').addEventListener('change', async (ev) => {
    if (app.session?.connected) { app.userDisconnect = true; await app.session.disconnect(); }
    app.demo = ev.target.checked;
    localStorage.setItem('wheeltop.demo', app.demo ? '1' : '0');
    app.state = null; app.session = null; app.deviceName = null;
    applyEnvBanners(); renderAll();
  });
  $('set-log').addEventListener('change', (ev) => { $('log-wrap').hidden = !ev.target.checked; log('Journal affiché'); });
  $('btn-copy-log').addEventListener('click', () => navigator.clipboard?.writeText(app.logLines.join('\n')));
}

function applyEnvBanners() {
  $('demo-banner').hidden = !app.demo;
  $('nobt-banner').hidden = app.demo || isWebBluetoothAvailable();
}

bind();
applyEnvBanners();
renderAll();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

// Exposé pour le débogage depuis la console
window.wheeltop = { app, storage, validateTarget };
