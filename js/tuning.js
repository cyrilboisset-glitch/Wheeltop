// Logique de réglage : validation, sauvegarde automatique, écriture, relecture et comparaison.
// Indépendante de l'interface (utilisable depuis des tests ou une future appli native).
import { DEVICE_NAME_TX, MAX_GEAR_VALUE, indexToGear } from './protocol.js';

export const DEFAULT_SETTINGS = Object.freeze({
  maxDelta: 150, // écart maximal autorisé (en pas) entre la valeur actuelle et la nouvelle
});

// Vérifie qu'on a le droit d'écrire `target` (tableau rear, rear[i-1] = H_GEA[i]).
export function validateTarget({ deviceName, state, target, settings = DEFAULT_SETTINGS }) {
  const errors = [];
  if (deviceName !== DEVICE_NAME_TX) {
    errors.push(`Matériel détecté : « ${deviceName} ». Cette appli n’écrit que dans un EDS TX.`);
    return errors;
  }
  if (!state) { errors.push('Les données lues ne correspondent pas à un EDS TX complet.'); return errors; }
  if (!Array.isArray(target) || target.length !== state.total) {
    errors.push(`Le profil contient ${target?.length ?? 0} vitesses, le dérailleur en a ${state.total}. ` +
      'Écriture refusée : cette appli ne modifie jamais le nombre de vitesses.');
    return errors;
  }
  target.forEach((v, i) => {
    if (!Number.isInteger(v) || v < 0 || v > MAX_GEAR_VALUE) {
      errors.push(`Vitesse ${indexToGear(i + 1, state.total)} : valeur invalide (${v}).`);
    }
  });
  if (errors.length) return errors;
  for (let i = 1; i < target.length; i++) {
    if (target[i] <= target[i - 1]) {
      errors.push(`Les valeurs doivent augmenter du plus petit au plus grand pignon : ` +
        `vitesse ${indexToGear(i + 1, state.total)} (${target[i]}) ≤ vitesse ${indexToGear(i, state.total)} (${target[i - 1]}).`);
    }
  }
  target.forEach((v, i) => {
    const d = Math.abs(v - state.rear[i]);
    if (d > settings.maxDelta) {
      errors.push(`Vitesse ${indexToGear(i + 1, state.total)} : écart de ${d} pas avec la valeur actuelle ` +
        `(${state.rear[i]} → ${v}), au-delà de la limite de sécurité (${settings.maxDelta}).`);
    }
  });
  return errors;
}

export function diffValues(current, target) {
  const out = [];
  target.forEach((v, i) => { if (v !== current[i]) out.push({ index: i + 1, from: current[i], to: v }); });
  return out;
}

export function compareValues(expected, actual) {
  const total = expected.length;
  const out = [];
  expected.forEach((v, i) => {
    if (actual[i] !== v) out.push({ index: i + 1, gear: indexToGear(i + 1, total), expected: v, actual: actual[i] });
  });
  return out;
}

