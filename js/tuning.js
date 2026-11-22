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
