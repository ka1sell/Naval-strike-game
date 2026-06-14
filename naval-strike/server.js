const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ───────────────────────────────────────────────
// KONSTANTA GAME
// ───────────────────────────────────────────────
const SIZE = 8;
const COLS = 'ABCDEFGH';
const SHIP_LEN = 3;
const MAX_TEAMS = 6;
const TEAM_COLORS = ['#ff5d5d', '#2dd4bf', '#f5c542', '#a78bfa', '#fb923c', '#60a5fa'];
const START_POINTS = 500;

// Poin
const POINT_QUIZ_CORRECT = 100;
const POINT_QUIZ_WRONG = -100;     // manual oleh admin
const POINT_FIND_SHIP = 100;       // berhasil menemukan posisi kapal lawan (hit)
const POINT_ELIM_PENALTY = [-200, -150, -100]; // gugur ke-1, ke-2, ke-3
const POINT_SURVIVE_BONUS = { 1: 75, 2: 150, 3: 200 }; // sisa nyawa -> bonus saat game selesai

// ───────────────────────────────────────────────
// STATE: in-memory rooms
// ───────────────────────────────────────────────
// rooms = { [roomCode]: roomState }
const rooms = {};

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function emptyBoard() {
  // board[r][c] = array of teamId yang punya kapal di sel ini
  return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => []));
}
function emptyRevealed() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(null)); // 'hit' | 'miss' | null
}

function createRoom() {
  const code = genRoomCode();
  rooms[code] = {
    code,
    phase: 'lobby', // lobby -> deploy -> battle -> over
    teams: Array.from({ length: MAX_TEAMS }, (_, i) => ({
      id: i,
      slot: i,
      name: `Tim ${i + 1}`,
      color: TEAM_COLORS[i],
      connected: false,
      socketId: null,
      cells: null,       // posisi kapal [[r,c],...]
      orientation: 'h',
      placed: false,
      hits: 0,           // jumlah petak kapal milik tim ini yang sudah ditembak
      lives: SHIP_LEN,   // nyawa tersisa = SHIP_LEN - hits
      points: START_POINTS,
      eliminated: false,
      eliminatedOrder: null,
    })),
    board: emptyBoard(),
    revealed: emptyRevealed(),
    activeTeamId: null,  // tim yang sedang diizinkan menembak
    pendingFire: null,   // {r,c}
    elimCounter: 0,
    log: [], // riwayat aksi untuk admin
  };
  return rooms[code];
}

function publicTeam(team) {
  return {
    id: team.id,
    name: team.name,
    color: team.color,
    connected: team.connected,
    placed: team.placed,
    hits: team.hits,
    lives: team.lives,
    points: team.points,
    eliminated: team.eliminated,
    eliminatedOrder: team.eliminatedOrder,
  };
}

// State yang dikirim ke ADMIN (lihat semua, termasuk posisi kapal)
function roomStateForAdmin(room) {
  return {
    code: room.code,
    phase: room.phase,
    teams: room.teams.map(t => ({
      ...publicTeam(t),
      cells: t.cells,
    })),
    board: room.board,
    revealed: room.revealed,
    activeTeamId: room.activeTeamId,
    pendingFire: room.pendingFire,
    log: room.log.slice(-30),
  };
}

// State yang dikirim ke PESERTA (tidak ada posisi kapal lawan)
function roomStateForPlayer(room, teamId) {
  const self = room.teams[teamId];
  return {
    code: room.code,
    phase: room.phase,
    myTeamId: teamId,
    myName: self.name,
    myColor: self.color,
    myCells: self.cells,
    myHits: self.hits,
    myLives: self.lives,
    myPoints: self.points,
    myPlaced: self.placed,
    myEliminated: self.eliminated,
    teams: room.teams.map(publicTeam),
    revealed: room.revealed, // hanya hit/miss, tidak ada lokasi kapal tersembunyi
    activeTeamId: room.activeTeamId,
    canIFire: room.phase === 'battle' && room.activeTeamId === teamId && !self.eliminated,
    log: room.log.slice(-10),
  };
}

function broadcastRoom(room) {
  io.to(`${room.code}:admin`).emit('state', roomStateForAdmin(room));
  room.teams.forEach(t => {
    if (t.connected && t.socketId) {
      io.to(t.socketId).emit('state', roomStateForPlayer(room, t.id));
    }
  });
}

function addLog(room, msg) {
  room.log.push({ ts: Date.now(), msg });
  if (room.log.length > 100) room.log.shift();
}

