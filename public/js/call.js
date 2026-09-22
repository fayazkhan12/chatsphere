// ---------------------------------------------------------------
// Voice/Video calling (WebRTC), signaled through the existing socket.
// The actual audio/video streams travel directly between the two
// browsers (peer-to-peer); the server only relays small "handshake"
// messages (call_user, answer_call, ice_candidate, etc. - see
// socket/socketHandler.js) needed to set that connection up.
// ---------------------------------------------------------------

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

let peerConnection = null;
let localStream = null;
let currentCallPeerId = null;
let currentCallType = null; // 'audio' | 'video'
let isMicMuted = false;
let isCameraOff = false;

// ---------- element references ----------
const incomingCallModal = document.getElementById('incomingCallModal');
const incomingCallAvatar = document.getElementById('incomingCallAvatar');
const incomingCallName = document.getElementById('incomingCallName');
const incomingCallType = document.getElementById('incomingCallType');
const rejectCallBtn = document.getElementById('rejectCallBtn');
const acceptCallBtn = document.getElementById('acceptCallBtn');

const callScreen = document.getElementById('callScreen');
const remoteVideo = document.getElementById('remoteVideo');
const localVideo = document.getElementById('localVideo');
const callStatusOverlay = document.getElementById('callStatusOverlay');
const callPeerAvatar = document.getElementById('callPeerAvatar');
const callPeerName = document.getElementById('callPeerName');
const callStatusText = document.getElementById('callStatusText');
const toggleMuteBtn = document.getElementById('toggleMuteBtn');
const toggleCameraBtn = document.getElementById('toggleCameraBtn');
const endCallBtn = document.getElementById('endCallBtn');

const voiceCallBtn = document.getElementById('voiceCallBtn');
const videoCallBtn = document.getElementById('videoCallBtn');
const ringtone = document.getElementById('ringtoneSound');

let pendingIncoming = null; // { from, fromName, fromAvatar, offer, callType }

// ---------- helpers ----------
function playRingtone() {
  ringtone.currentTime = 0;
  ringtone.play().catch(() => {});
}
function stopRingtone() {
  ringtone.pause();
  ringtone.currentTime = 0;
}

function showCallScreen(peerName, peerAvatar, statusText) {
  incomingCallModal.classList.add('d-none');
  callScreen.classList.remove('d-none');
  callPeerName.textContent = peerName;
  callPeerAvatar.src = peerAvatar || '';
  callStatusText.textContent = statusText;
  callStatusOverlay.classList.remove('d-none');
}

function hideCallUI() {
  incomingCallModal.classList.add('d-none');
  callScreen.classList.add('d-none');
  callStatusOverlay.classList.remove('d-none');
  remoteVideo.srcObject = null;
  localVideo.srcObject = null;
}

async function getLocalStream(withVideo) {
  return navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
}

function createPeerConnection(remoteUserId) {
  const pc = new RTCPeerConnection(ICE_SERVERS);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice_candidate', { to: remoteUserId, candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    callStatusOverlay.classList.add('d-none'); // peer connected -> hide "connecting" avatar overlay
    callStatusText.textContent = 'Connected';
  };

  pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      endCall(false);
    }
  };

  return pc;
}

// ---------- outgoing call ----------
async function startCall(callType) {
  if (!activeConversation || activeConversation.type !== 'one-to-one') return;
  const other = otherParticipant(activeConversation);
  if (!other) return;

  if (currentCallPeerId) {
    alert('You are already in a call.');
    return;
  }

  currentCallPeerId = other._id;
  currentCallType = callType;

  try {
    localStream = await getLocalStream(callType === 'video');
  } catch (err) {
    alert('Could not access camera/microphone. Please allow permission and try again.');
    currentCallPeerId = null;
    return;
  }

  localVideo.srcObject = localStream;
  toggleCameraBtn.style.display = callType === 'video' ? 'flex' : 'none';

  showCallScreen(conversationTitle(activeConversation), conversationAvatar(activeConversation), 'Calling...');

  peerConnection = createPeerConnection(currentCallPeerId);
  localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  socket.emit('call_user', { to: currentCallPeerId, offer, callType });
}

voiceCallBtn?.addEventListener('click', () => startCall('audio'));
videoCallBtn?.addEventListener('click', () => startCall('video'));

// ---------- incoming call ----------
socket.on('incoming_call', ({ from, fromName, fromAvatar, offer, callType }) => {
  if (currentCallPeerId) {
    // already on/starting another call -> auto-decline
    socket.emit('reject_call', { to: from });
    return;
  }

  pendingIncoming = { from, fromName, fromAvatar, offer, callType };

  incomingCallAvatar.src = fromAvatar || '';
  incomingCallName.textContent = fromName || 'Unknown';
  incomingCallType.textContent = `Incoming ${callType === 'video' ? 'video' : 'voice'} call`;
  incomingCallModal.classList.remove('d-none');
  playRingtone();
});

acceptCallBtn.addEventListener('click', async () => {
  if (!pendingIncoming) return;
  stopRingtone();

  const { from, fromName, fromAvatar, offer, callType } = pendingIncoming;
  currentCallPeerId = from;
  currentCallType = callType;

  try {
    localStream = await getLocalStream(callType === 'video');
  } catch (err) {
    alert('Could not access camera/microphone. Please allow permission and try again.');
    socket.emit('reject_call', { to: from });
    resetCallState();
    return;
  }

  localVideo.srcObject = localStream;
  toggleCameraBtn.style.display = callType === 'video' ? 'flex' : 'none';

  showCallScreen(fromName, fromAvatar, 'Connecting...');

  peerConnection = createPeerConnection(currentCallPeerId);
  localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));

  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  socket.emit('answer_call', { to: currentCallPeerId, answer });
  pendingIncoming = null;
});

rejectCallBtn.addEventListener('click', () => {
  if (pendingIncoming) {
    socket.emit('reject_call', { to: pendingIncoming.from });
  }
  stopRingtone();
  pendingIncoming = null;
  incomingCallModal.classList.add('d-none');
});

// ---------- call answered (caller side) ----------
socket.on('call_answered', async ({ answer }) => {
  if (!peerConnection) return;
  await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  callStatusText.textContent = 'Connecting...';
});

// ---------- ICE candidates ----------
socket.on('ice_candidate', async ({ candidate }) => {
  if (!peerConnection || !candidate) return;
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('Error adding ICE candidate:', err);
  }
});

// ---------- rejected / ended by the other side ----------
socket.on('call_rejected', () => {
  alert('Call was declined.');
  resetCallState();
});

socket.on('call_ended', () => {
  resetCallState();
});

// ---------- end call (local action) ----------
function endCall(notifyPeer = true) {
  if (notifyPeer && currentCallPeerId) {
    socket.emit('end_call', { to: currentCallPeerId });
  }
  resetCallState();
}

endCallBtn.addEventListener('click', () => endCall(true));

function resetCallState() {
  stopRingtone();

  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }

  currentCallPeerId = null;
  currentCallType = null;
  pendingIncoming = null;
  isMicMuted = false;
  isCameraOff = false;
  toggleMuteBtn.innerHTML = '<i class="bi bi-mic-fill"></i>';
  toggleMuteBtn.classList.remove('call-btn-off');
  toggleCameraBtn.innerHTML = '<i class="bi bi-camera-video-fill"></i>';
  toggleCameraBtn.classList.remove('call-btn-off');

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