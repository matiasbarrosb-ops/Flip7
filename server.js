/*
 * Flip Siete — servidor de juego.
 * El servidor guarda la partida entera y solo envía a cada jugador lo que
 * puede ver. Los clientes mandan intenciones ("pido carta"), nunca resultados.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const GOAL = 200;
const BOT_NAMES = ['Vera', 'Nilo', 'Sura'];
const ROOM_TTL = 1000 * 60 * 60 * 3;   // salas abandonadas se borran a las 3 h

/* ---------------------------------------------------------------- mazo --- */
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function buildDeck() {
  const d = [{ t: 'n', v: 0 }];
  for (let v = 1; v <= 12; v++) for (let i = 0; i < v; i++) d.push({ t: 'n', v });
  [2, 4, 6, 8, 10].forEach(v => d.push({ t: 'm', v }));
  d.push({ t: 'x2' });
  for (let i = 0; i < 3; i++) {
    d.push({ t: 'a', a: 'freeze' });
    d.push({ t: 'a', a: 'flip3' });
    d.push({ t: 'a', a: 'second' });
  }
  return shuffle(d);
}
const ACT = { freeze: 'CONGELAR', flip3: 'VOLTEAR 3', second: '2.ª OPORTUNIDAD' };

/* --------------------------------------------------------------- motor --- */
const P = (G, id) => G.players.find(p => p.id === id);
const actives = G => G.players.filter(p => p.state === 'in');

