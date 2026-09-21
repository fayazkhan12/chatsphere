// Establishes the single shared Socket.IO connection for the whole app.
// Requires: localStorage "token" to already be set (i.e. user is logged in).

const token = localStorage.getItem('token');
if (!token) {
  window.location.href = '/login.html';
}

const socket = io({
  auth: { token },
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
});

socket.on('disconnect', (reason) => {
  console.warn('Socket disconnected:', reason);
});

socket.on('connect_error', (err) => {
  console.error('Socket connection failed:', err.message);
  if (err.message.includes('Authentication')) {
    localStorage.clear();
    window.location.href = '/login.html';
  }
});

// Chrome's "back/forward cache" (bfcache) silently freezes the page (and its
// WebSocket) when the tab goes inactive, e.g. switching apps/tabs on mobile.
// When the page is restored, the socket does NOT reconnect automatically —
// this forces a fresh connection so messages arrive in real time again
// without the user needing to manually refresh.
window.addEventListener('pageshow', (event) => {
  if (event.persisted && !socket.connected) {
    socket.connect();
  }
});

// Belt-and-braces: also reconnect whenever the tab becomes visible again
// and the socket happens to be disconnected for any other reason.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !socket.connected) {
    socket.connect();
  }
});