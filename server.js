import http from "node:http";
import express from "express";
import { Server } from "socket.io";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const httpServer = http.createServer(app);
app.use(express.json({ limit: "256kb" }));

const allowedOrigins = [
  process.env.ORIGIN_ENDPOINT,
  process.env.ORIGIN_ENPOINT,
  process.env.NEXTAUTH_URL,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
].filter(Boolean);

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
  },
});

// ============ HEALTH CHECK FOR RENDER ============
app.get("/", (req, res) => {
  res.send("Socket.io server is running 🚀");
});

// ============ ONLINE USERS MAP ============
// Tracks all active sockets per user for multi-tab/device support.
const onlineUsers = new Map();

function getOnlineUserIds() {
  return Array.from(onlineUsers.keys());
}

function addOnlineSocket(userId, socketId) {
  const sockets = onlineUsers.get(userId) || new Set();
  const wasOffline = sockets.size === 0;
  sockets.add(socketId);
  onlineUsers.set(userId, sockets);
  return wasOffline;
}

function removeOnlineSocket(socketId) {
  for (const [userId, sockets] of onlineUsers.entries()) {
    if (!sockets.has(socketId)) continue;

    sockets.delete(socketId);
    if (sockets.size === 0) {
      onlineUsers.delete(userId);
      return { userId, becameOffline: true };
    }

    onlineUsers.set(userId, sockets);
    return { userId, becameOffline: false };
  }

  return null;
}

app.post("/internal/broadcast", (req, res) => {
  const expectedToken = process.env.SOCKET_INTERNAL_BROADCAST_TOKEN;
  const authHeader = req.headers.authorization;

  if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { event, data } = req.body || {};

  if (!event || typeof data !== "object" || data === null) {
    return res.status(400).json({ error: "Invalid broadcast payload" });
  }

  if (event === "new_message") {
    const message = data.message;
    if (!message?.senderId || !message?.receiverId) {
      return res.status(400).json({ error: "Invalid message payload" });
    }

    io.to(message.receiverId).emit("receive_message", message);
    io.to(message.senderId).emit("receive_message", message);
    return res.json({ ok: true });
  }

  if (event === "messages_read") {
    const targetUserId = data.targetUserId;
    const messageIds = Array.isArray(data.messageIds)
      ? data.messageIds.filter((id) => typeof id === "string")
      : [];
    const readerId = data.readerId;

    if (!targetUserId || messageIds.length === 0) {
      return res.status(400).json({ error: "Invalid read receipt payload" });
    }

    io.to(targetUserId).emit("messages_read", {
      messageIds,
      readerId: typeof readerId === "string" ? readerId : null,
    });

    for (const messageId of messageIds) {
      io.to(targetUserId).emit("message_read", { messageId, readerId });
    }

    return res.json({ ok: true });
  }

  if (event === "message_delivered") {
    const targetUserId = data.targetUserId;
    const messageId = data.messageId;

    if (!targetUserId || !messageId) {
      return res
        .status(400)
        .json({ error: "Invalid delivery receipt payload" });
    }

    io.to(targetUserId).emit("message_delivered", {
      messageId,
      receiverId: data.receiverId || null,
    });
    return res.json({ ok: true });
  }

  if (event === "conversation_cleared") {
    const targetUserId = data.targetUserId;
    const clearedById = data.clearedById;
    const partnerId =
      typeof data.partnerId === "string" ? data.partnerId : null;
    if (!targetUserId || !clearedById) {
      return res.status(400).json({ error: "Invalid clear payload" });
    }

    io.to(targetUserId).emit("conversation_cleared", {
      clearedById,
      partnerId,
    });
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: "Unsupported broadcast event" });
});

// ============ SOCKET.IO LOGIC ============
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // JOIN ROOM
  socket.on("join", (userId) => {
    if (!userId || typeof userId !== "string") return;

    socket.join(userId);
    socket.data.userId = userId;

    const becameOnline = addOnlineSocket(userId, socket.id);

    console.log(`User ${userId} joined room ${userId}`);

    // Notify others user is online
    if (becameOnline) {
      socket.broadcast.emit("user_online", { userId });
    }

    // Send current online users to the new user
    socket.emit("online_users_list", { userIds: getOnlineUserIds() });
  });

  // SEND MESSAGE
  socket.on("send_message", (message) => {
    if (!message?.receiverId || !message?.senderId) return;

    io.to(message.receiverId).emit("receive_message", {
      ...message,
      isRead: false,
      isDelivered: false,
    });

    io.to(message.senderId).emit("receive_message", {
      ...message,
      isRead: false,
      isDelivered: false,
    });
  });

  // READ RECEIPT
  socket.on("message_read", ({ messageId, senderId, receiverId }) => {
    io.to(senderId).emit("message_read", { messageId, receiverId });
  });

  // DELIVERY RECEIPT
  socket.on("message_delivered", ({ messageId, senderId, receiverId }) => {
    io.to(senderId).emit("message_delivered", { messageId, receiverId });
  });

  // TYPING INDICATORS
  socket.on("typing", ({ senderId, receiverId }) => {
    io.to(receiverId).emit("user_typing", { senderId });
  });

  socket.on("stop_typing", ({ senderId, receiverId }) => {
    io.to(receiverId).emit("user_stop_typing", { senderId });
  });

  // ============ WEBRTC SIGNALING ============

  // Initiate Call
  socket.on("call_user", (data) => {
    // data: { userToCall, signalData, from, name }
    io.to(data.userToCall).emit("call_user", {
      signal: data.signalData,
      from: data.from,
      name: data.name,
      image: data.image,
      callType: data.callType,
    });
  });

  // Answer Call
  socket.on("answer_call", (data) => {
    // data: { to, signal }
    io.to(data.to).emit("call_accepted", data.signal);
  });

  // Reject Call
  socket.on("reject_call", (data) => {
    // data: { to }
    io.to(data.to).emit("call_rejected");
  });

  // End Call
  socket.on("end_call", (data) => {
    // data: { to }
    io.to(data.to).emit("call_ended");
  });

  // ICE Candidates
  socket.on("ice_candidate", (data) => {
    // data: { to, candidate }
    io.to(data.to).emit("ice_candidate", { candidate: data.candidate });
  });

  // PING/PONG - Keep connection alive
  socket.on("ping", () => {
    socket.emit("pong");
  });

  // DISCONNECT HANDLER
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    const disconnected = removeOnlineSocket(socket.id);
    if (disconnected?.becameOffline) {
      socket.broadcast.emit("user_offline", { userId: disconnected.userId });
    }
  });
});

// ============ PORT CONFIG (Render Compatible) ============
const PORT = process.env.PORT || 4000;

httpServer.listen(PORT, () => {
  console.log(`🔥 Socket.io server running on port ${PORT}`);
});
