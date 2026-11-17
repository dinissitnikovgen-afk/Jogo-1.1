// Brawl Web — servidor central autoritativo
// A simulação de física, ataques, colisões, hazards e stocks corre neste processo.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const rooms = new Map();
const EMPTY = Object.freeze({left:false,right:false,jump:false,down:false,dodge:false,light:false,heavy:false,special:false});

function makeCanvasContext() {
  const base = {
    measureText: () => ({ width: 0 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => null,
    getImageData: () => ({ data: [] })
  };
  return new Proxy(base, {
    get(target, key) { return key in target ? target[key] : () => {}; },
    set(target, key, value) { target[key] = value; return true; }
  });
}
function makeCanvas() {
  const context = makeCanvasContext();
  return { width:1280, height:720, style:{}, addEventListener(){}, getContext(){return context;}, toDataURL(){return ''; } };
}
function createEngine() {
  let html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const match = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop();
  if (!match) throw new Error('Não foi possível carregar o motor do jogo.');
  let source = match[1];
  source = source.replace('loadTurn().then(testTurn);', '');
  source = source.replace('requestAnimationFrame(loop);', '');
  source = source.replace(
    "const EMPTY_INPUT = { left:false, right:false, jump:false, down:false, dodge:false, light:false, heavy:false, special:false };",
    "const EMPTY_INPUT = { left:false, right:false, jump:false, down:false, dodge:false, light:false, heavy:false, special:false };\nlet serverInputs = [{...EMPTY_INPUT},{...EMPTY_INPUT}];"
  );
  source = source.replace(
    "else { inputs = readInput(p.idx); }",
    "else { inputs = serverInputs[p.idx] || EMPTY_INPUT; }"
  );
  source += `\n;globalThis.__engine = {
    S, CHARACTERS, MAPS,
    configure() { isMultiplayer = true; isHost = false; S.mode = 'mp_host'; },
    start(p1, p2, mapId) { S.p1Char=p1; S.p2Char=p2; this.configure(); startGame(mapId, true); },
    tick(inputs) { serverInputs=inputs; update(1); S.frame += 1; return this.snapshot(); },
    snapshot() {
      return {
        mapId: S.map && S.map.id,
        frame: S.frame,
        shake: S.shake,
        screen: S.screen,
        winnerIdx: S.winner ? S.winner.idx : null,
        players: S.players.map(p => ({
          idx:p.idx,charId:p.charId,x:p.x,y:p.y,vx:p.vx,vy:p.vy,w:p.w,h:p.h,
          facing:p.facing,damage:p.damage,stocks:p.stocks,grounded:p.grounded,
          jumpsLeft:p.jumpsLeft,hitstun:p.hitstun,invuln:p.invuln,respawn:p.respawn,
          dodging:p.dodging,dodgeCd:p.dodgeCd,animState:p.animState,animTime:p.animTime,
          isAI:false,eliminated:p.eliminated,jumpHeld:p.jumpHeld,
          attack:p.attack ? {type:p.attack.type,timer:p.attack.timer,hitDone:p.attack.hitDone,waveDone:p.attack.waveDone} : null
        })),
        projectiles:S.projectiles.map(p=>({x:p.x,y:p.y,vx:p.vx,vy:p.vy,ownerIdx:p.ownerIdx,life:p.life,radius:p.radius,color:p.color,kind:p.kind})),
        particles:S.particles.slice(-50).map(p=>({x:p.x,y:p.y,vx:p.vx,vy:p.vy,life:p.life,max:p.max,color:p.color,size:p.size,text:p.text,dmgNum:p.dmgNum}))
      };
    }
  };`;

  const fakeCanvas = makeCanvas();
  const elements = {
    game: fakeCanvas,
    modalOverlay: { style:{} },
    modalInput: { value:'', focus(){}, blur(){}, addEventListener(){} }
  };
  const document = {
    getElementById(id) { return elements[id] || (elements[id]={style:{},addEventListener(){},focus(){},blur(){}}); },
    createElement() { return makeCanvas(); },
    fonts: { load() { return Promise.resolve(); } },
    write() {}
  };
  class FakeImage { constructor(){this.complete=false;this.naturalWidth=0;this.onload=null;} set src(v){this._src=v;} }
  const sandbox = {
    console, document,
    window:{addEventListener(){},location:{reload(){}}},
    location:{protocol:'https:',host:'localhost'},
    Image:FakeImage, performance:{now:()=>0}, requestAnimationFrame(){},
    setTimeout, clearTimeout, setInterval, clearInterval, alert(){},
    Math, Date, Map, Set, Promise, Number, String, Object, Array, JSON
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, {timeout:10000, filename:'brawl-engine.js'});
  const engine = sandbox.__engine;
  engine.configure();
  return engine;
}
const catalog = createEngine();

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}
function broadcast(room, payload) {
  for (const player of room.players) if (player && player.ws) send(player.ws, payload);
}
function validInput(input) {
  const out = {};
  for (const key of Object.keys(EMPTY)) out[key] = !!(input && input[key]);
  return out;
}
function roomCode() {
  let code;
  do { code = String(crypto.randomInt(100000, 1000000)); } while (rooms.has(code));
  return code;
}
function roomFor(ws) { return ws.roomCode && rooms.get(ws.roomCode); }
function statePacket(room) { return {type:'state', ...room.engine.snapshot(), mapId:room.mapId}; }
function broadcastState(room) { broadcast(room, statePacket(room)); }
function leave(ws) {
  const room = roomFor(ws);
  if (!room) return;
  const seat = ws.seat;
  if (room.players[seat] && room.players[seat].ws === ws) room.players[seat] = null;
  ws.roomCode = null; ws.seat = null;
  broadcast(room, {type:'left'});
  rooms.delete(room.code);
}
function beginMatch(room, mapId) {
  if (room.stage !== 'mapvote' || !room.players[0] || !room.players[1]) return;
  room.stage = 'playing'; room.mapId = mapId;
  room.inputs = [{...EMPTY},{...EMPTY}];
  room.engine.start(room.picks[0], room.picks[1], mapId);
  broadcast(room, {type:'start',p1:room.picks[0],p2:room.picks[1],mapId});
  broadcastState(room);
}
function onMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch (_) { return send(ws,{type:'error',message:'Mensagem inválida.'}); }
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'create') {
    if (ws.roomCode) leave(ws);
    const code = roomCode();
    const room = {code,stage:'waiting',players:[{ws},null],picks:[null,null],votes:[null,null],inputs:[{...EMPTY},{...EMPTY}],mapId:null,engine:createEngine()};
    rooms.set(code,room); ws.roomCode=code; ws.seat=0;
    return send(ws,{type:'roomCreated',code});
  }
  if (msg.type === 'join') {
    const code = String(msg.code || '');
    const room = rooms.get(code);
    if (!room || room.stage !== 'waiting' || room.players[1]) return send(ws,{type:'error',message:'Sala inexistente ou cheia.'});
    room.players[1]={ws}; ws.roomCode=code; ws.seat=1;
    send(ws,{type:'joined',code});
    broadcast(room,{type:'playerJoined'});
    broadcast(room,{type:'screen',screen:'charselect'});
    return;
  }
  const room = roomFor(ws);
  if (!room) return send(ws,{type:'error',message:'Entra numa sala primeiro.'});
  const seat = ws.seat;
  if (!room.players[seat] || room.players[seat].ws !== ws) return;
  if (msg.type === 'pick' && room.stage === 'waiting') {
    const char = String(msg.char || '');
    if (!catalog.CHARACTERS[char]) return;
    room.picks[seat]=char;
    broadcast(room,{type:'picks',p1:room.picks[0],p2:room.picks[1]});
    return;
  }
  if (msg.type === 'ready' && seat === 0 && room.stage === 'waiting' && room.picks[0] && room.picks[1]) {
    room.stage='mapvote'; room.votes=[null,null];
    broadcast(room,{type:'screen',screen:'mapvote'});
    broadcast(room,{type:'voteUpdate',votes:{}});
    return;
  }
  if (msg.type === 'vote' && room.stage === 'mapvote') {
    const mapId=String(msg.mapId || '');
    if (!catalog.MAPS[mapId] || room.votes[seat]) return;
    room.votes[seat]=mapId;
    const counts={}; for (const vote of room.votes) if (vote) counts[vote]=(counts[vote]||0)+1;
    broadcast(room,{type:'voteUpdate',votes:counts});
    if (room.votes[0] && room.votes[1]) {
      const selected = room.votes[0] === room.votes[1] ? room.votes[0] : room.votes[0];
      beginMatch(room,selected);
    }
    return;
  }
  if (msg.type === 'input' && room.stage === 'playing') {
    room.inputs[seat]=validInput(msg.inputs);
    return;
  }
  if (msg.type === 'leave') leave(ws);
}

const server = http.createServer((req,res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR,file);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(resolved,(err,data)=>{
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext=path.extname(resolved);
    const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'};
    res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-store'}); res.end(data);
  });
});
const wss = new WebSocketServer({server,maxPayload:16*1024});
wss.on('connection',ws=>{
  ws.roomCode=null; ws.seat=null;
  ws.on('message',raw=>onMessage(ws,raw));
  ws.on('close',()=>leave(ws));
  ws.on('error',()=>leave(ws));
});

// Tick de simulação fixo a 60 Hz, independente do FPS dos browsers.
setInterval(()=>{
  for (const room of rooms.values()) {
    if (room.stage !== 'playing' || !room.players[0] || !room.players[1]) continue;
    const state=room.engine.tick(room.inputs);
    if (state.screen === 'gameover') {
      room.stage='gameover';
      broadcast(room,{type:'gameover',winnerIdx:state.winnerIdx});
      broadcastState(room);
    }
  }
},1000/60);
// Estado visual a 30 Hz. A simulação continua a 60 Hz.
setInterval(()=>{
  for (const room of rooms.values()) if (room.stage === 'playing') broadcastState(room);
},1000/30);
server.listen(PORT,()=>console.log(`Brawl Central ativo na porta ${PORT}`));
