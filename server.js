const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
require("dotenv").config();

const app = express();
const httpServer = http.createServer(app);

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
const onlineUsers = new Map();

// ============ SOCKET.IO LOGIC ============
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // JOIN ROOM
  socket.on("join", (userId) => {
    socket.join(userId);
    onlineUsers.set(userId, socket.id);

    console.log(`User ${userId} joined room ${userId}`);

    // Notify others user is online
    socket.broadcast.emit("user_online", { userId });

    // Send current online users to the new user
    const onlineUserIds = Array.from(onlineUsers.keys());
    socket.emit("online_users_list", { userIds: onlineUserIds });
  });

  // SEND MESSAGE
  socket.on("send_message", (message) => {
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

    let disconnectedUserId = null;
    for (const [userId, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) {
        disconnectedUserId = userId;
        onlineUsers.delete(userId);
        break;
      }
    }

    if (disconnectedUserId) {
      socket.broadcast.emit("user_offline", { userId: disconnectedUserId });
    }
  });
});

// ============ PORT CONFIG (Render Compatible) ============
const PORT = process.env.PORT || 4000;

httpServer.listen(PORT, () => {
  console.log(`🔥 Socket.io server running on port ${PORT}`);
});
