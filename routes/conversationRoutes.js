const express = require('express');
const {
  getConversations,
  createConversation,
  addMember,
  removeMember,
  leaveGroup,
  deleteConversation,
} = require('../controllers/conversationController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

router.get('/', getConversations);
router.post('/', createConversation);
router.put('/:id/add-member', addMember);
router.put('/:id/remove-member', removeMember);
router.put('/:id/leave', leaveGroup);
router.delete('/:id', deleteConversation);

module.exports = router;