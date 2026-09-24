const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['one-to-one', 'group'], default: 'one-to-one' },
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],

    // Group-specific fields (ignored for one-to-one)
    groupName: { type: String, trim: true },
    groupAdmin: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    groupAvatar: {
      type: String,
      default: 'https://api.dicebear.com/7.x/shapes/svg?seed=Group',
    },

    lastMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },

    // Users who have "deleted" this chat from their own view (WhatsApp-style delete for me)
    deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    // Message-request system: a fresh one-to-one chat with someone who
    // hasn't talked to you before starts 'pending'. The recipient must
    // accept it before they can reply; the sender can still send messages
    // while it's pending. Group chats are always 'accepted' (no request flow).
    status: { type: String, enum: ['pending', 'accepted'], default: 'accepted' },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Speeds up "find my conversations" queries
conversationSchema.index({ participants: 1 });

module.exports = mongoose.model('Conversation', conversationSchema);
