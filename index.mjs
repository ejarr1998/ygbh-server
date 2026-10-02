// Yard Goats vs Ball Hogs — realtime lobby + match server (TRD §3–4)
// Node + ws, in-memory rooms, server-authoritative at 15Hz. $0 hosting target.
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8787;
const wss = new WebSocketServer({ port: PORT });

let nextId = 1;
const rooms = new Map();

const MODES = {
  practice2: { teams: false, roles: ['QB', 'WR'] },
  rotate3: { teams: false, roles: ['QB', 'WR', 'DB'] },
  teams4: { teams: true, roles: ['QB', 'WR', 'DE', 'CB'] },
};

const DEFAULT_SETTINGS = {
  ptsCatch: 1, ptsINT: 1, targetScore: 5, triesPerPossession: 3,
  preSnapSec: 12, qbTimerSec: 6,
};

const SPEED = { QB: 6, WR: 8.5, DE: 7.5, CB: 8.5, DB: 8.5 };
const FIELD = { losX: 0, markerX: 7, maxX: 32, halfW: 8.5 }; // maxX = back of the painted end zone (x 25..33)

// ---------- helpers ----------
const sleep = () => {}; // (timers use tick loop)
function pubRooms() {
  const list = [...rooms.values()].filter(r => r.phase === 'lobby')
    .map(r => ({ id: r.id, host: r.players.find(p => p.id === r.hostId)?.nickname, mode: r.mode, filled: r.players.length, max: MODES[r.mode].roles.length }));
  const msg = JSON.stringify({ t: 'rooms', list });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}
function pubState(room) {
  const msg = JSON.stringify({ t: 'state', room: pubRoom(room) });
  for (const p of room.players) p.ws?.readyState === 1 && p.ws.send(msg);
}
function pubRoom(r) {
  return {
    id: r.id, hostId: r.hostId, mode: r.mode, phase: r.phase, settings: r.settings,
    players: r.players.map(p => ({ id: p.id, nickname: p.nickname, team: p.team, role: p.role, ready: p.ready, cameraPref: p.cameraPref || 'classic', gone: !!p.gone })),
    match: r.match ? pubMatch(r.match) : null,
  };
}
function pubMatch(m) {
  return {
    phase: m.phase, scores: m.scores, banked: m.banked, tryNumber: m.tryNumber,
    totalTries: m.totalTries, roles: m.roles, possession: m.possession,
    outcome: m.outcome, winner: m.winner,
    clock: m.clock, paused: m.paused || null,
    route: m.route || null,
    pressure: m.pressure || null,
    snap: m.phase === 'live' || m.phase === 'presnap' ? {
      positions: m.positions, ball: m.ball, time: m.time,
    } : null,
  };
}
function sanitizeName(n) { return String(n || '').slice(0, 12).replace(/[<>]/g, '') || 'Player'; }

// ---------- match engine ----------
function startMatch(room) {
  const s = room.settings;
  room.match = {
    phase: 'presnap', time: s.preSnapSec,
    scores: room.mode === 'rotate3' ? Object.fromEntries(room.players.map(p => [p.id, 0])) : { goats: 0, hogs: 0 },
    banked: { goats: 0, hogs: 0 },
    tryNumber: 0, totalTries: room.mode === 'rotate3' ? 9 : Infinity,
    possession: { offense: 'goats' },
    roles: {}, schedule: [], schedIdx: 0,
    positions: {}, inputs: {}, ball: null,
    clock: null, outcome: null, winner: null,
  };
  const m = room.match;

  if (room.mode === 'rotate3') {
    // 3 rounds; each round every player plays each role once
    const ids = room.players.map(p => p.id);
    const perms = [
      [['QB', 'WR', 'DB']],
      [['WR', 'DB', 'QB']],
      [['DB', 'QB', 'WR']],
    ];
    m.schedule = perms.flatMap(perm => perm.map(roles => Object.fromEntries(ids.map((id, i) => [id, roles[i]]))));
  }
  assignRoles(room);
  resetPlay(room);
  room.timer = setInterval(() => tick(room, 1 / 15), 66);
  pubState(room);
}

function assignRoles(room) {
  const m = room.match;
  if (room.mode === 'rotate3') {
    m.roles = m.schedule[m.schedIdx];
  } else {
    m.roles = Object.fromEntries(room.players.map(p => [p.id, p.role]));
  }
}

function playersByRole(room, role) {
  return room.players.filter(p => room.match.roles[p.id] === role);
}

