const API_BASE = '/api';
const me = JSON.parse(localStorage.getItem('user') || '{}');

let activeConversation = null;
let conversationsCache = [];
let typingTimeout = null;
const selectedGroupMembers = new Map();

// ---------- helpers ----------
function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

function timeAgo(dateStr) {
  const diff = (Date.now() - new Date(dateStr)) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(dateStr).toLocaleDateString();
}

function formatTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function otherParticipant(conv) {
  if (conv.type === 'group') return null;
  return conv.participants.find((p) => p._id !== me._id);
}

function conversationTitle(conv) {
  if (conv.type === 'group') return conv.groupName;
  const other = otherParticipant(conv);
  return other ? other.name : 'Unknown';
}

function conversationAvatar(conv) {
  if (conv.type === 'group') return conv.groupAvatar;
  const other = otherParticipant(conv);
  return other ? other.profilePicture : '';
}

// ---------- init ----------
document.getElementById('myAvatar').src = me.profilePicture || '';
document.getElementById('myName').textContent = me.name || '';

// theme persistence
const savedTheme = localStorage.getItem('theme') || 'light';
document.documentElement.setAttribute('data-theme', savedTheme);
document.getElementById('themeToggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch(`${API_BASE}/auth/logout`, { method: 'POST', headers: authHeaders() });
  localStorage.clear();
  window.location.href = '/login.html';
});

loadConversations();

// Safety net: some hosting setups (e.g. free-tier proxies) can silently drop
// the WebSocket connection after a couple of minutes even while the tab is
// active. This background poll guarantees new messages/unread counts show
// up within ~5s even if that happens, without needing a manual refresh.
setInterval(() => {
  loadConversations();
}, 5000);

// ---------- load & render conversation list ----------
async function loadConversations() {
  const res = await fetch(`${API_BASE}/conversations`, { headers: authHeaders() });
  conversationsCache = await res.json();
  renderChatList();
}

function renderChatList() {
  const list = document.getElementById('chatList');
  list.innerHTML = '';

  conversationsCache.forEach((conv) => {
    const div = document.createElement('div');
    div.className = 'chat-item';
    div.dataset.id = conv._id;
    if (activeConversation && activeConversation._id === conv._id) div.classList.add('active');

    const lastMsgText = conv.lastMessage
      ? (conv.lastMessage.sender?._id === me._id ? 'You: ' : '') +
        (conv.lastMessage.messageType === 'location'
          ? '📍 Location'
          : conv.lastMessage.messageType === 'image'
          ? '📷 Photo'
          : conv.lastMessage.messageType === 'file'
          ? '📎 File'
          : conv.lastMessage.text || '')
      : 'No messages yet';

    const isPendingForMe = conv.status === 'pending' && String(conv.requestedBy) !== String(me._id);
    const isPendingFromMe = conv.status === 'pending' && String(conv.requestedBy) === String(me._id);

    div.innerHTML = `
      <img class="avatar" src="${conversationAvatar(conv)}" />
      <div class="chat-item-info">
        <div class="chat-item-name">${conversationTitle(conv)} ${isPendingForMe ? '<span class="request-tag">Request</span>' : ''}</div>
        <div class="chat-item-last">${isPendingFromMe ? 'Message request sent' : lastMsgText}</div>
      </div>
      <div class="chat-item-meta">
        ${conv.lastMessage ? formatTime(conv.lastMessage.createdAt) : ''}
        ${conv.unreadCount > 0 ? `<span class="unread-badge">${conv.unreadCount > 99 ? '99+' : conv.unreadCount}</span>` : ''}
      </div>
      <button class="chat-item-delete" title="Delete chat"><i class="bi bi-trash"></i></button>
    `;
    div.querySelector('.chat-item-delete').addEventListener('click', (e) => {
      e.stopPropagation(); // don't trigger openConversation when clicking delete
      deleteConversation(conv);
    });
    div.addEventListener('click', () => openConversation(conv));
    list.appendChild(div);
  });
}

