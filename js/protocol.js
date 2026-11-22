// Protocole Wheeltop EDS (dérailleur arrière = RD, avant = FD).
//
// Module PUR : aucune dépendance au navigateur ni à l'interface.
// Il peut être testé seul avec Node (voir tests/) et porté tel quel en Kotlin.
//
// Toutes les informations viennent du dépôt drEDS (git.jeckyll.net/published/personal/eds-ox),
// réimplémentées sans reprise de code (le dépôt n'a pas de licence). Références entre crochets :
//   [PA:n]  = PROTOCOL-APP.md ligne n
//   [FJ:n]  = js/functions.js ligne n (commit 099100a)

// --- GATT (Nordic UART Service) [PA:7-9] -------------------------------------------------
export const SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const WRITE_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // appli -> RD
export const NOTIFY_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // RD -> appli

// Nom annoncé par le RD [PA:3]
export const DEVICE_NAME_TX = 'EDS TX';

// --- Commandes [PA:45-52, PA:147-170] ------------------------------------------------------
// Volontairement ABSENTES : setTotalGear (0x91), fineTuneGear (0x95), fineTuneFrontGear (0x85),
// shutdown (0x90) et tout ce qui touche au firmware. Cette appli ne doit jamais les envoyer.
export const CMD = Object.freeze({
  GET_KEY: 0x11,
  GET_TRANSMISSION_INFO: 0x60, // batteries [FJ:498-501]
  GET_FD_RD_VALUES: 0x61, // limites FD quand le TX ne les donne pas [PA:104, FJ:798-807]
  FRONT_STATUS_REPORT: 0x88, // notification spontanée : position FD [FJ:274-280]
  FRONT_LIFTING: 0x89, // changement de plateau [FJ:1552-1561]
  SET_GEAR_VALUE: 0x92, // setGearUpValue : réglage d'une vitesse RD [FJ:1060-1067]
  SERVER_REPORT_GEAR: 0x98, // notification spontanée : vitesse RD [FJ:242-251]
  REAR_LIFTING: 0x99, // changement de vitesse RD [FJ:1509-1522]
  START_READ: 0xfa,
  READ: 0xfb,
});

export const PREFIX = 0xfe;
export const NEUTRAL_XOR = 0x32; // avec 0x32, le masque vaut 0 : trame en clair [PA:56]

// Mot de passe fixe de getKey : "yOTmK50z" [PA:28] et clé initiale 0x29 [PA:18, FJ:1493]
export const GETKEY_PASSWORD = [0x79, 0x4f, 0x54, 0x6d, 0x4b, 0x35, 0x30, 0x7a];
export const GETKEY_INITIAL_KEY = 0x29;

// Changement de vitesse RD : 0x02 = monter (vers un pignon plus petit), 0x01 = descendre.
// Source : code de drEDS [FJ:1509, FJ:1519]. HARDWARE.md:8 dit l'inverse : à vérifier sur le vélo.
export const REAR_UP = 0x02;
export const REAR_DOWN = 0x01;

