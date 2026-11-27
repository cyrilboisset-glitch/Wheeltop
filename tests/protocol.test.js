// Tests du protocole. Les SEULES trames réelles disponibles sont les 3 exemples de
// PROTOCOL-APP.md (lignes 13, 30 et 56) et les dumps texte (lignes 66-73, 90-103, 130-139).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  crc16, buildFrame, parseFrame, frames, CMD, parseInfoText, extractTxState, decodeReadBlock,
  parseStartReadReply, parseServerReportGear, parseTransmissionInfo, indexToGear, gearToIndex,
} from '../js/protocol.js';

const h = (s) => Uint8Array.from(s.trim().split(/\s+/).map((x) => parseInt(x, 16)));

// --- Trames réelles (PROTOCOL-APP.md) ---
const REAL_GETKEY_REQ = 'fe 32 29 11 08 79 4f 54 6d 4b 35 30 7a 41 15'; // ligne 13
const REAL_GETKEY_RSP = 'fe b7 00 94 84 00 33 c3'; // ligne 30
const REAL_READ_REQ = 'fe 32 d1 fb 03 00 00 51 2d eb'; // ligne 56

test('CRC : les 3 trames réelles de la doc', () => {
  for (const s of [REAL_GETKEY_REQ, REAL_GETKEY_RSP, REAL_READ_REQ]) {
    const b = h(s);
    const crc = crc16(b, b.length - 2);
    assert.equal(crc >> 8, b[b.length - 2], s);
    assert.equal(crc & 0xff, b[b.length - 1], s);
  }
});

test('CRC : valeur de contrôle CRC-16/MODBUS standard ("123456789" -> 0x4B37)', () => {
  assert.equal(crc16(new TextEncoder().encode('123456789')), 0x4b37);
});

test('encodage : getKey reproduit exactement la trame réelle', () => {
  assert.deepEqual(frames.getKey(), h(REAL_GETKEY_REQ));
});

test('encodage : read bloc 0 avec la clé 0xd1 reproduit exactement la trame réelle', () => {
  assert.deepEqual(frames.readBlock(0xd1, 0), h(REAL_READ_REQ));
});

test('décodage : réponse getKey réelle (masque 0x85) -> clé 0x85', () => {
  const f = parseFrame(h(REAL_GETKEY_RSP));
  assert.deepEqual(f, { key: 0x85, cmd: CMD.GET_KEY, payload: [0x85] });
});

test('décodage : la requête getKey réelle se relit', () => {
  const f = parseFrame(h(REAL_GETKEY_REQ));
  assert.equal(f.cmd, 0x11);
  assert.equal(f.key, 0x29);
  assert.equal(String.fromCharCode(...f.payload), 'yOTmK50z');
});

test('décodage : CRC faux ou préfixe absent -> null (bloc ASCII)', () => {
  const b = h(REAL_GETKEY_RSP); b[7] ^= 1;
  assert.equal(parseFrame(b), null);
  assert.equal(parseFrame(h('67 d4 00 00 52 45 4d 4f 54 45 5f 56 3a 32 2e 35 38 2c 50 4f')), null); // bloc réel, ligne 63
});

test('encodage/décodage aller-retour avec masques non nuls', () => {
  for (let x = 0; x < 256; x += 7) {
    const f = buildFrame(0x85, CMD.SET_GEAR_VALUE, [3, 0x02, 0x58], x);
    assert.deepEqual(parseFrame(f), { key: 0x85, cmd: CMD.SET_GEAR_VALUE, payload: [3, 0x02, 0x58] });
  }
});

test('setGearValue : structure [indice, poids fort, poids faible] (functions.js:1060-1065)', () => {
  const f = frames.setGearValue(0x85, 4, 600);
  assert.deepEqual(Array.from(f.slice(0, 8)), [0xfe, 0x32, 0x85, 0x92, 0x03, 4, 0x02, 0x58]);
  assert.throws(() => frames.setGearValue(0x85, 0, 10));
  assert.throws(() => frames.setGearValue(0x85, 3, -1));
  assert.throws(() => frames.setGearValue(0x85, 3, 70000));
  assert.throws(() => frames.setGearValue(0x85, 3, 12.5));
});

test('startRead demande des blocs de 128 octets (functions.js:220)', () => {
  assert.deepEqual(Array.from(frames.startRead(0x85).slice(0, 6)), [0xfe, 0x32, 0x85, 0xfa, 0x01, 0x80]);
});

test('réponse startRead : nombre de blocs (exemple ligne 54 : 00 14 -> 20)', () => {
  assert.equal(parseStartReadReply(h('00 14 a6 ce 51 00 00 00 00')), 20);
});

test('bloc de lecture réel (ligne 63) -> "REMOTE_V:2.58,PO"', () => {
  assert.equal(decodeReadBlock(h('67 d4 00 00 52 45 4d 4f 54 45 5f 56 3a 32 2e 35 38 2c 50 4f')), 'REMOTE_V:2.58,PO');
});

