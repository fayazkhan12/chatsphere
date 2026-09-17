const Conversation = require('../models/Conversation');
const User = require('../models/User');

// @route  GET /api/conversations
// Returns all conversations the logged-in user is part of, newest activity first
const getConversations = async (req, res, next) => {
  try {
    const conversations = await Conversation.find({ participants: req.user._id })
      .populate('participants', '-password')
      .populate('groupAdmin', '-password')
      .populate({
        path: 'lastMessage',
        populate: { path: 'sender', select: 'name username' },
      })
      .sort({ updatedAt: -1 });

    res.json(conversations);
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

    const conversation = await Conversation.create({
      type: 'one-to-one',
      participants: [req.user._id, userId],
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

module.exports = {
  getConversations,
  createConversation,
  addMember,
  removeMember,
  leaveGroup,
};