function handCards(p) {
  const o = p.nums.map(v => ({ t: 'n', v }));
  p.mods.forEach(v => o.push({ t: 'm', v }));
  if (p.x2) o.push({ t: 'x2' });
  if (p.sc) o.push({ t: 'a', a: 'second' });
  return o;
}
function roundPts(p) {
  if (p.state === 'bust') return 0;
  let s = p.nums.reduce((a, b) => a + b, 0);
  if (p.x2) s *= 2;
  s += p.mods.reduce((a, b) => a + b, 0);
  if (p.nums.length === 7) s += 15;
  return s;
}
function note(G, t, k) {
  G.log.push({ t, k: k || '' });
  if (G.log.length > 40) G.log.splice(0, G.log.length - 40);
}
function takeCard(G) {
  if (!G.deck.length) {
    G.deck = shuffle(G.pile);
    G.pile = [];
    note(G, 'Mazo agotado: se baraja el descarte.');
  }
  return G.deck.pop();
}
function startRound(G) {
  G.deck = buildDeck();
  G.pile = [];
  G.endRound = false;
  G.pending = null;
  G.queue = null;
  G.players.forEach(p => {
    p.nums = []; p.mods = []; p.x2 = false; p.sc = false; p.state = 'in';
  });
  G.turn = (G.dealer + 1) % G.players.length;
  G.phase = 'play';
  note(G, 'Ronda ' + G.round + '. Reparte ' + G.players[G.dealer].name + '.', 'hi');
}
function optionsFor(G, pid, kind) {
  if (kind === 'second') return actives(G).filter(q => q.id !== pid && !q.sc).map(q => q.id);
  return actives(G).map(q => q.id);
}
function applyDraw(G, pid) {
  const p = P(G, pid), c = takeCard(G), who = p.name;
  if (c.t === 'n') {
    if (p.nums.includes(c.v)) {
      if (p.sc) {
        p.sc = false;
        G.pile.push(c, { t: 'a', a: 'second' });
        note(G, who + ' repite el ' + c.v + ' y quema su segunda oportunidad.', 'warm');
      } else {
        p.state = 'bust';
        G.pile.push(...handCards(p), c);
        note(G, who + ' repite el ' + c.v + ' y pierde la ronda.', 'bad');
      }
    } else {
      p.nums.push(c.v);
      p.nums.sort((a, b) => a - b);
      note(G, who + ' saca el ' + c.v + '.');
      if (p.nums.length === 7) {
        G.endRound = true;
        note(G, '¡' + who + ' junta siete distintos! +15 y se cierra la ronda.', 'hi');
      }
    }
  } else if (c.t === 'm') {
    p.mods.push(c.v);
    note(G, who + ' suma +' + c.v + '.');
  } else if (c.t === 'x2') {
    if (p.x2) p.mods.push(0);
    p.x2 = true;
    note(G, who + ' consigue ×2.');
  } else {
    if (c.a === 'second' && !p.sc) {
      p.sc = true;
      note(G, who + ' guarda una segunda oportunidad.');
    } else {
      const opts = optionsFor(G, pid, c.a);
      if (!opts.length) {
        G.pile.push(c);
        note(G, who + ' saca ' + ACT[c.a] + ' pero no hay a quién aplicarla.');
      } else if (opts.length === 1) {
        G.pending = { kind: c.a, chooser: pid };
        applyChoice(G, opts[0]);
      } else {
        G.pending = { kind: c.a, chooser: pid };
        note(G, who + ' saca ' + ACT[c.a] + '…', 'warm');
      }
    }
  }
}
function applyChoice(G, targetId) {
  const k = G.pending.kind, actor = P(G, G.pending.chooser), t = P(G, targetId);
  G.pending = null;
  if (k === 'second') {
    t.sc = true;
    note(G, actor.name + ' le regala una segunda oportunidad a ' + t.name + '.');
  } else if (k === 'freeze') {
    G.pile.push({ t: 'a', a: 'freeze' });
    note(G, actor.name + ' congela a ' + t.name + ' con ' + roundPts(t) + '.', 'warm');
    t.state = 'out';
  } else {
    G.pile.push({ t: 'a', a: 'flip3' });
    note(G, actor.name + ' obliga a ' + t.name + ' a voltear tres.', 'warm');
    G.queue = { player: targetId, left: 3 };
  }
}
function postStep(G) {
  if (G.pending) return;
  if (G.queue) {
    const q = P(G, G.queue.player);
    if (G.queue.left > 0 && q.state === 'in' && !G.endRound) return;
    G.queue = null;
  }
  if (G.endRound || !actives(G).length) return finishRound(G);
  let i = G.turn, guard = 0;
  do { i = (i + 1) % G.players.length; } while (G.players[i].state !== 'in' && guard++ < 20);
  G.turn = i;
}
function finishRound(G) {
  const parts = G.players.map(p => {
    const g = roundPts(p);
    p.total += g;
    G.pile.push(...handCards(p));
    return p.name + ' +' + g;
  });
  note(G, 'Fin de ronda · ' + parts.join(' · '), 'hi');
  G.phase = G.players.some(p => p.total >= GOAL) ? 'over' : 'between';
  G.dealer = (G.dealer + 1) % G.players.length;
  if (G.phase === 'over') {
    const best = G.players.reduce((a, b) => (a.total >= b.total ? a : b));
    note(G, 'Gana ' + best.name + ' con ' + best.total + '.', 'hi');
  }
}
function driverId(G) {
  if (G.phase !== 'play') return null;
  if (G.pending) return G.pending.chooser;
  if (G.queue && G.queue.left > 0) return G.queue.player;
  const p = G.players[G.turn];
  return p ? p.id : null;
}
function doHit(G, pid) {
  if (G.queue && G.queue.player === pid && G.queue.left > 0) G.queue.left--;
  applyDraw(G, pid);
  postStep(G);
}
function doStay(G, pid) {
  const p = P(G, pid);
  if (!p || p.state !== 'in') return;
  p.state = 'out';
  note(G, p.name + ' se planta con ' + roundPts(p) + '.');
  postStep(G);
}

