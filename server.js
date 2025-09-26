const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// データストレージ (本番環境ではRedisなどを使用)
const rooms = new Map();
const users = new Map();

// ルームデータ構造
class Room {
  constructor(name, rule, password = null) {
    this.id = uuidv4();
    this.name = name;
    this.rule = rule; // 'normal' or 'ex'
    this.password = password;
    this.members = new Map();
    this.currentSong = {
      isActive: false,
      scores: new Map(),
      completedPlayers: new Set()
    };
    this.songHistory = [];
    this.totalPoints = new Map();
    this.chatMessages = [];
    this.createdAt = new Date();
  }

  addMember(userId, username) {
    this.members.set(userId, {
      id: userId,
      username: username,
      isPlayer: true,
      socketId: null
    });
    this.totalPoints.set(userId, 0);
  }

  removeMember(userId) {
    this.members.delete(userId);
    this.totalPoints.delete(userId);
    this.currentSong.scores.delete(userId);
    this.currentSong.completedPlayers.delete(userId);
  }

  setMemberRole(userId, isPlayer) {
    const member = this.members.get(userId);
    if (member) {
      member.isPlayer = isPlayer;
      if (!isPlayer) {
        this.currentSong.scores.delete(userId);
        this.currentSong.completedPlayers.delete(userId);
      }
    }
  }

  setScore(userId, normalScore, exScore) {
    const member = this.members.get(userId);
    if (!member || !member.isPlayer) return false;

    this.currentSong.scores.set(userId, {
      normalScore,
      exScore,
      username: member.username
    });

    // 全員が0点を送信した場合、新しい曲の開始とみなす
    const playerScores = Array.from(this.currentSong.scores.values());
    const activePlayers = Array.from(this.members.values()).filter(m => m.isPlayer);
    
    if (playerScores.length === activePlayers.length && 
        playerScores.every(score => score.normalScore === 0 && score.exScore === 0)) {
      this.startNewSong();
    }

    return true;
  }

  finishSong(userId) {
    const member = this.members.get(userId);
    if (!member || !member.isPlayer) return false;

    this.currentSong.completedPlayers.add(userId);
    
    // 全プレイヤーが完了した場合、順位を確定
    const activePlayers = Array.from(this.members.values()).filter(m => m.isPlayer);
    if (this.currentSong.completedPlayers.size === activePlayers.length) {
      this.finalizeSongRanking();
    }

    return true;
  }

  startNewSong() {
    this.currentSong = {
      isActive: true,
      scores: new Map(),
      completedPlayers: new Set()
    };
  }

  finalizeSongRanking() {
    if (this.currentSong.scores.size === 0) return;

    const scoreArray = Array.from(this.currentSong.scores.entries());
    const sortedScores = scoreArray.sort(([, a], [, b]) => {
      const scoreA = this.rule === 'ex' ? a.exScore : a.normalScore;
      const scoreB = this.rule === 'ex' ? b.exScore : b.normalScore;
      return scoreB - scoreA;
    });

    // ポイント付与
    if (sortedScores.length >= 1) {
      const firstPlaceId = sortedScores[0][0];
      this.totalPoints.set(firstPlaceId, (this.totalPoints.get(firstPlaceId) || 0) + 2);
    }
    if (sortedScores.length >= 2) {
      const secondPlaceId = sortedScores[1][0];
      this.totalPoints.set(secondPlaceId, (this.totalPoints.get(secondPlaceId) || 0) + 1);
    }

    // 履歴に追加
    this.songHistory.push({
      timestamp: new Date(),
      ranking: sortedScores.map(([userId, score], index) => ({
        rank: index + 1,
        userId,
        username: score.username,
        normalScore: score.normalScore,
        exScore: score.exScore,
        points: index === 0 ? 2 : (index === 1 ? 1 : 0)
      }))
    });

    this.currentSong.isActive = false;
  }

  getRanking() {
    const scoreArray = Array.from(this.currentSong.scores.entries());
    return scoreArray.sort(([, a], [, b]) => {
      const scoreA = this.rule === 'ex' ? a.exScore : a.normalScore;
      const scoreB = this.rule === 'ex' ? b.exScore : b.normalScore;
      return scoreB - scoreA;
    });
  }

  addChatMessage(userId, message) {
    const member = this.members.get(userId);
    if (!member) return false;

    const chatMessage = {
      id: uuidv4(),
      userId,
      username: member.username,
      message,
      timestamp: new Date()
    };
    
    this.chatMessages.push(chatMessage);
    // 最新100件のメッセージのみ保持
    if (this.chatMessages.length > 100) {
      this.chatMessages = this.chatMessages.slice(-100);
    }
    
    return chatMessage;
  }
}