// ---------- delete a conversation ----------
async function deleteConversation(conv) {
  const confirmed = confirm(`Delete chat with "${conversationTitle(conv)}"? This only removes it from your list.`);
  if (!confirmed) return;

  try {
    const res = await fetch(`${API_BASE}/conversations/${conv._id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error('Delete failed');

    // If the deleted chat was open, go back to the empty state
    if (activeConversation && activeConversation._id === conv._id) {
      activeConversation = null;
      document.getElementById('chatWindow').classList.add('d-none');
      document.getElementById('emptyState').classList.remove('d-none');
      document.getElementById('app').classList.remove('chat-open');
    }

    await loadConversations();
  } catch (err) {
    alert('Could not delete chat. Try again.');
    console.error(err);
  }
}

// ---------- user search ----------
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');

let searchDebounce;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  if (!q) {
    searchResults.classList.add('d-none');
    return;
  }
  searchDebounce = setTimeout(() => searchUsers(q), 300);
});

async function searchUsers(q) {
  const res = await fetch(`${API_BASE}/users?search=${encodeURIComponent(q)}`, {
    headers: authHeaders(),
  });
  const users = await res.json();

  searchResults.innerHTML = '';
  searchResults.classList.remove('d-none');

  if (users.length === 0) {
    searchResults.innerHTML = '<div class="p-3 text-muted">No users found</div>';
    return;
  }

  users.forEach((u) => {
    const div = document.createElement('div');
    div.className = 'user-result';
    div.innerHTML = `
      <img class="avatar" src="${u.profilePicture}" />
      <div class="chat-item-info">
        <div class="chat-item-name">${u.name}</div>
        <div class="chat-item-last">@${u.username} ${u.isOnline ? '🟢' : '⚫'}</div>
      </div>
    `;
    div.addEventListener('click', () => startConversation(u._id));
    searchResults.appendChild(div);
  });
}

async function startConversation(userId) {
  const res = await fetch(`${API_BASE}/conversations`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ type: 'one-to-one', userId }),
  });
  const conv = await res.json();

  searchInput.value = '';
  searchResults.classList.add('d-none');

  await loadConversations();
  const fresh = conversationsCache.find((c) => c._id === conv._id) || conv;
  openConversation(fresh);
}

// ---------- open a conversation ----------
async function openConversation(conv) {
  activeConversation = conv;
  renderChatList();

  document.getElementById('emptyState').classList.add('d-none');
  document.getElementById('chatWindow').classList.remove('d-none');
  document.getElementById('app').classList.add('chat-open');

  document.getElementById('chatAvatar').src = conversationAvatar(conv);
  document.getElementById('chatTitle').textContent = conversationTitle(conv);

  if (conv.type === 'group') {
    document.getElementById('chatSubtitle').textContent =
      `${conv.participants.length} members`;
  } else {
    const other = otherParticipant(conv);
    document.getElementById('chatSubtitle').textContent = other.isOnline
      ? 'Online'
      : `Last seen ${timeAgo(other.lastSeen)}`;
  }
  // Calling works for both one-to-one and group conversations now
  document.getElementById('voiceCallBtn')?.classList.remove('d-none');
  document.getElementById('videoCallBtn')?.classList.remove('d-none');

  updateRequestBar(conv);

  socket.emit('join_room', conv._id);
  await loadMessages(conv._id);

  // messages just got marked read -> reflect that immediately in the sidebar
  conv.unreadCount = 0;
  renderChatList();

  // Push a history entry so the browser's back button closes this
  // conversation (returns to the chat list) instead of leaving the app
  // entirely and landing back on the login page.
  history.pushState({ chatOpen: true }, '', location.pathname);
}

// Shows the Accept/Decline bar (hiding the normal input) when this chat is a
// pending request addressed TO me. If I'm the one who sent the request, or
// it's already accepted / a group chat, the normal input stays visible.
function updateRequestBar(conv) {
  const requestBar = document.getElementById('requestBar');
  const requestBarText = document.getElementById('requestBarText');
  const isPendingForMe =
    conv.type === 'one-to-one' &&
    conv.status === 'pending' &&
    String(conv.requestedBy) !== String(me._id);

  if (isPendingForMe) {
    requestBar.classList.remove('d-none');
    messageForm.classList.add('d-none');
    requestBarText.textContent = `${conversationTitle(conv)} sent you a message request`;
  } else {
    requestBar.classList.add('d-none');
    messageForm.classList.remove('d-none');
  }
}

document.getElementById('acceptRequestBtn').addEventListener('click', async () => {
  if (!activeConversation) return;
  const res = await fetch(`${API_BASE}/conversations/${activeConversation._id}/accept`, {
    method: 'PUT',
    headers: authHeaders(),
  });
  if (!res.ok) return alert('Could not accept request. Try again.');

  const updated = await res.json();
  activeConversation = updated;
  const idx = conversationsCache.findIndex((c) => c._id === updated._id);
  if (idx !== -1) conversationsCache[idx] = updated;

  updateRequestBar(updated);
  renderChatList();
});

document.getElementById('declineRequestBtn').addEventListener('click', async () => {
  if (!activeConversation) return;
  const confirmed = confirm('Decline this message request? The chat will be removed.');
  if (!confirmed) return;

  const res = await fetch(`${API_BASE}/conversations/${activeConversation._id}/decline`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) return alert('Could not decline request. Try again.');

  conversationsCache = conversationsCache.filter((c) => c._id !== activeConversation._id);
  closeActiveConversation();
});

function closeActiveConversation() {
  activeConversation = null;
  document.getElementById('chatWindow').classList.add('d-none');
  document.getElementById('emptyState').classList.remove('d-none');
  document.getElementById('app').classList.remove('chat-open');
  renderChatList();
}

// Back button (or swipe-back on mobile) while a conversation is open should
// just close it, not navigate away from the app.
window.addEventListener('popstate', () => {
  if (activeConversation) {
    closeActiveConversation();
  }
});

async function loadMessages(conversationId) {
  const res = await fetch(`${API_BASE}/messages/${conversationId}`, { headers: authHeaders() });
  const messages = await res.json();

  const container = document.getElementById('messagesContainer');
  container.innerHTML = '';
  messages.forEach(renderMessage);
  container.scrollTop = container.scrollHeight;

  // mark unread messages from others as read
  const unreadIds = messages
    .filter((m) => m.sender._id !== me._id && !m.readBy?.includes(me._id))
    .map((m) => m._id);

  if (unreadIds.length > 0) {
    socket.emit('message_read', { conversationId, messageIds: unreadIds });
  }
}

function renderMessage(msg) {
  const container = document.getElementById('messagesContainer');
  const mine = msg.sender._id === me._id;

  const row = document.createElement('div');
  row.className = `msg-row ${mine ? 'mine' : ''}`;
  row.dataset.id = msg._id;

  let tick = '';
  if (mine) {
    tick =
      msg.status === 'read'
        ? '<span class="tick read">✓✓</span>'
        : msg.status === 'delivered'
        ? '<span class="tick">✓✓</span>'
        : '<span class="tick">✓</span>';
  }

  let mediaHtml = '';
  if (msg.isDeleted) {
    mediaHtml = '';
  } else if (msg.messageType === 'image' && msg.fileUrl) {
    mediaHtml = `<a href="${msg.fileUrl}" target="_blank"><img src="${msg.fileUrl}" class="msg-image" /></a>`;
  } else if (msg.messageType === 'file' && msg.fileUrl) {
    mediaHtml = `<a href="${msg.fileUrl}" target="_blank" class="msg-file"><i class="bi bi-file-earmark-arrow-down"></i> Download file</a>`;
  } else if (msg.messageType === 'location' && msg.location) {
    const { lat, lng } = msg.location;
    const mapImg = `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lng}&zoom=15&size=280x160&markers=${lat},${lng},red-pushpin`;
    const mapLink = `https://www.google.com/maps?q=${lat},${lng}`;
    mediaHtml = `
      <a href="${mapLink}" target="_blank" class="msg-location">
        <img src="${mapImg}" class="msg-location-img" alt="Shared location" />
        <div class="msg-location-label"><i class="bi bi-geo-alt-fill"></i> Location shared &middot; Open in Maps</div>
      </a>
    `;
  }

  const deleteMenuHtml = msg.isDeleted
    ? ''
    : `
    <div class="msg-menu">
      <button class="msg-menu-btn" title="Delete"><i class="bi bi-three-dots-vertical"></i></button>
      <div class="msg-menu-dropdown d-none">
        <button class="msg-menu-item" data-action="me">Delete for me</button>
        ${mine ? '<button class="msg-menu-item text-danger" data-action="everyone">Delete for everyone</button>' : ''}
      </div>
    </div>
  `;

  row.innerHTML = `
    <div class="bubble">
      ${activeConversation.type === 'group' && !mine ? `<div class="sender-name">${msg.sender.name}</div>` : ''}
      ${deleteMenuHtml}
      ${mediaHtml}
      <div class="msg-text ${msg.isDeleted ? 'msg-deleted-text' : ''}"></div>
      <div class="msg-meta">${formatTime(msg.createdAt)} ${tick}</div>
    </div>
  `;
  if (msg.text) row.querySelector('.msg-text').textContent = msg.text; // textContent avoids XSS
  container.appendChild(row);

  if (!msg.isDeleted) {
    const menuBtn = row.querySelector('.msg-menu-btn');
    const dropdown = row.querySelector('.msg-menu-dropdown');
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.msg-menu-dropdown').forEach((d) => {
        if (d !== dropdown) d.classList.add('d-none');
      });
      dropdown.classList.toggle('d-none');
    });
    dropdown.querySelectorAll('.msg-menu-item').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.add('d-none');
        handleDeleteMessage(msg, btn.dataset.action === 'everyone');
      });
    });
  }
}