/* ---------------------------------------------------------------- bots --- */
function deckOdds(G, p) {
  const pool = G.deck.length ? G.deck : G.pile;
  if (!pool.length || !p) return 0;
  return pool.filter(c => c.t === 'n' && p.nums.includes(c.v)).length / pool.length;
}
function botHit(G, p) {
  const risk = deckOdds(G, p), pts = roundPts(p);
  const lead = Math.max(...G.players.map(q => q.total));
  if (!p.nums.length) return true;
  if (p.nums.length === 6 && risk < 0.62) return true;
  if (p.sc && risk < 0.55) return true;
  if (p.total + pts >= GOAL && p.total >= lead && risk > 0.18) return false;
  const chase = lead - p.total > 45 ? 3 : 0;
  return risk < (7 + chase) / (7 + chase + pts);
}
function botChoice(G, pid, kind, opts) {
  const me = P(G, pid), others = opts.filter(id => id !== pid);
  if (kind === 'second') return others.reduce((a, b) => (P(G, a).total <= P(G, b).total ? a : b), others[0]);
  if (kind === 'freeze') {
    if (opts.includes(pid) && roundPts(me) >= 22 && deckOdds(G, me) > 0.32) return pid;
    if (!others.length) return pid;
    return others.reduce((a, b) => (roundPts(P(G, a)) >= roundPts(P(G, b)) ? a : b));
  }
  if (opts.includes(pid) && me.nums.length <= 1 && deckOdds(G, me) < 0.18) return pid;
  if (!others.length) return pid;
  return others.reduce((a, b) => (P(G, a).nums.length >= P(G, b).nums.length ? a : b));
}

/* ---------------------------------------------------------------- salas --- */
const rooms = new Map();   // code -> {G, conns:Map(playerId->Set(ws)), timer, touched}

function newRoom(code) {
  const room = {
    code,
    conns: new Map(),
    timer: null,
    touched: Date.now(),
    G: {
      code, round: 1, dealer: 0, turn: 0, phase: 'lobby', goal: GOAL,
      players: [], deck: [], pile: [], log: [],
      pending: null, queue: null, endRound: false, hostId: null, lastAction: Date.now()
    }
  };
  rooms.set(code, room);
  return room;
}

/** Lo que ve cada cliente: nunca el mazo, solo cuántas cartas quedan de cada número. */
function viewFor(room) {
  const G = room.G;
  const counts = {};
  const pool = G.deck.length ? G.deck : G.pile;
  pool.forEach(c => { if (c.t === 'n') counts[c.v] = (counts[c.v] || 0) + 1; });
  return {
    type: 'state',
    state: {
      code: G.code, phase: G.phase, round: G.round, goal: G.goal,
      hostId: G.hostId, turnId: driverId(G), pending: G.pending, queue: G.queue,
      log: G.log, deckLeft: pool.length, counts, lastAction: G.lastAction,
      players: G.players.map(p => ({
        id: p.id, name: p.name, bot: !!p.bot, total: p.total,
        nums: p.nums || [], mods: p.mods || [], x2: !!p.x2, sc: !!p.sc,
        state: p.state || 'in', online: !!p.bot || room.conns.has(p.id),
        pts: p.nums ? roundPts(p) : 0
      }))
    }
  };
}
function broadcast(room) {
  const msg = JSON.stringify(viewFor(room));
  room.conns.forEach(set => set.forEach(ws => {
    if (ws.readyState === 1) ws.send(msg);
  }));
}
function touch(room) {
  room.G.lastAction = Date.now();
  room.touched = Date.now();
}

/** Si al que le toca es un bot, juega solo tras una pausa. */
function scheduleBot(room) {
  clearTimeout(room.timer);
  const G = room.G;
  const id = driverId(G);
  if (!id) return;
  const p = P(G, id);
  const forced = G.queue && G.queue.player === id && G.queue.left > 0;
  if (!p || (!p.bot && !forced)) return;
  if (!p.bot && forced && room.conns.has(id)) return;   // humano presente: voltea él
  room.timer = setTimeout(() => {
    if (G.pending && G.pending.chooser === id) {
      applyChoice(G, botChoice(G, id, G.pending.kind, optionsFor(G, id, G.pending.kind)));
      postStep(G);
    } else if (G.queue && G.queue.player === id && G.queue.left > 0) {
      doHit(G, id);
    } else if (p.bot) {
      botHit(G, p) ? doHit(G, id) : doStay(G, id);
    }
    touch(room);
    broadcast(room);
    scheduleBot(room);
  }, 700);
}

function cleanName(s) {
  return String(s || '').replace(/[<>]/g, '').trim().slice(0, 14) || 'Jugador';
}

