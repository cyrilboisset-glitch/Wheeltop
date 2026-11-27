// Dérailleur EDS TX SIMULÉ : sert aux tests automatiques et au « mode démo » de l'interface.
// ATTENTION : ses réponses sont construites d'après la documentation, ce ne sont PAS des
// captures réelles. Le comportement réel ne peut être validé que sur le vélo.
import { CMD, buildFrame, parseFrame, REAR_UP, REAR_DOWN } from './protocol.js';

export function createSimulatedTx(options = {}) {
  const st = {
    name: options.name ?? 'EDS TX',
    // Valeurs de l'exemple TX de PROTOCOL-APP.md:95
    rear: options.rear ? [...options.rear] : [0, 220, 420, 600, 780, 980, 1170, 1370, 1580, 1780, 2030],
    front: options.front ? [...options.front] : [50, 0, 180, 780, 1010, 660],
    num: options.num ?? 4,
    qNum: options.qNum ?? 4,
    key: options.key ?? 0x85,
    blockSize: options.blockSize ?? 128,
    includeFrontInText: options.includeFrontInText ?? false, // bug TX : Q_GEA souvent absents
    rejectWrites: options.rejectWrites ?? false,
    ignoreWritesTo: options.ignoreWritesTo ?? [], // indices dont l'écriture est "perdue"
    dropReplies: 0, // nombre de réponses à ignorer (test des délais d'expiration)
    disconnectAfterWrites: options.disconnectAfterWrites ?? null,
    writes: [],
    commands: [], // toutes les commandes reçues (pour vérifier ce que l'appli envoie)
    connected: true,
    latency: options.latency ?? 5,
  };
  const dataCbs = [];
  const discCbs = [];
  let writeCount = 0;

  const reply = (cmd, payload) => {
    if (st.dropReplies > 0) { st.dropReplies--; return; }
    const xorByte = 0x32 + Math.floor(Math.random() * 200); // masque non nul, comme le vrai RD
    send(buildFrame(st.key, cmd, payload, xorByte));
  };
  const send = (bytes) => setTimeout(() => { if (st.connected) dataCbs.forEach((cb) => cb(bytes)); }, st.latency);

  const infoText = () => {
    const r = st.rear.map((v, i) => `H_GEA[${i + 1}]:${v}`).join(',');
    let t = 'L_Ver:3.23,L_POWER:318,R_Ver:4.28,R_POWER:311,\n' +
      'Q_Ver:1.34,Q_POWER:780,H_Ver:2.60,H_POWER:730,\n' +
      `TOTAL_CNT:${st.rear.length},NUM:${st.num},PTOTECT:2,KeySwitch:213:0x0,0x0,0x0\n` +
      'ERRCODE:0x0\n' + r + (st.includeFrontInText ? `,Q_TOTAL:6,Q_NUM:${st.qNum},Q_PTOTECT:1,\n` : `,Q_NUM:${st.qNum},Q_PTOTECT:1,\n`) +
      'ANT_Ver:6.2,Q_CODE:0x0,\n';
    if (st.includeFrontInText) t += st.front.map((v, i) => `Q_GEA[${i + 1}]:${v},\n`).join('');
    return t;
  };
  let blocks = [];

  function handle(bytes) {
    const f = parseFrame(bytes);
    if (!f) return;
    st.commands.push(f.cmd);
    switch (f.cmd) {
      case CMD.GET_KEY: reply(CMD.GET_KEY, [st.key]); break;
      case CMD.START_READ: {
        const text = infoText();
        blocks = [];
        for (let i = 0; i < text.length; i += st.blockSize) blocks.push(text.slice(i, i + st.blockSize));
        reply(CMD.START_READ, [(blocks.length >> 8) & 0xff, blocks.length & 0xff, 0xa6, 0xce, 0x51, 0, 0, 0, 0]);
        break;
      }
      case CMD.READ: {
        const n = (f.payload[0] << 8) | f.payload[1];
        const s = blocks[n] ?? '';
        const out = new Uint8Array(4 + s.length);
        out.set([0x67, 0xd4, (n >> 8) & 0xff, n & 0xff]);
        for (let i = 0; i < s.length; i++) out[4 + i] = s.charCodeAt(i);
        if (st.dropReplies > 0) { st.dropReplies--; break; }
        send(out);
        break;
      }
      case CMD.SET_GEAR_VALUE: {
        const [idx, hi, lo] = f.payload;
        st.writes.push({ index: idx, value: (hi << 8) | lo });
        writeCount++;
        if (st.disconnectAfterWrites !== null && writeCount >= st.disconnectAfterWrites) {
          if (!st.ignoreWritesTo.includes(idx)) st.rear[idx - 1] = (hi << 8) | lo;
          sim.forceDisconnect();
          return;
        }
        if (st.rejectWrites) { reply(CMD.SET_GEAR_VALUE, [1]); break; }
        if (!st.ignoreWritesTo.includes(idx)) st.rear[idx - 1] = (hi << 8) | lo;
        reply(CMD.SET_GEAR_VALUE, [0]);
        break;
      }
      case CMD.REAR_LIFTING: {
        const dir = f.payload[0];
        if (dir === REAR_UP && st.num > 1) st.num--;
        if (dir === REAR_DOWN && st.num < st.rear.length) st.num++;
        reply(CMD.REAR_LIFTING, [0]);
        reply(CMD.SERVER_REPORT_GEAR, [0, 0, 0, 0, st.num, 1]);
        setTimeout(() => reply(CMD.SERVER_REPORT_GEAR, [0, 0, 0, 0, st.num, 0]), 150);
        break;
      }
      case CMD.FRONT_LIFTING: {
        st.qNum = st.qNum <= 3 ? 4 : 1;
        reply(CMD.FRONT_STATUS_REPORT, [0, 0, 0, 0, st.qNum]);
        break;
      }
      case CMD.GET_TRANSMISSION_INFO:
        reply(CMD.GET_TRANSMISSION_INFO, [0x02, 0xda, 0x01, 0x37, 0, 0, 0x03, 0x0c, 0x01, 0x3e, 0, 0, 1]);
        break;
      default: break; // commande inconnue : le simulateur ne répond pas
    }
  }

  const sim = {
    state: st,
    transport: {
      name: st.name,
      write: async (bytes) => {
        if (!st.connected) throw new Error('GATT déconnecté');
        handle(bytes);
      },
      onData: (cb) => dataCbs.push(cb),
      onDisconnect: (cb) => discCbs.push(cb),
      disconnect: async () => sim.forceDisconnect(),
    },
    forceDisconnect() {
      if (!st.connected) return;
      st.connected = false;
      setTimeout(() => discCbs.forEach((cb) => cb()), 0);
    },
    // Nouveau transport sur le même dérailleur simulé (reconnexion)
    reconnect() {
      st.connected = true;
      dataCbs.length = 0; discCbs.length = 0;
      writeCount = 0;
      st.disconnectAfterWrites = null;
      return sim.transport;
    },
  };
  return sim;
}
