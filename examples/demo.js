import { createCallClient } from './webrtc-client.js';

const $ = id => document.getElementById(id);
let csrfToken;
let user;
let socket;
let conversations = [];
let selectedConversation;
let callClient;
let activeCall;
let localStream;
let joiningCall = false;
const seenMessages = new Set();

function notice(message, isError = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', isError);
}
const report = error => notice(error.message, true);
const safely = fn => (...args) => Promise.resolve().then(() => fn(...args)).catch(report);
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action, className = 'secondary') {
  const node = element('button', text, className);
  node.type = 'button';
  node.addEventListener('click', safely(action));
  return node;
}
async function api(path, method = 'GET', body) {
  const response = await fetch(`/api${path}`, {
    method, credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = new Error(data?.error?.message || 'Request failed.');
    error.status = response.status;
    throw error;
  }
  return data;
}
function conversationLabel(conversation) {
  return conversation.title || conversation.members.filter(member => member.id !== user.id).map(member => member.fullName).join(', ');
}
function appendMessage(message) {
  if (message.conversationId !== selectedConversation?.id || seenMessages.has(message.id)) return;
  seenMessages.add(message.id);
  const sender = selectedConversation.members.find(member => member.id === message.senderId);
  const node = element('div', undefined, 'message');
  node.append(element('strong', `${sender?.fullName || 'Participant'} · ${new Date(message.createdAt).toLocaleTimeString()}`), document.createTextNode(message.body));
  $('messages').append(node);
  $('messages').scrollTop = $('messages').scrollHeight;
}
async function selectConversation(conversation) {
  selectedConversation = conversation;
  $('chat-title').textContent = conversationLabel(conversation);
  $('messages').replaceChildren();
  seenMessages.clear();
  for (const id of ['audio-call', 'video-call', 'send-message']) $(id).disabled = false;
  const data = await api(`/conversations/${conversation.id}/messages?limit=100`);
  if (selectedConversation.id === conversation.id) data.messages.reverse().forEach(appendMessage);
}
async function refreshConversations() {
  ({ conversations } = await api('/conversations?limit=100'));
  $('conversations').replaceChildren(...conversations.map(conversation => {
    const row = element('div', undefined, 'row');
    row.append(button(conversationLabel(conversation), () => selectConversation(conversation)));
    return row;
  }));
}
async function refreshPeople() {
  const [{ users }, { users: following }] = await Promise.all([
    api('/users?limit=100'), api(`/users/${user.id}/following?limit=100`),
  ]);
  const follows = new Set(following.map(person => person.id));
  $('people').replaceChildren(...users.filter(person => person.id !== user.id).map(person => {
    const row = element('div', undefined, 'row');
    const label = element('label');
    const checkbox = element('input');
    checkbox.type = 'checkbox'; checkbox.value = person.id; checkbox.name = 'member';
    label.append(checkbox, document.createTextNode(`${person.fullName} · ${person.role}`));
    row.append(label, button(follows.has(person.id) ? 'Unfollow' : 'Follow', async () => {
      await api(`/users/${person.id}/follow`, follows.has(person.id) ? 'DELETE' : 'POST');
      await refreshPeople();
    }));
    return row;
  }));
  const { counsellors } = await api('/counsellors?limit=100');
  $('counsellors').replaceChildren(new Option('Choose a counsellor', ''), ...counsellors.map(person => new Option(person.fullName, person.id)));
}
async function refreshSlots() {
  const id = $('counsellors').value;
  $('slots').replaceChildren();
  if (!id) return;
  const { slots } = await api(`/counsellors/${id}/availability`);
  for (const slot of slots) {
    const row = element('div', undefined, 'row');
    row.append(element('div', `${new Date(slot.startsAt).toLocaleString()} — ${new Date(slot.endsAt).toLocaleTimeString()}`));
    row.append(button('Request session', async () => {
      await api('/bookings', 'POST', { slotId: slot.id });
      notice('Session requested. Your counsellor can confirm it.');
      await Promise.all([refreshBookings(), refreshSlots()]);
    }));
    $('slots').append(row);
  }
  if (!slots.length) $('slots').textContent = 'No available slots yet.';
}
async function refreshBookings() {
  const { bookings } = await api('/bookings?limit=100');
  $('bookings').replaceChildren(...bookings.map(booking => {
    const row = element('div', undefined, 'row');
    row.append(element('div', `${booking.clientName} with ${booking.counsellorName}`));
    row.append(element('small', `${new Date(booking.startsAt).toLocaleString()} · ${booking.status}`));
    async function status(value) {
      await api(`/bookings/${booking.id}/status`, 'PATCH', { status: value });
      await refreshBookings();
    }
    if (['pending', 'confirmed'].includes(booking.status)) row.append(button('Cancel', () => status('cancelled')));
    if (user.role === 'counsellor' && booking.status === 'pending') row.append(button('Confirm', () => status('confirmed')));
    if (booking.status === 'confirmed') {
      row.append(button('Join session', () => startCall({ bookingId: booking.id }, 'video')));
      if (user.role === 'counsellor') row.append(button('Complete', () => status('completed')));
    }
    return row;
  }));
}
function resetCall() {
  $('call-panel').hidden = true;
  $('local-video').srcObject = null;
  $('videos').querySelectorAll('[data-peer]').forEach(node => node.remove());
  localStream?.getTracks().forEach(track => track.stop());
  localStream = null; activeCall = null;
  $('toggle-mic').textContent = 'Mute mic';
  $('toggle-camera').textContent = 'Camera off';
}
async function joinCall(call) {
  if (callClient || joiningCall) throw new Error('Leave your current call before joining another.');
  if (!socket?.connected) throw new Error('Wait for chat to reconnect before joining.');
  joiningCall = true;
  try {
    const { iceServers } = await api('/calls/ice');
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: call.mode === 'video' });
    activeCall = call;
    $('local-video').srcObject = localStream;
    $('toggle-camera').hidden = call.mode === 'audio';
    $('end-call').hidden = Boolean(call.conversationId && conversations.find(c => c.id === call.conversationId)?.kind === 'group' && call.createdBy !== user.id);
    callClient = createCallClient({
      socket, localStream, iceServers,
      onRemoteStream: ({ socketId, stream }) => {
        let video = [...$('videos').querySelectorAll('[data-peer]')].find(node => node.dataset.peer === socketId);
        if (!video) {
          video = element('video'); video.autoplay = true; video.playsInline = true; video.dataset.peer = socketId;
          $('videos').append(video);
        }
        video.srcObject = stream;
        video.play().catch(() => notice('Click a remote video to enable playback.'));
        video.onclick = () => video.play().catch(report);
      },
      onPeerLeft: ({ socketId }) => [...$('videos').querySelectorAll('[data-peer]')].find(node => node.dataset.peer === socketId)?.remove(),
      onError: report,
      onEnded: ({ reason }) => {
        const previous = callClient; callClient = null;
        void previous?.destroy().catch(report);
        resetCall(); notice(`Call ended: ${reason}`);
      },
    });
    await callClient.join(call.id);
    $('call-panel').hidden = false;
    notice('Call joined. Waiting participants can accept their invitation.');
  } catch (error) {
    const previous = callClient; callClient = null;
    await previous?.destroy().catch(() => {});
    resetCall(); throw error;
  } finally { joiningCall = false; }
}
async function startCall(scope, mode) {
  if (callClient || joiningCall) throw new Error('Leave your current call first.');
  const { call } = await api('/calls', 'POST', { ...scope, mode });
  await joinCall(call);
}
async function enterWorkspace() {
  $('auth').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
  $('greeting').textContent = `Hello, ${user.fullName}`;
  $('availability-form').hidden = user.role !== 'counsellor';
  $('booking-picker').hidden = user.role !== 'client';
  socket?.disconnect();
  socket = window.io({ withCredentials: true, auth: { csrfToken } });
  socket.on('connect', () => { notice('Connected.'); void refreshConversations().catch(report); });
  socket.on('connect_error', report);
  socket.on('disconnect', () => notice('Disconnected. Your messages are saved; reconnect or sign in again.'));
  socket.on('message:new', appendMessage);
  socket.on('conversation:new', safely(refreshConversations));
  socket.on('call:invited', ({ call }) => {
    const row = element('div', undefined, 'row');
    row.append(element('div', `Incoming ${call.mode} call`), button('Accept', async () => { await joinCall(call); row.remove(); }), button('Dismiss', () => row.remove()));
    $('invitations').append(row);
  });
  await Promise.all([refreshPeople(), refreshConversations(), refreshBookings()]);
}
$('auth-form').addEventListener('submit', safely(async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  const action = event.submitter?.value || 'login';
  const body = action === 'register' ? values : { email: values.email, password: values.password };
  ({ user, csrfToken } = await api(`/auth/${action}`, 'POST', body));
  await enterWorkspace();
}));
$('conversation-form').addEventListener('submit', safely(async event => {
  event.preventDefault();
  const memberIds = [...$('people').querySelectorAll('input:checked')].map(input => input.value);
  const body = { kind: memberIds.length > 1 ? 'group' : 'direct', memberIds };
  const title = new FormData(event.currentTarget).get('title').trim();
  if (body.kind === 'group' && title) body.title = title;
  const { conversation } = await api('/conversations', 'POST', body);
  await refreshConversations(); await selectConversation(conversation);
}));
$('message-form').addEventListener('submit', safely(async event => {
  event.preventDefault();
  if (!selectedConversation) return;
  const form = event.currentTarget;
  const { message } = await api(`/conversations/${selectedConversation.id}/messages`, 'POST', { body: new FormData(form).get('body') });
  appendMessage(message); form.reset();
}));
$('availability-form').addEventListener('submit', safely(async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  await api('/counsellors/availability', 'POST', { startsAt: new Date(values.startsAt).toISOString(), endsAt: new Date(values.endsAt).toISOString() });
  notice('Availability published.'); event.currentTarget.reset();
}));
$('refresh-people').onclick = safely(refreshPeople);
$('refresh-bookings').onclick = safely(refreshBookings);
$('counsellors').onchange = safely(refreshSlots);
$('audio-call').onclick = safely(() => startCall({ conversationId: selectedConversation.id }, 'audio'));
$('video-call').onclick = safely(() => startCall({ conversationId: selectedConversation.id }, 'video'));
$('leave-call').onclick = safely(async () => { const previous = callClient; callClient = null; try { await previous?.destroy(); } finally { resetCall(); } });
$('end-call').onclick = safely(async () => { if (activeCall) await api(`/calls/${activeCall.id}/end`, 'POST'); });
$('toggle-mic').onclick = () => {
  const tracks = localStream?.getAudioTracks() ?? [];
  for (const track of tracks) track.enabled = !track.enabled;
  $('toggle-mic').textContent = tracks[0]?.enabled ? 'Mute mic' : 'Unmute mic';
};
$('toggle-camera').onclick = () => {
  const tracks = localStream?.getVideoTracks() ?? [];
  for (const track of tracks) track.enabled = !track.enabled;
  $('toggle-camera').textContent = tracks[0]?.enabled ? 'Camera off' : 'Camera on';
};
$('logout').onclick = safely(async () => { await callClient?.destroy(); await api('/auth/logout', 'POST'); socket?.disconnect(); window.location.reload(); });
window.addEventListener('pagehide', () => { void callClient?.destroy().catch(() => {}); socket?.disconnect(); });
await safely(async () => {
  try { ({ user, csrfToken } = await api('/auth/me')); await enterWorkspace(); }
  catch (error) {
    if (error.status !== 401) throw error;
    ({ csrfToken } = await api('/auth/csrf'));
    notice('Sign in or create an account to begin.');
  }
})();