function resetPlay(room) {
  const m = room.match;
  m.phase = 'presnap';
  m.time = room.settings.preSnapSec;
  m.clock = null;
  m.ball = null;
  m.outcome = null;
  m.inputs = {};
  m.route = null;
  m.pressure = null;
  m.positions = {};
  const put = (role, x, z) => playersByRole(room, role).forEach(p => { m.positions[p.id] = { x, z }; });
  put('QB', -1.5, 0); put('WR', -0.5, 3);
  put('DE', 0.5, -1); put('CB', 2, 3.5); put('DB', 2.5, 3);
}

function roleOf(room, id) { return room.match.roles[id]; }
function teamOf(room, id) { return room.players.find(p => p.id === id)?.team; }

function resolveOutcome(room, kind, scorerId) {
  const m = room.match;
  const s = room.settings;
  m.phase = 'recap'; m.time = 3;
  m.outcome = { kind };
  const catchScored = kind === 'catch';

  if (room.mode === 'rotate3') {
    if (kind === 'catch') {
      for (const r of ['QB', 'WR']) playersByRole(room, r).forEach(p => m.scores[p.id] += s.ptsCatch);
      m.outcome.text = `Catch! +${s.ptsCatch} QB & WR`;
    } else if (kind === 'int') {
      playersByRole(room, 'DB').forEach(p => m.scores[p.id] += s.ptsINT);
      m.outcome.text = `Interception! +${s.ptsINT} DB`;
    } else if (kind === 'sack') m.outcome.text = 'Sack!';
    else m.outcome.text = 'Incomplete';
  } else {
    const teams = room.mode === 'teams4';
    const off = m.possession.offense;
    const def = off === 'goats' ? 'hogs' : 'goats';
    if (kind === 'catch') {
      m.scores[teams ? off : 'goats'] += s.ptsCatch; // practice2 single "team"
      m.outcome.text = `Catch! +${s.ptsCatch}`;
    } else if (kind === 'int') {
      m.scores[teams ? def : 'hogs'] += s.ptsINT;
      if (teams) m.banked[def] += s.ptsINT;
      m.outcome.text = `Interception! +${s.ptsINT}${teams ? ' (carries over)' : ''}`;
    } else if (kind === 'sack') m.outcome.text = 'Sack!';
    else m.outcome.text = 'Incomplete';
  }

  // match end checks
  if (room.mode === 'rotate3') {
    if (m.tryNumber + 1 >= m.totalTries) {
      const ids = room.players.map(p => p.id);
      const best = Math.max(...ids.map(id => m.scores[id]));
      const tops = ids.filter(id => m.scores[id] === best);
      if (m.tryNumber + 1 >= m.totalTries && tops.length === 1) {
        m.pendingEnd = { winner: tops[0] };
      } // tie → overtime plays continue
    }
  } else {
    const sMax = Math.max(m.scores.goats, m.scores.hogs);
    if (sMax >= s.targetScore) m.pendingEnd = { winner: m.scores.goats >= s.targetScore ? (room.mode === 'teams4' ? 'goats' : 'goats') : 'hogs' };
  }
}

function advancePlay(room) {
  const m = room.match;
  if (m.pendingEnd) { endMatch(room, m.pendingEnd.winner); return; }

  const s = room.settings;
  m.tryNumber++;
  if (room.mode === 'rotate3') {
    m.schedIdx = m.tryNumber; // schedule advances every try; rounds wrap by schedule length
    if (m.schedIdx >= m.schedule.length) m.schedIdx = 0; // overtime: replay schedule
    assignRoles(room);
    resetPlay(room);
    return;
  }
  if (room.mode === 'teams4') {
    const cycleDone = (m.tryNumber % s.triesPerPossession) === 0;
    if (cycleDone) {
      // roles swap with fixed counterparts QB<->DE, WR<->CB; possession flips
      for (const p of room.players) {
        p.role = { QB: 'DE', DE: 'QB', WR: 'CB', CB: 'WR' }[p.role];
      }
      m.roles = Object.fromEntries(room.players.map(p => [p.id, p.role]));
      m.possession.offense = m.possession.offense === 'goats' ? 'hogs' : 'goats';
    }
    resetPlay(room);
  } else {
    resetPlay(room); // practice2: same try repeated
  }
}

function endMatch(room, winner) {
  const m = room.match;
  m.phase = 'over';
  m.winner = winner;
  clearInterval(room.timer);
  pubState(room);
}

