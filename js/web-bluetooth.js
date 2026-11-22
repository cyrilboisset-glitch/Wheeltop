// Transport Web Bluetooth (Chrome Android / desktop). Seule partie liée au navigateur côté BLE.
import { SERVICE_UUID, WRITE_CHAR_UUID, NOTIFY_CHAR_UUID } from './protocol.js';

export function isWebBluetoothAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

// Ouvre le sélecteur Bluetooth (doit être appelé depuis un geste utilisateur).
export async function requestEdsDevice() {
  return navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: 'EDS' }],
    optionalServices: [SERVICE_UUID],
  });
}

// Connecte (ou reconnecte, sans geste utilisateur) un appareil déjà choisi.
export async function connectTransport(device, log = () => {}) {
  const dataCbs = [];
  const discCbs = [];
  const onDisc = () => { device.removeEventListener('gattserverdisconnected', onDisc); discCbs.forEach((cb) => cb()); };

  const server = await device.gatt.connect();
  device.addEventListener('gattserverdisconnected', onDisc);
  try {
    const service = await server.getPrimaryService(SERVICE_UUID);
    const writeChar = await service.getCharacteristic(WRITE_CHAR_UUID);
    const notifyChar = await service.getCharacteristic(NOTIFY_CHAR_UUID);
    notifyChar.addEventListener('characteristicvaluechanged', (ev) => {
      const dv = ev.target.value;
      dataCbs.forEach((cb) => cb(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength).slice()));
    });
    await notifyChar.startNotifications();
    // drEDS laisse 500 ms au RD avant le premier envoi [FJ:1488]
    await new Promise((r) => setTimeout(r, 500));
    log(`Connecté à ${device.name}`);

    return {
      name: device.name,
      write: (bytes) => writeChar.writeValueWithoutResponse(bytes), // comme drEDS
      onData: (cb) => dataCbs.push(cb),
      onDisconnect: (cb) => discCbs.push(cb),
      disconnect: async () => { if (device.gatt.connected) device.gatt.disconnect(); },
    };
  } catch (e) {
    device.removeEventListener('gattserverdisconnected', onDisc);
    if (device.gatt.connected) device.gatt.disconnect();
    throw e;
  }
}
