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

// データ構造
let rooms = new Map(); // roomId -> room data
let users = new Map(); // userId -> user data
let socketToUser = new Map(); // socketId -> userId

// 部屋のデータ構造
class Room {
    constructor(name, rule, password = null, ownerId) {
        this.id = uuidv4();
        this.name = name;
        this.rule = rule; // 'normal' or 'ex'
        this.password = password;
        this.ownerId = ownerId;
        this.members = new Set();
        this.currentSong = null;
        this.songHistory = [];
        this.createdAt = new Date();
    }

    addMember(userId) {
        this.members.add(userId);
    }

    removeMember(userId) {
        this.members.delete(userId);
        // 部屋主が退出した場合、次の人に権限を委譲
        if (this.ownerId === userId && this.members.size > 0) {
            this.ownerId = Array.from(this.members)[0];
        }
    }

    getMemberList() {
        return Array.from(this.members).map(userId => users.get(userId)).filter(user => user);
    }
}

// ユーザーのデータ構造
class User {
    constructor(username, type = 'web') {
        this.id = uuidv4();
        this.username = username;
        this.type = type; // 'web' or 'api'
        this.role = 'spectator'; // 'player' or 'spectator'
        this.roomId = null;
        this.points = 0;
        this.socketId = null;
        this.isOnline = true;
        this.joinedAt = new Date();
    }
}

// 曲のデータ構造
class Song {
    constructor(roomId) {
        this.id = uuidv4();
        this.roomId = roomId;
        this.scores = new Map(); // userId -> {normal, ex, finished}
        this.startedAt = new Date();
        this.finishedAt = null;
        this.rankings = null;
    }

    addScore(userId, normalScore, exScore) {
        this.scores.set(userId, {
            normal: normalScore,
            ex: exScore,
            finished: false,
            submittedAt: new Date()
        });
    }

    finishUser(userId) {
        const score = this.scores.get(userId);
        if (score) {
            score.finished = true;
        }
    }

    calculateRankings(rule) {
        const players = Array.from(this.scores.entries())
            .map(([userId, data]) => ({
                userId,
                score: rule === 'ex' ? data.ex : data.normal,
                ...data
            }))
            .sort((a, b) => b.score - a.score);

        this.rankings = players.map((player, index) => ({
            ...player,
            rank: index + 1
        }));

        return this.rankings;
    }

    isAllPlayersFinished(room) {
        const players = room.getMemberList().filter(user => user.role === 'player');
        return players.every(player => {
            const score = this.scores.get(player.id);
            return score && score.finished;
        });
    }
}

// REST API エンドポイント

// ユーザー接続
app.post('/api/connect', (req, res) => {
    const { username } = req.body;
    
    if (!username) {
        return res.status(400).json({ error: 'Username is required' });
    }

    const user = new User(username, 'api');
    users.set(user.id, user);

    res.json({
        userId: user.id,
        username: user.username
    });
});

// 部屋作成
app.post('/api/rooms', (req, res) => {
    const { name, rule, password, userId } = req.body;
    
    if (!name || !rule || !userId) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const user = users.get(userId);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    const room = new Room(name, rule, password, userId);
    room.addMember(userId);
    user.roomId = room.id;
    
    rooms.set(room.id, room);

    // WebSocketクライアントに通知
    io.emit('roomCreated', {
        id: room.id,
        name: room.name,
        rule: room.rule,
        memberCount: room.members.size,
        hasPassword: !!room.password
    });

    res.json({ roomId: room.id });
});

// 部屋一覧取得
app.get('/api/rooms', (req, res) => {
    const roomList = Array.from(rooms.values()).map(room => ({
        id: room.id,
        name: room.name,
        rule: room.rule,
        memberCount: room.members.size,
        hasPassword: !!room.password,
        createdAt: room.createdAt
    }));

    res.json(roomList);
});

// 部屋入室
app.post('/api/rooms/:roomId/join', (req, res) => {
    const { roomId } = req.params;
    const { userId, password } = req.body;

    const room = rooms.get(roomId);
    const user = users.get(userId);

    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }

    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    if (room.password && room.password !== password) {
        return res.status(403).json({ error: 'Invalid password' });
    }

    // 既に他の部屋にいる場合は退出
    if (user.roomId) {
        const oldRoom = rooms.get(user.roomId);
        if (oldRoom) {
            oldRoom.removeMember(userId);
            io.to(`room_${user.roomId}`).emit('memberLeft', {
                userId: userId,
                username: user.username
            });
        }
    }

    room.addMember(userId);
    user.roomId = roomId;
    user.role = 'spectator'; // 初期は観戦者

    // WebSocketクライアントに通知
    io.to(`room_${roomId}`).emit('memberJoined', {
        userId: user.id,
        username: user.username,
        type: user.type,
        role: user.role,
        points: user.points
    });

    res.json({ success: true });
});