/* ------------------------------------------------------------ mensajes --- */
function handle(ws, msg) {
  const room = ws.room;

  if (msg.type === 'join') {
    const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (code.length < 3) return ws.send(JSON.stringify({ type: 'error', msg: 'Código inválido.' }));
    const r = rooms.get(code) || newRoom(code);
    const id = String(msg.id || '').slice(0, 40);
    const name = cleanName(msg.name);
    ws.room = r; ws.pid = id;
    if (!r.conns.has(id)) r.conns.set(id, new Set());
    r.conns.get(id).add(ws);

    const existing = P(r.G, id);
    if (existing) existing.name = name;                       // vuelve a entrar
    else if (r.G.phase === 'lobby') {
      if (r.G.players.length >= 8)
        return ws.send(JSON.stringify({ type: 'error', msg: 'La mesa está llena.' }));
      r.G.players.push({ id, name, bot: false, total: 0, nums: [], mods: [], x2: false, sc: false, state: 'in' });
    } else {
      ws.send(JSON.stringify({ type: 'error', msg: 'La partida ya empezó. Entras como espectador.' }));
    }
    if (!r.G.hostId) r.G.hostId = id;
    touch(r); broadcast(r); scheduleBot(r);
    return;
  }

  if (!room) return;
  const G = room.G;
  const me = ws.pid;

  if (msg.type === 'addBot') {
    if (me !== G.hostId || G.phase !== 'lobby') return;
    const used = G.players.filter(p => p.bot).length;
    if (G.players.length >= 8 || used >= 3) return;
    G.players.push({
      id: 'bot' + used, name: BOT_NAMES[used], bot: true, total: 0,
      nums: [], mods: [], x2: false, sc: false, state: 'in'
    });
    touch(room); broadcast(room);
    return;
  }

  if (msg.type === 'start' || msg.type === 'next') {
    if (me !== G.hostId) return;
    if (msg.type === 'start' && G.phase !== 'lobby') return;
    if (msg.type === 'next' && G.phase !== 'between' && G.phase !== 'over') return;
    if (G.players.length < 2) return ws.send(JSON.stringify({ type: 'error', msg: 'Hacen falta al menos dos jugadores.' }));
    if (G.phase === 'over') { G.players.forEach(p => (p.total = 0)); G.round = 0; G.log = []; }
    if (msg.type === 'next') G.round++;
    startRound(G);
    touch(room); broadcast(room); scheduleBot(room);
    return;
  }

  if (G.phase !== 'play') return;
  const driver = driverId(G);

  if (msg.type === 'hit' && driver === me) { doHit(G, me); }
  else if (msg.type === 'stay' && driver === me) { doStay(G, me); }
  else if (msg.type === 'choice' && G.pending && G.pending.chooser === me) {
    const opts = optionsFor(G, me, G.pending.kind);
    if (!opts.includes(msg.target)) return;
    applyChoice(G, msg.target);
    postStep(G);
  }
  else if (msg.type === 'skip') {
    // cualquiera puede plantar al que lleva 30 s sin mover
    if (!driver || driver === me || Date.now() - G.lastAction < 30000) return;
    doStay(G, driver);
    note(G, 'Turno saltado por inactividad.', 'warm');
  }
  else return;

  touch(room); broadcast(room); scheduleBot(room);
}

/* ------------------------------------------------------------ servidor --- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = url === '/' ? '/index.html' : url;
  const full = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('No existe'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { handle(ws, msg); } catch (e) { console.error('fallo al procesar', e); }
  });
  ws.on('close', () => {
    const r = ws.room;
    if (!r) return;
    const set = r.conns.get(ws.pid);
    if (set) { set.delete(ws); if (!set.size) r.conns.delete(ws.pid); }
    // en el lobby, quien se va deja su asiento
    if (r.G.phase === 'lobby') {
      r.G.players = r.G.players.filter(p => p.bot || r.conns.has(p.id));
      if (r.G.hostId === ws.pid) r.G.hostId = (r.G.players.find(p => !p.bot) || {}).id || null;
    }
    broadcast(r);
    scheduleBot(r);
  });
});

// conexiones muertas y salas abandonadas
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
  const now = Date.now();
  rooms.forEach((r, code) => {
    if (!r.conns.size && now - r.touched > ROOM_TTL) { clearTimeout(r.timer); rooms.delete(code); }
  });
}, 30000);

server.listen(PORT, () => console.log('Flip Siete escuchando en http://localhost:' + PORT));