// close any open message menu when clicking elsewhere on the page
document.addEventListener('click', () => {
  document.querySelectorAll('.msg-menu-dropdown').forEach((d) => d.classList.add('d-none'));
});

// ---------- delete a message ----------
async function handleDeleteMessage(msg, forEveryone) {
  const confirmed = confirm(
    forEveryone ? 'Delete this message for everyone?' : 'Delete this message for you?'
  );
  if (!confirmed) return;

  try {
    const res = await fetch(`${API_BASE}/messages/${msg._id}`, {
      method: 'DELETE',
      headers: authHeaders(),
      body: JSON.stringify({ forEveryone }),
    });
    if (!res.ok) throw new Error('Delete failed');

    if (forEveryone) {
      markMessageDeletedInDOM(msg._id);
    } else {
      // "delete for me" -> just remove it from my own view
      const row = document.querySelector(`.msg-row[data-id="${msg._id}"]`);
      row?.remove();
    }
  } catch (err) {
    alert('Could not delete message. Try again.');
    console.error(err);
  }
}

function markMessageDeletedInDOM(messageId) {
  const row = document.querySelector(`.msg-row[data-id="${messageId}"]`);
  if (!row) return;
  const bubble = row.querySelector('.bubble');
  if (!bubble) return;
  bubble.querySelector('.msg-image')?.parentElement.remove();
  bubble.querySelector('.msg-file')?.remove();
  bubble.querySelector('.msg-menu')?.remove();
  const textEl = bubble.querySelector('.msg-text');
  if (textEl) {
    textEl.textContent = 'This message was deleted';
    textEl.classList.add('msg-deleted-text');
  }
}