// 部屋退室
app.post('/api/rooms/:roomId/leave', (req, res) => {
    const { roomId } = req.params;
    const { userId } = req.body;

    const room = rooms.get(roomId);
    const user = users.get(userId);

    if (!room || !user) {
        return res.status(404).json({ error: 'Room or user not found' });
    }

    room.removeMember(userId);
    user.roomId = null;
    user.role = 'spectator';

    // WebSocketクライアントに通知
    io.to(`room_${roomId}`).emit('memberLeft', {
        userId: userId,
        username: user.username
    });

    // 部屋が空の場合は削除
    if (room.members.size === 0) {
        rooms.delete(roomId);
        io.emit('roomDeleted', roomId);
    }

    res.json({ success: true });
});

// スコア送信
app.post('/api/rooms/:roomId/score', (req, res) => {
    const { roomId } = req.params;
    const { userId, normalScore, exScore } = req.body;

    const room = rooms.get(roomId);
    const user = users.get(userId);

    if (!room || !user || user.roomId !== roomId) {
        return res.status(404).json({ error: 'Room or user not found' });
    }

    if (user.role !== 'player') {
        return res.status(403).json({ error: 'Only players can submit scores' });
    }

    // 新しい曲の開始または既存曲へのスコア追加
    if (!room.currentSong) {
        room.currentSong = new Song(roomId);
    }

    room.currentSong.addScore(userId, normalScore, exScore);

    // WebSocketクライアントに通知
    io.to(`room_${roomId}`).emit('scoreUpdated', {
        userId: userId,
        username: user.username,
        normalScore: normalScore,
        exScore: exScore,
        rule: room.rule
    });

    // 現在のランキングを計算して送信
    const rankings = room.currentSong.calculateRankings(room.rule);
    io.to(`room_${roomId}`).emit('rankingsUpdated', rankings);

    res.json({ success: true });
});

// 曲終了通知
app.post('/api/rooms/:roomId/finish', (req, res) => {
    const { roomId } = req.params;
    const { userId } = req.body;

    const room = rooms.get(roomId);
    const user = users.get(userId);

    if (!room || !user || user.roomId !== roomId) {
        return res.status(404).json({ error: 'Room or user not found' });
    }

    if (!room.currentSong) {
        return res.status(400).json({ error: 'No active song' });
    }

    room.currentSong.finishUser(userId);

    // WebSocketクライアントに通知
    io.to(`room_${roomId}`).emit('userFinished', {
        userId: userId,
        username: user.username
    });

    // 全プレイヤーが終了したかチェック
    if (room.currentSong.isAllPlayersFinished(room)) {
        const rankings = room.currentSong.calculateRankings(room.rule);
        
        // ポイント付与 (1位: 2pt, 2位: 1pt)
        if (rankings.length >= 1) {
            const firstPlace = users.get(rankings[0].userId);
            if (firstPlace) firstPlace.points += 2;
        }
        if (rankings.length >= 2) {
            const secondPlace = users.get(rankings[1].userId);
            if (secondPlace) secondPlace.points += 1;
        }

        room.currentSong.finishedAt = new Date();
        room.songHistory.push(room.currentSong);
        room.currentSong = null;

        // 最終結果を送信
        io.to(`room_${roomId}`).emit('songFinished', {
            rankings: rankings,
            members: room.getMemberList()
        });
    }

    res.json({ success: true });
});