// --- Dumps texte réels ---
const TX_DUMP = `L_Ver:3.23,L_POWER:318,R_Ver:4.28,R_POWER:311,
Q_Ver:1.34,Q_POWER:780,H_Ver:2.60,H_POWER:730,
TOTAL_CNT:11,NUM:4,PTOTECT:2,KeySwitch:213:0x0,0x0,0x0
ERRCODE:0x0
H_GEA[1]:0,H_GEA[2]:220,H_GEA[3]:420,H_GEA[4]:600,H_GEA[5]:780,H_GEA[6]:980,H_GEA[7]:1170,H_GEA[8]:1370,H_GEA[9]:1580,H_GEA[10]:1780,H_GEA[11]:2030,Q_TOTAL:6,Q_NUM:4,Q_PTOTECT:1,
ANT_Ver:6.2,Q_CODE:0x0,
Q_GEA[1]:50,
Q_GEA[2]:0,
Q_GEA[3]:180,
Q_GEA[4]:780,
Q_GEA[5]:1010,
Q_GEA[6]:660,
`;

test('dump TX réel -> état complet', () => {
  const s = extractTxState(parseInfoText(TX_DUMP));
  assert.equal(s.total, 11);
  assert.equal(s.num, 4);
  assert.deepEqual(s.rear, [0, 220, 420, 600, 780, 980, 1170, 1370, 1580, 1780, 2030]);
  assert.deepEqual(s.front, [50, 0, 180, 780, 1010, 660]);
  assert.equal(s.chainring, 2);
  assert.deepEqual(s.versions, { rd: '2.60', fd: '1.34', left: '3.23', right: '4.28' });
  assert.deepEqual(s.power, { rd: 730, fd: 780, left: 318, right: 311 });
});

test('dump TX réel découpé en blocs de 16 octets -> même résultat', () => {
  let text = '';
  for (let i = 0; i < TX_DUMP.length; i += 16) text += TX_DUMP.slice(i, i + 16);
  assert.deepEqual(extractTxState(parseInfoText(text)).rear.length, 11);
});

test('dump TX sans Q_GEA (bug TX, ligne 104) -> front null', () => {
  const s = extractTxState(parseInfoText(TX_DUMP.replace(/Q_TOTAL:6,/, '').replace(/Q_GEA\[\d\]:\d+,\n/g, '')));
  assert.equal(s.front, null);
});

test('dump OX réel -> refusé (pas un TX), malgré "TOTAL_CNT:12.NUM:6"', () => {
  const OX = `REMOTE_V:2.58,POWER_1:292,
GEARS_V:2.89,POWER_2:712,
TOTAL_CNT:12.NUM:6,PTOTECT:2,KeySwitch:0
MCU_DATA:14,0,0,1,0,ErrList:0x20,0x0,0x0
ERRCODE:0x0
GEARS[1]:   0,GEARS[2]: 220,GEARS[3]: 450,GEARS[4]: 650,GEARS[5]: 860,GEARS[6]:1040,GEARS[7]:1240,GEARS[8]:1440,GEARS[9]:1680,GEARS[10]:1920,GEARS[11]:2180,GEARS[12]:2560,
`;
  const info = parseInfoText(OX);
  assert.equal(info.TOTAL_CNT, '12');
  assert.equal(info.NUM, '6');
  assert.equal(info['GEARS[12]'], '2560');
  assert.throws(() => extractTxState(info), /H_GEA/);
});

test('dump GeX réel : se lit (format proche du TX), front null', () => {
  const GEX = `L_Ver:3.25,L_POWER:299,R_Ver:4.30,R_POWER:297,
Q_Ver:0.0,Q_POWER:0,H_Ver:2.67,B,H_POWER:825,
TOTAL_CNT:11,NUM:9,PTOTECT:2,KeySwitch:2120
RacingMode:0,HRunCnt:41993,RunTime:2377,
ErrList:0x20,0x0,0x0
ERRCODE:0x0
H_GEA[1]:0,H_GEA[2]:170,H_GEA[3]:280,H_GEA[4]:410,H_GEA[5]:540,H_GEA[6]:650,H_GEA[7]:795,H_GEA[8]:930,H_GEA[9]:1050,H_GEA[10]:1190,H_GEA[11]:1335,Q_TOTAL:0,Q_NUM:0,Q_PTOTECT:0,
ANT_Ver:6.2,Q_CODE:0x0,
`;
  const s = extractTxState(parseInfoText(GEX));
  assert.equal(s.rear[10], 1335);
  assert.equal(s.power.rd, 825);
  assert.equal(s.front, null);
  // Le refus du GeX se fait sur le nom BLE (voir tuning.test.js), pas sur le texte.
});

test('notifications : serverReportGear, batteries', () => {
  assert.deepEqual(parseServerReportGear([0, 0, 0, 0, 5, 1]), { num: 5, moving: true });
  assert.equal(parseServerReportGear([1, 2]), null);
  assert.deepEqual(parseTransmissionInfo([0x02, 0xda, 0x01, 0x37, 0, 0, 0x03, 0x0c, 0x01, 0x3e]), { rd: 730, rightShifter: 311, fd: 780, leftShifter: 318 });
});

test('numérotation : H_GEA[1] = vitesse la plus haute (plus petit pignon)', () => {
  assert.equal(indexToGear(1, 11), 11);
  assert.equal(indexToGear(11, 11), 1);
  assert.equal(gearToIndex(indexToGear(4, 11), 11), 4);
});

test('aucune commande dangereuse n’est exposée', () => {
  const codes = Object.values(CMD);
  for (const forbidden of [0x91, 0x95, 0x85, 0x90, 0x93, 0x61]) assert.ok(!codes.includes(forbidden), `0x${forbidden.toString(16)}`);
});
