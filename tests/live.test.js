// Réglage en direct (LiveTuner) sur le dérailleur SIMULÉ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSimulatedTx } from '../js/simulator.js';
import { EdsSession } from '../js/eds-session.js';
import { LiveTuner } from '../js/tuning.js';
import { createStorage } from '../js/storage.js';

const memBackend = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
const ORIG = [0, 220, 420, 600, 780, 980, 1170, 1370, 1580, 1780, 2030];
const waitIdle = async (t) => { while (t.timer || t.flushing) { await (t.flushing ?? new Promise((r) => setTimeout(r, 20))); } };

async function setup(opts = {}, tunerOpts = {}) {
  const sim = createSimulatedTx({ num: 3, ...opts }); // vitesse engagée : H_GEA[3] = vitesse 9
  const session = new EdsSession(sim.transport);
  await session.handshake();
  const storage = createStorage(memBackend());
  const tuner = new LiveTuner({ session, deviceName: 'EDS TX', storage, debounceMs: 30, ...tunerOpts });
  await tuner.start();
  return { sim, session, storage, tuner };
}

test('démarrage : sauvegarde et opération en attente, aucune écriture', async () => {
  const { sim, storage, tuner } = await setup();
  assert.deepEqual(storage.listBackups()[0].rear, ORIG);
  assert.equal(storage.getPending().label, 'Réglage direct');
  assert.equal(sim.state.writes.length, 0);
  assert.equal(tuner.num, 3);
  await tuner.stop();
});

test('appuis rapprochés regroupés : une seule écriture, relue, puis aller-retour', async () => {
  const { sim, tuner } = await setup();
  tuner.nudge(3, 5); tuner.nudge(3, 5); tuner.nudge(3, -1);
  await waitIdle(tuner);
  assert.deepEqual(sim.state.writes, [{ index: 3, value: 429 }]);
  assert.equal(sim.state.rear[2], 429);
  assert.equal(tuner.current[2], 429);
  assert.equal(sim.state.commands.filter((c) => c === 0x99).length, 2, 'aller-retour de vitesse');
  assert.equal(sim.state.num, 3, 'revenu sur la même vitesse');
  const r = await tuner.stop();
  assert.ok(r.clean);
  assert.deepEqual(r.changes, [{ index: 3, from: 420, to: 429 }]);
});

test('sans repositionnement : pas de changement de vitesse', async () => {
  const { sim, tuner } = await setup({}, { reposition: false });
  tuner.nudge(3, 5);
  await waitIdle(tuner);
  assert.equal(sim.state.rear[2], 425);
  assert.equal(sim.state.commands.filter((c) => c === 0x99).length, 0);
  await tuner.stop();
});

test('limite de sécurité comptée depuis la valeur de départ', async () => {
  const { sim, tuner } = await setup({ rear: [0, 220, 420, 600, 780, 980, 1170, 1370, 1580, 1780, 2030] }, { settings: { maxDelta: 20 } });
  for (let k = 0; k < 4; k++) assert.equal(tuner.nudge(3, 5).ok, true);
  const r = tuner.nudge(3, 5);
  assert.equal(r.ok, false);
  assert.match(r.message, /limite de sécurité/);
  await waitIdle(tuner);
  assert.equal(sim.state.rear[2], 440);
  await tuner.stop();
});

test('ordre des pignons conservé', async () => {
  const { sim, tuner } = await setup({ rear: [0, 220, 420, 425, 780, 980, 1170, 1370, 1580, 1780, 2030] });
  for (let k = 0; k < 4; k++) tuner.nudge(3, 1);
  const r = tuner.nudge(3, 1); // 425 = vitesse suivante
  assert.equal(r.ok, false);
  assert.match(r.message, /ne peut pas dépasser/);
  await waitIdle(tuner);
  assert.equal(sim.state.rear[2], 424);
  await tuner.stop();
});

test('arrêt pendant le délai : le dernier appui est quand même écrit et vérifié', async () => {
  const { sim, storage, tuner } = await setup({}, { debounceMs: 5000 });
  tuner.nudge(3, 7);
  const r = await tuner.stop();
  assert.equal(sim.state.rear[2], 427);
  assert.ok(r.clean);
  assert.equal(storage.getPending(), null);
});

test('écriture perdue : le mode s’arrête sur l’écart, l’opération reste en attente', async () => {
  const { tuner, storage } = await setup({ ignoreWritesTo: [3] });
  tuner.nudge(3, 5);
  await waitIdle(tuner);
  assert.equal(tuner.active, false);
  assert.equal(tuner.status, 'error');
  assert.match(tuner.message, /Écart sur la vitesse 9/);
  assert.ok(storage.getPending());
});

test('déconnexion pendant l’écriture : arrêt, opération en attente avec la sauvegarde', async () => {
  const { sim, tuner, storage } = await setup({ disconnectAfterWrites: 1 });
  tuner.nudge(3, 5);
  await waitIdle(tuner);
  assert.equal(tuner.active, false);
  assert.equal(tuner.status, 'error');
  const p = storage.getPending();
  assert.ok(p);
  assert.deepEqual(storage.getBackup(p.backupId).rear, ORIG);
  assert.equal(sim.state.connected, false);
});

test('vitesse changée à la manette : le réglage suit la vitesse engagée', async () => {
  const { session, tuner } = await setup();
  await session.shiftDown();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(tuner.num, 4);
  await tuner.stop();
});

test('refusé sur un autre matériel que l’EDS TX', async () => {
  const sim = createSimulatedTx({ name: 'EDS OX' });
  const session = new EdsSession(sim.transport);
  await session.handshake();
  const t = new LiveTuner({ session, deviceName: 'EDS OX', storage: createStorage(memBackend()) });
  await assert.rejects(t.start(), /EDS TX/);
  assert.equal(sim.state.commands.includes(0x92), false);
});
