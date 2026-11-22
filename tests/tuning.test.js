// Tests session + logique d'application sur le dérailleur SIMULÉ (js/simulator.js).
// Ils valident notre logique (sécurité, relecture, reprise), pas le comportement réel du RD.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSimulatedTx } from '../js/simulator.js';
import { EdsSession, DisconnectedError, TimeoutError, TIMEOUTS } from '../js/eds-session.js';
import { applyRearValues, validateTarget, DEFAULT_SETTINGS } from '../js/tuning.js';
import { createStorage, toDrEdsExport, fromDrEdsImport, exportFileName } from '../js/storage.js';

const memBackend = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
async function connect(sim) {
  const s = new EdsSession(sim.transport);
  await s.handshake();
  return s;
}
const ORIG = [0, 220, 420, 600, 780, 980, 1170, 1370, 1580, 1780, 2030];

test('lecture complète : blocs de 128 et de 16 octets', async () => {
  for (const blockSize of [128, 16]) {
    const sim = createSimulatedTx({ blockSize });
    const s = await connect(sim);
    const r = await s.readAll();
    assert.deepEqual(r.state.rear, ORIG);
    assert.deepEqual(r.state.front, [50, 0, 180, 780, 1010, 660]); // via 0x61 (bug TX)
    assert.equal(r.state.num, 4);
  }
});

test('écriture d’une vitesse puis relecture', async () => {
  const sim = createSimulatedTx();
  const s = await connect(sim);
  await s.setGearValue(3, 425);
  assert.equal((await s.readAll()).state.rear[2], 425);
});

test('setGearValue : refus du dérailleur -> erreur', async () => {
  const sim = createSimulatedTx({ rejectWrites: true });
  const s = await connect(sim);
  await assert.rejects(s.setGearValue(3, 425), /refusé/);
});

test('setGearValue : une réponse perdue -> nouvelle tentative réussie', async () => {
  const sim = createSimulatedTx();
  const s = await connect(sim);
  sim.state.dropReplies = 1;
  const t = TIMEOUTS.setGear; TIMEOUTS.setGear = 50;
  try { await s.setGearValue(3, 430); } finally { TIMEOUTS.setGear = t; }
  assert.equal(sim.state.rear[2], 430);
  assert.equal(sim.state.writes.length, 2);
});

test('délai dépassé en lecture -> TimeoutError', async () => {
  const sim = createSimulatedTx();
  const s = await connect(sim);
  sim.state.dropReplies = 1;
  const t = TIMEOUTS.startRead; TIMEOUTS.startRead = 50;
  try { await assert.rejects(s.readAll(), TimeoutError); } finally { TIMEOUTS.startRead = t; }
});

test('validation : matériel, nombre de vitesses, ordre, écart max', () => {
  const state = { total: 11, rear: ORIG };
  const ok = ORIG.map((v, i) => (i === 3 ? v + 10 : v));
  assert.deepEqual(validateTarget({ deviceName: 'EDS TX', state, target: ok }), []);
  assert.match(validateTarget({ deviceName: 'EDS OX', state, target: ok })[0], /EDS TX/);
  assert.match(validateTarget({ deviceName: 'EDS GeX', state, target: ok })[0], /EDS TX/);
  assert.match(validateTarget({ deviceName: 'EDS TX', state, target: ORIG.slice(0, 10) })[0], /10 vitesses.*11/);
  const unordered = [...ORIG]; unordered[5] = 500;
  assert.match(validateTarget({ deviceName: 'EDS TX', state, target: unordered }).join(), /augmenter/);
  const far = [...ORIG]; far[10] = 2300;
  assert.match(validateTarget({ deviceName: 'EDS TX', state, target: far, settings: DEFAULT_SETTINGS }).join(), /écart de 270/);
  assert.match(validateTarget({ deviceName: 'EDS TX', state, target: [...ORIG.slice(0, 10), 2030.5] }).join(), /invalide/);
});

test('application complète : sauvegarde, écriture des seules vitesses modifiées, vérification', async () => {
  const sim = createSimulatedTx();
  const s = await connect(sim);
  const storage = createStorage(memBackend());
  const target = ORIG.map((v, i) => (i === 2 || i === 7 ? v + 15 : v));
  const r = await applyRearValues({ session: s, deviceName: 'EDS TX', target, label: 'Trainer', storage });
  assert.equal(r.status, 'ok');
  assert.equal(sim.state.writes.length, 2);
  assert.deepEqual(sim.state.rear, target);
  assert.deepEqual(storage.listBackups()[0].rear, ORIG);
  assert.equal(storage.getPending(), null);
});

test('application : profil identique -> aucune écriture', async () => {
  const sim = createSimulatedTx();
  const s = await connect(sim);
  const storage = createStorage(memBackend());
  const r = await applyRearValues({ session: s, deviceName: 'EDS TX', target: [...ORIG], label: 'Roue', storage });
  assert.equal(r.status, 'ok');
  assert.ok(r.unchanged);
  assert.equal(sim.state.writes.length, 0);
  assert.equal(storage.listBackups().length, 0);
});

test('application : refus -> rien n’est écrit', async () => {
  const sim = createSimulatedTx({ rear: ORIG.slice(0, 10) });
  const s = await connect(sim);
  const storage = createStorage(memBackend());
  const r = await applyRearValues({ session: s, deviceName: 'EDS TX', target: ORIG, label: 'Roue', storage });
  assert.equal(r.status, 'refused');
  assert.equal(sim.state.writes.length, 0);
});

