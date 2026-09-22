// ---------------------------------------------------------------
// Voice/Video calling (WebRTC), signaled through the existing socket.
// Supports 1-to-1 AND group calls using a full "mesh": every participant
// opens a direct peer-to-peer connection to every other participant.
// The server only relays small handshake messages (see join_call,
// call_offer, call_answer, call_ice etc. in socket/socketHandler.js) -
// actual audio/video never passes through the server.
//
// callId is always the conversation's _id: everyone who calls into the
// same conversation joins the same call room.
// ---------------------------------------------------------------

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

let callId = null;
let callType = null; // 'audio' | 'video'
let callConversationId = null;
let isCallActive = false; // true once we've joined the call room (ringing-out or connected)
let localStream = null;
let isMicMuted = false;
let isCameraOff = false;

// One entry per remote participant currently in the call.
// userId -> { pc, name, avatar, videoEl, connected }
const peers = new Map();

// ICE candidates that arrive before we've created a peer entry for that
// sender yet (e.g. arrives before their offer). Held here until then.
const earlyCandidates = new Map(); // userId -> [candidate, ...]

let pendingIncoming = null; // { callId, from, fromName, fromAvatar, callType, conversationId, isGroup }

// ---------- element references ----------
const incomingCallModal = document.getElementById('incomingCallModal');
const incomingCallAvatar = document.getElementById('incomingCallAvatar');
const incomingCallName = document.getElementById('incomingCallName');
const incomingCallType = document.getElementById('incomingCallType');
const rejectCallBtn = document.getElementById('rejectCallBtn');
const acceptCallBtn = document.getElementById('acceptCallBtn');

const callScreen = document.getElementById('callScreen');
const callGrid = document.getElementById('callGrid');
const localVideo = document.getElementById('localVideo');
const callStatusOverlay = document.getElementById('callStatusOverlay');
const callPeerAvatar = document.getElementById('callPeerAvatar');
const callPeerName = document.getElementById('callPeerName');
const callStatusText = document.getElementById('callStatusText');
const callParticipantCount = document.getElementById('callParticipantCount');
const callParticipantCountText = document.getElementById('callParticipantCountText');
const toggleMuteBtn = document.getElementById('toggleMuteBtn');
const toggleCameraBtn = document.getElementById('toggleCameraBtn');
const endCallBtn = document.getElementById('endCallBtn');
const addToCallBtn = document.getElementById('addToCallBtn');

const addToCallModal = document.getElementById('addToCallModal');
const addToCallList = document.getElementById('addToCallList');
const closeAddToCallBtn = document.getElementById('closeAddToCallBtn');

const voiceCallBtn = document.getElementById('voiceCallBtn');
const videoCallBtn = document.getElementById('videoCallBtn');
const ringtone = document.getElementById('ringtoneSound');

// ---------- helpers ----------
function playRingtone() {
  ringtone.currentTime = 0;
  ringtone.play().catch(() => {});
}
function stopRingtone() {
  ringtone.pause();
  ringtone.currentTime = 0;
}

function showCallScreen(statusText) {
  incomingCallModal.classList.add('d-none');
  callScreen.classList.remove('d-none');
  callStatusText.textContent = statusText;
  callStatusOverlay.classList.remove('d-none');
}

function hideCallUI() {
  incomingCallModal.classList.add('d-none');
  callScreen.classList.add('d-none');
  addToCallModal.classList.add('d-none');
  callStatusOverlay.classList.remove('d-none');
  localVideo.srcObject = null;
  callGrid.innerHTML = '';
}

async function getLocalStream(withVideo) {
  return navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
}

function updateParticipantCount() {
  const n = peers.size + 1; // + myself
  if (n > 2) {
    callParticipantCount.classList.remove('d-none');
    callParticipantCountText.textContent = `${n} in call`;
  } else {
    callParticipantCount.classList.add('d-none');
  }
  callGrid.classList.toggle('single-tile', peers.size === 1);
}

// Shows the "connecting..." avatar overlay only while nobody has connected yet
function refreshStatusOverlay() {
  const anyoneConnected = [...peers.values()].some((p) => p.connected);
  if (anyoneConnected) {
    callStatusOverlay.classList.add('d-none');
  } else {
    callStatusOverlay.classList.remove('d-none');
  }
}

// ---------- per-peer video tile ----------
function createTile(userId, name) {
  const tile = document.createElement('div');
  tile.className = 'call-tile';
  tile.id = `call-tile-${userId}`;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;

  const label = document.createElement('div');
  label.className = 'call-tile-label';
  label.textContent = name || 'Guest';

  tile.appendChild(video);
  tile.appendChild(label);
  callGrid.appendChild(tile);

  return video;
}

function removeTile(userId) {
  document.getElementById(`call-tile-${userId}`)?.remove();
}