// WebSocket接続処理
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Webクライアントからの接続
    socket.on('webConnect', (data) => {
        const { username } = data;
        
        if (!username) {
            socket.emit('error', { message: 'Username is required' });
            return;
        }

        const user = new User(username, 'web');
        user.socketId = socket.id;
        users.set(user.id, user);
        socketToUser.set(socket.id, user.id);

        socket.emit('connected', {
            userId: user.id,
            username: user.username
        });
    });

    // 部屋作成 (Webクライアント)
    socket.on('createRoom', (data) => {
        const userId = socketToUser.get(socket.id);
        const user = users.get(userId);
        
        if (!user) {
            socket.emit('error', { message: 'User not found' });
            return;
        }

        const room = new Room(data.name, data.rule, data.password, userId);
        room.addMember(userId);
        user.roomId = room.id;
        
        rooms.set(room.id, room);
        socket.join(`room_${room.id}`);

        socket.emit('roomCreated', { roomId: room.id });
        io.emit('roomListUpdated');
    });

    // 部屋入室 (Webクライアント)
    socket.on('joinRoom', (data) => {
        const userId = socketToUser.get(socket.id);
        const user = users.get(userId);
        const room = rooms.get(data.roomId);

        if (!user) {
            socket.emit('error', { message: 'User not found' });
            return;
        }

        if (!room) {
            socket.emit('error', { message: 'Room not found' });
            return;
        }

        if (room.password && room.password !== data.password) {
            socket.emit('error', { message: 'Invalid password' });
            return;
        }

        // 既に他の部屋にいる場合は退出
        if (user.roomId) {
            socket.leave(`room_${user.roomId}`);
            const oldRoom = rooms.get(user.roomId);
            if (oldRoom) {
                oldRoom.removeMember(userId);
                io.to(`room_${user.roomId}`).emit('memberLeft', {
                    userId: userId,
                    username: user.username
                });
            }
        }

        room.addMember(userId);
        user.roomId = data.roomId;
        user.role = 'spectator';

        socket.join(`room_${data.roomId}`);

        // 部屋情報を送信
        socket.emit('joinedRoom', {
            room: {
                id: room.id,
                name: room.name,
                rule: room.rule,
                ownerId: room.ownerId
            },
            members: room.getMemberList(),
            currentSong: room.currentSong,
            songHistory: room.songHistory
        });

        // 他のメンバーに通知
        socket.to(`room_${data.roomId}`).emit('memberJoined', {
            userId: user.id,
            username: user.username,
            type: user.type,
            role: user.role,
            points: user.points
        });
    });

    // ロール変更
    socket.on('changeRole', (data) => {
        const userId = socketToUser.get(socket.id);
        const user = users.get(userId);

        if (!user || !user.roomId) {
            socket.emit('error', { message: 'User not in room' });
            return;
        }

        user.role = data.role;

        io.to(`room_${user.roomId}`).emit('roleChanged', {
            userId: user.id,
            username: user.username,
            role: user.role
        });
    });

    // メンバーのロール変更 (部屋主のみ)
    socket.on('changeMemberRole', (data) => {
        const userId = socketToUser.get(socket.id);
        const user = users.get(userId);
        const targetUser = users.get(data.targetUserId);

        if (!user || !user.roomId) {
            socket.emit('error', { message: 'User not in room' });
            return;
        }

        const room = rooms.get(user.roomId);
        if (!room || room.ownerId !== userId) {
            socket.emit('error', { message: 'Permission denied' });
            return;
        }

        if (!targetUser || targetUser.roomId !== user.roomId) {
            socket.emit('error', { message: 'Target user not found in room' });
            return;
        }

        // API経由のユーザーのみロール変更可能
        if (targetUser.type !== 'api') {
            socket.emit('error', { message: 'Can only change role of API users' });
            return;
        }

        targetUser.role = data.role;

        io.to(`room_${user.roomId}`).emit('roleChanged', {
            userId: targetUser.id,
            username: targetUser.username,
            role: targetUser.role
        });
    });

    // メンバーキック (部屋主のみ)
    socket.on('kickMember', (data) => {
        const userId = socketToUser.get(socket.id);
        const user = users.get(userId);
        const targetUser = users.get(data.targetUserId);

        if (!user || !user.roomId) {
            socket.emit('error', { message: 'User not in room' });
            return;
        }

        const room = rooms.get(user.roomId);
        if (!room || room.ownerId !== userId) {
            socket.emit('error', { message: 'Permission denied' });
            return;
        }

        if (!targetUser || targetUser.roomId !== user.roomId) {
            socket.emit('error', { message: 'Target user not found in room' });
            return;
        }

        room.removeMember(data.targetUserId);
        targetUser.roomId = null;
        targetUser.role = 'spectator';

        io.to(`room_${room.id}`).emit('memberKicked', {
            userId: data.targetUserId,
            username: targetUser.username
        });

        // ソケット接続があれば部屋から退出
        if (targetUser.socketId) {
            const targetSocket = io.sockets.sockets.get(targetUser.socketId);
            if (targetSocket) {
                targetSocket.leave(`room_${room.id}`);
                targetSocket.emit('kicked');
            }
        }
    });

    // ポイントリセット (部屋主のみ)
    socket.on('resetPoints', () => {
        const userId = socketToUser.get(socket.id);
        const user = users.get(userId);

        if (!user || !user.roomId) {
            socket.emit('error', { message: 'User not in room' });
            return;
        }

        const room = rooms.get(user.roomId);
        if (!room || room.ownerId !== userId) {
            socket.emit('error', { message: 'Permission denied' });
            return;
        }

        // 全メンバーのポイントをリセット
        room.getMemberList().forEach(member => {
            member.points = 0;
        });

        io.to(`room_${user.roomId}`).emit('pointsReset', {
            members: room.getMemberList()
        });
    });

    // 部屋削除 (部屋主のみ)
    socket.on('deleteRoom', () => {
        const userId = socketToUser.get(socket.id);
        const user = users.get(userId);

        if (!user || !user.roomId) {
            socket.emit('error', { message: 'User not in room' });
            return;
        }

        const room = rooms.get(user.roomId);
        if (!room || room.ownerId !== userId) {
            socket.emit('error', { message: 'Permission denied' });
            return;
        }

        // 全メンバーを退出させる
        room.getMemberList().forEach(member => {
            member.roomId = null;
            member.role = 'spectator';
            if (member.socketId) {
                const memberSocket = io.sockets.sockets.get(member.socketId);
                if (memberSocket) {
                    memberSocket.leave(`room_${room.id}`);
                }
            }
        });

        io.to(`room_${room.id}`).emit('roomDeleted');
        rooms.delete(room.id);
        io.emit('roomListUpdated');
    });

    // チャット送信
    socket.on('sendMessage', (data) => {
        const userId = socketToUser.get(socket.id);
        const user = users.get(userId);

        if (!user || !user.roomId) {
            socket.emit('error', { message: 'User not in room' });
            return;
        }

        const message = {
            id: uuidv4(),
            userId: user.id,
            username: user.username,
            message: data.message,
            timestamp: new Date()
        };

        io.to(`room_${user.roomId}`).emit('newMessage', message);
    });

    // テストデータ送信 (開発環境のみ)
    socket.on('sendTestScore', (data) => {
        if (process.env.NODE_ENV === 'production') {
            socket.emit('error', { message: 'Test data not available in production' });
            return;
        }

        const userId = socketToUser.get(socket.id);
        const user = users.get(userId);

        if (!user || !user.roomId) {
            socket.emit('error', { message: 'User not in room' });
            return;
        }

        const room = rooms.get(user.roomId);
        if (!room) {
            socket.emit('error', { message: 'Room not found' });
            return;
        }

        if (user.role !== 'player') {
            socket.emit('error', { message: 'Only players can submit scores' });
            return;
        }

        // 新しい曲の開始または既存曲へのスコア追加
        if (!room.currentSong) {
            room.currentSong = new Song(room.id);
        }

        room.currentSong.addScore(userId, data.normalScore, data.exScore);

        // WebSocketクライアントに通知
        io.to(`room_${room.id}`).emit('scoreUpdated', {
            userId: userId,
            username: user.username,
            normalScore: data.normalScore,
            exScore: data.exScore,
            rule: room.rule
        });

        // 現在のランキングを計算して送信
        const rankings = room.currentSong.calculateRankings(room.rule);
        io.to(`room_${room.id}`).emit('rankingsUpdated', rankings);
    });

    // テスト曲終了 (開発環境のみ)
    socket.on('finishTestSong', () => {
        if (process.env.NODE_ENV === 'production') {
            socket.emit('error', { message: 'Test data not available in production' });
            return;
        }

        const userId = socketToUser.get(socket.id);
        const user = users.get(userId);

        if (!user || !user.roomId) {
            socket.emit('error', { message: 'User not in room' });
            return;
        }

        const room = rooms.get(user.roomId);
        if (!room || !room.currentSong) {
            socket.emit('error', { message: 'No active song' });
            return;
        }

        room.currentSong.finishUser(userId);

        io.to(`room_${room.id}`).emit('userFinished', {
            userId: userId,
            username: user.username
        });

        // 全プレイヤーが終了したかチェック
        if (room.currentSong.isAllPlayersFinished(room)) {
            const rankings = room.currentSong.calculateRankings(room.rule);
            
            // ポイント付与
            if (rankings.length >= 1) {
                const firstPlace = users.get(rankings[0].userId);
                if (firstPlace) firstPlace.points += 2;
            }
            if (rankings.length >= 2) {
                const secondPlace = users.get(rankings[1].userId);
                if (secondPlace) secondPlace.points += 1;
            }

            room.currentSong.finishedAt = new Date();
            room.songHistory.push(room.currentSong);
            room.currentSong = null;

            io.to(`room_${room.id}`).emit('songFinished', {
                rankings: rankings,
                members: room.getMemberList()
            });
        }
    });

    // 切断処理
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        const userId = socketToUser.get(socket.id);
        if (userId) {
            const user = users.get(userId);
            if (user) {
                user.isOnline = false;
                user.socketId = null;

                if (user.roomId) {
                    const room = rooms.get(user.roomId);
                    if (room) {
                        room.removeMember(userId);
                        
                        // Webクライアントユーザーは完全に削除
                        if (user.type === 'web') {
                            users.delete(userId);
                        }

                        io.to(`room_${user.roomId}`).emit('memberLeft', {
                            userId: userId,
                            username: user.username
                        });

                        // 部屋が空の場合は削除
                        if (room.members.size === 0) {
                            rooms.delete(room.id);
                            io.emit('roomDeleted', room.id);
                        }
                    }
                }
                
                // Webクライアントユーザーは完全に削除
                if (user.type === 'web') {
                    users.delete(userId);
                }
            }
            
            socketToUser.delete(socket.id);
        }
    });
});

// サーバー起動
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});