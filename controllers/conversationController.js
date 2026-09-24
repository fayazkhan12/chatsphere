const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const User = require('../models/User');

// @route  GET /api/conversations
// Returns all conversations the logged-in user is part of, newest activity first,
// each annotated with an "unreadCount" of messages sent by others not yet read.
const getConversations = async (req, res, next) => {
  try {
    const conversations = await Conversation.find({
      participants: req.user._id,
      deletedFor: { $ne: req.user._id }, // hide chats this user has deleted
    })
      .populate('participants', '-password')
      .populate('groupAdmin', '-password')
      .populate({
        path: 'lastMessage',
        populate: { path: 'sender', select: 'name username' },
      })
      .sort({ updatedAt: -1 });

    const conversationIds = conversations.map((c) => c._id);

    const unreadAgg = await Message.aggregate([
      {
        $match: {
          conversationId: { $in: conversationIds },
          sender: { $ne: req.user._id },
          readBy: { $ne: req.user._id },
          deletedFor: { $ne: req.user._id },
        },
      },
      { $group: { _id: '$conversationId', count: { $sum: 1 } } },
    ]);

    const unreadMap = {};
    unreadAgg.forEach((u) => {
      unreadMap[String(u._id)] = u.count;
    });

    const result = conversations.map((c) => {
      const obj = c.toObject();
      obj.unreadCount = unreadMap[String(c._id)] || 0;
      return obj;
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
};

// @route  POST /api/conversations
// body: { type: 'one-to-one', userId }  OR  { type: 'group', groupName, members: [ids] }
const createConversation = async (req, res, next) => {
  try {
    const { type, userId, groupName, members } = req.body;

    if (type === 'group') {
      if (!groupName || !members || members.length < 2) {
        return res
          .status(400)
          .json({ message: 'Group needs a name and at least 2 other members' });
      }

      const group = await Conversation.create({
        type: 'group',
        groupName,
        groupAdmin: req.user._id,
        participants: [req.user._id, ...members],
      });

      const populated = await group.populate('participants', '-password');
      return res.status(201).json(populated);
    }

    // one-to-one
    if (!userId) return res.status(400).json({ message: 'userId is required' });

    const existing = await Conversation.findOne({
      type: 'one-to-one',
      participants: { $all: [req.user._id, userId], $size: 2 },
    }).populate('participants', '-password');

    if (existing) return res.json(existing);

    const otherUser = await User.findById(userId);
    if (!otherUser) return res.status(404).json({ message: 'User not found' });

    // Brand new one-to-one chat -> starts as a pending message request.
    // The recipient will need to accept it before they can reply.
    const conversation = await Conversation.create({
      type: 'one-to-one',
      participants: [req.user._id, userId],
      status: 'pending',
      requestedBy: req.user._id,
    });

    const populated = await conversation.populate('participants', '-password');
    res.status(201).json(populated);
  } catch (error) {
    next(error);
  }
};

// @route  PUT /api/conversations/:id/add-member
const addMember = async (req, res, next) => {
  try {
    const { memberId } = req.body;
    const group = await Conversation.findById(req.params.id);

    if (!group || group.type !== 'group') {
      return res.status(404).json({ message: 'Group not found' });
    }
    if (String(group.groupAdmin) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Only group admin can add members' });
    }

    if (!group.participants.includes(memberId)) {
      group.participants.push(memberId);
      await group.save();
    }

    const populated = await group.populate('participants', '-password');
    res.json(populated);
  } catch (error) {
    next(error);
  }
};

// @route  PUT /api/conversations/:id/remove-member
const removeMember = async (req, res, next) => {
  try {
    const { memberId } = req.body;
    const group = await Conversation.findById(req.params.id);

    if (!group || group.type !== 'group') {
      return res.status(404).json({ message: 'Group not found' });
    }
    if (String(group.groupAdmin) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Only group admin can remove members' });
    }

    group.participants = group.participants.filter(
      (p) => String(p) !== String(memberId)
    );
    await group.save();

    const populated = await group.populate('participants', '-password');
    res.json(populated);
  } catch (error) {
    next(error);
  }
};

// @route  PUT /api/conversations/:id/leave
const leaveGroup = async (req, res, next) => {
  try {
    const group = await Conversation.findById(req.params.id);
    if (!group || group.type !== 'group') {
      return res.status(404).json({ message: 'Group not found' });
    }

    group.participants = group.participants.filter(
      (p) => String(p) !== String(req.user._id)
    );

    // reassign admin if the admin left and members remain
    if (String(group.groupAdmin) === String(req.user._id) && group.participants.length > 0) {
      group.groupAdmin = group.participants[0];
    }

    await group.save();
    res.json({ message: 'Left group successfully' });
  } catch (error) {
    next(error);
  }
};

// @route  DELETE /api/conversations/:id
// "Delete for me" — hides the chat from this user's list only; the other
// participant(s) still see it and its messages, exactly like WhatsApp.
const deleteConversation = async (req, res, next) => {
  try {
    const conversation = await Conversation.findById(req.params.id);

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found' });
    }
    if (!conversation.participants.some((p) => String(p) === String(req.user._id))) {
      return res.status(403).json({ message: 'Not a participant of this conversation' });
    }

    if (!conversation.deletedFor.some((id) => String(id) === String(req.user._id))) {
      conversation.deletedFor.push(req.user._id);
      await conversation.save();
    }

    res.json({ message: 'Conversation deleted', conversationId: conversation._id });
  } catch (error) {
    next(error);
  }
};

// @route  PUT /api/conversations/:id/accept
// The recipient of a pending message request accepts it -> chat becomes normal.
const acceptRequest = async (req, res, next) => {
  try {
    const conversation = await Conversation.findById(req.params.id);
    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found' });
    }
    if (!conversation.participants.some((p) => String(p) === String(req.user._id))) {
      return res.status(403).json({ message: 'Not a participant of this conversation' });
    }
    if (String(conversation.requestedBy) === String(req.user._id)) {
      return res.status(400).json({ message: 'You cannot accept your own request' });
    }

    conversation.status = 'accepted';
    await conversation.save();

    const populated = await conversation.populate('participants', '-password');
    res.json(populated);
  } catch (error) {
    next(error);
  }
};

// @route  DELETE /api/conversations/:id/decline
// The recipient declines a pending request -> conversation + its messages are removed.
const declineRequest = async (req, res, next) => {
  try {
    const conversation = await Conversation.findById(req.params.id);
    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found' });
    }
    if (!conversation.participants.some((p) => String(p) === String(req.user._id))) {
      return res.status(403).json({ message: 'Not a participant of this conversation' });
    }

    await Message.deleteMany({ conversationId: conversation._id });
    await conversation.deleteOne();

    res.json({ message: 'Request declined', conversationId: conversation._id });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getConversations,
  createConversation,
  addMember,
  removeMember,
  leaveGroup,
  deleteConversation,
  acceptRequest,
  declineRequest,
};