// ---------- peer connection lifecycle ----------
function createPeerForUser(userId, name, avatar) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  const videoEl = createTile(userId, name);

  const peer = { pc, name, avatar, videoEl, connected: false };
  peers.set(userId, peer);

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('call_ice', { callId, to: userId, candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    videoEl.srcObject = event.streams[0];
    peer.connected = true;
    refreshStatusOverlay();
    callStatusText.textContent = 'Connected';
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      removePeer(userId);
    }
  };

  // Apply any ICE candidates that arrived before this peer connection existed
  const queued = earlyCandidates.get(userId);
  if (queued) {
    earlyCandidates.delete(userId);
    queued.forEach((candidate) => {
      pc.addIceCandidate(new RTCIceCandidate(candidate)).catch((err) =>
        console.error('Error adding queued ICE candidate:', err)
      );
    });
  }

  updateParticipantCount();
  return peer;
}

function removePeer(userId) {
  const peer = peers.get(userId);
  if (!peer) return;
  peer.pc.close();
  peers.delete(userId);
  earlyCandidates.delete(userId);
  removeTile(userId);
  updateParticipantCount();
  refreshStatusOverlay();
}

// ---------- starting / joining a call ----------
async function startCall(type) {
  if (!activeConversation) return;

  if (isCallActive) {
    alert('You are already in a call.');
    return;
  }

  callId = activeConversation._id;
  callType = type;
  callConversationId = activeConversation._id;

  try {
    localStream = await getLocalStream(type === 'video');
  } catch (err) {
    alert('Could not access camera/microphone. Please allow permission and try again.');
    callId = null;
    return;
  }

  localVideo.srcObject = localStream;
  toggleCameraBtn.style.display = type === 'video' ? 'flex' : 'none';
  callScreen.classList.toggle('audio-only', type === 'audio');

  callPeerAvatar.src = conversationAvatar(activeConversation) || '';
  callPeerName.textContent = conversationTitle(activeConversation);
  showCallScreen('Calling...');
  isCallActive = true;

  socket.emit('join_call', { callId, callType: type, conversationId: callConversationId });
}

voiceCallBtn?.addEventListener('click', () => startCall('audio'));
videoCallBtn?.addEventListener('click', () => startCall('video'));

// ---------- incoming call (ringing) ----------
socket.on('incoming_call', ({ callId: incomingId, from, fromName, fromAvatar, callType: incomingType, conversationId, isGroup }) => {
  if (isCallActive) {
    // already on a call -> auto-decline this new one
    socket.emit('reject_call', { callId: incomingId, to: from });
    return;
  }

  pendingIncoming = { callId: incomingId, from, fromName, fromAvatar, callType: incomingType, conversationId, isGroup };

  incomingCallAvatar.src = fromAvatar || '';
  incomingCallName.textContent = fromName || 'Unknown';
  incomingCallType.textContent = `Incoming ${incomingType === 'video' ? 'video' : 'voice'}${isGroup ? ' group' : ''} call`;
  incomingCallModal.classList.remove('d-none');
  playRingtone();
});

acceptCallBtn.addEventListener('click', async () => {
  if (!pendingIncoming) return;
  stopRingtone();

  const { callId: incomingId, fromName, fromAvatar, callType: incomingType, conversationId } = pendingIncoming;

  try {
    localStream = await getLocalStream(incomingType === 'video');
  } catch (err) {
    alert('Could not access camera/microphone. Please allow permission and try again.');
    socket.emit('reject_call', { callId: incomingId, to: pendingIncoming.from });
    pendingIncoming = null;
    incomingCallModal.classList.add('d-none');
    return;
  }

  callId = incomingId;
  callType = incomingType;
  callConversationId = conversationId;
  isCallActive = true;

  localVideo.srcObject = localStream;
  toggleCameraBtn.style.display = incomingType === 'video' ? 'flex' : 'none';
  callScreen.classList.toggle('audio-only', incomingType === 'audio');

  callPeerAvatar.src = fromAvatar || '';
  callPeerName.textContent = fromName || 'Unknown';
  showCallScreen('Connecting...');

  pendingIncoming = null;
  socket.emit('join_call', { callId, callType: incomingType, conversationId });
});

rejectCallBtn.addEventListener('click', () => {
  if (pendingIncoming) {
    socket.emit('reject_call', { callId: pendingIncoming.callId, to: pendingIncoming.from });
  }
  stopRingtone();
  pendingIncoming = null;
  incomingCallModal.classList.add('d-none');
});

// ---------- room membership events ----------

// Sent only to me, right after I join: who's already in the room.
// Per the "existing members offer to the newcomer" rule, I do NOT
// initiate connections here - I just wait for their offers.
socket.on('call_joined', ({ callId: id, participants }) => {
  if (id !== callId) return;
  if (participants.length > 0) {
    callStatusText.textContent = 'Connecting...';
  }
  updateParticipantCount();
});

// A new peer joined a room I'm already in -> I initiate the offer to them.
socket.on('call_peer_joined', async ({ callId: id, userId, name, avatar }) => {
  if (id !== callId || peers.has(userId)) return;

  const peer = createPeerForUser(userId, name, avatar);
  try {
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    socket.emit('call_offer', { callId, to: userId, offer });
  } catch (err) {
    console.error('Error creating offer for new peer:', err);
  }
});

