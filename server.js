// 部屋機能付き 音ゲーリアルタイムスコアサーバー (Render.com対応)
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
const MAX_PLAYERS_PER_ROOM = 8;
const MAX_ROOMS = 20;
const INACTIVE_TIMEOUT = 15 * 60 * 1000; // 15分
const PORT = process.env.PORT || 3000;

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

// Keep-alive endpoint
app.get('/ping', (req, res) => {
  res.json({ 
    pong: true, 
    time: Date.now() 
  });
});

// REST API - 部屋一覧取得
app.get('/api/rooms', (req, res) => {
  const roomList = Array.from(gameRooms.entries()).map(([roomId, room]) => ({
    roomId,
    name: room.name,
    playerCount: room.players.size,
    maxPlayers: MAX_PLAYERS_PER_ROOM,
    hasPassword: !!room.password,
    songHash: room.songHash,
    createdAt: room.createdAt,
    lastActivity: room.lastActivity,
    creator: room.creator
  }));
  
  res.json({
    rooms: roomList,
    totalRooms: roomList.length,
    totalPlayers: connections.size,
    maxRooms: MAX_ROOMS
  });
});

// WebSocket接続処理
io.on('connection', (socket) => {
  console.log(`🎵 New connection: ${socket.id}`);

  // 部屋作成
  socket.on('create_room', (data) => {
    const { roomName, songHash, password, userId } = data;
    
    // バリデーション
    if (!roomName || !songHash || !userId) {
      socket.emit('error', { 
        message: '必要な情報が不足しています',
        code: 'MISSING_DATA' 
      });
      return;
    }

    if (roomName.length > 30 || userId.length > 20) {
      socket.emit('error', { 
        message: '部屋名は30文字以内、ユーザー名は20文字以内で入力してください',
        code: 'INVALID_LENGTH' 
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

    // 既存接続をクリーンアップ
    cleanup(socket.id);

    // 新しい部屋ID生成
    let roomId;
    do {
      roomId = generateRoomId();
    } while (gameRooms.has(roomId));

    // 部屋作成
    const room = {
      id: roomId,
      name: roomName.trim(),
      songHash: songHash.trim(),
      password: password ? hashPassword(password.trim()) : null,
      creator: userId.trim(),
      players: new Map(),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      isActive: true
    };

    // プレイヤーを部屋に追加
    room.players.set(socket.id, {
      userId: userId.trim(),
      score: 0,
      lastUpdate: Date.now(),
      joinTime: Date.now(),
      isCreator: true
    });

    gameRooms.set(roomId, room);
    
    connections.set(socket.id, {
      userId: userId.trim(),
      roomId: roomId,
      score: 0,
      joinTime: Date.now()
    });

    socket.join(roomId);

    // 部屋作成成功を通知
    socket.emit('room_created', {
      roomId,
      roomName: room.name,
      songHash: room.songHash,
      playerCount: room.players.size
    });

    broadcastRoom(roomId);
    broadcastRoomList(); // 全体に部屋一覧更新を通知

    console.log(`🏠 Room created: ${roomId} (${roomName}) by ${userId}`);
  });

  // 部屋参加
  socket.on('join_room', (data) => {
    const { roomId, userId, password } = data;
    
    // バリデーション
    if (!roomId || !userId) {
      socket.emit('error', { 
        message: '部屋IDとユーザー名が必要です',
        code: 'MISSING_DATA' 
      });
      return;
    }

    if (userId.length > 20) {
      socket.emit('error', { 
        message: 'ユーザー名は20文字以内で入力してください',
        code: 'INVALID_LENGTH' 
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

    // パスワードチェック
    if (room.password) {
      if (!password) {
        socket.emit('error', { 
          message: 'この部屋にはパスワードが必要です',
          code: 'PASSWORD_REQUIRED' 
        });
        return;
      }
      
      if (hashPassword(password.trim()) !== room.password) {
        socket.emit('error', { 
          message: 'パスワードが間違っています',
          code: 'WRONG_PASSWORD' 
        });
        return;
      }
    }

    // 部屋の容量チェック
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
      socket.emit('error', { 
        message: 'この部屋は満員です',
        code: 'ROOM_FULL' 
      });
      return;
    }

    // 既存接続をクリーンアップ
    cleanup(socket.id);

    // プレイヤーを部屋に追加
    room.players.set(socket.id, {
      userId: userId.trim(),
      score: 0,
      lastUpdate: Date.now(),
      joinTime: Date.now(),
      isCreator: false
    });
    room.lastActivity = Date.now();

    connections.set(socket.id, {
      userId: userId.trim(),
      roomId: roomId,
      score: 0,
      joinTime: Date.now()
    });

    socket.join(roomId);

    // 参加成功を通知
    socket.emit('room_joined', {
      roomId,
      roomName: room.name,
      songHash: room.songHash,
      playerCount: room.players.size,
      creator: room.creator
    });

    broadcastRoom(roomId);
    broadcastRoomList(); // 全体に部屋一覧更新を通知

    console.log(`✅ ${userId} joined room ${roomId} (${room.players.size}/${MAX_PLAYERS_PER_ROOM})`);
  });

  // 部屋一覧要求
  socket.on('get_room_list', () => {
    const roomList = Array.from(gameRooms.entries()).map(([roomId, room]) => ({
      roomId,
      name: room.name,
      playerCount: room.players.size,
      maxPlayers: MAX_PLAYERS_PER_ROOM,
      hasPassword: !!room.password,
      songHash: room.songHash,
      creator: room.creator,
      createdAt: room.createdAt
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

    // スコア妥当性チェック
    if (typeof score !== 'number' || score < 0 || score > 99999999) {
      return;
    }

    const roundedScore = Math.floor(score);
    conn.score = roundedScore;
    
    const room = gameRooms.get(conn.roomId);
    if (room && room.players.has(socket.id)) {
      const player = room.players.get(socket.id);
      player.score = roundedScore;
      player.lastUpdate = Date.now();
      room.lastActivity = Date.now();
      
      broadcastRoom(conn.roomId);
    }
  });

  // 部屋を出る
  socket.on('leave_room', () => {
    cleanup(socket.id);
    socket.emit('left_room');
  });

  // 切断処理
  socket.on('disconnect', (reason) => {
    console.log(`👋 Disconnection: ${socket.id} (${reason})`);
    cleanup(socket.id);
  });

  // Ping-pong
  socket.on('ping', () => {
    socket.emit('pong');
  });

  // クリーンアップ関数
  function cleanup(socketId) {
    const conn = connections.get(socketId);
    if (conn) {
      const room = gameRooms.get(conn.roomId);
      if (room) {
        room.players.delete(socketId);
        room.lastActivity = Date.now();
        
        // 部屋が空になったら削除
        if (room.players.size === 0) {
          gameRooms.delete(conn.roomId);
          console.log(`🗑️ Empty room deleted: ${conn.roomId} (${room.name})`);
          broadcastRoomList(); // 部屋一覧更新を通知
        } else {
          broadcastRoom(conn.roomId);
          broadcastRoomList(); // 人数変更を通知
        }
      }
      connections.delete(socketId);
    }
  }

  // 部屋の状態を配信
  function broadcastRoom(roomId) {
    const room = gameRooms.get(roomId);
    if (!room) return;

    const players = Array.from(room.players.entries())
      .map(([socketId, data]) => ({
        userId: data.userId,
        score: data.score,
        lastUpdate: data.lastUpdate,
        isCreator: data.isCreator
      }))
      .sort((a, b) => b.score - a.score);

    const topScore = players[0]?.score || 0;
    const result = players.map((player, idx) => ({
      ...player,
      rank: idx + 1,
      diff: idx === 0 ? 0 : topScore - player.score
    }));

    io.to(roomId).emit('room_update', {
      roomId,
      roomName: room.name,
      songHash: room.songHash,
      players: result,
      count: players.length,
      timestamp: Date.now()
    });
  }

  // 全体に部屋一覧更新を配信
  function broadcastRoomList() {
    const roomList = Array.from(gameRooms.entries()).map(([roomId, room]) => ({
      roomId,
      name: room.name,
      playerCount: room.players.size,
      maxPlayers: MAX_PLAYERS_PER_ROOM,
      hasPassword: !!room.password,
      songHash: room.songHash,
      creator: room.creator,
      createdAt: room.createdAt
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
      gameRooms.delete(roomId);
      cleanedRooms++;
    }
  }

  if (cleanedRooms > 0) {
    console.log(`🧹 Cleaned ${cleanedRooms} inactive rooms`);
    broadcastRoomList(); // 削除後に一覧更新
  }

  // メモリ使用量ログ
  const memUsage = process.memoryUsage();
  if (memUsage.heapUsed > 50 * 1024 * 1024) {
    console.log(`⚠️ High memory usage: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
  }
}, 2 * 60 * 1000);

// Keep-alive for Render
const RENDER_SERVICE_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_SERVICE_URL && process.env.NODE_ENV === 'production') {
  console.log('🔄 Keep-alive enabled for Render');
  setInterval(() => {
    try {
      require('http').get(`${RENDER_SERVICE_URL}/ping`, (res) => {
        res.on('data', () => {});
        res.on('end', () => {});
      });
    } catch (error) {
      console.error('Keep-alive request failed:', error.message);
    }
  }, 14 * 60 * 1000);
}

// サーバー起動
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 Rhythm Game Server with Rooms is running!`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`🏠 Max rooms: ${MAX_ROOMS}`);
  console.log(`👥 Max players per room: ${MAX_PLAYERS_PER_ROOM}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  if (RENDER_SERVICE_URL) {
    console.log(`🔗 Service URL: ${RENDER_SERVICE_URL}`);
  }
});

// Graceful shutdown
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