function tick(room, dt) {
  const m = room.match;
  if (!m) return;

  // FR-11: freeze the try while a player is reconnecting
  if (room.players.some(p => p.gone)) {
    m.paused = m.paused || room.players.find(p => p.gone)?.id || null;
    const msg = JSON.stringify({ t: 'state', room: pubRoom(room) });
    for (const p of room.players) p.ws?.readyState === 1 && p.ws.send(msg);
    return;
  }
  if (m.paused) m.paused = null;

  if (m.phase === 'presnap') {
    m.time -= dt;
    if (m.time <= 0) {
      m.phase = 'live';
      if (room.mode === 'rotate3') m.clock = room.settings.qbTimerSec;
      m.ball = { state: 'held', by: playersByRole(room, 'QB')[0]?.id };
    }
  } else if (m.phase === 'live') {
    stepLive(room, dt);
  } else if (m.phase === 'recap') {
    m.time -= dt;
    if (m.time <= 0) advancePlay(room);
  }
  // broadcast snapshot at 15Hz
  const msg = JSON.stringify({ t: 'state', room: pubRoom(room) });
  for (const p of room.players) p.ws?.readyState === 1 && p.ws.send(msg);
}

function stepLive(room, dt) {
  const m = room.match;
  // movement integration
  for (const p of room.players) {
    const pos = m.positions[p.id];
    if (!pos) continue;
    const inp = m.inputs[p.id] || { mx: 0, mz: 0 };
    const sp = SPEED[m.roles[p.id]] || 7;
    pos.x += inp.mx * sp * dt;
    pos.z += inp.mz * sp * dt;
    // bounds
    pos.x = Math.max(-4, Math.min(FIELD.maxX, pos.x));
    pos.z = Math.max(-FIELD.halfW, Math.min(FIELD.halfW, pos.z));
    // QB cannot cross the line of scrimmage
    if (m.roles[p.id] === 'QB') pos.x = Math.min(FIELD.losX, pos.x);
    if (m.roles[p.id] !== 'QB') pos.x = Math.max(FIELD.losX - 2, pos.x);
  }

  // 3P QB clock ("the clock plays DB")
  if (room.mode === 'rotate3' && m.clock != null) {
    m.clock -= dt;
    if (m.clock <= 0) { resolveOutcome(room, 'sack'); return; }
  }

  // ball flight
  if (m.ball?.state === 'flying') {
    const b = m.ball;
    b.vy -= 22 * dt;
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
    // catch windows
    const catcherRole = b.target; // 'WR' or general
    for (const p of room.players) {
      const role = m.roles[p.id];
      if (role !== 'WR' && role !== 'CB' && role !== 'DB') continue;
      const pos = m.positions[p.id];
      const d = Math.hypot(pos.x - b.x, pos.z - b.z, (1.6 - b.y) * 0.6);
      const wants = (m.inputs[p.id]?.act === 'catch' || m.inputs[p.id]?.act === 'int');
      if (d < 1.3 && wants) {
        if (role === 'WR') {
          // 7-yard rule
          if (pos.x >= FIELD.markerX) { m.ball.state = 'dead'; resolveOutcome(room, 'catch'); return; }
          m.ball.state = 'dead'; resolveOutcome(room, 'incomplete', null); return;
        } else {
          m.ball.state = 'dead'; resolveOutcome(room, 'int'); return;
        }
      }
    }
    if (b.y <= 0.25) { m.ball.state = 'dead'; resolveOutcome(room, 'incomplete'); return; }
    if (b.x > FIELD.maxX + 5) { m.ball.state = 'dead'; resolveOutcome(room, 'incomplete'); return; }
  }

  // sack check: DE/DB in range of QB with tackle input
  const qb = playersByRole(room, 'QB')[0];
  if (qb) {
    const qpos = m.positions[qb.id];
    for (const p of room.players) {
      const role = m.roles[p.id];
      if (role !== 'DE' && role !== 'DB') continue;
      const pos = m.positions[p.id];
      if (Math.hypot(pos.x - qpos.x, pos.z - qpos.z) < 1.2 && m.inputs[p.id]?.act === 'tackle') {
        resolveOutcome(room, 'sack'); return;
      }
    }
  }

  // pressure indicator for Under Center QB
  const qbp = playersByRole(room, 'QB')[0];
  m.pressure = null;
  if (qbp && qbp.cameraPref === 'undercenter') {
    const qpos = m.positions[qbp.id];
    let nearest = null, nd = 2.0;
    for (const p of room.players) {
      const role = m.roles[p.id];
      if (role !== 'DE' && role !== 'DB') continue;
      const pos = m.positions[p.id];
      const d = Math.hypot(pos.x - qpos.x, pos.z - qpos.z);
      if (d < nd) { nd = d; nearest = pos; }
    }
    if (nearest) m.pressure = { side: nearest.z >= qpos.z ? 'right' : 'left' };
  }

  // clear one-shot act inputs each tick
  for (const id of Object.keys(m.inputs)) m.inputs[id].act = null;
}

