// 音ゲー大会システム (観戦者対応＋ポイントシステム)
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { 
    origin: "*", 
    methods: ["GET", "POST"] 
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// 設定
const MAX_PLAYERS_PER_ROOM = 12; // プレイヤー + 観戦者
const MAX_ROOMS = 20;
const INACTIVE_TIMEOUT = 30 * 60 * 1000; // 30分
const PORT = process.env.PORT || 3000;
const ZERO_SCORE_THRESHOLD = 3000; // 全員0点から3秒後に次の曲と判定

// データストレージ
let gameRooms = new Map(); // roomId -> room data
let connections = new Map(); // socketId -> connection data

// ユーティリティ関数
function generateRoomId() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// 静的ファイル配信
app.use(express.static('public'));
app.use(express.json());

// CORS対応
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// ヘルスチェック
app.get('/', (req, res) => {
  const stats = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    connections: connections.size,
    rooms: gameRooms.size,
    maxRooms: MAX_ROOMS,
    maxPlayersPerRoom: MAX_PLAYERS_PER_ROOM,
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
    }
  };
  res.json(stats);
});

app.get('/ping', (req, res) => {
  updateActivity();
  res.json({ pong: true, time: Date.now() });
});

app.get('/health', (req, res) => {
  updateActivity();
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    lastActivity: new Date(lastActivity).toISOString(),
    connections: connections.size,
    rooms: gameRooms.size,
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
    },
    keepAlive: !!keepAliveInterval
  });
});

app.get('/wakeup', (req, res) => {
  updateActivity();
  console.log('💤 Wake-up request received');
  res.json({
    message: 'Server is awake!',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime())
  });
});

// REST API - 部屋一覧取得
app.get('/api/rooms', (req, res) => {
  const roomList = Array.from(gameRooms.entries()).map(([roomId, room]) => ({
    roomId,
    name: room.name,
    scoreRule: room.scoreRule,
    playerCount: Array.from(room.players.values()).filter(p => p.isPlayer).length,
    spectatorCount: Array.from(room.players.values()).filter(p => !p.isPlayer).length,
    totalCount: room.players.size,
    maxPlayers: MAX_PLAYERS_PER_ROOM,
    hasPassword: !!room.password,
    createdAt: room.createdAt,
    lastActivity: room.lastActivity,
    creator: room.creator,
    currentSong: room.currentSong,
    songHistory: room.songHistory.length
  }));
  
  res.json({
    rooms: roomList,
    totalRooms: roomList.length,
    totalConnections: connections.size,
    maxRooms: MAX_ROOMS
  });
});

// REST API - 部屋作成（スコアルール対応）
app.post('/api/rooms', express.json(), (req, res) => {
  const { roomName, password, userId, scoreRule } = req.body;
  
  if (!roomName || !userId) {
    return res.status(400).json({ 
      error: 'Missing required fields: roomName, userId' 
    });
  }

  if (roomName.length > 30 || userId.length > 20) {
    return res.status(400).json({ 
      error: 'roomName max 30 chars, userId max 20 chars' 
    });
  }

  if (scoreRule && !['normal', 'ex'].includes(scoreRule)) {
    return res.status(400).json({ 
      error: 'scoreRule must be either "normal" or "ex"' 
    });
  }

  if (gameRooms.size >= MAX_ROOMS) {
    return res.status(409).json({ 
      error: 'Maximum number of rooms reached' 
    });
  }

  let roomId;
  do {
    roomId = generateRoomId();
  } while (gameRooms.has(roomId));

  // 部屋作成（スコアルール付き）
  const room = {
    id: roomId,
    name: roomName.trim(),
    password: password ? hashPassword(password.trim()) : null,
    creator: userId.trim(),
    scoreRule: scoreRule || 'normal', // デフォルトは通常スコア
    players: new Map(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
    isActive: true,
    pythonClients: new Set(),
    // 新機能
    currentSong: 1,
    songHistory: [], // [{songNumber, rankings, timestamp}]
    playerPoints: new Map(), // userId -> totalPoints
    allZeroScoreTimer: null,
    lastScoreUpdate: Date.now()
  };

  gameRooms.set(roomId, room);

  res.json({
    success: true,
    roomId: roomId,
    roomName: room.name,
    scoreRule: room.scoreRule,
    hasPassword: !!room.password
  });

  broadcastRoomList();
  console.log(`🏠 Room created: ${roomId} (${roomName}) by ${userId} - Score rule: ${room.scoreRule}`);
});

// REST API - 部屋参加検証
app.post('/api/rooms/:roomId/join', express.json(), (req, res) => {
  const { roomId } = req.params;
  const { userId, password } = req.body;
  
  const room = gameRooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (room.password && (!password || hashPassword(password.trim()) !== room.password)) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
    return res.status(409).json({ error: 'Room is full' });
  }

  res.json({
    success: true,
    roomId: roomId,
    roomName: room.name,
    scoreRule: room.scoreRule,
    creator: room.creator,
    currentSong: room.currentSong,
    songHistory: room.songHistory
  });
});

