const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true,
    },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, trim: true },
        messageType: {
      type: String,
      enum: ['text', 'image', 'file', 'system', 'location'],
      default: 'text',
    },
    fileUrl: { type: String }, // used only when messageType is image/file
    location: {
      lat: { type: Number },
      lng: { type: Number },
    }, // used only when messageType is 'location'

    
    fileUrl: { type: String }, // used only when messageType is image/file
    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
    reactions: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        emoji: { type: String },
      },
    ],
    status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
        isEdited: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false }, // true = deleted for everyone
    deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // per-user "delete for me"
  },
  { timestamps: true }
);

messageSchema.index({ conversationId: 1, createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);
