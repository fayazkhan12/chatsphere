const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const upload = require('../middleware/upload');
const { uploadFile } = require('../controllers/uploadController');

const router = express.Router();

router.post('/', protect, upload.single('file'), uploadFile);

module.exports = router;