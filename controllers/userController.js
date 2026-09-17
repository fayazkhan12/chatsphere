const User = require('../models/User');

// @route  GET /api/users?search=xyz
// Search users by name/username (excludes the logged-in user)
const getUsers = async (req, res, next) => {
  try {
    const search = req.query.search
      ? {
          $and: [
            { _id: { $ne: req.user._id } },
            {
              $or: [
                { name: { $regex: req.query.search, $options: 'i' } },
                { username: { $regex: req.query.search, $options: 'i' } },
              ],
            },
          ],
        }
      : { _id: { $ne: req.user._id } };

    const users = await User.find(search).select('-password').limit(20);
    res.json(users);
  } catch (error) {
    next(error);
  }
};

// @route  GET /api/users/:id
const getUserById = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (error) {
    next(error);
  }
};

// @route  PUT /api/users/profile
const updateProfile = async (req, res, next) => {
  try {
    const { name, profilePicture } = req.body;
    req.user.name = name || req.user.name;
    req.user.profilePicture = profilePicture || req.user.profilePicture;
    const updated = await req.user.save();
    res.json(updated);
  } catch (error) {
    next(error);
  }
};

// @route  PUT /api/users/change-password
const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id).select('+password');

    if (!(await user.matchPassword(currentPassword))) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    user.password = newPassword;
    await user.save();
    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    next(error);
  }
};

module.exports = { getUsers, getUserById, updateProfile, changePassword };
