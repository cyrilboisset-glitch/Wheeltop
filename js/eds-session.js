// Session avec un dérailleur EDS, indépendante du transport (Web Bluetooth, simulateur, Kotlin...).
//
// Un "transport" doit fournir :
//   name                       nom BLE annoncé (ex. "EDS TX")
//   async write(Uint8Array)    envoi d'une trame
//   onData(cb)                 cb(Uint8Array) à chaque notification
//   onDisconnect(cb)           cb() quand le lien tombe
//   async disconnect()
//
// Toutes les commandes passent par une file : une seule requête en vol à la fois.

import {
  CMD, frames, parseFrame, parseStartReadReply, decodeReadBlock, parseInfoText, extractTxState,
  isSetGearAccepted, parseServerReportGear, parseFrontStatusReport, parseTransmissionInfo, parseFdValues,
  REAR_UP, REAR_DOWN,
} from './protocol.js';

export class DisconnectedError extends Error {
  constructor() { super('Dérailleur déconnecté'); this.name = 'DisconnectedError'; }
}
export class TimeoutError extends Error {
  constructor(what) { super(`Pas de réponse du dérailleur (${what})`); this.name = 'TimeoutError'; }
}

export const TIMEOUTS = { getKey: 3000, startRead: 3000, block: 3000, setGear: 2000, optional: 2000 };

export class EdsSession {
  constructor(transport, { log = () => {} } = {}) {
    this.transport = transport;
    this.log = log;
    this.key = null;
    this.connected = true;
    this.listeners = new Set(); // événements spontanés : { type: 'gear'|'front'|'disconnect', ... }
    this.waiter = null; // { match(evt) -> bool, resolve, reject, timer }
    this.queue = Promise.resolve();
    transport.onData((bytes) => this._onData(bytes));
    transport.onDisconnect(() => this._onDisconnect());
  }

  on(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  _emit(evt) { for (const cb of this.listeners) { try { cb(evt); } catch (e) { this.log('listener: ' + e.message); } } }

  _onDisconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.key = null;
    this.log('Déconnecté');
    if (this.waiter) { const w = this.waiter; this.waiter = null; clearTimeout(w.timer); w.reject(new DisconnectedError()); }
    this._emit({ type: 'disconnect' });
  }

  _onData(bytes) {
    const frame = parseFrame(bytes);
    const evt = frame ? { kind: 'frame', ...frame } : { kind: 'raw', bytes };
    this.log((frame ? `← cmd 0x${frame.cmd.toString(16)} ` : '← bloc ') + hex(bytes));

    if (frame && frame.cmd === CMD.SERVER_REPORT_GEAR) {
      const g = parseServerReportGear(frame.payload);
      if (g) this._emit({ type: 'gear', ...g });
    } else if (frame && frame.cmd === CMD.FRONT_STATUS_REPORT) {
      const f = parseFrontStatusReport(frame.payload);
      if (f) this._emit({ type: 'front', ...f });
    }
    if (this.waiter && this.waiter.match(evt)) {
      const w = this.waiter; this.waiter = null; clearTimeout(w.timer); w.resolve(evt);
    }
  }

  // Envoie une trame et attend l'événement qui satisfait `match`.
  async _request(bytes, match, timeoutMs, what) {
    if (!this.connected) throw new DisconnectedError();
    const p = new Promise((resolve, reject) => {
      this.waiter = { match, resolve, reject, timer: setTimeout(() => { this.waiter = null; reject(new TimeoutError(what)); }, timeoutMs) };
    });
    this.log(`→ ${what} ${hex(bytes)}`);
    try {
      await this.transport.write(bytes);
    } catch (e) {
      if (this.waiter) { clearTimeout(this.waiter.timer); this.waiter = null; }
      throw this.connected ? e : new DisconnectedError();
    }
    return p;
  }

  _replyTo(cmd) { return (e) => e.kind === 'frame' && e.cmd === cmd; }

