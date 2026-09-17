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
      ? (conv.lastMessage.sender?._id === me._id ? 'You: ' : '') + (conv.lastMessage.text || '')
      : 'No messages yet';

    div.innerHTML = `
      <img class="avatar" src="${conversationAvatar(conv)}" />
      <div class="chat-item-info">
        <div class="chat-item-name">${conversationTitle(conv)}</div>
        <div class="chat-item-last">${lastMsgText}</div>
      </div>
      <div class="chat-item-meta">
        ${conv.lastMessage ? formatTime(conv.lastMessage.createdAt) : ''}
      </div>
    `;
    div.addEventListener('click', () => openConversation(conv));
    list.appendChild(div);
  });
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

  socket.emit('join_room', conv._id);
  await loadMessages(conv._id);
}

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
  if (msg.messageType === 'image' && msg.fileUrl) {
    mediaHtml = `<a href="${msg.fileUrl}" target="_blank"><img src="${msg.fileUrl}" class="msg-image" /></a>`;
  } else if (msg.messageType === 'file' && msg.fileUrl) {
    mediaHtml = `<a href="${msg.fileUrl}" target="_blank" class="msg-file"><i class="bi bi-file-earmark-arrow-down"></i> Download file</a>`;
  }

  row.innerHTML = `
    <div class="bubble">
      ${activeConversation.type === 'group' && !mine ? `<div class="sender-name">${msg.sender.name}</div>` : ''}
      ${mediaHtml}
      <div class="msg-text"></div>
      <div class="msg-meta">${formatTime(msg.createdAt)} ${tick}</div>
    </div>
  `;
  if (msg.text) row.querySelector('.msg-text').textContent = msg.text; // textContent avoids XSS
  container.appendChild(row);
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

// ---------- socket listeners ----------
socket.on('receive_message', (msg) => {
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
  }
  loadConversations();
});

socket.on('message_delivered', ({ messageId }) => {
  const row = document.querySelector(`.msg-row[data-id="${messageId}"] .tick`);
  if (row) row.textContent = '✓✓';
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