// WebSocket接続処理
io.on('connection', (socket) => {
  console.log(`🎵 New connection: ${socket.id}`);

  socket.on('client_type', (data) => {
    if (data.type === 'python') {
      socket.isPythonClient = true;
      console.log(`🐍 Python client identified: ${socket.id}`);
    }
  });

  // 部屋作成（Web UI用）
  socket.on('create_room', (data) => {
    const { roomName, password, userId, scoreRule } = data;
    
    if (!roomName || !userId) {
      socket.emit('error', { 
        message: '必要な情報が不足しています',
        code: 'MISSING_DATA' 
      });
      return;
    }

    if (scoreRule && !['normal', 'ex'].includes(scoreRule)) {
      socket.emit('error', { 
        message: 'スコアルールが無効です',
        code: 'INVALID_SCORE_RULE' 
      });
      return;
    }

    if (gameRooms.size >= MAX_ROOMS) {
      socket.emit('error', { 
        message: 'これ以上部屋を作成できません',
        code: 'MAX_ROOMS_REACHED' 
      });
      return;
    }

    cleanup(socket.id);

    let roomId;
    do {
      roomId = generateRoomId();
    } while (gameRooms.has(roomId));

    const room = {
      id: roomId,
      name: roomName.trim(),
      password: password ? hashPassword(password.trim()) : null,
      creator: userId.trim(),
      scoreRule: scoreRule || 'normal',
      players: new Map(),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      isActive: true,
      pythonClients: new Set(),
      currentSong: 1,
      songHistory: [],
      playerPoints: new Map(),
      allZeroScoreTimer: null,
      lastScoreUpdate: Date.now()
    };

    // 作成者をプレイヤーとして追加
    room.players.set(socket.id, {
      userId: userId.trim(),
      normalScore: 0,
      exScore: 0,
      displayScore: 0, // 表示用スコア（ルールに応じて変更）
      lastUpdate: Date.now(),
      joinTime: Date.now(),
      isCreator: true,
      isPlayer: true, // 新機能：プレイヤー/観戦者フラグ
      isPythonClient: false
    });

    room.playerPoints.set(userId.trim(), 0);
    gameRooms.set(roomId, room);
    
    connections.set(socket.id, {
      userId: userId.trim(),
      roomId: roomId,
      normalScore: 0,
      exScore: 0,
      displayScore: 0,
      joinTime: Date.now()
    });

    socket.join(roomId);

    socket.emit('room_created', {
      roomId,
      roomName: room.name,
      scoreRule: room.scoreRule,
      playerCount: room.players.size,
      currentSong: room.currentSong
    });

    broadcastRoom(roomId);
    broadcastRoomList();

    console.log(`🏠 Room created: ${roomId} (${roomName}) by ${userId} - Score rule: ${room.scoreRule}`);
  });

  // 部屋参加
  socket.on('join_room', (data) => {
    const { roomId, userId, password, isPlayer = true } = data;
    
    if (!roomId || !userId) {
      socket.emit('error', { 
        message: '部屋IDとユーザー名が必要です',
        code: 'MISSING_DATA' 
      });
      return;
    }

    const room = gameRooms.get(roomId);
    if (!room) {
      socket.emit('error', { 
        message: '指定された部屋が見つかりません',
        code: 'ROOM_NOT_FOUND' 
      });
      return;
    }

    if (room.password && (!password || hashPassword(password.trim()) !== room.password)) {
      socket.emit('error', { 
        message: 'パスワードが間違っています',
        code: 'WRONG_PASSWORD' 
      });
      return;
    }

    if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
      socket.emit('error', { 
        message: 'この部屋は満員です',
        code: 'ROOM_FULL' 
      });
      return;
    }

    cleanup(socket.id);

    room.players.set(socket.id, {
      userId: userId.trim(),
      normalScore: 0,
      exScore: 0,
      displayScore: 0, // ルールに応じた表示用スコア
      lastUpdate: Date.now(),
      joinTime: Date.now(),
      isCreator: false,
      isPlayer: isPlayer, // プレイヤーまたは観戦者
      isPythonClient: !!socket.isPythonClient
    });

    // プレイヤーの場合のみポイントを初期化
    if (isPlayer) {
      if (!room.playerPoints.has(userId.trim())) {
        room.playerPoints.set(userId.trim(), 0);
      }
    }

    room.lastActivity = Date.now();

    connections.set(socket.id, {
      userId: userId.trim(),
      roomId: roomId,
      normalScore: 0,
      exScore: 0,
      displayScore: 0,
      joinTime: Date.now()
    });

    socket.join(roomId);

    socket.emit('room_joined', {
      roomId,
      roomName: room.name,
      scoreRule: room.scoreRule,
      playerCount: Array.from(room.players.values()).filter(p => p.isPlayer).length,
      spectatorCount: Array.from(room.players.values()).filter(p => !p.isPlayer).length,
      creator: room.creator,
      currentSong: room.currentSong,
      songHistory: room.songHistory,
      playerPoints: Array.from(room.playerPoints.entries()).map(([userId, points]) => ({userId, points}))
    });

    broadcastRoom(roomId);
    broadcastRoomList();

    const playerType = isPlayer ? "プレイヤー" : "観戦者";
    console.log(`✅ ${userId} joined room ${roomId} as ${playerType} (${room.players.size}/${MAX_PLAYERS_PER_ROOM})`);
  });

  // Pythonクライアント用参加
  socket.on('join_room_python', (data) => {
    const { roomId, userId, clientInfo, isPlayer = true } = data;
    
    const room = gameRooms.get(roomId);
    if (!room) {
      socket.emit('error', { 
        message: 'Room not found',
        code: 'ROOM_NOT_FOUND' 
      });
      return;
    }

    cleanup(socket.id);

    room.players.set(socket.id, {
      userId: userId.trim(),
      normalScore: 0,
      exScore: 0,
      displayScore: 0,
      lastUpdate: Date.now(),
      joinTime: Date.now(),
      isCreator: false,
      isPlayer: isPlayer,
      isPythonClient: true,
      clientInfo: clientInfo || {}
    });

    if (isPlayer && !room.playerPoints.has(userId.trim())) {
      room.playerPoints.set(userId.trim(), 0);
    }

    room.lastActivity = Date.now();
    room.pythonClients.add(socket.id);

    connections.set(socket.id, {
      userId: userId.trim(),
      roomId: roomId,
      normalScore: 0,
      exScore: 0,
      displayScore: 0,
      joinTime: Date.now(),
      isPythonClient: true
    });

    socket.join(roomId);

    socket.emit('room_joined_python', {
      roomId,
      roomName: room.name,
      scoreRule: room.scoreRule,
      playerCount: Array.from(room.players.values()).filter(p => p.isPlayer).length,
      spectatorCount: Array.from(room.players.values()).filter(p => !p.isPlayer).length,
      creator: room.creator,
      currentSong: room.currentSong,
      songHistory: room.songHistory,
      playerPoints: Array.from(room.playerPoints.entries()).map(([userId, points]) => ({userId, points})),
      isPlayer: isPlayer
    });

    broadcastRoom(roomId);
    broadcastRoomList();
  });

  // プレイヤー/観戦者切り替え
  socket.on('toggle_player_status', () => {
    const conn = connections.get(socket.id);
    if (!conn) return;

    const room = gameRooms.get(conn.roomId);
    if (!room || !room.players.has(socket.id)) return;

    const player = room.players.get(socket.id);
    player.isPlayer = !player.isPlayer;
    
    // プレイヤーになった場合はポイントを初期化
    if (player.isPlayer && !room.playerPoints.has(player.userId)) {
      room.playerPoints.set(player.userId, 0);
    }

    // 観戦者になった場合はスコアを0にリセット
    if (!player.isPlayer) {
      player.normalScore = 0;
      player.exScore = 0;
      player.displayScore = 0;
      conn.normalScore = 0;
      conn.exScore = 0;
      conn.displayScore = 0;
    }

    room.lastActivity = Date.now();

    socket.emit('status_toggled', {
      isPlayer: player.isPlayer,
      message: player.isPlayer ? 'プレイヤーになりました' : '観戦者になりました'
    });

    broadcastRoom(conn.roomId);
    broadcastRoomList();

    console.log(`🔄 ${player.userId} switched to ${player.isPlayer ? 'player' : 'spectator'} in room ${conn.roomId}`);
  });

  // 部屋一覧要求
  socket.on('get_room_list', () => {
    const roomList = Array.from(gameRooms.entries()).map(([roomId, room]) => ({
      roomId,
      name: room.name,
      scoreRule: room.scoreRule,
      playerCount: Array.from(room.players.values()).filter(p => p.isPlayer).length,
      spectatorCount: Array.from(room.players.values()).filter(p => !p.isPlayer).length,
      totalCount: room.players.size,
      maxPlayers: MAX_PLAYERS_PER_ROOM,
      hasPassword: !!room.password,
      creator: room.creator,
      createdAt: room.createdAt,
      currentSong: room.currentSong,
      songHistory: room.songHistory.length
    }));

    socket.emit('room_list', {
      rooms: roomList,
      totalRooms: roomList.length
    });
  });

  // スコア更新（スコアルール対応）
  socket.on('score_update', (data) => {
    const conn = connections.get(socket.id);
    if (!conn) return;

    const room = gameRooms.get(conn.roomId);
    if (!room || !room.players.has(socket.id)) return;

    const player = room.players.get(socket.id);
    
    // 観戦者のスコアは無視
    if (!player.isPlayer) return;

    // データ形式の判定（後方互換性）
    let normalScore, exScore;
    
    if (typeof data === 'number') {
      // 旧形式：単一スコア（通常スコアとして扱う）
      normalScore = data;
      exScore = data; // EXスコアも同じ値
    } else if (typeof data === 'object') {
      // 新形式：両方のスコア
      normalScore = data.normalScore || data.score || 0;
      exScore = data.exScore || data.score || 0;
    } else {
      return; // 無効なデータ
    }

    // スコア妥当性チェック
    if (typeof normalScore !== 'number' || normalScore < 0 || normalScore > 99999999 ||
        typeof exScore !== 'number' || exScore < 0 || exScore > 99999999) {
      return;
    }

    const roundedNormalScore = Math.floor(normalScore);
    const roundedExScore = Math.floor(exScore);
    
    // 部屋のルールに応じて表示用スコアを決定
    const displayScore = room.scoreRule === 'ex' ? roundedExScore : roundedNormalScore;

    // データ更新
    conn.normalScore = roundedNormalScore;
    conn.exScore = roundedExScore;
    conn.displayScore = displayScore;
    
    player.normalScore = roundedNormalScore;
    player.exScore = roundedExScore;
    player.displayScore = displayScore;
    player.lastUpdate = Date.now();
    room.lastActivity = Date.now();
    room.lastScoreUpdate = Date.now();
    
    // 全員0点チェック（表示用スコアで判定）
    checkAllZeroScores(conn.roomId);
    
    broadcastRoom(conn.roomId);
  });

  // Pythonクライアント用スコア更新（スコアルール対応）
  socket.on('score_update_python', (data) => {
    const conn = connections.get(socket.id);
    if (!conn) return;

    const room = gameRooms.get(conn.roomId);
    if (!room || !room.players.has(socket.id)) return;

    const player = room.players.get(socket.id);
    if (!player.isPlayer) return; // 観戦者は無視

    const { normalScore, exScore, metadata } = data;
    
    // スコア妥当性チェック
    if (typeof normalScore !== 'number' || normalScore < 0 || normalScore > 99999999 ||
        typeof exScore !== 'number' || exScore < 0 || exScore > 99999999) {
      return;
    }

    const roundedNormalScore = Math.floor(normalScore);
    const roundedExScore = Math.floor(exScore);
    
    // 部屋のルールに応じて表示用スコアを決定
    const displayScore = room.scoreRule === 'ex' ? roundedExScore : roundedNormalScore;

    // データ更新
    conn.normalScore = roundedNormalScore;
    conn.exScore = roundedExScore;
    conn.displayScore = displayScore;
    
    player.normalScore = roundedNormalScore;
    player.exScore = roundedExScore;
    player.displayScore = displayScore;
    player.lastUpdate = Date.now();
    player.metadata = metadata || {};
    room.lastActivity = Date.now();
    room.lastScoreUpdate = Date.now();
    
    checkAllZeroScores(conn.roomId);
    broadcastRoom(conn.roomId);
  });

  socket.on('leave_room', () => {
    cleanup(socket.id);
    socket.emit('left_room');
  });

  socket.on('disconnect', (reason) => {
    console.log(`👋 Disconnection: ${socket.id} (${reason})`);
    cleanup(socket.id);
  });

  socket.on('ping', () => {
    socket.emit('pong');
  });

  socket.on('ping_python', (data) => {
    socket.emit('pong_python', {
      timestamp: Date.now(),
      serverUptime: process.uptime(),
      yourLatency: data.clientTimestamp ? Date.now() - data.clientTimestamp : null
    });
  });

  // 全員0点チェック関数（表示用スコアで判定）
  function checkAllZeroScores(roomId) {
    const room = gameRooms.get(roomId);
    if (!room) return;

    const players = Array.from(room.players.values()).filter(p => p.isPlayer);
    if (players.length === 0) return;

    const allZero = players.every(p => p.displayScore === 0);
    
    if (allZero) {
      // 全員0点の状態
      if (!room.allZeroScoreTimer) {
        room.allZeroScoreTimer = setTimeout(() => {
          finalizeSongRanking(roomId);
          room.allZeroScoreTimer = null;
        }, ZERO_SCORE_THRESHOLD);
      }
    } else {
      // 誰かがスコアを持っている
      if (room.allZeroScoreTimer) {
        clearTimeout(room.allZeroScoreTimer);
        room.allZeroScoreTimer = null;
      }
    }
  }

  // 曲終了時のランキング確定（表示用スコアで集計）
  function finalizeSongRanking(roomId) {
    const room = gameRooms.get(roomId);
    if (!room) return;

    const players = Array.from(room.players.values())
      .filter(p => p.isPlayer && p.displayScore > 0) // プレイヤーかつ表示スコア > 0
      .sort((a, b) => b.displayScore - a.displayScore);

    if (players.length === 0) return;

    // ランキング記録（表示用スコアと両方のスコアを保存）
    const ranking = players.map((player, index) => ({
      rank: index + 1,
      userId: player.userId,
      displayScore: player.displayScore,
      normalScore: player.normalScore,
      exScore: player.exScore,
      points: index === 0 ? 2 : index === 1 ? 1 : 0 // 1位=2pt, 2位=1pt, 3位以下=0pt
    }));

    // ポイント加算
    ranking.forEach(entry => {
      const currentPoints = room.playerPoints.get(entry.userId) || 0;
      room.playerPoints.set(entry.userId, currentPoints + entry.points);
    });

    // 履歴に追加
    room.songHistory.push({
      songNumber: room.currentSong,
      scoreRule: room.scoreRule,
      ranking: ranking,
      timestamp: Date.now()
    });

    room.currentSong++;

    const scoreRuleText = room.scoreRule === 'ex' ? 'EXスコア' : '通常スコア';
    console.log(`🏁 Song ${room.currentSong - 1} finished in room ${roomId} (${scoreRuleText}):`, 
                ranking.map(r => `${r.rank}位 ${r.userId}(${r.points}pt)`).join(', '));

    // 全員にランキング通知
    io.to(roomId).emit('song_finished', {
      songNumber: room.currentSong - 1,
      scoreRule: room.scoreRule,
      ranking: ranking,
      totalPoints: Array.from(room.playerPoints.entries()).map(([userId, points]) => ({userId, points})).sort((a, b) => b.points - a.points),
      nextSong: room.currentSong
    });

    broadcastRoom(roomId);
    broadcastRoomList();
  }

  function cleanup(socketId) {
    const conn = connections.get(socketId);
    if (conn) {
      const room = gameRooms.get(conn.roomId);
      if (room) {
        room.players.delete(socketId);
        room.pythonClients.delete(socketId);
        room.lastActivity = Date.now();
        
        if (room.allZeroScoreTimer) {
          clearTimeout(room.allZeroScoreTimer);
          room.allZeroScoreTimer = null;
        }
        
        if (room.players.size === 0) {
          gameRooms.delete(conn.roomId);
          console.log(`🗑️ Empty room deleted: ${conn.roomId} (${room.name})`);
          broadcastRoomList();
        } else {
          broadcastRoom(conn.roomId);
          broadcastRoomList();
        }
      }
      connections.delete(socketId);
    }
  }

  function broadcastRoom(roomId) {
    const room = gameRooms.get(roomId);
    if (!room) return;

    const players = Array.from(room.players.entries())
      .map(([socketId, data]) => ({
        userId: data.userId,
        displayScore: data.displayScore,
        normalScore: data.normalScore,
        exScore: data.exScore,
        lastUpdate: data.lastUpdate,
        isCreator: data.isCreator,
        isPlayer: data.isPlayer,
        isPythonClient: data.isPythonClient
      }))
      .filter(p => p.isPlayer) // プレイヤーのみ表示
      .sort((a, b) => b.displayScore - a.displayScore);

    const spectators = Array.from(room.players.values())
      .filter(p => !p.isPlayer)
      .map(p => ({
        userId: p.userId,
        isPythonClient: p.isPythonClient
      }));

    const topScore = players[0]?.displayScore || 0;
    const result = players.map((player, idx) => ({
      ...player,
      rank: idx + 1,
      diff: idx === 0 ? 0 : topScore - player.displayScore
    }));

    const totalPoints = Array.from(room.playerPoints.entries())
      .map(([userId, points]) => ({userId, points}))
      .sort((a, b) => b.points - a.points);

    io.to(roomId).emit('room_update', {
      roomId,
      roomName: room.name,
      scoreRule: room.scoreRule,
      currentSong: room.currentSong,
      players: result,
      spectators: spectators,
      playerCount: players.length,
      spectatorCount: spectators.length,
      totalPoints: totalPoints,
      timestamp: Date.now()
    });
  }

  function broadcastRoomList() {
    const roomList = Array.from(gameRooms.entries()).map(([roomId, room]) => ({
      roomId,
      name: room.name,
      scoreRule: room.scoreRule,
      playerCount: Array.from(room.players.values()).filter(p => p.isPlayer).length,
      spectatorCount: Array.from(room.players.values()).filter(p => !p.isPlayer).length,
      totalCount: room.players.size,
      maxPlayers: MAX_PLAYERS_PER_ROOM,
      hasPassword: !!room.password,
      creator: room.creator,
      createdAt: room.createdAt,
      currentSong: room.currentSong,
      songHistory: room.songHistory.length
    }));

    io.emit('room_list_updated', {
      rooms: roomList,
      totalRooms: roomList.length
    });
  }
});