test('application : écriture perdue -> écart détecté sur la bonne vitesse', async () => {
  const sim = createSimulatedTx({ ignoreWritesTo: [8] });
  const s = await connect(sim);
  const storage = createStorage(memBackend());
  const target = ORIG.map((v, i) => (i === 7 ? v + 20 : v));
  const r = await applyRearValues({ session: s, deviceName: 'EDS TX', target, label: 'Trainer', storage });
  assert.equal(r.status, 'mismatch');
  assert.deepEqual(r.mismatches, [{ index: 8, gear: 4, expected: 1390, actual: 1370 }]);
  assert.ok(storage.getPending(), 'reste en attente');
});

test('déconnexion en pleine écriture -> opération en attente, reprise après reconnexion', async () => {
  const sim = createSimulatedTx({ disconnectAfterWrites: 2 });
  let s = await connect(sim);
  const storage = createStorage(memBackend());
  const target = ORIG.map((v, i) => (i >= 2 && i <= 5 ? v + 10 : v));
  await assert.rejects(
    applyRearValues({ session: s, deviceName: 'EDS TX', target, label: 'Trainer', storage }),
    (e) => e instanceof DisconnectedError && e.partial.written.length === 1,
  );
  const pending = storage.getPending();
  assert.ok(pending);
  assert.deepEqual(storage.getBackup(pending.backupId).rear, ORIG);
  // Reconnexion + reprise (comme le propose l'interface)
  sim.reconnect();
  s = new EdsSession(sim.transport);
  await s.handshake();
  const r = await applyRearValues({ session: s, deviceName: 'EDS TX', target: pending.target, label: 'Reprise', storage });
  assert.equal(r.status, 'ok');
  assert.deepEqual(sim.state.rear, target);
  assert.equal(storage.getPending(), null);
});

test('restauration de la sauvegarde après interruption', async () => {
  const sim = createSimulatedTx({ disconnectAfterWrites: 2 });
  let s = await connect(sim);
  const storage = createStorage(memBackend());
  const target = ORIG.map((v, i) => (i >= 2 && i <= 5 ? v + 10 : v));
  await assert.rejects(applyRearValues({ session: s, deviceName: 'EDS TX', target, label: 'Trainer', storage }));
  const backup = storage.getBackup(storage.getPending().backupId);
  sim.reconnect();
  s = new EdsSession(sim.transport);
  await s.handshake();
  const r = await applyRearValues({ session: s, deviceName: 'EDS TX', target: backup.rear, label: 'Restauration', storage });
  assert.equal(r.status, 'ok');
  assert.deepEqual(sim.state.rear, ORIG);
});

test('changement de vitesse et notification serverReportGear', async () => {
  const sim = createSimulatedTx({ num: 4 });
  const s = await connect(sim);
  const nums = [];
  s.on((e) => { if (e.type === 'gear' && !e.moving) nums.push(e.num); });
  await s.shiftUp();
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(nums, [3]);
  const bat = await s.getBatteries();
  assert.equal(bat.rd, 730);
});

test('export drEDS -> import : aller-retour', () => {
  const profiles = { Roue: { rear: ORIG, front: [50, 0, 180, 780, 1010, 660], fw: '2.60', note: '' }, Trainer: { rear: ORIG.map((v) => v + 5), front: null } };
  const exp = toDrEdsExport({ profiles, current: { rear: ORIG, front: null } });
  assert.deepEqual(exp.gears['EDS TX'].Roue.rear[1], { gear: '2', value: '220' });
  assert.equal(exp.current.device, 'EDS TX');
  const imp = fromDrEdsImport(JSON.parse(JSON.stringify(exp)));
  assert.deepEqual(imp.profiles.Roue.rear, ORIG);
  assert.deepEqual(imp.profiles.Trainer.rear, ORIG.map((v) => v + 5));
  assert.equal(imp.profiles.Trainer.front, null);
  assert.deepEqual(imp.current.rear, ORIG);
  assert.match(exportFileName(new Date(2026, 10, 22, 9, 5, 7)), /^drEDS-20261122090507\.json$/);
});

test('import d’un fichier drEDS (structure de functions.js:1858-1897), autres matériels ignorés', () => {
  const file = {
    debug: false, page: 'settings', battery: '1', lock: null,
    current: { device: 'EDS TX', rear: ORIG.map((v, i) => ({ gear: String(i + 1), value: String(v) })), front: [] },
    gears: {
      'EDS TX': { route: { rear: ORIG.map((v, i) => ({ gear: String(i + 1), value: String(v) })), front: [{ gear: '1', value: '50' }] } },
      'EDS OX': { vieux: { rear: [{ gear: '1', value: '0' }] } },
    },
  };
  const imp = fromDrEdsImport(file);
  assert.deepEqual(Object.keys(imp.profiles), ['route']);
  assert.deepEqual(imp.profiles.route.front, [50]);
  assert.deepEqual(imp.ignoredDevices, ['EDS OX']);
  assert.throws(() => fromDrEdsImport({ gears: { 'EDS TX': { x: { rear: [{ gear: '1', value: 'abc' }] } } } }), /invalide/);
});

test('application : annulation à la confirmation -> rien n’est écrit ni sauvegardé', async () => {
  const sim = createSimulatedTx();
  const s = await connect(sim);
  const storage = createStorage(memBackend());
  let seen = null;
  const r = await applyRearValues({
    session: s, deviceName: 'EDS TX', label: 'Vitesse 9', storage,
    target: (st) => st.rear.map((v, i) => (i === 2 ? v + 5 : v)),
    confirm: async (changes) => { seen = changes; return false; },
  });
  assert.equal(r.status, 'cancelled');
  assert.deepEqual(seen, [{ index: 3, from: 420, to: 425 }]);
  assert.equal(sim.state.writes.length, 0);
  assert.equal(storage.listBackups().length, 0);
});