function shipCells(r, c, orient) {
  const cells = [];
  for (let i = 0; i < SHIP_LEN; i++) {
    const rr = orient === 'h' ? r : r + i;
    const cc = orient === 'h' ? c + i : c;
    if (rr >= SIZE || cc >= SIZE) return null;
    cells.push([rr, cc]);
  }
  return cells;
}

function allPlaced(room) {
  return room.teams.every(t => t.placed);
}

function checkGameEnd(room) {
  const eliminatedCount = room.teams.filter(t => t.eliminated).length;
  if (eliminatedCount >= 3) {
    endGame(room);
  }
}

function endGame(room) {
  room.phase = 'over';

  // Bonus untuk survivor berdasarkan sisa nyawa
  room.teams.forEach(t => {
    if (!t.eliminated) {
      const bonus = POINT_SURVIVE_BONUS[t.lives] || 0;
      if (bonus > 0) {
        t.points += bonus;
        addLog(room, `🏅 ${t.name} bertahan dengan ${t.lives} nyawa, +${bonus} poin (total ${t.points})`);
      }
    }
  });

  addLog(room, `🏁 Permainan selesai — 3 tim telah gugur.`);
}

// ───────────────────────────────────────────────
// SOCKET.IO
// ───────────────────────────────────────────────
io.on('connection', (socket) => {

  // ── ADMIN: buat room baru ──
  socket.on('admin:createRoom', () => {
    const room = createRoom();
    socket.join(`${room.code}:admin`);
    socket.data.roomCode = room.code;
    socket.data.role = 'admin';
    socket.emit('admin:roomCreated', { code: room.code });
    socket.emit('state', roomStateForAdmin(room));
  });

  // ── ADMIN: rejoin room yang sudah ada (refresh halaman) ──
  socket.on('admin:joinRoom', ({ code }) => {
    const room = rooms[code];
    if (!room) {
      socket.emit('errorMsg', 'Kode room tidak ditemukan.');
      return;
    }
    socket.join(`${room.code}:admin`);
    socket.data.roomCode = room.code;
    socket.data.role = 'admin';
    socket.emit('admin:roomCreated', { code: room.code });
    socket.emit('state', roomStateForAdmin(room));
  });

  // ── PESERTA: join dengan kode room ──
  socket.on('player:join', ({ code, name }) => {
    code = (code || '').trim().toUpperCase();
    const room = rooms[code];
    if (!room) {
      socket.emit('errorMsg', 'Kode room tidak ditemukan. Periksa kembali kode dari juri.');
      return;
    }
    if (room.phase !== 'lobby') {
      // izinkan rejoin jika socket sebelumnya untuk tim ini terputus (reconnect)
    }

    // Cari slot kosong, atau slot dengan nama sama (reconnect)
    let team = room.teams.find(t => t.connected && t.name === (name || '').trim() && t.name.trim() !== '');
    if (!team) {
      team = room.teams.find(t => !t.connected);
    }
    if (!team) {
      socket.emit('errorMsg', 'Room penuh (maksimal 6 peserta).');
      return;
    }

    team.connected = true;
    team.socketId = socket.id;
    if (name && name.trim()) team.name = name.trim().slice(0, 24);

    socket.join(`${room.code}:player:${team.id}`);
    socket.data.roomCode = room.code;
    socket.data.role = 'player';
    socket.data.teamId = team.id;

    addLog(room, `✅ ${team.name} bergabung ke room.`);

    socket.emit('player:joined', { teamId: team.id, name: team.name, color: team.color });
    broadcastRoom(room);
  });

  // ── PESERTA: set nama tim ──
  socket.on('player:setName', ({ newName }) => {
    const room = getMyRoom(socket);
    if (!room || socket.data.role !== 'player') return;
    const team = room.teams[socket.data.teamId];
    if (!newName || !newName.trim()) return;
    team.name = newName.trim().slice(0, 24);
    addLog(room, `✏️ ${team.name} mengganti nama tim.`);
    broadcastRoom(room);
  });

  // ── PESERTA: tempatkan kapal ──
  socket.on('player:placeShip', ({ r, c, orientation }) => {
    const room = getMyRoom(socket);
    if (!room || socket.data.role !== 'player') return;
    if (room.phase !== 'lobby' && room.phase !== 'deploy') return;

    const team = room.teams[socket.data.teamId];
    if (team.placed) return;

    const cells = shipCells(r, c, orientation === 'v' ? 'v' : 'h');
    if (!cells) {
      socket.emit('errorMsg', 'Posisi kapal keluar dari papan.');
      return;
    }

    team.cells = cells;
    team.orientation = orientation === 'v' ? 'v' : 'h';
    team.placed = true;
    cells.forEach(([rr, cc]) => room.board[rr][cc].push(team.id));

    addLog(room, `🚢 ${team.name} telah menempatkan kapal.`);

    if (room.phase === 'lobby') room.phase = 'deploy';

    broadcastRoom(room);
  });

  // ── PESERTA: batal/ubah penempatan kapal (selama belum dikonfirmasi final oleh admin) ──
  socket.on('player:unplaceShip', () => {
    const room = getMyRoom(socket);
    if (!room || socket.data.role !== 'player') return;
    if (room.phase !== 'deploy' && room.phase !== 'lobby') return;

    const team = room.teams[socket.data.teamId];
    if (!team.placed) return;

    // hapus dari board
    team.cells.forEach(([rr, cc]) => {
      room.board[rr][cc] = room.board[rr][cc].filter(id => id !== team.id);
    });
    team.cells = null;
    team.placed = false;

    addLog(room, `↩️ ${team.name} membatalkan penempatan kapal.`);
    broadcastRoom(room);
  });

  // ── ADMIN: mulai pertempuran (setelah semua peserta menempatkan kapal) ──
  socket.on('admin:startBattle', () => {
    const room = getMyRoom(socket);
    if (!room || socket.data.role !== 'admin') return;
    if (!allPlaced(room)) {
      socket.emit('errorMsg', 'Belum semua peserta menempatkan kapal.');
      return;
    }
    room.phase = 'battle';
    addLog(room, `⚔️ Pertempuran dimulai!`);
    broadcastRoom(room);
  });

  // ── ADMIN: pilih tim yang boleh menembak ──
  socket.on('admin:setActiveTeam', ({ teamId }) => {
    const room = getMyRoom(socket);
    if (!room || socket.data.role !== 'admin') return;
    if (room.phase !== 'battle') return;
    if (room.pendingFire) return;

    const team = room.teams[teamId];
    if (!team || team.eliminated) return;

    room.activeTeamId = teamId;
    addLog(room, `🎯 ${team.name} dipersilakan menembak.`);
    broadcastRoom(room);
  });

  // ── ADMIN: batalkan giliran tembak aktif ──
  socket.on('admin:clearActiveTeam', () => {
    const room = getMyRoom(socket);
    if (!room || socket.data.role !== 'admin') return;
    room.activeTeamId = null;
    room.pendingFire = null;
    broadcastRoom(room);
  });

  // ── PESERTA: pilih koordinat untuk ditembak (mengajukan, menunggu konfirmasi admin) ──
  socket.on('player:selectFire', ({ r, c }) => {
    const room = getMyRoom(socket);
    if (!room || socket.data.role !== 'player') return;
    if (room.phase !== 'battle') return;

    const team = room.teams[socket.data.teamId];
    if (team.id !== room.activeTeamId) {
      socket.emit('errorMsg', 'Belum giliranmu untuk menembak.');
      return;
    }
    if (room.revealed[r][c]) {
      socket.emit('errorMsg', 'Koordinat ini sudah pernah ditembak.');
      return;
    }

    room.pendingFire = { r, c, teamId: team.id };
    addLog(room, `📍 ${team.name} memilih koordinat ${COLS[c]}${r + 1}.`);
    broadcastRoom(room);
  });

  // ── ADMIN: eksekusi tembakan ──
  socket.on('admin:resolveFire', () => {
    const room = getMyRoom(socket);
    if (!room || socket.data.role !== 'admin') return;
    if (!room.pendingFire) return;

    const { r, c, teamId } = room.pendingFire;
    const firingTeam = room.teams[teamId];
    const ownerIds = room.board[r][c];
    const actualHit = ownerIds.length > 0;

    room.revealed[r][c] = actualHit ? 'hit' : 'miss';

    const newlyEliminated = [];
    if (actualHit) {
      // poin untuk penembak yang berhasil menemukan kapal lawan
      firingTeam.points += POINT_FIND_SHIP;
      addLog(room, `🎯 ${firingTeam.name} menemukan kapal di ${COLS[c]}${r + 1}, +${POINT_FIND_SHIP} poin (total ${firingTeam.points}).`);

      ownerIds.forEach(id => {
        const owner = room.teams[id];
        owner.hits++;
        owner.lives = Math.max(0, SHIP_LEN - owner.hits);
        if (owner.hits >= SHIP_LEN && !owner.eliminated) {
          owner.eliminated = true;
          room.elimCounter++;
          owner.eliminatedOrder = room.elimCounter;
          const penalty = POINT_ELIM_PENALTY[Math.min(room.elimCounter, 3) - 1] || -100;
          owner.points += penalty;
          newlyEliminated.push(owner);
          addLog(room, `💥 ${owner.name} GUGUR (#${room.elimCounter}), ${penalty} poin (total ${owner.points}).`);
        }
      });

      const names = ownerIds.map(id => room.teams[id].name).join(', ');
      addLog(room, `🔥 KENA! ${firingTeam.name} menembak ${COLS[c]}${r + 1} mengenai kapal ${names}.`);
    } else {
      addLog(room, `🌊 ${firingTeam.name} menembak ${COLS[c]}${r + 1} — MELESET.`);
    }

    room.pendingFire = null;
    room.activeTeamId = null;

    checkGameEnd(room);
    broadcastRoom(room);
  });

  // ── ADMIN: batalkan pending fire ──
  socket.on('admin:cancelFire', () => {
    const room = getMyRoom(socket);
    if (!room || socket.data.role !== 'admin') return;
    room.pendingFire = null;
    broadcastRoom(room);
  });

  // ── ADMIN: jawaban kuis benar (+100) ──
  socket.on('admin:quizCorrect', ({ teamId }) => {
    const room = getMyRoom(socket);
    if (!room || socket.data.role !== 'admin') return;
    const team = room.teams[teamId];
    if (!team) return;
    team.points += POINT_QUIZ_CORRECT;
    addLog(room, `✅ ${team.name} menjawab benar, +${POINT_QUIZ_CORRECT} poin (total ${team.points}).`);
    broadcastRoom(room);
  });

  // ── ADMIN: jawaban kuis salah (-100, manual) ──
  socket.on('admin:quizWrong', ({ teamId }) => {
    const room = getMyRoom(socket);
    if (!room || socket.data.role !== 'admin') return;
    const team = room.teams[teamId];
    if (!team) return;
    team.points += POINT_QUIZ_WRONG;
    addLog(room, `❌ ${team.name} menjawab salah, ${POINT_QUIZ_WRONG} poin (total ${team.points}).`);
    broadcastRoom(room);
  });

  // ── ADMIN: penyesuaian poin manual bebas (opsional, untuk koreksi) ──
  socket.on('admin:adjustPoints', ({ teamId, amount }) => {
    const room = getMyRoom(socket);
    if (!room || socket.data.role !== 'admin') return;
    const team = room.teams[teamId];
    if (!team) return;
    const amt = Number(amount) || 0;
    team.points += amt;
    addLog(room, `🛠️ Poin ${team.name} disesuaikan ${amt >= 0 ? '+' : ''}${amt} (total ${team.points}).`);
    broadcastRoom(room);
  });

  // ── ADMIN: reset seluruh room ──
  socket.on('admin:resetRoom', () => {
    const room = getMyRoom(socket);
    if (!room || socket.data.role !== 'admin') return;
    const code = room.code;
    const oldTeams = room.teams;

    rooms[code] = createRoom();
    rooms[code].code = code; // pertahankan kode room

    // pertahankan koneksi peserta yang sedang online (re-map by slot)
    oldTeams.forEach((t, i) => {
      if (t.connected && t.socketId) {
        rooms[code].teams[i].connected = true;
        rooms[code].teams[i].socketId = t.socketId;
        rooms[code].teams[i].name = t.name;
      }
    });

    addLog(rooms[code], `🔄 Room direset oleh admin.`);
    broadcastRoom(rooms[code]);
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    const room = getMyRoom(socket);
    if (!room) return;
    if (socket.data.role === 'player' && socket.data.teamId !== undefined) {
      const team = room.teams[socket.data.teamId];
      if (team && team.socketId === socket.id) {
        team.connected = false;
        team.socketId = null;
        addLog(room, `⚠️ ${team.name} terputus.`);
        broadcastRoom(room);
      }
    }
  });

  function getMyRoom(socket) {
    const code = socket.data.roomCode;
    return code ? rooms[code] : null;
  }
});

server.listen(PORT, () => {
  console.log(`Naval Strike server running on port ${PORT}`);
});
