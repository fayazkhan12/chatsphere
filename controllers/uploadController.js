const uploadFile = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const messageType = req.file.mimetype.startsWith('image/') ? 'image' : 'file';

    res.status(201).json({
      fileUrl: req.file.path,
      fileName: req.file.originalname,
      messageType,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { uploadFile };