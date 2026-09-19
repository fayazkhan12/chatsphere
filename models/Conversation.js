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
  },
  { timestamps: true }
);

// Speeds up "find my conversations" queries
conversationSchema.index({ participants: 1 });

module.exports = mongoose.model('Conversation', conversationSchema);
    // Users who have "deleted" this chat from their own view (WhatsApp-style delete for me)
    deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]