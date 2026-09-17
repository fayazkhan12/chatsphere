const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const Notification = require('../models/Notification');

// Maps a userId -> Set of socket ids (a user can have multiple tabs/devices open)
const onlineUsers = new Map();

const addOnlineUser = (userId, socketId) => {
  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socketId);
};

const removeOnlineUser = (userId, socketId) => {
  if (!onlineUsers.has(userId)) return;
  onlineUsers.get(userId).delete(socketId);
  if (onlineUsers.get(userId).size === 0) onlineUsers.delete(userId);
};

const isUserOnline = (userId) => onlineUsers.has(String(userId));

function initSocket(io) {
  // --- Authentication middleware for sockets ---
  // Client must connect with: io(URL, { auth: { token: "<JWT>" } })
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Authentication error: no token provided'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id);
      if (!user) return next(new Error('Authentication error: user not found'));

      socket.user = user;
      next();
    } catch (err) {
      next(new Error('Authentication error: invalid token'));
    }
  });

  io.on('connection', async (socket) => {
    const userId = String(socket.user._id);
    console.log(`Socket connected: ${socket.user.username} (${socket.id})`);

    // --- user comes online ---
    addOnlineUser(userId, socket.id);
    await User.findByIdAndUpdate(userId, { isOnline: true });
    socket.broadcast.emit('user_online', { userId });

    // Auto-join every conversation the user already belongs to, so messages
    // and events reach them the instant they connect (no manual join needed).
    const conversations = await Conversation.find({ participants: userId }).select('_id');
    conversations.forEach((c) => socket.join(String(c._id)));

    // --- join/leave a specific room (used when opening/closing a chat window) ---
    socket.on('join_room', (conversationId) => {
      socket.join(conversationId);
    });

    socket.on('leave_room', (conversationId) => {
      socket.leave(conversationId);
    });

    // --- send a message ---
    socket.on('send_message', async (data, callback) => {
      try {
        const { conversationId, text, messageType, replyTo, fileUrl } = data;

        const conversation = await Conversation.findById(conversationId);
        if (!conversation || !conversation.participants.some((p) => String(p) === userId)) {
          return callback?.({ error: 'Not a participant of this conversation' });
        }

        const message = await Message.create({
          conversationId,
          sender: userId,
          text,
          messageType: messageType || 'text',
          fileUrl: fileUrl || undefined,
          replyTo: replyTo || null,
          status: 'sent',
        });

        conversation.lastMessage = message._id;
        await conversation.save();

        const populatedMessage = await message.populate(
          'sender',
          'name username profilePicture'
        );

        // Broadcast to everyone in the conversation room, including sender
        // (sender uses this to confirm the message was actually saved)
        io.to(conversationId).emit('receive_message', populatedMessage);

        // Mark delivered for participants who are currently online
        const otherParticipants = conversation.participants.filter(
          (p) => String(p) !== userId
        );

        let deliveredToAnyone = false;
        for (const participantId of otherParticipants) {
          if (isUserOnline(String(participantId))) {
            deliveredToAnyone = true;
          } else {
            // Offline user -> create a persistent notification for later
            const notification = await Notification.create({
              recipient: participantId,
              sender: userId,
              type: conversation.type === 'group' ? 'group_message' : 'new_message',
              message:
                conversation.type === 'group'
                  ? `${socket.user.name} sent a message in ${conversation.groupName}`
                  : `${socket.user.name} sent you a message`,
              conversationId,
            });
            io.to(String(participantId)).emit('new_notification', notification);
          }
        }

        if (deliveredToAnyone) {
          message.status = 'delivered';
          await message.save();
          io.to(conversationId).emit('message_delivered', { messageId: message._id });
        }

        callback?.({ success: true, message: populatedMessage });
      } catch (err) {
        console.error('send_message error:', err.message);
        callback?.({ error: 'Could not send message' });
      }
    });

    // --- read receipts ---
    socket.on('message_read', async ({ conversationId, messageIds }) => {
      try {
        await Message.updateMany(
          { _id: { $in: messageIds } },
          { $addToSet: { readBy: userId }, $set: { status: 'read' } }
        );
        io.to(conversationId).emit('message_read', { messageIds, readBy: userId });
      } catch (err) {
        console.error('message_read error:', err.message);
      }
    });

    // --- typing indicator ---
    socket.on('typing', ({ conversationId }) => {
      socket.to(conversationId).emit('typing', {
        conversationId,
        userId,
        name: socket.user.name,
      });
    });

    socket.on('stop_typing', ({ conversationId }) => {
      socket.to(conversationId).emit('stop_typing', { conversationId, userId });
    });

    // --- join a personal room too, so we can target notifications directly at a user ---
    socket.join(userId);

    // --- disconnect ---
    socket.on('disconnect', async () => {
      removeOnlineUser(userId, socket.id);
      console.log(`Socket disconnected: ${socket.user.username} (${socket.id})`);

      // Only mark fully offline if this was the user's LAST open connection/tab
      if (!isUserOnline(userId)) {
        const lastSeen = new Date();
        await User.findByIdAndUpdate(userId, { isOnline: false, lastSeen });
        socket.broadcast.emit('user_offline', { userId, lastSeen });
      }
    });
  });
}

module.exports = { initSocket, isUserOnline };