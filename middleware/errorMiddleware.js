// 404 handler
const notFound = (req, res, next) => {
  const error = new Error(`Route not found - ${req.originalUrl}`);
  res.status(404);
  next(error);
};

// Central error handler - always returns JSON
// Central error handler - always returns JSON
const errorHandler = (err, req, res, next) => {
  console.error('--- ERROR ---', err); // always log the full error object for debugging

  let statusCode = res.statusCode === 200 ? 500 : res.statusCode;
  let message = err.message || err.error?.message || 'Something went wrong';

  // Mongoose bad ObjectId
  if (err.name === 'CastError' && err.kind === 'ObjectId') {
    statusCode = 404;
    message = 'Resource not found';
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    statusCode = 400;
    const field = Object.keys(err.keyValue)[0];
    message = `${field} already exists`;
  }

  res.status(statusCode).json({
    message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  });
};
module.exports = { notFound, errorHandler };
