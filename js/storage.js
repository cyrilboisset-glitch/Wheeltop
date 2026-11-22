// Stockage local (localStorage) + conversion vers/depuis le format d'export drEDS.
//
// Format drEDS (js/functions.js:1858-1897 du dépôt d'origine) :
// { debug, page, battery, lock,
//   current: { device: "EDS TX", rear: [{gear:"1", value:"0"}, ...], front: [...] },
//   gears:   { "EDS TX": { "<préréglage>": { rear: [...], front: [...] } } } }
// "gear" est l'indice H_GEA (chaîne), "value" la valeur (chaîne).
import { DEVICE_NAME_TX } from './protocol.js';
import { DEFAULT_SETTINGS } from './tuning.js';

const STORAGE_KEY = 'wheeltop.v1';
const MAX_BACKUPS = 30;
export const PROFILE_NAMES = ['Roue', 'Trainer'];

function emptyData() {
  return { profiles: {}, backups: [], settings: { ...DEFAULT_SETTINGS }, pending: null, lastState: null };
}

// `backend` : objet { getItem, setItem } (localStorage dans le navigateur, Map simulée en test).
export function createStorage(backend) {
  let data = emptyData();
  try {
    const raw = backend.getItem(STORAGE_KEY);
    if (raw) data = { ...emptyData(), ...JSON.parse(raw) };
  } catch { /* stockage illisible : on repart à vide */ }
  data.settings = { ...DEFAULT_SETTINGS, ...data.settings };

  const save = () => backend.setItem(STORAGE_KEY, JSON.stringify(data));

  return {
    data: () => data,
    getProfile: (name) => data.profiles[name] ?? null,
    listProfiles: () => Object.keys(data.profiles),
    setProfile(name, { rear, front = null, fw = null, note = '' }) {
      data.profiles[name] = { rear: [...rear], front: front ? [...front] : null, fw, note, savedAt: new Date().toISOString() };
      save();
    },
    deleteProfile(name) { delete data.profiles[name]; save(); },
    addBackup({ reason, device, rear, front = null, fw = null }) {
      const b = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date: new Date().toISOString(), reason, device, rear: [...rear], front: front ? [...front] : null, fw };
      data.backups.unshift(b);
      data.backups = data.backups.slice(0, MAX_BACKUPS);
      save();
      return b;
    },
    listBackups: () => data.backups,
    getBackup: (id) => data.backups.find((b) => b.id === id) ?? null,
    getPending: () => data.pending,
    setPending(p) { data.pending = p; save(); },
    clearPending() { data.pending = null; save(); },
    getSettings: () => data.settings,
    setSettings(s) { data.settings = { ...data.settings, ...s }; save(); },
    setLastState(s) { data.lastState = s; save(); },
    getLastState: () => data.lastState,
    // Fusionne un import (profils écrasés si même nom)
    mergeImport({ profiles, backups = [] }) {
      for (const [name, p] of Object.entries(profiles)) {
        data.profiles[name] = { ...p, savedAt: p.savedAt ?? new Date().toISOString() };
      }
      const known = new Set(data.backups.map((b) => b.id));
      for (const b of backups) if (b && b.id && !known.has(b.id)) data.backups.push(b);
      data.backups.sort((a, b) => (a.date < b.date ? 1 : -1));
      data.backups = data.backups.slice(0, MAX_BACKUPS);
      save();
    },
  };
}

// --- Export / import au format drEDS ------------------------------------------------------------
const toItems = (values) => values.map((v, i) => ({ gear: String(i + 1), value: String(v) }));

function fromItems(items, what) {
  if (!Array.isArray(items)) throw new Error(`${what} : liste attendue`);
  const sorted = items.map((it) => ({ g: parseInt(it.gear, 10), v: Number(it.value) }));
  sorted.sort((a, b) => a.g - b.g);
  sorted.forEach((it, i) => {
    if (it.g !== i + 1) throw new Error(`${what} : indices de vitesse non continus`);
    if (!Number.isInteger(it.v) || it.v < 0 || it.v > 0xffff) throw new Error(`${what} : valeur invalide (${it.v})`);
  });
  return sorted.map((it) => it.v);
}

// `current` : { rear, front } lues sur le dérailleur (ou null) ; `extra` : données propres à Wheeltop.
export function toDrEdsExport({ profiles, current = null, backups = [], settings = null }) {
  const gears = { [DEVICE_NAME_TX]: {} };
  for (const [name, p] of Object.entries(profiles)) {
    gears[DEVICE_NAME_TX][name] = { rear: toItems(p.rear), front: p.front ? toItems(p.front) : [] };
  }
  const out = { debug: false, page: 'settings', battery: null, lock: null };
  if (current) out.current = { device: DEVICE_NAME_TX, rear: toItems(current.rear), front: current.front ? toItems(current.front) : [] };
  out.gears = gears;
  // Clé supplémentaire ignorée par drEDS (son import ne lit que les clés qu'il connaît)
  out.wheeltop = { version: 1, backups, settings, profilesMeta: Object.fromEntries(Object.entries(profiles).map(([n, p]) => [n, { savedAt: p.savedAt, fw: p.fw, note: p.note }])) };
  return out;
}

// Retourne { profiles, current, backups, ignoredDevices } ; lève une erreur si le fichier est invalide.
export function fromDrEdsImport(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Fichier JSON invalide');
  const profiles = {};
  const ignoredDevices = [];
  if (obj.gears && typeof obj.gears === 'object') {
    for (const [device, presets] of Object.entries(obj.gears)) {
      if (device !== DEVICE_NAME_TX) { ignoredDevices.push(device); continue; }
      for (const [name, p] of Object.entries(presets ?? {})) {
        const rear = fromItems(p.rear, `Préréglage « ${name} »`);
        const front = Array.isArray(p.front) && p.front.length ? fromItems(p.front, `Préréglage « ${name} » (avant)`) : null;
        const meta = obj.wheeltop?.profilesMeta?.[name] ?? {};
        profiles[name] = { rear, front, fw: meta.fw ?? null, note: meta.note ?? 'importé', savedAt: meta.savedAt };
      }
    }
  }
  let current = null;
  if (obj.current && obj.current.device === DEVICE_NAME_TX && Array.isArray(obj.current.rear) && obj.current.rear.length) {
    current = {
      rear: fromItems(obj.current.rear, 'Valeurs actuelles'),
      front: Array.isArray(obj.current.front) && obj.current.front.length ? fromItems(obj.current.front, 'Valeurs actuelles (avant)') : null,
    };
  } else if (obj.current?.device && obj.current.device !== DEVICE_NAME_TX) {
    ignoredDevices.push(obj.current.device);
  }
  const backups = Array.isArray(obj.wheeltop?.backups) ? obj.wheeltop.backups : [];
  return { profiles, current, backups, ignoredDevices: [...new Set(ignoredDevices)] };
}

export function exportFileName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `drEDS-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
}
