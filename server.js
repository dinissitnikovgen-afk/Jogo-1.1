// Brawl Web — servidor central autoritativo (v2: otimizado para latência e estabilidade)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

// ------------------------------------------------------------------ config
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const TICK_MS = 1000 / 60;                                   // simulação a 60 Hz
const SNAP_HZ = [20, 30, 60].includes(Number(process.env.SNAP_HZ)) ? Number(process.env.SNAP_HZ) : 30;
const SNAP_EVERY = 60 / SNAP_HZ;                             // ticks entre snapshots
const MAX_CATCHUP = 5;                                       // máx. ticks recuperados por iteração
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 200);
const RECONNECT_GRACE_MS = 20000;                            // tempo para um jogador voltar
const IDLE_ROOM_MS = 10 * 60 * 1000;                         // salas sem jogo ativo
const HEARTBEAT_MS = 15000;
const MAX_BUFFERED = 64 * 1024;                              // não acumular snapshots em ligações lentas
const MSG_BURST = 120, MSG_RATE = 90;                        // anti-flood (mensagens/seg)
const KEYS = ['left', 'right', 'jump', 'down', 'dodge', 'light', 'heavy', 'special'];

const rooms = new Map();

// ------------------------------------------------------------------ motor do jogo
// O HTML é lido e compilado UMA vez; cada sala só cria um contexto novo (barato).
function makeCanvasContext() {
  const base = {
    measureText: () => ({ width: 0 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => null,
    getImageData: () => ({ data: [] })
  };
  return new Proxy(base, {
    get(t, k) { return k in t ? t[k] : () => {}; },
    set(t, k, v) { t[k] = v; return true; }
  });
}
function makeCanvas() {
  const context = makeCanvasContext();
  return { width: 1280, height: 720, style: {}, addEventListener() {}, getContext() { return context; }, toDataURL() { return ''; } };
}

function buildEngineScript() {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const match = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop();
  if (!match) throw new Error('Não foi possível carregar o motor do jogo.');
  let source = match[1];
  const patch = (from, to, optional = false) => {
    if (!source.includes(from)) {
      if (optional) return;
      throw new Error('Motor: padrão não encontrado: ' + from.slice(0, 40));
    }
    source = source.replace(from, to);
  };
  patch('loadTurn().then(testTurn);', '', true);   // já não existe no HTML sem TURN
  patch('requestAnimationFrame(loop);', '');
  patch(
    'const EMPTY_INPUT = { left:false, right:false, jump:false, down:false, dodge:false, light:false, heavy:false, special:false };',
    'const EMPTY_INPUT = { left:false, right:false, jump:false, down:false, dodge:false, light:false, heavy:false, special:false };\nlet serverInputs = [{...EMPTY_INPUT},{...EMPTY_INPUT}];'
  );
  patch('else { inputs = readInput(p.idx); }', 'else { inputs = serverInputs[p.idx] || EMPTY_INPUT; }');
  source += `
;(function () {
  let nextProjId = 1;
  const r2 = v => Math.round(v * 100) / 100;
  globalThis.__engine = {
    S, CHARACTERS, MAPS,
    configure() { isMultiplayer = true; isHost = false; S.mode = 'mp_host'; },
    start(p1, p2, mapId) { S.p1Char = p1; S.p2Char = p2; this.configure(); startGame(mapId, true); },
    tick(inputs) { serverInputs = inputs; update(1); S.frame += 1; return S; },
    // Snapshot compacto: números arredondados e apenas as partículas NOVAS
    // (o cliente simula-as localmente — antes eram reenviadas 50x a cada snapshot).
    snapshot(withParticles = true) {
      const fresh = [];
      if (withParticles) for (const p of S.particles) {
        if (p._sent) continue;
        p._sent = 1;
        fresh.push(p.dmgNum
          ? [r2(p.x), r2(p.y), 0, r2(p.vy), p.life | 0, p.max, p.color, p.size, p.text]
          : [r2(p.x), r2(p.y), r2(p.vx), r2(p.vy), p.life | 0, p.max, p.color, r2(p.size)]);
      }
      return {
        frame: S.frame,
        shake: r2(S.shake),
        screen: S.screen,
        winnerIdx: S.winner ? S.winner.idx : null,
        players: S.players.map(p => ({
          idx: p.idx, charId: p.charId, x: r2(p.x), y: r2(p.y), vx: r2(p.vx), vy: r2(p.vy), w: p.w, h: p.h,
          facing: p.facing, damage: r2(p.damage), stocks: p.stocks, grounded: p.grounded,
          jumpsLeft: p.jumpsLeft, hitstun: r2(p.hitstun), invuln: r2(p.invuln), respawn: r2(p.respawn),
          dodging: r2(p.dodging), dodgeCd: r2(p.dodgeCd), animState: p.animState, animTime: p.animTime,
          eliminated: p.eliminated, jumpHeld: p.jumpHeld,
          attack: p.attack ? { type: p.attack.type, timer: r2(p.attack.timer), hitDone: p.attack.hitDone, waveDone: p.attack.waveDone } : null
        })),
        projectiles: S.projectiles.map(p => {
          if (!p._id) p._id = nextProjId++;
          return { id: p._id, x: r2(p.x), y: r2(p.y), vx: r2(p.vx), vy: r2(p.vy), ownerIdx: p.ownerIdx, life: r2(p.life), radius: p.radius, color: p.color, kind: p.kind };
        }),
        particles: fresh
      };
    }
  };
})();`;
  return new vm.Script(source, { filename: 'brawl-engine.js' });
}

let ENGINE_SCRIPT = buildEngineScript();

function createEngine() {
  const canvas = makeCanvas();
  const elements = { game: canvas, modalOverlay: { style: {} }, modalInput: { value: '', focus() {}, blur() {}, addEventListener() {} } };
  const document = {
    getElementById(id) { return elements[id] || (elements[id] = { style: {}, addEventListener() {}, focus() {}, blur() {} }); },
    createElement() { return makeCanvas(); },
    fonts: { load() { return Promise.resolve(); } },
    hidden: false, addEventListener() {},
    write() {}
  };
  class FakeImage { constructor() { this.complete = false; this.naturalWidth = 0; this.onload = null; } set src(v) { this._src = v; } }
  const sandbox = {
    console, document,
    window: { addEventListener() {}, location: { reload() {} } },
    location: { protocol: 'https:', host: 'localhost' },
    Image: FakeImage, performance: { now: () => 0 }, requestAnimationFrame() {},
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {}, alert() {},
    Math, Date, Map, Set, Promise, Number, String, Object, Array, JSON
  };
  vm.createContext(sandbox);
  ENGINE_SCRIPT.runInContext(sandbox, { timeout: 10000 });
  const engine = sandbox.__engine;
  engine.configure();
  return engine;
}
const catalog = createEngine(); // só para validar personagens e mapas

// ------------------------------------------------------------------ utilidades
const emptyInput = () => ({ left: false, right: false, jump: false, down: false, dodge: false, light: false, heavy: false, special: false });
const now = () => Date.now();

function sendRaw(ws, str) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(str); }
function send(ws, payload) { sendRaw(ws, JSON.stringify(payload)); }
function broadcast(room, payload) {
  const str = JSON.stringify(payload);                       // serializa UMA vez
  for (const seat of room.seats) if (seat) sendRaw(seat.ws, str);
}
function roomCode() {
  let code;
  do { code = String(crypto.randomInt(100000, 1000000)); } while (rooms.has(code));
  return code;
}
function newToken() { return crypto.randomBytes(12).toString('hex'); }
function bothConnected(room) { return !!(room.seats[0] && room.seats[0].ws && room.seats[1] && room.seats[1].ws); }
function bothSeated(room) { return !!(room.seats[0] && room.seats[1]); }

function createRoom() {
  return {
    code: roomCode(), stage: 'waiting',
    seats: [null, null],              // {ws, token, lostAt}
    picks: [null, null], votes: [null, null],
    inputs: [emptyInput(), emptyInput()],
    latch: [emptyInput(), emptyInput()],   // garante que toques curtos (<1 tick) não se perdem
    mapId: null, engine: null, tickCount: 0, lastActive: now()
  };
}
function destroyRoom(room, notifyMsg) {
  if (!rooms.has(room.code)) return;
  if (notifyMsg) broadcast(room, notifyMsg);
  for (const seat of room.seats) if (seat && seat.ws) { seat.ws.roomCode = null; seat.ws.seat = null; }
  room.engine = null;
  rooms.delete(room.code);
}
function roomFor(ws) { return ws.roomCode ? rooms.get(ws.roomCode) : null; }

function leave(ws, intentional = true) {
  const room = roomFor(ws);
  if (!room) return;
  const seat = room.seats[ws.seat];
  if (!seat || seat.ws !== ws) return;
  ws.roomCode = null; ws.seat = null;
  if (intentional) { seat.ws = null; destroyRoom(room, { type: 'left' }); return; }
  // Queda de ligação: guarda o lugar e espera pela reconexão.
  seat.ws = null; seat.lostAt = now();
  room.inputs[ws._seat ?? 0] = emptyInput();
  const other = room.seats[1 - (ws._seat ?? 0)];
  if (other && other.ws) send(other.ws, { type: 'peerLost', graceMs: RECONNECT_GRACE_MS });
}

function currentScreen(room) {
  if (room.stage === 'playing') return 'playing';
  if (room.stage === 'gameover') return 'gameover';
  if (room.stage === 'mapvote') return 'mapvote';
  return bothSeated(room) ? 'charselect' : 'waiting';
}
function startPayload(room) { return { type: 'start', p1: room.picks[0], p2: room.picks[1], mapId: room.mapId, tickHz: 60, snapEvery: SNAP_EVERY }; }

function beginMatch(room, mapId) {
  if (room.stage !== 'mapvote' || !bothSeated(room)) return;
  room.stage = 'playing'; room.mapId = mapId; room.tickCount = 0;
  room.inputs = [emptyInput(), emptyInput()];
  room.latch = [emptyInput(), emptyInput()];
  room.engine = createEngine();                              // motor só existe durante a partida
  room.engine.start(room.picks[0], room.picks[1], mapId);
  broadcast(room, startPayload(room));
  broadcast(room, { type: 'state', ...room.engine.snapshot() });
}

// ------------------------------------------------------------------ mensagens
function onMessage(ws, raw) {
  // anti-flood (token bucket)
  const t = now();
  ws._tokens = Math.min(MSG_BURST, (ws._tokens ?? MSG_BURST) + ((t - (ws._tokT || t)) / 1000) * MSG_RATE);
  ws._tokT = t;
  if (--ws._tokens < 0) return;

  let msg;
  try { msg = JSON.parse(raw.toString()); } catch (_) { return send(ws, { type: 'error', message: 'Mensagem inválida.' }); }
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'ping') return send(ws, { type: 'pong', t: msg.t });

  if (msg.type === 'create') {
    if (ws.roomCode) leave(ws);
    if (rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', message: 'Servidor cheio. Tenta daqui a pouco.' });
    const room = createRoom();
    const token = newToken();
    room.seats[0] = { ws, token, lostAt: 0 };
    rooms.set(room.code, room); ws.roomCode = room.code; ws.seat = 0; ws._seat = 0;
    return send(ws, { type: 'roomCreated', code: room.code, token });
  }
  if (msg.type === 'join') {
    if (ws.roomCode) leave(ws);
    const code = String(msg.code || '');
    const room = rooms.get(code);
    if (!room || room.stage !== 'waiting' || room.seats[1]) {
      ws._failedJoins = (ws._failedJoins || 0) + 1;
      if (ws._failedJoins >= 8) return ws.close(1008, 'Demasiadas tentativas');
      return send(ws, { type: 'error', message: 'Sala inexistente ou cheia.' });
    }
    const token = newToken();
    room.seats[1] = { ws, token, lostAt: 0 }; ws.roomCode = code; ws.seat = 1; ws._seat = 1;
    room.lastActive = now();
    send(ws, { type: 'joined', code, token });
    broadcast(room, { type: 'playerJoined' });
    broadcast(room, { type: 'screen', screen: 'charselect' });
    return;
  }
  if (msg.type === 'resume') {
    const room = rooms.get(String(msg.code || ''));
    const seatNo = msg.seat === 1 ? 1 : 0;
    const seat = room && room.seats[seatNo];
    if (!seat || seat.token !== msg.token) return send(ws, { type: 'resumeFailed' });
    if (seat.ws && seat.ws !== ws) { const old = seat.ws; old.roomCode = null; old.seat = null; try { old.terminate(); } catch (_) {} }
    seat.ws = ws; seat.lostAt = 0; ws.roomCode = room.code; ws.seat = seatNo; ws._seat = seatNo;
    room.lastActive = now();
    send(ws, {
      type: 'resumed', seat: seatNo, code: room.code, screen: currentScreen(room),
      p1: room.picks[0], p2: room.picks[1], mapId: room.mapId, tickHz: 60, snapEvery: SNAP_EVERY,
      votes: countVotes(room)
    });
    if (room.stage === 'playing' && room.engine) send(ws, { type: 'state', ...room.engine.snapshot(false) });
    const other = room.seats[1 - seatNo];
    if (other && other.ws) send(other.ws, { type: 'peerBack' });
    return;
  }

  const room = roomFor(ws);
  if (!room) return send(ws, { type: 'error', message: 'Entra numa sala primeiro.' });
  const seatNo = ws.seat;
  if (!room.seats[seatNo] || room.seats[seatNo].ws !== ws) return;
  room.lastActive = now();

  if (msg.type === 'input') {
    if (room.stage !== 'playing') return;
    const cur = room.inputs[seatNo], latch = room.latch[seatNo], inp = msg.inputs || {};
    for (const k of KEYS) { const v = !!inp[k]; cur[k] = v; if (v) latch[k] = true; }
    return;
  }
  if (msg.type === 'pick' && room.stage === 'waiting') {
    const char = String(msg.char || '');
    if (!catalog.CHARACTERS[char]) return;
    room.picks[seatNo] = char;
    broadcast(room, { type: 'picks', p1: room.picks[0], p2: room.picks[1] });
    return;
  }
  if (msg.type === 'ready' && seatNo === 0 && room.stage === 'waiting' && room.picks[0] && room.picks[1] && bothSeated(room)) {
    room.stage = 'mapvote'; room.votes = [null, null];
    broadcast(room, { type: 'screen', screen: 'mapvote' });
    broadcast(room, { type: 'voteUpdate', votes: {} });
    return;
  }
  if (msg.type === 'vote' && room.stage === 'mapvote') {
    const mapId = String(msg.mapId || '');
    if (!catalog.MAPS[mapId] || room.votes[seatNo]) return;
    room.votes[seatNo] = mapId;
    broadcast(room, { type: 'voteUpdate', votes: countVotes(room) });
    if (room.votes[0] && room.votes[1]) beginMatch(room, room.votes[0]); // empate de votos: vale o voto do Host
    return;
  }
  if (msg.type === 'leave') leave(ws, true);
}
function countVotes(room) {
  const counts = {};
  for (const v of room.votes) if (v) counts[v] = (counts[v] || 0) + 1;
  return counts;
}

// ------------------------------------------------------------------ HTTP (estático + gzip + ETag)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const fileCache = new Map(); // caminho -> {mtime, raw, gz, etag}
function loadFile(resolved, cb) {
  fs.stat(resolved, (err, st) => {
    if (err || !st.isFile()) return cb(err || new Error('not file'));
    const hit = fileCache.get(resolved);
    if (hit && hit.mtime === st.mtimeMs) return cb(null, hit);
    fs.readFile(resolved, (err2, raw) => {
      if (err2) return cb(err2);
      const ext = path.extname(resolved);
      const entry = { mtime: st.mtimeMs, raw, gz: null, etag: '"' + crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 16) + '"' };
      if (['.html', '.js', '.css', '.svg'].includes(ext)) entry.gz = zlib.gzipSync(raw, { level: 9 });
      fileCache.set(resolved, entry);
      cb(null, entry);
    });
  });
}
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('ok'); }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (_) { res.writeHead(400); return res.end(); }
  const file = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, file);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  loadFile(resolved, (err, entry) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(resolved);
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'ETag': entry.etag, 'X-Content-Type-Options': 'nosniff', 'Vary': 'Accept-Encoding'
    };
    if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); return res.end(); }
    let body = entry.raw;
    if (entry.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { body = entry.gz; headers['Content-Encoding'] = 'gzip'; }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  });
});
server.keepAliveTimeout = 65000;   // acima do timeout do proxy do Render
server.headersTimeout = 66000;

