const express = require('express');
const {
  getConversations,
  createConversation,
  addMember,
  removeMember,
  leaveGroup,
} = require('../controllers/conversationController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

router.get('/', getConversations);
router.post('/', createConversation);
router.put('/:id/add-member', addMember);
router.put('/:id/remove-member', removeMember);
router.put('/:id/leave', leaveGroup);

module.exports = router;