// 定期クリーンアップ
setInterval(() => {
  const now = Date.now();
  let cleanedRooms = 0;

  for (const [roomId, room] of gameRooms.entries()) {
    if (now - room.lastActivity > INACTIVE_TIMEOUT) {
      if (room.allZeroScoreTimer) {
        clearTimeout(room.allZeroScoreTimer);
      }
      gameRooms.delete(roomId);
      cleanedRooms++;
    }
  }

  if (cleanedRooms > 0) {
    console.log(`🧹 Cleaned ${cleanedRooms} inactive rooms`);
    broadcastRoomList();
  }
}, 5 * 60 * 1000);

// Enhanced Keep-alive system
let keepAliveInterval = null;
let lastActivity = Date.now();

function updateActivity() {
  lastActivity = Date.now();
}

if (process.env.NODE_ENV === 'production') {
  console.log('🔄 Enhanced keep-alive system starting...');
  
  function performKeepAlive() {
    const RENDER_SERVICE_URL = process.env.RENDER_EXTERNAL_URL;
    const urls = [
      RENDER_SERVICE_URL ? `${RENDER_SERVICE_URL}/ping` : null,
      RENDER_SERVICE_URL ? `${RENDER_SERVICE_URL}/health` : null
    ].filter(Boolean);
    
    urls.forEach((url, index) => {
      setTimeout(() => {
        try {
          require('http').get(url, (res) => {
            res.on('data', () => {});
            res.on('end', () => {
              console.log(`📡 Keep-alive ping successful: ${url}`);
              updateActivity();
            });
          }).on('error', (error) => {
            console.error(`❌ Keep-alive ping failed for ${url}:`, error.message);
          });
        } catch (error) {
          console.error('Keep-alive request error:', error.message);
        }
      }, index * 2000);
    });
  }

  keepAliveInterval = setInterval(performKeepAlive, 14 * 60 * 1000);
  setTimeout(performKeepAlive, 30000);

  app.get('/external-ping', (req, res) => {
    updateActivity();
    console.log('🌐 External ping received from:', req.get('User-Agent') || 'Unknown');
    res.status(200).send('OK');
  });
}

// サーバー起動
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 Rhythm Game Tournament Server is running!`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`🏠 Max rooms: ${MAX_ROOMS}`);
  console.log(`👥 Max players per room: ${MAX_PLAYERS_PER_ROOM}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});