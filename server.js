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

// REST API - 部屋作成（曲選択削除）
app.post('/api/rooms', express.json(), (req, res) => {
  const { roomName, password, userId } = req.body;
  
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

  if (gameRooms.size >= MAX_ROOMS) {
    return res.status(409).json({ 
      error: 'Maximum number of rooms reached' 
    });
  }

  let roomId;
  do {
    roomId = generateRoomId();
  } while (gameRooms.has(roomId));

  // 部屋作成（曲管理システム付き）
  const room = {
    id: roomId,
    name: roomName.trim(),
    password: password ? hashPassword(password.trim()) : null,
    creator: userId.trim(),
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
    hasPassword: !!room.password
  });

  broadcastRoomList();
  console.log(`🏠 Room created: ${roomId} (${roomName}) by ${userId}`);
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
    playerCount: room.players.size,
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
    const { roomName, password, userId } = data;
    
    if (!roomName || !userId) {
      socket.emit('error', { 
        message: '必要な情報が不足しています',
        code: 'MISSING_DATA' 
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
      score: 0,
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
      score: 0,
      joinTime: Date.now()
    });

    socket.join(roomId);

    socket.emit('room_created', {
      roomId,
      roomName: room.name,
      playerCount: room.players.size,
      currentSong: room.currentSong
    });

    broadcastRoom(roomId);
    broadcastRoomList();

    console.log(`🏠 Room created: ${roomId} (${roomName}) by ${userId}`);
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
      score: 0,
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
      score: 0,
      joinTime: Date.now()
    });

    socket.join(roomId);

    socket.emit('room_joined', {
      roomId,
      roomName: room.name,
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
      score: 0,
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
      score: 0,
      joinTime: Date.now(),
      isPythonClient: true
    });

    socket.join(roomId);

    socket.emit('room_joined_python', {
      roomId,
      roomName: room.name,
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
      player.score = 0;
      conn.score = 0;
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

  // スコア更新
  socket.on('score_update', (score) => {
    const conn = connections.get(socket.id);
    if (!conn) return;

    const room = gameRooms.get(conn.roomId);
    if (!room || !room.players.has(socket.id)) return;

    const player = room.players.get(socket.id);
    
    // 観戦者のスコアは無視
    if (!player.isPlayer) return;

    if (typeof score !== 'number' || score < 0 || score > 99999999) {
      return;
    }

    const roundedScore = Math.floor(score);
    conn.score = roundedScore;
    player.score = roundedScore;
    player.lastUpdate = Date.now();
    room.lastActivity = Date.now();
    room.lastScoreUpdate = Date.now();
    
    // 全員0点チェック
    checkAllZeroScores(conn.roomId);
    
    broadcastRoom(conn.roomId);
  });

  // Pythonクライアント用スコア更新
  socket.on('score_update_python', (data) => {
    const conn = connections.get(socket.id);
    if (!conn) return;

    const room = gameRooms.get(conn.roomId);
    if (!room || !room.players.has(socket.id)) return;

    const player = room.players.get(socket.id);
    if (!player.isPlayer) return; // 観戦者は無視

    const { score, metadata } = data;
    
    if (typeof score !== 'number' || score < 0 || score > 99999999) {
      return;
    }

    const roundedScore = Math.floor(score);
    conn.score = roundedScore;
    player.score = roundedScore;
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

  // 全員0点チェック関数
  function checkAllZeroScores(roomId) {
    const room = gameRooms.get(roomId);
    if (!room) return;

    const players = Array.from(room.players.values()).filter(p => p.isPlayer);
    if (players.length === 0) return;

    const allZero = players.every(p => p.score === 0);
    
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

  // 曲終了時のランキング確定
  function finalizeSongRanking(roomId) {
    const room = gameRooms.get(roomId);
    if (!room) return;

    const players = Array.from(room.players.values())
      .filter(p => p.isPlayer && p.score > 0) // プレイヤーかつスコア > 0
      .sort((a, b) => b.score - a.score);

    if (players.length === 0) return;

    // ランキング記録
    const ranking = players.map((player, index) => ({
      rank: index + 1,
      userId: player.userId,
      score: player.score,
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
      ranking: ranking,
      timestamp: Date.now()
    });

    room.currentSong++;

    console.log(`🏁 Song ${room.currentSong - 1} finished in room ${roomId}:`, ranking.map(r => `${r.rank}位 ${r.userId}(${r.points}pt)`).join(', '));

    // 全員にランキング通知
    io.to(roomId).emit('song_finished', {
      songNumber: room.currentSong - 1,
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
        score: data.score,
        lastUpdate: data.lastUpdate,
        isCreator: data.isCreator,
        isPlayer: data.isPlayer,
        isPythonClient: data.isPythonClient
      }))
      .filter(p => p.isPlayer) // プレイヤーのみ表示
      .sort((a, b) => b.score - a.score);

    const spectators = Array.from(room.players.values())
      .filter(p => !p.isPlayer)
      .map(p => ({
        userId: p.userId,
        isPythonClient: p.isPythonClient
      }));

    const topScore = players[0]?.score || 0;
    const result = players.map((player, idx) => ({
      ...player,
      rank: idx + 1,
      diff: idx === 0 ? 0 : topScore - player.score
    }));

    const totalPoints = Array.from(room.playerPoints.entries())
      .map(([userId, points]) => ({userId, points}))
      .sort((a, b) => b.points - a.points);

    io.to(roomId).emit('room_update', {
      roomId,
      roomName: room.name,
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