socket.on('call_offer', async ({ callId: id, from, fromName, fromAvatar, offer }) => {
  if (id !== callId) return;

  let peer = peers.get(from);
  if (!peer) peer = createPeerForUser(from, fromName, fromAvatar);

  try {
    await peer.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    socket.emit('call_answer', { callId, to: from, answer });
  } catch (err) {
    console.error('Error handling call offer:', err);
  }
});

socket.on('call_answer', async ({ callId: id, from, answer }) => {
  if (id !== callId) return;
  const peer = peers.get(from);
  if (!peer) return;
  try {
    await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (err) {
    console.error('Error applying call answer:', err);
  }
});

socket.on('call_ice', async ({ callId: id, from, candidate }) => {
  if (id !== callId || !candidate) return;

  const peer = peers.get(from);
  if (!peer) {
    // Peer connection for this sender doesn't exist yet -> queue it
    if (!earlyCandidates.has(from)) earlyCandidates.set(from, []);
    earlyCandidates.get(from).push(candidate);
    return;
  }

  try {
    await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('Error adding ICE candidate:', err);
  }
});

socket.on('call_peer_left', ({ callId: id, userId }) => {
  if (id !== callId) return;
  removePeer(userId);
});

// The call was cancelled before I ever joined (caller hung up while I was still ringing)
socket.on('call_cancelled', ({ callId: id }) => {
  if (pendingIncoming && pendingIncoming.callId === id) {
    stopRingtone();
    pendingIncoming = null;
    incomingCallModal.classList.add('d-none');
  }
});

socket.on('call_rejected', ({ callId: id }) => {
  // Informational only for now (e.g. someone declined an "add to call" invite).
});

// ---------- add someone to an ongoing call ----------
addToCallBtn?.addEventListener('click', () => {
  if (!isCallActive) return;
  openAddToCallModal();
});

closeAddToCallBtn?.addEventListener('click', () => {
  addToCallModal.classList.add('d-none');
});

function openAddToCallModal() {
  const inCallIds = new Set([...peers.keys(), me._id]);
  const seen = new Set();
  const candidates = [];

  (conversationsCache || []).forEach((conv) => {
    (conv.participants || []).forEach((p) => {
      if (!p || !p._id) return;
      if (inCallIds.has(p._id) || seen.has(p._id)) return;
      seen.add(p._id);
      candidates.push(p);
    });
  });

  addToCallList.innerHTML = '';

  if (candidates.length === 0) {
    addToCallList.innerHTML = '<div class="call-invite-empty">No one else to add right now.</div>';
  } else {
    candidates.forEach((user) => {
      const row = document.createElement('div');
      row.className = 'call-invite-row';
      row.innerHTML = `
        <img src="${user.profilePicture || ''}" class="avatar" alt="" />
        <span class="flex-grow-1">${user.name}</span>
        <button class="call-invite-add-btn"><i class="bi bi-plus-lg"></i></button>
      `;
      row.querySelector('.call-invite-add-btn').addEventListener('click', () => {
        socket.emit('call_invite', { callId, to: user._id });
        const btn = row.querySelector('.call-invite-add-btn');
        btn.innerHTML = '<i class="bi bi-check-lg"></i>';
        btn.disabled = true;
      });
      addToCallList.appendChild(row);
    });
  }

  addToCallModal.classList.remove('d-none');
}

// ---------- end / leave call (local action) ----------
function endCall() {
  if (callId) {
    socket.emit('leave_call', { callId });
  }
  resetCallState();
}

endCallBtn.addEventListener('click', endCall);

function resetCallState() {
  stopRingtone();

  peers.forEach((peer) => peer.pc.close());
  peers.clear();
  earlyCandidates.clear();

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }

  callId = null;
  callType = null;
  callConversationId = null;
  isCallActive = false;
  pendingIncoming = null;
  isMicMuted = false;
  isCameraOff = false;
  toggleMuteBtn.innerHTML = '<i class="bi bi-mic-fill"></i>';
  toggleMuteBtn.classList.remove('call-btn-off');
  toggleCameraBtn.innerHTML = '<i class="bi bi-camera-video-fill"></i>';
  toggleCameraBtn.classList.remove('call-btn-off');
  callParticipantCount.classList.add('d-none');

  hideCallUI();
}

// ---------- mic/camera toggles ----------
toggleMuteBtn.addEventListener('click', () => {
  if (!localStream) return;
  isMicMuted = !isMicMuted;
  localStream.getAudioTracks().forEach((t) => (t.enabled = !isMicMuted));
  toggleMuteBtn.innerHTML = isMicMuted
    ? '<i class="bi bi-mic-mute-fill"></i>'
    : '<i class="bi bi-mic-fill"></i>';
  toggleMuteBtn.classList.toggle('call-btn-off', isMicMuted);
});

toggleCameraBtn.addEventListener('click', () => {
  if (!localStream) return;
  isCameraOff = !isCameraOff;
  localStream.getVideoTracks().forEach((t) => (t.enabled = !isCameraOff));
  toggleCameraBtn.innerHTML = isCameraOff
    ? '<i class="bi bi-camera-video-off-fill"></i>'
    : '<i class="bi bi-camera-video-fill"></i>';
  toggleCameraBtn.classList.toggle('call-btn-off', isCameraOff);
});