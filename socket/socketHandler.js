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

// --- Group/1-to-1 call rooms (WebRTC mesh) ---
// callId is always the conversation's _id: everyone who calls into the same
// conversation lands in the same room. A room looks like:
//   {
//     conversationId,
//     callType,               // 'audio' | 'video' (set by whoever started it)
//     participants: Map(userId -> { name, avatar }),  // actually in the call
//     ringing: Set(userId),   // invited but haven't accepted/declined yet
//   }
// Peers connect directly to each other; the server only relays the small
// WebRTC handshake messages (offer/answer/ICE) between specific peers.
const activeCalls = new Map();

function removeFromCall(io, room, callId, userId) {
  const wasParticipant = room.participants.delete(userId);
  room.ringing.delete(userId);

  if (wasParticipant) {
    room.participants.forEach((_p, pid) => {
      io.to(pid).emit('call_peer_left', { callId, userId });
    });
  }

  // Nobody actually talking anymore -> stop ringing anyone still invited, clean up
  if (room.participants.size === 0) {
    room.ringing.forEach((pid) => {
      io.to(pid).emit('call_cancelled', { callId });
    });
    activeCalls.delete(callId);
  }
}

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
              const { conversationId, text, messageType, replyTo, fileUrl, location } = data;

        const conversation = await Conversation.findById(conversationId);
        if (!conversation || !conversation.participants.some((p) => String(p) === userId)) {
          return callback?.({ error: 'Not a participant of this conversation' });
        }

        // Message-request gate: while a fresh one-to-one chat is still 'pending',
        // only the original requester may send messages. Whoever was messaged
        // must accept the request before they can reply.
        if (
          conversation.status === 'pending' &&
          String(conversation.requestedBy) !== userId
        ) {
          return callback?.({ error: 'Accept this message request before replying' });
        }

        const message = await Message.create({
          conversationId,
          sender: userId,
          text,
          messageType: messageType || 'text',
          fileUrl: fileUrl || undefined,
          location: location || undefined,
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

    // --- voice/video group calling (WebRTC mesh) ---
    // The actual audio/video always travels directly between browsers
    // (peer-to-peer); the server only relays small handshake messages and
    // keeps track of who is currently in which call room.

    // Start OR join the call room for a conversation. The first person to
    // call this becomes the room's first participant and rings everyone
    // else in the conversation; anyone who calls it afterwards (accepting
    // the ring, or opening the same group call independently) just joins
    // the existing room.
    socket.on('join_call', async ({ callId, callType, conversationId }) => {
      try {
        if (!callId || !conversationId) return;

        let room = activeCalls.get(callId);
        if (!room) {
          room = { conversationId, callType, participants: new Map(), ringing: new Set() };
          activeCalls.set(callId, room);
        }

        if (room.participants.has(userId)) return; // already in (duplicate tab etc.)

        const existing = [...room.participants.entries()].map(([pid, p]) => ({
          userId: pid,
          name: p.name,
          avatar: p.avatar,
        }));

        room.participants.set(userId, { name: socket.user.name, avatar: socket.user.profilePicture });
        room.ringing.delete(userId);

        // Tell the joining client who is already in the room
        socket.emit('call_joined', { callId, participants: existing });

        // Tell everyone already there that a new peer joined -> each of
        // them will initiate a WebRTC offer directly to the newcomer.
        existing.forEach((p) => {
          io.to(p.userId).emit('call_peer_joined', {
            callId,
            userId,
            name: socket.user.name,
            avatar: socket.user.profilePicture,
          });
        });

        // First person in the room -> ring the rest of the conversation
        if (existing.length === 0) {
          const conversation = await Conversation.findById(conversationId).select('participants type');
          if (conversation) {
            const targets = conversation.participants.map(String).filter((pid) => pid !== userId);
            targets.forEach((pid) => {
              room.ringing.add(pid);
              io.to(pid).emit('incoming_call', {
                callId,
                from: userId,
                fromName: socket.user.name,
                fromAvatar: socket.user.profilePicture,
                callType: room.callType,
                conversationId,
                isGroup: conversation.type === 'group',
              });
            });
          }
        }
      } catch (err) {
        console.error('join_call error:', err.message);
      }
    });

    // Pull an extra person into an ongoing call, even if they aren't part
    // of the conversation itself (e.g. adding someone mid 1-to-1 call).
    socket.on('call_invite', ({ callId, to }) => {
      const room = activeCalls.get(callId);
      if (!room || !room.participants.has(userId) || !to) return; // only current participants can invite
      if (room.participants.has(to) || room.ringing.has(to)) return; // already in / already invited

      room.ringing.add(to);
      io.to(to).emit('incoming_call', {
        callId,
        from: userId,
        fromName: socket.user.name,
        fromAvatar: socket.user.profilePicture,
        callType: room.callType,
        conversationId: room.conversationId,
        isGroup: true,
      });
    });

    socket.on('reject_call', ({ callId, to }) => {
      const room = activeCalls.get(callId);
      if (room) room.ringing.delete(userId);
      if (to) io.to(to).emit('call_rejected', { callId, from: userId });
    });

    socket.on('leave_call', ({ callId }) => {
      const room = activeCalls.get(callId);
      if (!room) return;
      removeFromCall(io, room, callId, userId);
    });

    // Generic WebRTC signaling relay, addressed peer-to-peer within a call room
    socket.on('call_offer', ({ callId, to, offer }) => {
      io.to(to).emit('call_offer', {
        callId,
        from: userId,
        fromName: socket.user.name,
        fromAvatar: socket.user.profilePicture,
        offer,
      });
    });

    socket.on('call_answer', ({ callId, to, answer }) => {
      io.to(to).emit('call_answer', { callId, from: userId, answer });
    });

    socket.on('call_ice', ({ callId, to, candidate }) => {
      io.to(to).emit('call_ice', { callId, from: userId, candidate });
    });

    // --- disconnect ---
    socket.on('disconnect', async () => {
      removeOnlineUser(userId, socket.id);
      console.log(`Socket disconnected: ${socket.user.username} (${socket.id})`);

      // Only mark fully offline if this was the user's LAST open connection/tab
      if (!isUserOnline(userId)) {
        const lastSeen = new Date();
        await User.findByIdAndUpdate(userId, { isOnline: false, lastSeen });
        socket.broadcast.emit('user_offline', { userId, lastSeen });

        // Remove them from any call room they were in/ringing for
        activeCalls.forEach((room, callId) => {
          if (room.participants.has(userId) || room.ringing.has(userId)) {
            removeFromCall(io, room, callId, userId);
          }
        });
      }
    });
  });
}

module.exports = { initSocket, isUserOnline };