// ---------- file upload ----------
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');

attachBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file || !activeConversation) return;

  attachBtn.disabled = true;
  attachBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';

  try {
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch(`${API_BASE}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }, // no Content-Type: browser sets multipart boundary
      body: formData,
    });

    if (!res.ok) throw new Error('Upload failed');
    const { fileUrl, messageType } = await res.json();

    socket.emit(
      'send_message',
      { conversationId: activeConversation._id, text: '', messageType, fileUrl },
      (ack) => {
        if (ack?.error) alert(ack.error);
      }
    );
  } catch (err) {
    alert('File upload failed. Try again.');
    console.error(err);
  } finally {
    attachBtn.disabled = false;
    attachBtn.innerHTML = '<i class="bi bi-paperclip"></i>';
    fileInput.value = '';
  }
});

// ---------- share location ----------
const locationBtn = document.getElementById('locationBtn');

locationBtn.addEventListener('click', () => {
  if (!activeConversation) return;

  if (!navigator.geolocation) {
    alert('Location sharing is not supported in this browser.');
    return;
  }

  locationBtn.disabled = true;
  locationBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude } = position.coords;

      socket.emit(
        'send_message',
        {
          conversationId: activeConversation._id,
          text: '',
          messageType: 'location',
          location: { lat: latitude, lng: longitude },
        },
        (ack) => {
          if (ack?.error) alert(ack.error);
        }
      );

      locationBtn.disabled = false;
      locationBtn.innerHTML = '<i class="bi bi-geo-alt-fill"></i>';
    },
    (err) => {
      alert('Could not get your location. Please allow location access and try again.');
      console.error(err);
      locationBtn.disabled = false;
      locationBtn.innerHTML = '<i class="bi bi-geo-alt-fill"></i>';
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

// ---------- sending messages ----------
const messageForm = document.getElementById('messageForm');
const messageText = document.getElementById('messageText');

messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageText.value.trim();
  if (!text || !activeConversation) return;

  socket.emit(
    'send_message',
    { conversationId: activeConversation._id, text, messageType: 'text' },
    (ack) => {
      if (ack?.error) alert(ack.error);
    }
  );

  messageText.value = '';
  socket.emit('stop_typing', { conversationId: activeConversation._id });
});

// typing indicator emit (debounced)
messageText.addEventListener('input', () => {
  if (!activeConversation) return;
  socket.emit('typing', { conversationId: activeConversation._id });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    socket.emit('stop_typing', { conversationId: activeConversation._id });
  }, 1500);
});

// ---------- toast notifications ----------
function showToast(conv, msg) {
  const container = document.getElementById('toastContainer');

  const toast = document.createElement('div');
  toast.className = 'chat-toast';

  const previewText =
    msg.messageType === 'image' ? '📷 Photo' : msg.messageType === 'file' ? '📎 File' : msg.messageType === 'location' ? '📍 Location' : msg.text;

  toast.innerHTML = `
    <img src="${conversationAvatar(conv)}" />
    <div class="toast-body">
      <div class="toast-name">${conversationTitle(conv)}</div>
      <div class="toast-text">${previewText}</div>
    </div>
  `;

  toast.addEventListener('click', () => {
    openConversation(conv);
    toast.remove();
  });

  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000); // auto-dismiss after 4s
}

function notifyNewMessage(conv, msg) {
  if (msg.sender._id === me._id) return; // never notify for my own messages

  document.getElementById('notifSound')?.play().catch(() => {});

  // In-app toast: only if this conversation isn't the one currently open
  if (!activeConversation || activeConversation._id !== conv._id) {
    showToast(conv, msg);
  }

  // Native OS/browser notification: useful when the tab is in the background
  if (document.hidden && window.Notification && Notification.permission === 'granted') {
    const body =
      msg.messageType === 'image' ? '📷 Sent a photo' : msg.messageType === 'file' ? '📎 Sent a file' : msg.messageType === 'location' ? '📍 Shared a location' : msg.text;
    new Notification(conversationTitle(conv), { body, icon: conversationAvatar(conv) });
  }
}

// ---------- socket listeners ----------
socket.on('connect', () => {
  // covers reconnects after bfcache/visibility recovery (see socket.js) —
  // pulls in anything that may have been missed while disconnected
  loadConversations();
});

socket.on('receive_message', (msg) => {
  const conv = conversationsCache.find((c) => c._id === msg.conversationId);

  if (activeConversation && msg.conversationId === activeConversation._id) {
    renderMessage(msg);
    const container = document.getElementById('messagesContainer');
    container.scrollTop = container.scrollHeight;

    if (msg.sender._id !== me._id) {
      socket.emit('message_read', {
        conversationId: activeConversation._id,
        messageIds: [msg._id],
      });
    }
  } else if (conv) {
    notifyNewMessage(conv, msg);
  }
  loadConversations();
});

socket.on('message_delivered', ({ messageId }) => {
  const row = document.querySelector(`.msg-row[data-id="${messageId}"] .tick`);
  if (row) row.textContent = '✓✓';
});

socket.on('message_deleted', ({ messageId }) => {
  markMessageDeletedInDOM(messageId);
});

socket.on('message_read', ({ messageIds }) => {
  messageIds.forEach((id) => {
    const tick = document.querySelector(`.msg-row[data-id="${id}"] .tick`);
    if (tick) {
      tick.textContent = '✓✓';
      tick.classList.add('read');
    }
  });
});

socket.on('typing', ({ conversationId, name }) => {
  if (activeConversation && conversationId === activeConversation._id) {
    const el = document.getElementById('typingIndicator');
    el.textContent = `${name} is typing...`;
    el.classList.remove('d-none');
  }
});

socket.on('stop_typing', ({ conversationId }) => {
  if (activeConversation && conversationId === activeConversation._id) {
    document.getElementById('typingIndicator').classList.add('d-none');
  }
});

socket.on('user_online', ({ userId }) => {
  if (activeConversation && activeConversation.type === 'one-to-one') {
    const other = otherParticipant(activeConversation);
    if (other && other._id === userId) {
      document.getElementById('chatSubtitle').textContent = 'Online';
    }
  }
});

socket.on('user_offline', ({ userId, lastSeen }) => {
  if (activeConversation && activeConversation.type === 'one-to-one') {
    const other = otherParticipant(activeConversation);
    if (other && other._id === userId) {
      document.getElementById('chatSubtitle').textContent = `Last seen ${timeAgo(lastSeen)}`;
    }
  }
});

socket.on('new_notification', (notification) => {
  document.getElementById('notifSound')?.play().catch(() => {});
  if (Notification && Notification.permission === 'granted') {
    new Notification('New message', { body: notification.message });
  }
  loadConversations();
});

if (window.Notification && Notification.permission === 'default') {
  Notification.requestPermission();
}

// ---------- group creation ----------
const groupModalEl = document.getElementById('groupModal');
const groupModal = new bootstrap.Modal(groupModalEl);

document.getElementById('newGroupBtn').addEventListener('click', () => {
  selectedGroupMembers.clear();
  document.getElementById('groupNameInput').value = '';
  document.getElementById('groupMemberSearch').value = '';
  document.getElementById('groupMemberResults').innerHTML = '';
  document.getElementById('selectedMembers').innerHTML = '';
  groupModal.show();
});

let groupSearchDebounce;
document.getElementById('groupMemberSearch').addEventListener('input', (e) => {
  clearTimeout(groupSearchDebounce);
  const q = e.target.value.trim();
  if (!q) return;
  groupSearchDebounce = setTimeout(async () => {
    const res = await fetch(`${API_BASE}/users?search=${encodeURIComponent(q)}`, {
      headers: authHeaders(),
    });
    const users = await res.json();
    const container = document.getElementById('groupMemberResults');
    container.innerHTML = '';
    users.forEach((u) => {
      const div = document.createElement('div');
      div.className = 'user-result';
      div.innerHTML = `<img class="avatar" src="${u.profilePicture}" /><div class="chat-item-info"><div class="chat-item-name">${u.name}</div></div>`;
      div.addEventListener('click', () => {
        selectedGroupMembers.set(u._id, u.name);
        renderSelectedMembers();
      });
      container.appendChild(div);
    });
  }, 300);
});

function renderSelectedMembers() {
  const el = document.getElementById('selectedMembers');
  el.innerHTML = [...selectedGroupMembers.entries()]
    .map(([id, name]) => `<span class="badge bg-secondary me-1">${name}</span>`)
    .join('');
}

document.getElementById('createGroupBtn').addEventListener('click', async () => {
  const groupName = document.getElementById('groupNameInput').value.trim();
  const members = [...selectedGroupMembers.keys()];

  if (!groupName || members.length < 2) {
    alert('Group name aur kam se kam 2 members chahiye');
    return;
  }

  const res = await fetch(`${API_BASE}/conversations`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ type: 'group', groupName, members }),
  });
  const group = await res.json();
  groupModal.hide();

  await loadConversations();
  openConversation(group);
});