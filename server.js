// Render.com対応 音ゲーリアルタイムスコアサーバー
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

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
const MAX_PLAYERS = 10;
const INACTIVE_TIMEOUT = 10 * 60 * 1000; // 10分
const PORT = process.env.PORT || 3000;

// データストレージ
let gameRooms = {};
let connections = {};

// 静的ファイル配信
app.use(express.static('public'));

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

// ヘルスチェック（Render用）
app.get('/', (req, res) => {
  const stats = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    connections: Object.keys(connections).length,
    rooms: Object.keys(gameRooms).length,
    maxCapacity: MAX_PLAYERS,
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
    }
  };
  res.json(stats);
});

// Keep-alive endpoint（スリープ防止用）
app.get('/ping', (req, res) => {
  res.json({ 
    pong: true, 
    time: Date.now() 
  });
});

// API endpoint - room list
app.get('/api/rooms', (req, res) => {
  const roomList = Object.entries(gameRooms).map(([songHash, room]) => ({
    songHash,
    playerCount: room.players.size,
    lastActivity: room.lastActivity,
    players: Array.from(room.players.values()).map(p => ({
      userId: p.userId,
      score: p.score
    }))
  }));
  
  res.json({
    rooms: roomList,
    totalRooms: roomList.length,
    totalPlayers: Object.keys(connections).length
  });
});

// WebSocket接続処理
io.on('connection', (socket) => {
  console.log(`🎵 New connection: ${socket.id} (${new Date().toLocaleTimeString()})`);

  socket.on('join', ({ userId, songHash }) => {
    // 容量チェック
    if (Object.keys(connections).length >= MAX_PLAYERS) {
      socket.emit('error', { 
        message: 'サーバーが満員です (最大10人)',
        code: 'SERVER_FULL' 
      });
      socket.disconnect();
      return;
    }

    // 入力値検証
    if (!userId || !songHash || userId.length > 20 || songHash.length > 50) {
      socket.emit('error', { 
        message: '無効な入力値です',
        code: 'INVALID_INPUT' 
      });
      return;
    }

    // 既存接続をクリーンアップ
    cleanup(socket.id);
    
    // 部屋作成/参加
    if (!gameRooms[songHash]) {
      gameRooms[songHash] = {
        players: new Map(),
        lastActivity: Date.now(),
        createdAt: Date.now()
      };
      console.log(`🏠 New room created: ${songHash}`);
    }

    const room = gameRooms[songHash];
    room.players.set(socket.id, {
      userId: userId.trim(),
      score: 0,
      lastUpdate: Date.now(),
      joinTime: Date.now()
    });
    room.lastActivity = Date.now();

    connections[socket.id] = {
      userId: userId.trim(),
      songHash,
      score: 0,
      joinTime: Date.now()
    };

    socket.join(songHash);
    
    // 参加成功を通知
    socket.emit('joined', {
      songHash,
      userId: userId.trim(),
      roomPlayers: room.players.size
    });
    
    broadcastRoom(songHash);
    
    console.log(`✅ ${userId} joined ${songHash} (${room.players.size}/${MAX_PLAYERS})`);
  });

  socket.on('score', (score) => {
    const conn = connections[socket.id];
    if (!conn) return;

    // スコア妥当性チェック
    if (typeof score !== 'number' || score < 0 || score > 99999999) {
      return;
    }

    const roundedScore = Math.floor(score);
    conn.score = roundedScore;
    
    const room = gameRooms[conn.songHash];
    if (room && room.players.has(socket.id)) {
      const player = room.players.get(socket.id);
      player.score = roundedScore;
      player.lastUpdate = Date.now();
      room.lastActivity = Date.now();
      
      broadcastRoom(conn.songHash);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`👋 Disconnection: ${socket.id} (${reason})`);
    cleanup(socket.id);
  });

  // Ping-pong for connection health
  socket.on('ping', () => {
    socket.emit('pong');
  });

  // クリーンアップ関数
  function cleanup(socketId) {
    const conn = connections[socketId];
    if (conn) {
      const room = gameRooms[conn.songHash];
      if (room) {
        room.players.delete(socketId);
        if (room.players.size === 0) {
          delete gameRooms[conn.songHash];
          console.log(`🗑️ Empty room deleted: ${conn.songHash}`);
        } else {
          room.lastActivity = Date.now();
          broadcastRoom(conn.songHash);
        }
      }
      delete connections[socketId];
    }
  }

  // 部屋状態の配信
  function broadcastRoom(songHash) {
    const room = gameRooms[songHash];
    if (!room) return;

    const players = Array.from(room.players.entries())
      .map(([socketId, data]) => ({
        userId: data.userId,
        score: data.score,
        lastUpdate: data.lastUpdate
      }))
      .sort((a, b) => b.score - a.score);

    const topScore = players[0]?.score || 0;
    const result = players.map((player, idx) => ({
      ...player,
      rank: idx + 1,
      diff: idx === 0 ? 0 : topScore - player.score
    }));

    io.to(songHash).emit('update', {
      players: result,
      count: players.length,
      timestamp: Date.now()
    });
  }
});

// 定期クリーンアップ
setInterval(() => {
  const now = Date.now();
  let cleanedRooms = 0;

  Object.entries(gameRooms).forEach(([songHash, room]) => {
    if (now - room.lastActivity > INACTIVE_TIMEOUT) {
      delete gameRooms[songHash];
      cleanedRooms++;
    }
  });

  if (cleanedRooms > 0) {
    console.log(`🧹 Cleaned ${cleanedRooms} inactive rooms`);
  }

  // メモリ使用量ログ（開発用）
  const memUsage = process.memoryUsage();
  if (memUsage.heapUsed > 50 * 1024 * 1024) { // 50MB超過時
    console.log(`⚠️ High memory usage: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
  }
}, 2 * 60 * 1000); // 2分ごと

// Render対応のkeep-alive（スリープ防止）
// 注意: 無料枠では750時間/月の制限があるので、必要な時だけ有効化
const RENDER_SERVICE_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_SERVICE_URL && process.env.NODE_ENV === 'production') {
  console.log('🔄 Keep-alive enabled for Render');
  setInterval(() => {
    try {
      require('http').get(`${RENDER_SERVICE_URL}/ping`, (res) => {
        // レスポンスを消費（メモリリーク防止）
        res.on('data', () => {});
        res.on('end', () => {});
      });
    } catch (error) {
      console.error('Keep-alive request failed:', error.message);
    }
  }, 14 * 60 * 1000); // 14分ごと（15分以内）
}

// サーバー起動
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 Rhythm Game Server is running!`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`💾 Max players: ${MAX_PLAYERS}`);
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