function throwBall(room, playerId, dx, dz, power) {
  const m = room.match;
  if (m.phase !== 'live' || m.ball?.state !== 'held' || m.ball.by !== playerId) return;
  const from = m.positions[playerId];
  const len = Math.hypot(dx, dz) || 1;
  dx /= len; dz /= len;
  const spd = 16 + 12 * Math.min(1, Math.max(0, power));
  const elev = Math.PI / 9 + (Math.PI / 5) * Math.min(1, Math.max(0, power));
  m.ball = {
    state: 'flying', x: from.x, y: 1.8, z: from.z,
    vx: Math.cos(elev) * spd * dx, vy: Math.sin(elev) * spd, vz: Math.cos(elev) * spd * dz,
  };
}

// ---------- connection handling ----------
wss.on('connection', (ws) => {
  const me = { id: 'p' + nextId++, nickname: '', ws, room: null, team: null, role: null, ready: false };
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const room = me.room ? rooms.get(me.room) : null;

    switch (m.t) {
      case 'hello': {
        me.nickname = sanitizeName(m.nickname);
        me.pid = String(m.pid || '').slice(0, 32) || null;
        // FR-11 reattach: a reconnecting client resumes its old seat (state intact)
        const rr = m.roomId ? rooms.get(String(m.roomId)) : null;
        const seat = rr?.players.find(p => p.pid && p.pid === me.pid && p.gone);
        if (rr && seat) {
          clearTimeout(seat.graceTimer);
          const idx = rr.players.indexOf(seat);
          me.id = seat.id; me.nickname = seat.nickname; me.team = seat.team; me.role = seat.role;
          me.ready = seat.ready; me.cameraPref = seat.cameraPref; me.room = rr.id;
          rr.players[idx] = me;
          if (rr.match && !rr.players.some(p => p.gone)) rr.match.paused = null;
          ws.send(JSON.stringify({ t: 'welcome', id: me.id, rejoined: rr.id }));
          pubState(rr); pubRooms();
          break;
        }
        ws.send(JSON.stringify({ t: 'welcome', id: me.id }));
        pubRooms();
        break;
      }

      case 'create': {
        if (room || !MODES[m.mode]) return;
        me.nickname = sanitizeName(m.nickname || me.nickname);
        const id = Math.random().toString(36).slice(2, 6).toUpperCase();
        const r = { id, mode: m.mode, hostId: me.id, phase: 'lobby', settings: { ...DEFAULT_SETTINGS }, players: [me], match: null };
        rooms.set(id, r);
        me.room = id;
        ws.send(JSON.stringify({ t: 'joined', roomId: id, you: me.id }));
        pubState(r); pubRooms();
        break;
      }

      case 'list':
        ws.send(JSON.stringify({ t: 'rooms', list: [...rooms.values()].filter(r => r.phase === 'lobby').map(r => ({ id: r.id, host: r.players.find(p => p.id === r.hostId)?.nickname, mode: r.mode, filled: r.players.length, max: MODES[r.mode].roles.length })) }));
        break;

      case 'join': {
        if (room) return;
        const r = rooms.get(m.roomId);
        if (!r || r.phase !== 'lobby') return ws.send(JSON.stringify({ t: 'error', msg: 'Room unavailable' }));
        if (r.players.length >= MODES[r.mode].roles.length) return ws.send(JSON.stringify({ t: 'error', msg: 'Room is full' }));
        me.nickname = sanitizeName(m.nickname || me.nickname);
        me.room = r.id; r.players.push(me);
        ws.send(JSON.stringify({ t: 'joined', roomId: r.id, you: me.id }));
        pubState(r); pubRooms();
        break;
      }

      case 'claim': {
        if (!room) return;
        const mode = MODES[room.mode];
        if (me.ready) me.ready = false;
        if (mode.teams) {
          const team = m.team === 'goats' || m.team === 'hogs' ? m.team : null;
          if (!team) return;
          const mates = room.players.filter(p => p.team === team && p.id !== me.id);
          if (mates.length >= 2 && me.team !== team) return;
          me.team = team;
          if (m.role) {
            if (!mode.roles.includes(m.role)) return;
            if (room.players.some(p => p.id !== me.id && p.role === m.role)) return;
            me.role = m.role;
          }
        } else {
          if (!mode.roles.includes(m.role)) return;
          if (room.players.some(p => p.id !== me.id && p.role === m.role)) return;
          me.role = m.role;
        }
        pubState(room);
        break;
      }

      case 'ready': me.ready = !!m.v; pubState(room); break;

      case 'start': {
        if (!room || room.hostId !== me.id) return;
        const mode = MODES[room.mode];
        if (room.players.length < mode.roles.length) return ws.send(JSON.stringify({ t: 'error', msg: 'Need more players' }));
        if (!room.players.every(p => p.role)) return ws.send(JSON.stringify({ t: 'error', msg: 'Everyone needs a role' }));
        if (!room.players.every(p => p.ready)) return ws.send(JSON.stringify({ t: 'error', msg: 'Everyone must be ready' }));
        room.phase = 'match';
        startMatch(room); pubRooms();
        break;
      }

      // ---- match messages ----
      case 'input': if (room?.match) { room.match.inputs[me.id] = { mx: +m.mx || 0, mz: +m.mz || 0, act: m.act || room.match.inputs[me.id]?.act || null }; } break;
      case 'throw': if (room?.match) throwBall(room, me.id, +m.dx || 1, +m.dz || 0, +m.power || 0.5); break;

      case 'rematch': {
        if (!room || room.hostId !== me.id || room.match?.phase !== 'over') return;
        clearInterval(room.timer);
        room.phase = 'match';
        startMatch(room);
        break;
      }

      case 'leave': {
        if (!room) return;
        clearTimeout(me.graceTimer);
        room.players = room.players.filter(p => p.id !== me.id);
        me.room = null; me.team = null; me.role = null; me.ready = false;
        if (!room.players.length) { cleanup(room); rooms.delete(room.id); }
        else {
          if (room.hostId === me.id) room.hostId = room.players[0].id;
          if (room.match && room.match.phase !== 'over') { endMatch(room, 'left'); }
          else pubState(room);
        }
        pubRooms();
        break;
      }

      case 'settings': { // host only, lobby phase
        if (!room || room.hostId !== me.id || room.phase !== 'lobby') return;
        for (const k of ['ptsCatch', 'ptsINT', 'targetScore', 'triesPerPossession', 'preSnapSec', 'qbTimerSec']) {
          if (typeof m[k] === 'number' && isFinite(m[k])) room.settings[k] = Math.max(1, Math.min(60, m[k]));
        }
        pubState(room);
        break;
      }

      case 'camera': // per-player QB camera preference
        me.cameraPref = m.pref === 'undercenter' ? 'undercenter' : 'classic';
        if (room) pubState(room);
        break;

      case 'route': { // QB draws route during presnap → relay to offense only
        const mm = room?.match;
        if (!mm || mm.phase !== 'presnap') return;
        if (mm.roles[me.id] !== 'QB') return;
        const pts = Array.isArray(m.pts) ? m.pts.slice(0, 64).map(pt => ({ x: +pt.x || 0, z: +pt.z || 0 })) : [];
        mm.route = pts;
        const msg = JSON.stringify({ t: 'route', pts });
        for (const p of room.players) {
          const r = mm.roles[p.id];
          if ((r === 'QB' || r === 'WR') && p.ws?.readyState === 1) p.ws.send(msg);
        }
        break;
      }

      case 'snapnow': { // QB ends presnap early
        const mm = room?.match;
        if (!mm || mm.phase !== 'presnap' || mm.roles[me.id] !== 'QB') return;
        mm.time = 0;
        break;
      }

      case 'ping': ws.send(JSON.stringify({ t: 'pong' })); break;
    }
  });

  ws.on('close', () => {
    const room = me.room ? rooms.get(me.room) : null;
    if (!room) return;
    // FR-11: hold the seat for 60s so a dropped player can auto-rejoin
    me.gone = true; me.ws = null;
    if (room.match && (room.match.phase === 'presnap' || room.match.phase === 'live')) room.match.paused = me.id;
    me.graceTimer = setTimeout(() => finalizeLeave(room, me), 60000);
    pubState(room); pubRooms();
  });
});

function cleanup(room) { if (room.timer) clearInterval(room.timer); }

function finalizeLeave(room, p) {
  if (!p.gone) return; // reattached in time
  room.players = room.players.filter(x => x.id !== p.id);
  if (!room.players.length) { cleanup(room); rooms.delete(room.id); }
  else {
    if (room.hostId === p.id) room.hostId = room.players[0].id;
    if (room.match && room.match.phase !== 'over') endMatch(room, 'left');
    else pubState(room);
  }
  pubRooms();
}

console.log(`YGBH server listening on :${PORT}`);