// --- CRC ------------------------------------------------------------------------------------
// CRC-16/MODBUS (poly réfléchi 0xA001, init 0xFFFF) calculé sur TOUTE la trame sauf les
// 2 octets de CRC (préfixe 0xFE compris) [FJ:1220], transmis poids fort en premier [FJ:1237-1240].
// Vérifié sur les 3 trames réelles de PROTOCOL-APP.md (voir tests/protocol.test.js).
export function crc16(bytes, length = bytes.length) {
  let crc = 0xffff;
  for (let i = 0; i < length; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

// --- Construction / analyse des trames [PA:15-24] --------------------------------------------
// FE | xorByte | key | cmd | len | payload[len] | CRC_hi | CRC_lo
// masque = (xorByte - 0x32) & 0xFF, appliqué par XOR à key, cmd, len et payload.

export function buildFrame(key, cmd, payload = [], xorByte = NEUTRAL_XOR) {
  if (payload.length > 255) throw new Error('payload trop long');
  const mask = (xorByte - NEUTRAL_XOR) & 0xff;
  const out = new Uint8Array(5 + payload.length + 2);
  out[0] = PREFIX;
  out[1] = xorByte & 0xff;
  out[2] = (key ^ mask) & 0xff;
  out[3] = (cmd ^ mask) & 0xff;
  out[4] = (payload.length ^ mask) & 0xff;
  for (let i = 0; i < payload.length; i++) out[5 + i] = (payload[i] ^ mask) & 0xff;
  const crc = crc16(out, out.length - 2);
  out[out.length - 2] = (crc >> 8) & 0xff;
  out[out.length - 1] = crc & 0xff;
  return out;
}

// Retourne { key, cmd, payload } si `bytes` est une trame valide (préfixe + CRC), sinon null.
// Les blocs de données renvoyés par `read` ne sont PAS des trames (ASCII brut) : ils donnent null.
export function parseFrame(bytes) {
  if (!bytes || bytes.length < 7 || bytes[0] !== PREFIX) return null;
  const crc = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  if (crc16(bytes, bytes.length - 2) !== crc) return null;
  const mask = (bytes[1] - NEUTRAL_XOR) & 0xff;
  const len = bytes[4] ^ mask;
  if (5 + len + 2 > bytes.length) return null;
  const payload = [];
  for (let i = 0; i < len; i++) payload.push(bytes[5 + i] ^ mask);
  return { key: bytes[2] ^ mask, cmd: bytes[3] ^ mask, payload };
}

// --- Trames prêtes à l'emploi -----------------------------------------------------------------
export const frames = {
  getKey: () => buildFrame(GETKEY_INITIAL_KEY, CMD.GET_KEY, GETKEY_PASSWORD),
  // 0x80 = blocs de 128 octets (firmware récent ; les anciens ignorent et restent à 16) [FJ:220, commit 691e278]
  startRead: (key) => buildFrame(key, CMD.START_READ, [0x80]),
  // payload : n° de bloc sur 2 octets puis 0x51 fixe [PA:60]
  readBlock: (key, n) => buildFrame(key, CMD.READ, [(n >> 8) & 0xff, n & 0xff, 0x51]),
  // index = indice de H_GEA[index] (1..TOTAL_CNT), valeur sur 16 bits poids fort en premier [FJ:1060-1067]
  setGearValue: (key, index, value) => {
    checkGearIndex(index);
    checkGearValue(value);
    return buildFrame(key, CMD.SET_GEAR_VALUE, [index, (value >> 8) & 0xff, value & 0xff]);
  },
  rearShift: (key, dir) => {
    if (dir !== REAR_UP && dir !== REAR_DOWN) throw new Error('sens de changement invalide');
    return buildFrame(key, CMD.REAR_LIFTING, [dir]);
  },
  // FD : on envoie la position actuelle (1 = grand plateau, 2 = petit) pour basculer [FJ:1553-1558]
  frontShift: (key, current) => {
    if (current !== 1 && current !== 2) throw new Error('position FD inconnue');
    return buildFrame(key, CMD.FRONT_LIFTING, [current]);
  },
  getTransmissionInfo: (key) => buildFrame(key, CMD.GET_TRANSMISSION_INFO, []), // [FJ:925]
  getFdValues: (key) => buildFrame(key, CMD.GET_FD_RD_VALUES, [0x01, 0x01, 0x06]), // [FJ:801-804]
};

export const MAX_GEAR_VALUE = 0xffff;
function checkGearIndex(index) {
  if (!Number.isInteger(index) || index < 1 || index > 14) throw new Error(`indice de vitesse invalide : ${index}`);
}
function checkGearValue(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_GEAR_VALUE) throw new Error(`valeur invalide : ${value}`);
}

// --- Réponses ---------------------------------------------------------------------------------
// startRead : les 2 premiers octets du payload = nombre de blocs [PA:54]
export function parseStartReadReply(payload) {
  if (payload.length < 2) throw new Error('réponse startRead trop courte');
  return (payload[0] << 8) | payload[1];
}

// Bloc de données : 4 octets d'en-tête (signification inconnue) puis ASCII [PA:63].
// Le texte peut être complété par des 0x00 [PA:87] : on les retire.
export function decodeReadBlock(bytes) {
  let s = '';
  for (let i = 4; i < bytes.length; i++) if (bytes[i] !== 0) s += String.fromCharCode(bytes[i]);
  return s;
}

// setGearUpValue : 0x00 en premier octet = accepté [FJ:371] (l'auteur n'en est pas certain [FJ:366]).
export function isSetGearAccepted(payload) {
  return payload.length > 0 && payload[0] === 0x00;
}

// serverReportGear : payload[4] = NUM (indice H_GEA de la vitesse), payload[5] == 1 => en cours [FJ:245-251]
export function parseServerReportGear(payload) {
  if (payload.length < 6) return null;
  return { num: payload[4], moving: payload[5] === 1 };
}

// frontStatusReport : payload[4] = Q_NUM 1..6 (1-3 grand plateau, 4-6 petit) [FJ:277-280, PA:123]
export function parseFrontStatusReport(payload) {
  if (payload.length < 5 || payload[4] < 1 || payload[4] > 6) return null;
  return { qNum: payload[4], chainring: payload[4] <= 3 ? 1 : 2 };
}

// getTransmissionInfo : tensions ×100, sur 16 bits poids fort en premier [FJ:498-501]
export function parseTransmissionInfo(payload) {
  if (payload.length < 10) return null;
  const w = (i) => (payload[i] << 8) | payload[i + 1];
  return { rd: w(0), rightShifter: w(2), fd: w(6), leftShifter: w(8) };
}

// getFrontAndRearDerailleurGearValuesInfo : suite de valeurs 16 bits = Q_GEA[1..n] [FJ:484-489].
// Tout à zéro = FD absent ou endormi [FJ:466-474] -> null.
export function parseFdValues(payload) {
  const values = [];
  for (let i = 0; i + 1 < payload.length; i += 2) values.push((payload[i] << 8) | payload[i + 1]);
  return values.some((v) => v !== 0) ? values : null;
}

// --- Texte d'information (concaténation des blocs) [PA:89-127] -----------------------------------
// Format "CLE:valeur" séparé par des virgules et des retours ligne. On reste tolérant aux
// bizarreries réelles ("TOTAL_CNT:12.NUM:6" sur OX, "KeySwitch:213:0x0,..." sur TX).
const ENTRY_RE = /([A-Za-z][A-Za-z0-9_]*(?:\[\d+\])?)\s*:\s*(.*?)(?=,|\n|\r|$|[A-Za-z][A-Za-z0-9_]*(?:\[\d+\])?\s*:)/g;

export function parseInfoText(text) {
  const info = {};
  for (const m of text.matchAll(ENTRY_RE)) {
    const key = m[1];
    const value = m[2].trim().replace(/[.,]$/, '');
    if (!(key in info)) info[key] = value;
  }
  return info;
}

function int(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// Extrait la configuration d'un EDS TX. Lève une erreur explicite si les données ne
// ressemblent pas à un TX complet (on n'écrit jamais sur la base de données partielles).
export function extractTxState(info) {
  const total = int(info.TOTAL_CNT);
  if (total === null || total < 2 || total > 14) throw new Error(`nombre de vitesses illisible (TOTAL_CNT=${info.TOTAL_CNT})`);
  if (!('H_GEA[1]' in info)) throw new Error('valeurs H_GEA absentes : ce n’est pas le format d’un EDS TX');
  const rear = [];
  for (let i = 1; i <= total; i++) {
    const v = int(info[`H_GEA[${i}]`]);
    if (v === null) throw new Error(`valeur H_GEA[${i}] manquante`);
    rear.push(v);
  }
  // Limites FD : souvent absentes sur TX [PA:104]
  const qTotal = int(info.Q_TOTAL) || 0;
  let front = null;
  if (qTotal > 0) {
    const f = [];
    for (let i = 1; i <= qTotal; i++) f.push(int(info[`Q_GEA[${i}]`]));
    if (f.every((v) => v !== null)) front = f;
  }
  const num = int(info.NUM);
  const qNum = int(info.Q_NUM);
  return {
    total,
    num, // indice H_GEA de la vitesse engagée
    rear, // rear[i-1] = H_GEA[i]
    front,
    chainring: qNum >= 1 && qNum <= 3 ? 1 : qNum >= 4 && qNum <= 6 ? 2 : null,
    versions: { rd: info.H_Ver ?? null, fd: info.Q_Ver ?? null, left: info.L_Ver ?? null, right: info.R_Ver ?? null },
    power: { rd: int(info.H_POWER), fd: int(info.Q_POWER), left: int(info.L_POWER), right: int(info.R_POWER) },
  };
}

// --- Numérotation des vitesses --------------------------------------------------------------
// H_GEA[1] = plus petit pignon (point de calibration, valeur 0). drEDS affiche la vitesse
// TOTAL - indice + 1 [FJ:791-792, FJ:843-844] : vitesse 1 = plus grand pignon (la plus facile).
export const indexToGear = (index, total) => total - index + 1;
export const gearToIndex = (gear, total) => total - gear + 1;
