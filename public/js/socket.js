// Establishes the single shared Socket.IO connection for the whole app.
// Requires: localStorage "token" to already be set (i.e. user is logged in).

const token = localStorage.getItem('token');
if (!token) {
  window.location.href = '/login.html';
}

const socket = io({
  auth: { token },
});

socket.on('connect_error', (err) => {
  console.error('Socket connection failed:', err.message);
  if (err.message.includes('Authentication')) {
    localStorage.clear();
    window.location.href = '/login.html';
  }
});
