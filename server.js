const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();
const httpServer = http.createServer();
const io = new Server(httpServer, {
  cors: {
    origin: process.env.ORIGIN_ENPOINT,
    methods: ["GET", "POST"],
  },
});

// Track online users: userId -> socketId
const onlineUsers = new Map();

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // User joins their own room based on userId
  socket.on("join", (userId) => {
    socket.join(userId);
    onlineUsers.set(userId, socket.id);
    console.log(`User ${userId} joined room ${userId}`);

    // Broadcast online status to everyone (or could be scoped to contacts)
    socket.broadcast.emit("user_online", { userId });

    // Send list of online users to the new user
    const onlineUserIds = Array.from(onlineUsers.keys());
    socket.emit("online_users_list", { userIds: onlineUserIds });
  });

  // Handle sending messages
  socket.on("send_message", (message) => {
    // Broadcast to receiver's room
    io.to(message.receiverId).emit("receive_message", {
      ...message,
      isRead: false,
      isDelivered: false,
    });

    // Also emit back to sender (for multi-device sync)
    io.to(message.senderId).emit("receive_message", {
      ...message,
      isRead: false,
      isDelivered: false,
    });
  });

  // Handle message read status
  socket.on("message_read", ({ messageId, senderId, receiverId }) => {
    // Notify sender that message was read
    io.to(senderId).emit("message_read", { messageId, receiverId });
  });

  // Handle message delivered status
  socket.on("message_delivered", ({ messageId, senderId, receiverId }) => {
    // Notify sender that message was delivered
    io.to(senderId).emit("message_delivered", { messageId, receiverId });
  });

  // Handle typing indicators
  socket.on("typing", ({ senderId, receiverId }) => {
    io.to(receiverId).emit("user_typing", { senderId });
  });

  socket.on("stop_typing", ({ senderId, receiverId }) => {
    io.to(receiverId).emit("user_stop_typing", { senderId });
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    // Find userId for this socket
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

const PORT = 4000;
httpServer.listen(PORT, () => {
  console.log(`Socket.io server running on port ${PORT}`);
});