// Applique des valeurs arrière. Étapes : lecture -> validation -> sauvegarde -> écriture des
// seules vitesses modifiées -> relecture -> comparaison.
// `target` : tableau, ou fonction (étatLu) -> tableau (pour partir des valeurs fraîchement lues).
// `confirm` : async (changes, state) -> bool, appelée après validation et avant toute écriture.
// Retourne { status: 'ok' | 'mismatch' | 'refused' | 'cancelled', ... }.
// En cas de déconnexion/délai dépassé, l'erreur est relancée avec err.partial = { written, backup }
// et l'opération reste marquée « en attente » dans le stockage pour être reprise ou annulée.
export async function applyRearValues({ session, deviceName, target, label, storage, settings = DEFAULT_SETTINGS, onStep = () => {}, confirm = async () => true }) {
  onStep('Lecture des valeurs actuelles…');
  const before = await session.readAll();
  if (!before.state) return { status: 'refused', errors: [`Données illisibles : ${before.stateError}`] };
  const state = before.state;
  if (typeof target === 'function') target = target(state);

  const errors = validateTarget({ deviceName, state, target, settings });
  if (errors.length) return { status: 'refused', errors, before: state };

  const changes = diffValues(state.rear, target);
  if (changes.length === 0) {
    return { status: 'ok', unchanged: true, changes, mismatches: [], before: state, after: state, target };
  }

  if (!(await confirm(changes, state))) return { status: 'cancelled', changes, before: state };

  const backup = storage.addBackup({
    reason: `Avant : ${label}`, device: deviceName, rear: state.rear, front: state.front, fw: state.versions.rd,
  });
  storage.setPending({ label, target, backupId: backup.id, startedAt: new Date().toISOString() });

  const written = [];
  try {
    for (const c of changes) {
      onStep(`Écriture vitesse ${indexToGear(c.index, state.total)} : ${c.from} → ${c.to}`);
      await session.setGearValue(c.index, c.to);
      written.push(c);
    }
    onStep('Relecture pour vérification…');
    const after = await session.readAll();
    if (!after.state) throw new Error(`Relecture illisible : ${after.stateError}`);
    const mismatches = compareValues(target, after.state.rear);
    if (mismatches.length === 0) storage.clearPending();
    return {
      status: mismatches.length ? 'mismatch' : 'ok',
      changes, mismatches, backup, before: state, after: after.state, target,
      engagedChanged: changes.some((c) => c.index === state.num),
    };
  } catch (e) {
    e.partial = { written, backup, changes };
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Réglage en direct : chaque appui +/- est écrit dans le dérailleur (après un court délai qui
// regroupe les appuis rapprochés), relu pour vérification, puis la vitesse est « rafraîchie »
// par un aller-retour (comme la Preview de drEDS, functions.js:394-414) si `reposition` est vrai.
//
// Sécurité :
// - une sauvegarde et une opération « en attente » sont créées au démarrage ;
// - l'écart maximal (settings.maxDelta) est compté par rapport à la valeur AU DÉMARRAGE,
//   pour que des appuis répétés ne puissent pas dériver sans limite ;
// - l'ordre strictement croissant des valeurs est conservé ;
// - chaque écriture est relue ; au premier écart ou à la première erreur, le mode s'arrête.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Change de vitesse et attend la fin du mouvement (notification serverReportGear).
async function shiftAndWait(session, fn, timeoutMs = 3000) {
  const done = new Promise((resolve) => {
    const off = session.on((e) => { if (e.type === 'gear' && !e.moving) { off(); resolve(true); } });
    setTimeout(() => { off(); resolve(false); }, timeoutMs);
  });
  await fn();
  return done;
}

// Aller-retour d'une vitesse pour que le dérailleur se replace sur la valeur écrite.
// num = indice H_GEA engagé ; 1 = plus petit pignon, on ne peut pas monter plus haut.
export async function repositionGear(session, num) {
  const atSmallest = num === 1;
  await shiftAndWait(session, () => (atSmallest ? session.shiftDown() : session.shiftUp()));
  await sleep(300);
  await shiftAndWait(session, () => (atSmallest ? session.shiftUp() : session.shiftDown()));
}

export class LiveTuner {
  constructor({ session, deviceName, storage, settings = DEFAULT_SETTINGS, reposition = true, debounceMs = 400, onUpdate = () => {} }) {
    Object.assign(this, { session, deviceName, storage, settings, reposition, debounceMs, onUpdate });
    this.active = false;
    this.status = 'idle'; // idle | waiting | writing | ok | error
    this.message = null;
    this.error = null;
    this.timer = null;
    this.flushing = null;
    this.writes = 0;
  }

  _emit() { try { this.onUpdate(this); } catch { /* interface */ } }

  get hasUnwritten() { return this.active && this.desired.some((v, i) => v !== this.current[i]); }

  async start() {
    if (this.deviceName !== DEVICE_NAME_TX) throw new Error(`Matériel détecté : « ${this.deviceName} ». Le réglage direct n’est possible que sur un EDS TX.`);
    const r = await this.session.readAll();
    if (!r.state) throw new Error(`Données illisibles : ${r.stateError}`);
    this.state = r.state;
    this.total = r.state.total;
    this.num = r.state.num;
    this.startRear = [...r.state.rear];
    this.current = [...r.state.rear];
    this.desired = [...r.state.rear];
    this.backup = this.storage.addBackup({ reason: 'Avant : réglage direct', device: this.deviceName, rear: r.state.rear, front: r.state.front, fw: r.state.versions.rd });
    this.storage.setPending({ label: 'Réglage direct', target: [...this.current], backupId: this.backup.id, startedAt: new Date().toISOString() });
    this.offGear = this.session.on((e) => { if (e.type === 'gear' && !e.moving) { this.num = e.num; this._emit(); } });
    this.active = true;
    this.status = 'ok';
    this._emit();
  }

  // Change la valeur voulue de la vitesse `index` (indice H_GEA) de `delta` pas.
  // Retourne { ok, message } ; en cas de refus, rien n'est modifié.
  nudge(index, delta) {
    if (!this.active) return { ok: false, message: 'Le réglage direct n’est pas actif.' };
    const i = index - 1;
    const gear = indexToGear(index, this.total);
    const value = this.desired[i] + delta;
    const limit = this.settings.maxDelta;
    let message = null;
    if (Math.abs(value - this.startRear[i]) > limit) {
      message = `Vitesse ${gear} : limite de sécurité atteinte (±${limit} pas autour de ${this.startRear[i]}).`;
    } else if (i > 0 && value <= this.desired[i - 1]) {
      message = `Vitesse ${gear} : ne peut pas descendre sous la vitesse ${indexToGear(index - 1, this.total)} (${this.desired[i - 1]}).`;
    } else if (i < this.total - 1 && value >= this.desired[i + 1]) {
      message = `Vitesse ${gear} : ne peut pas dépasser la vitesse ${indexToGear(index + 1, this.total)} (${this.desired[i + 1]}).`;
    } else if (value < 0 || value > MAX_GEAR_VALUE) {
      message = `Vitesse ${gear} : valeur invalide (${value}).`;
    }
    if (message) { this.message = message; this._emit(); return { ok: false, message }; }
    this.desired[i] = value;
    this.message = null;
    this.status = 'waiting';
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._kick(), this.debounceMs);
    this._emit();
    return { ok: true };
  }

  _kick() {
    this.timer = null;
    if (this.flushing || !this.active) return;
    this.flushing = this._flush().finally(() => {
      this.flushing = null;
      if (this.hasUnwritten && !this.timer) this._kick(); // appuis arrivés pendant l'écriture
    });
  }

  async _flush() {
    while (this.hasUnwritten) {
      const i = this.desired.findIndex((v, k) => v !== this.current[k]);
      const value = this.desired[i];
      this.status = 'writing';
      this._emit();
      try {
        await this.session.setGearValue(i + 1, value);
        const r = await this.session.readAll();
        if (!r.state) throw new Error(`Relecture illisible : ${r.stateError}`);
        this.state = r.state;
        this.num = r.state.num;
        this.current = [...r.state.rear];
        this.writes++;
        if (this.current[i] !== value) {
          throw new Error(`Écart sur la vitesse ${indexToGear(i + 1, this.total)} : écrit ${value}, relu ${this.current[i]}.`);
        }
        const p = this.storage.getPending();
        if (p) this.storage.setPending({ ...p, target: [...this.current] });
        if (this.reposition && r.state.num === i + 1 && !this.hasUnwritten) {
          this.status = 'repositioning';
          this._emit();
          await repositionGear(this.session, r.state.num);
        }
        this.status = this.hasUnwritten ? 'waiting' : 'ok';
        this._emit();
      } catch (e) {
        this._fail(e);
        return;
      }
    }
  }

  _fail(e) {
    this.error = e;
    this.status = 'error';
    this.message = e.message;
    this._end();
    this._emit();
  }

  _end() {
    this.active = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.offGear?.();
  }

  // Termine le mode : écrit d'abord le dernier appui en attente. Si tout est écrit et vérifié,
  // l'opération « en attente » est levée. Retourne le résumé des changements depuis le départ.
  async stop() {
    if (this.active) {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      if (this.hasUnwritten && !this.flushing) this._kick();
      while (this.flushing) await this.flushing;
    }
    const clean = !this.error && this.current.every((v, i) => v === this.desired[i]);
    this._end();
    if (clean) this.storage.clearPending();
    if (this.status !== 'error') this.status = 'idle';
    this._emit();
    return { clean, changes: diffValues(this.startRear, this.current), backup: this.backup, error: this.error };
  }

  // Le dérailleur s'est déconnecté (hors écriture) : on arrête sans écrire.
  abort(reason) {
    if (!this.active) return;
    const clean = !this.flushing && this.current.every((v, i) => v === this.desired[i]);
    if (clean) this.storage.clearPending();
    this._fail(new Error(reason));
  }
}
