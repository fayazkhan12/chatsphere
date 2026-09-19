const Message = require('../models/Message');
const Conversation = require('../models/Conversation');

// @route  GET /api/messages/:conversationId?page=1&limit=20
// Loads messages oldest->newest for a page (pagination for "load older messages")
const getMessages = async (req, res, next) => {
  try {
    const { conversationId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const conversation = await Conversation.findById(conversationId);
    if (!conversation || !conversation.participants.includes(req.user._id)) {
      return res.status(403).json({ message: 'Not a participant of this conversation' });
    }

        const messages = await Message.find({
      conversationId,
      deletedFor: { $ne: req.user._id }, // hide messages this user deleted "for me"
    })
      .populate('sender', 'name username profilePicture')
      .populate('replyTo')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.json(messages.reverse()); // return oldest-first for easy rendering
  } catch (error) {
    next(error);
  }
};

// @route  POST /api/messages
// NOTE: In real-time flow, sending normally happens via the Socket.IO "send_message"
// event (see socket/socketHandler.js). This REST endpoint exists as a fallback / for
// clients that don't have a socket connection yet.
const sendMessage = async (req, res, next) => {
  try {
    const { conversationId, text, messageType, replyTo } = req.body;

    if (!conversationId || (!text && messageType === 'text')) {
      return res.status(400).json({ message: 'conversationId and text are required' });
    }

    const message = await Message.create({
      conversationId,
      sender: req.user._id,
      text,
      messageType: messageType || 'text',
      replyTo: replyTo || null,
      status: 'sent',
    });

    await Conversation.findByIdAndUpdate(conversationId, { lastMessage: message._id });

    const populated = await message.populate('sender', 'name username profilePicture');
    res.status(201).json(populated);
  } catch (error) {
    next(error);
  }
};

// @route  PUT /api/messages/:id  (edit message)
const editMessage = async (req, res, next) => {
  try {
    const { text } = req.body;
    const message = await Message.findById(req.params.id);

    if (!message) return res.status(404).json({ message: 'Message not found' });
    if (String(message.sender) !== String(req.user._id)) {
      return res.status(403).json({ message: 'You can only edit your own messages' });
    }

    message.text = text;
    message.isEdited = true;
    await message.save();

    res.json(message);
  } catch (error) {
    next(error);
  }
};

// @route  DELETE /api/messages/:id
// body: { forEveryone: boolean }
// forEveryone=true -> only the sender can do this; replaces the text for ALL participants
//                      and broadcasts the change in real time.
// forEveryone=false (default) -> "delete for me"; only hides it from this user's own view.
const deleteMessage = async (req, res, next) => {
  try {
    const { forEveryone } = req.body;
    const message = await Message.findById(req.params.id);
    if (!message) return res.status(404).json({ message: 'Message not found' });

    if (forEveryone) {
      if (String(message.sender) !== String(req.user._id)) {
        return res.status(403).json({ message: 'You can only delete your own messages for everyone' });
      }

      message.isDeleted = true;
      message.text = 'This message was deleted';
      message.fileUrl = undefined;
      await message.save();

      // Notify everyone else in the conversation in real time
      const io = req.app.get('io');
      io?.to(String(message.conversationId)).emit('message_deleted', {
        messageId: message._id,
        conversationId: message.conversationId,
        forEveryone: true,
      });

      return res.json({ message: 'Message deleted for everyone', messageId: message._id });
    }

    // delete for me only
    if (!message.deletedFor.some((id) => String(id) === String(req.user._id))) {
      message.deletedFor.push(req.user._id);
      await message.save();
    }

    res.json({ message: 'Message deleted for you', messageId: message._id });
  } catch (error) {
    next(error);
  }
};
module.exports = { getMessages, sendMessage, editMessage, deleteMessage };
