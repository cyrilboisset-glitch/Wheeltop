// Transport Bluetooth pour l'APK Android : la WebView n'a pas Web Bluetooth, le BLE est fourni
// par le code Kotlin (android/app/src/main/java/.../BleBridge.kt) exposé en `window.WheeltopAndroid`.
// Même interface que web-bluetooth.js : { name, write, onData, onDisconnect, disconnect }.

const pending = new Map();
let seq = 0;
let dataCbs = [];
let discCbs = [];
const lifecycleCbs = [];

// cb('background' | 'foreground') : l'activité Android passe en arrière-plan / revient.
export function onAndroidLifecycle(cb) { lifecycleCbs.push(cb); }

export const isAndroidBridge = () => typeof window !== 'undefined' && !!window.WheeltopAndroid;

function toB64(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function fromB64(b64) { const s = atob(b64); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }

// Appelé par le code natif avec une chaîne JSON
if (typeof window !== 'undefined') {
  window.__wheeltopNative = (json) => {
    const e = JSON.parse(json);
    if (e.type === 'result') {
      const p = pending.get(e.id);
      if (!p) return;
      pending.delete(e.id);
      if (e.ok) p.resolve(e);
      else p.reject(Object.assign(new Error(e.error || 'Erreur Bluetooth'), { name: e.code || 'Error' }));
    } else if (e.type === 'data') {
      const bytes = fromB64(e.b64);
      dataCbs.forEach((cb) => cb(bytes));
    } else if (e.type === 'lifecycle') {
      lifecycleCbs.forEach((cb) => cb(e.state));
    } else if (e.type === 'disconnect') {
      // Toute requête en cours échoue
      for (const [id, p] of pending) { pending.delete(id); p.reject(Object.assign(new Error('GATT déconnecté'), { name: 'NetworkError' })); }
      discCbs.forEach((cb) => cb());
    }
  };
}

function call(method, ...args) {
  return new Promise((resolve, reject) => {
    const id = String(++seq);
    pending.set(id, { resolve, reject });
    try { window.WheeltopAndroid[method](id, ...args); } catch (err) { pending.delete(id); reject(err); }
  });
}

// fresh = true : ouvre la liste des dérailleurs ; sinon reconnecte le dernier choisi.
export async function connectAndroid({ fresh }) {
  const r = await call(fresh ? 'requestDevice' : 'reconnect');
  dataCbs = [];
  discCbs = [];
  return {
    name: r.name,
    write: (bytes) => call('write', toB64(bytes)),
    onData: (cb) => dataCbs.push(cb),
    onDisconnect: (cb) => discCbs.push(cb),
    disconnect: async () => window.WheeltopAndroid.disconnect(),
  };
}

// Enregistre un fichier dans Téléchargements ; renvoie un message à afficher.
export function saveFileAndroid(name, text) {
  return window.WheeltopAndroid.saveFile(name, text);
}