// REST APIエンドポイント

// 部屋一覧取得
app.get('/api/rooms', (req, res) => {
  const roomList = Array.from(rooms.values()).map(room => ({
    id: room.id,
    name: room.name,
    rule: room.rule,
    hasPassword: !!room.password,
    memberCount: room.members.size,
    createdAt: room.createdAt
  }));
  
  res.json({ rooms: roomList });
});

// 部屋作成
app.post('/api/rooms', (req, res) => {
  const { name, rule, password } = req.body;
  
  if (!name || !rule || !['normal', 'ex'].includes(rule)) {
    return res.status(400).json({ error: 'Invalid room parameters' });
  }

  const room = new Room(name, rule, password);
  rooms.set(room.id, room);
  
  res.json({ 
    roomId: room.id,
    message: 'Room created successfully'
  });
});

// 入室
app.post('/api/rooms/:roomId/join', (req, res) => {
  const { roomId } = req.params;
  const { username, password } = req.body;
  
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (room.password && room.password !== password) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const userId = uuidv4();
  room.addMember(userId, username);
  users.set(userId, { username, roomId });

  res.json({ 
    userId,
    message: 'Joined room successfully',
    room: {
      id: room.id,
      name: room.name,
      rule: room.rule
    }
  });
});

// スコア送信
app.post('/api/score', (req, res) => {
  const { userId, normalScore, exScore } = req.body;
  
  if (!userId || normalScore === undefined || exScore === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const user = users.get(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const room = rooms.get(user.roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const success = room.setScore(userId, normalScore, exScore);
  if (!success) {
    return res.status(400).json({ error: 'Cannot set score' });
  }

  // リアルタイム更新
  io.to(room.id).emit('scoreUpdate', {
    ranking: room.getRanking(),
    rule: room.rule
  });

  res.json({ message: 'Score submitted successfully' });
});

// 曲終了通知
app.post('/api/finish-song', (req, res) => {
  const { userId } = req.body;
  
  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  const user = users.get(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const room = rooms.get(user.roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const success = room.finishSong(userId);
  if (!success) {
    return res.status(400).json({ error: 'Cannot finish song' });
  }

  // リアルタイム更新
  io.to(room.id).emit('songFinished', {
    totalPoints: Array.from(room.totalPoints.entries()).map(([userId, points]) => ({
      userId,
      username: room.members.get(userId)?.username,
      points
    })),
    songHistory: room.songHistory
  });

  res.json({ message: 'Song finished successfully' });
});

// Socket.IO接続処理
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // 部屋参加
  socket.on('joinRoom', ({ userId, roomId }) => {
    const user = users.get(userId);
    const room = rooms.get(roomId);
    
    if (user && room && user.roomId === roomId) {
      socket.join(roomId);
      
      // メンバーのソケットIDを更新
      const member = room.members.get(userId);
      if (member) {
        member.socketId = socket.id;
      }

      // 現在の状態を送信
      socket.emit('roomState', {
        room: {
          id: room.id,
          name: room.name,
          rule: room.rule
        },
        members: Array.from(room.members.values()),
        currentRanking: room.getRanking(),
        totalPoints: Array.from(room.totalPoints.entries()).map(([userId, points]) => ({
          userId,
          username: room.members.get(userId)?.username,
          points
        })),
        chatMessages: room.chatMessages,
        songHistory: room.songHistory
      });

      // 他のメンバーに通知
      socket.to(roomId).emit('memberJoined', {
        members: Array.from(room.members.values())
      });
    }
  });

  // プレイヤー/観戦者切り替え
  socket.on('toggleRole', ({ userId, isPlayer }) => {
    const user = users.get(userId);
    if (!user) return;

    const room = rooms.get(user.roomId);
    if (!room) return;

    room.setMemberRole(userId, isPlayer);

    io.to(room.id).emit('memberRoleChanged', {
      members: Array.from(room.members.values())
    });
  });

  // チャットメッセージ
  socket.on('sendMessage', ({ userId, message }) => {
    const user = users.get(userId);
    if (!user || !message.trim()) return;

    const room = rooms.get(user.roomId);
    if (!room) return;

    const chatMessage = room.addChatMessage(userId, message.trim());
    if (chatMessage) {
      io.to(room.id).emit('newMessage', chatMessage);
    }
  });

  // 切断処理
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // ユーザーを検索してソケットIDをクリア
    for (const [userId, user] of users.entries()) {
      const room = rooms.get(user.roomId);
      if (room) {
        const member = room.members.get(userId);
        if (member && member.socketId === socket.id) {
          member.socketId = null;
          break;
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});