  // Exécute fn en exclusivité (file d'attente).
  exclusive(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // Envoi sans attente de réponse spécifique (changements de vitesse).
  async _send(bytes, what) {
    if (!this.connected) throw new DisconnectedError();
    this.log(`→ ${what} ${hex(bytes)}`);
    await this.transport.write(bytes);
  }

  // --- Commandes ---------------------------------------------------------------------------
  handshake() {
    return this.exclusive(async () => {
      const r = await this._request(frames.getKey(), this._replyTo(CMD.GET_KEY), TIMEOUTS.getKey, 'getKey');
      this.key = r.key;
      this.log(`Clé de session : 0x${this.key.toString(16)}`);
      return this.key;
    });
  }

  _needKey() { if (this.key === null) throw new Error('Pas de clé de session (handshake non fait)'); }

  // Lit tous les blocs d'information et renvoie { text, info, state }.
  // `state` est null si le texte n'a pas le format TX (stateError explique pourquoi).
  readAll({ onProgress = () => {} } = {}) {
    return this.exclusive(async () => {
      this._needKey();
      const r = await this._request(frames.startRead(this.key), this._replyTo(CMD.START_READ), TIMEOUTS.startRead, 'startRead');
      const blocks = parseStartReadReply(r.payload);
      if (blocks < 1 || blocks > 200) throw new Error(`nombre de blocs incohérent : ${blocks}`);
      let text = '';
      for (let n = 0; n < blocks; n++) {
        onProgress(n + 1, blocks);
        // Les blocs sont de l'ASCII brut, pas des trames [PA:63]
        const b = await this._request(frames.readBlock(this.key, n), (e) => e.kind === 'raw', TIMEOUTS.block, `read ${n + 1}/${blocks}`);
        text += decodeReadBlock(b.bytes);
      }
      const info = parseInfoText(text);
      let state = null, stateError = null;
      try { state = extractTxState(info); } catch (e) { stateError = e.message; }

      // Bug TX : limites FD souvent absentes, on les redemande [PA:104]
      if (state && !state.front) {
        try {
          const f = await this._request(frames.getFdValues(this.key), this._replyTo(CMD.GET_FD_RD_VALUES), TIMEOUTS.optional, 'getFdValues');
          state.front = parseFdValues(f.payload);
        } catch (e) {
          if (e instanceof DisconnectedError) throw e;
          this.log('Limites FD non disponibles : ' + e.message);
        }
      }
      return { text, info, state, stateError };
    });
  }

  // Écrit la valeur d'une vitesse (index H_GEA). Une seule nouvelle tentative en cas d'absence
  // de réponse : l'écriture est absolue, donc la répéter ne change rien au résultat.
  setGearValue(index, value) {
    return this.exclusive(async () => {
      this._needKey();
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await this._request(frames.setGearValue(this.key, index, value), this._replyTo(CMD.SET_GEAR_VALUE), TIMEOUTS.setGear, `setGear H_GEA[${index}]=${value}`);
          if (!isSetGearAccepted(r.payload)) throw new Error(`Le dérailleur a refusé la valeur de H_GEA[${index}] (code ${r.payload[0]})`);
          return;
        } catch (e) {
          if (e instanceof TimeoutError && attempt < 2) { this.log('Pas de réponse, nouvelle tentative'); continue; }
          throw e;
        }
      }
    });
  }

  getBatteries() {
    return this.exclusive(async () => {
      this._needKey();
      const r = await this._request(frames.getTransmissionInfo(this.key), this._replyTo(CMD.GET_TRANSMISSION_INFO), TIMEOUTS.optional, 'getTransmissionInfo');
      return parseTransmissionInfo(r.payload);
    });
  }

  shiftUp() { return this.exclusive(async () => { this._needKey(); await this._send(frames.rearShift(this.key, REAR_UP), 'monter'); }); }
  shiftDown() { return this.exclusive(async () => { this._needKey(); await this._send(frames.rearShift(this.key, REAR_DOWN), 'descendre'); }); }
  shiftFront(currentChainring) { return this.exclusive(async () => { this._needKey(); await this._send(frames.frontShift(this.key, currentChainring), 'plateau'); }); }

  async disconnect() {
    try { await this.transport.disconnect(); } finally { this._onDisconnect(); }
  }
}

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}