// ------------------------------------------------------------------ WebSocket
const wss = new WebSocketServer({ server, maxPayload: 2048, perMessageDeflate: false });
wss.on('connection', (ws, req) => {
  try { req.socket.setNoDelay(true); } catch (_) {}
  ws.roomCode = null; ws.seat = null; ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => { ws.isAlive = true; try { onMessage(ws, raw); } catch (e) { console.error('onMessage', e); } });
  ws.on('close', () => leave(ws, false));
  ws.on('error', () => { try { ws.terminate(); } catch (_) {} });
});

// Heartbeat: mantém o proxy aberto e deteta ligações mortas.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, HEARTBEAT_MS).unref();

// Limpeza: lugares perdidos há demasiado tempo e salas esquecidas.
setInterval(() => {
  const t = now();
  for (const room of [...rooms.values()]) {
    const lost = room.seats.find(s => s && !s.ws);
    if (lost && t - lost.lostAt > RECONNECT_GRACE_MS) { destroyRoom(room, { type: 'left' }); continue; }
    if (t - room.lastActive > IDLE_ROOM_MS && room.stage !== 'playing') destroyRoom(room, { type: 'left' });
  }
}, 2000).unref();

// ------------------------------------------------------------------ loop de simulação
// Passo fixo com acumulador: 60 Hz exatos mesmo com setTimeout impreciso (o setInterval(16.67)
// arredondava para 16/17 ms e deixava o jogo mais lento/rápido).
let acc = 0, last = performance.now();
function stepRoom(room) {
  if (room.stage !== 'playing' || !room.engine) return;
  if (!bothConnected(room)) return;                          // pausa enquanto alguém reconecta
  // inputs efetivos = estado atual OU toque ocorrido entre ticks
  const eff = [0, 1].map(i => { const o = {}; for (const k of KEYS) o[k] = room.inputs[i][k] || room.latch[i][k]; return o; });
  room.latch = [emptyInput(), emptyInput()];
  const S = room.engine.tick(eff);
  room.tickCount++;
  if (S.screen === 'gameover') {
    room.stage = 'gameover';
    const snap = room.engine.snapshot();
    broadcast(room, { type: 'state', ...snap });
    broadcast(room, { type: 'gameover', winnerIdx: snap.winnerIdx });
    room.engine = null;
    return;
  }
  if (room.tickCount % SNAP_EVERY === 0) broadcast(room, { type: 'state', ...room.engine.snapshot() });
}
function loop() {
  const t = performance.now();
  if (rooms.size === 0) { last = t; acc = 0; return; }
  acc += Math.min(t - last, TICK_MS * MAX_CATCHUP); last = t;
  while (acc >= TICK_MS) {
    acc -= TICK_MS;
    for (const room of rooms.values()) {
      try { stepRoom(room); } catch (e) { console.error('Erro na sala', room.code, e); destroyRoom(room, { type: 'error', message: 'Erro interno no servidor.' }); }
    }
  }
}
setInterval(loop, 4);

// ------------------------------------------------------------------ arranque / paragem
process.on('uncaughtException', e => console.error('uncaughtException', e));
process.on('unhandledRejection', e => console.error('unhandledRejection', e));
function shutdown() {
  for (const room of rooms.values()) broadcast(room, { type: 'error', message: 'Servidor a reiniciar. Volta a criar a sala em instantes.' });
  server.close(); setTimeout(() => process.exit(0), 500);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
server.listen(PORT, () => console.log(`Brawl Central ativo na porta ${PORT} (sim 60 Hz, snapshots ${SNAP_HZ} Hz)`));
