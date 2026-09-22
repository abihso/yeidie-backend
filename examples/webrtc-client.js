/**
 * Native WebRTC client for the Yiedie Socket.IO signaling API.
 *
 * const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
 * const { iceServers } = await fetch('/api/calls/ice', { credentials: 'include' }).then(r => r.json());
 * const socket = io(API_URL, { withCredentials: true, auth: { csrfToken } });
 * const client = createCallClient({ socket, localStream: stream, iceServers,
 *   onRemoteStream: ({ socketId, stream }) => { videoElements[socketId].srcObject = stream; },
 *   onPeerLeft: ({ socketId }) => removeVideo(socketId),
 *   onError: error => console.error(error),
 *   onEnded: ({ callId, reason }) => console.log(callId, reason),
 * });
 * await client.join(call.id); // socket must be connected first
 * await client.leave();       // releases local tracks and all peer connections
 * await client.destroy();     // also removes event listeners
 *
 * Each browser has one RTCPeerConnection per remote participant (small-group mesh).
 * Only the newly joined participant offers to peers returned by its join ACK.
 * Reacquire media and create a fresh helper after leaving/ending/disconnecting.
 * Serve from HTTPS or localhost. Reliable connectivity requires a TURN server.
 */
export function createCallClient({
  socket,
  localStream,
  iceServers = [],
  onRemoteStream = () => {},
  onPeerLeft = () => {},
  onError = () => {},
  onEnded = () => {},
}) {
  const peers = new Map();
  const departedPeers = new Set();
  let activeCallId = null;
  let joining = false;
  let destroyed = false;
  let generation = 0;

  function report(error) {
    onError(error instanceof Error ? error : new Error(error?.message || 'Call failed.'));
  }

  function request(event, payload) {
    return new Promise((resolve, reject) => {
      if (!socket.connected) { reject(new Error('Connect to the server before starting a call.')); return; }
      socket.timeout(10_000).emit(event, payload, (timeoutError, response) => {
        if (timeoutError) { reject(new Error(`The server did not acknowledge ${event}.`)); return; }
        if (!response?.ok) {
          const error = new Error(response?.error?.message || `${event} failed.`);
          error.code = response?.error?.code;
          reject(error);
          return;
        }
        resolve(response.data);
      });
    });
  }

  function closePeer(socketId) {
    departedPeers.add(socketId);
    const peer = peers.get(socketId);
    if (!peer) return;
    peers.delete(socketId);
    peer.closed = true;
    peer.pendingCandidates.length = 0;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    peer.remoteStream.getTracks().forEach((track) => track.stop());
    onPeerLeft({ socketId });
  }

  function releaseMedia() {
    for (const socketId of [...peers.keys()]) closePeer(socketId);
    localStream.getTracks().forEach((track) => track.stop());
  }

  function peerFor(socketId) {
    if (peers.has(socketId)) return peers.get(socketId);
    const pc = new RTCPeerConnection({ iceServers });
    const peer = { pc, remoteStream: new MediaStream(), pendingCandidates: [], queue: Promise.resolve(), closed: false };
    peers.set(socketId, peer);
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    pc.ontrack = (event) => {
      if (peer.closed) return;
      if (!peer.remoteStream.getTracks().some((track) => track.id === event.track.id)) peer.remoteStream.addTrack(event.track);
      onRemoteStream({ socketId, stream: peer.remoteStream });
    };
    pc.onicecandidate = (event) => {
      const callId = activeCallId;
      if (peer.closed || !callId) return;
      void request('webrtc:ice-candidate', { callId, targetId: socketId, candidate: event.candidate?.toJSON() ?? null })
        .catch((error) => { if (!peer.closed && activeCallId === callId) report(error); });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        report(new Error('A peer connection failed. Check TURN configuration, then leave and rejoin the call.'));
        closePeer(socketId);
      }
    };
    return peer;
  }

  function enqueue(peer, work) {
    peer.queue = peer.queue.then(async () => {
      if (!peer.closed) await work();
    }).catch((error) => { if (!peer.closed) report(error); });
    return peer.queue;
  }

  async function flushCandidates(peer) {
    while (!peer.closed && peer.pendingCandidates.length) {
      await peer.pc.addIceCandidate(peer.pendingCandidates.shift());
    }
  }

  function accepts(payload) {
    return !destroyed && activeCallId && payload?.callId === activeCallId;
  }

  function offerReceived(payload) {
    if (!accepts(payload) || departedPeers.has(payload.fromId)) return;
    const peer = peerFor(payload.fromId);
    void enqueue(peer, async () => {
      await peer.pc.setRemoteDescription(payload.sdp);
      await flushCandidates(peer);
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      await request('webrtc:answer', { callId: payload.callId, targetId: payload.fromId, sdp: peer.pc.localDescription.toJSON() });
    });
  }

  function answerReceived(payload) {
    if (!accepts(payload) || departedPeers.has(payload.fromId)) return;
    const peer = peers.get(payload.fromId);
    if (!peer) return;
    void enqueue(peer, async () => {
      await peer.pc.setRemoteDescription(payload.sdp);
      await flushCandidates(peer);
    });
  }

  function candidateReceived(payload) {
    if (!accepts(payload) || departedPeers.has(payload.fromId)) return;
    const peer = peerFor(payload.fromId);
    void enqueue(peer, async () => {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(payload.candidate);
      else if (peer.pendingCandidates.length < 256) peer.pendingCandidates.push(payload.candidate);
      else throw new Error('Too many queued ICE candidates.');
    });
  }

  function peerLeft(payload) {
    if (accepts(payload)) closePeer(payload.socketId);
  }

  function peerJoined(payload) {
    // A socket can leave and later rejoin. Only a fresh membership event clears its tombstone.
    if (accepts(payload)) departedPeers.delete(payload.socketId);
  }

  function ended(payload) {
    if (!accepts(payload)) return;
    generation += 1;
    activeCallId = null;
    joining = false;
    releaseMedia();
    onEnded(payload);
  }

  function disconnected(reason) {
    if (!activeCallId) { releaseMedia(); return; }
    ended({ callId: activeCallId, reason: `disconnected: ${reason}` });
  }

  function connectionError(error) {
    report(error);
    if (activeCallId) ended({ callId: activeCallId, reason: 'connection_error' });
    else releaseMedia();
  }

  const listeners = {
    'webrtc:offer': offerReceived,
    'webrtc:answer': answerReceived,
    'webrtc:ice-candidate': candidateReceived,
    'call:peer-joined': peerJoined,
    'call:peer-left': peerLeft,
    'call:ended': ended,
    disconnect: disconnected,
    connect_error: connectionError,
  };
  for (const [event, listener] of Object.entries(listeners)) socket.on(event, listener);

  async function join(callId) {
    callId = callId.toLowerCase();
    if (destroyed) throw new Error('This call client was destroyed.');
    if (activeCallId || joining) throw new Error('Leave the current call before joining another.');
    if (!localStream.getTracks().some((track) => track.readyState === 'live')) throw new Error('Acquire a fresh microphone/camera stream before joining.');
    const operation = ++generation;
    departedPeers.clear();
    activeCallId = callId;
    joining = true;
    try {
      const data = await request('call:join', { callId });
      if (operation !== generation || activeCallId !== callId) throw new Error('Joining the call was cancelled.');
      for (const remote of data.peers) {
        if (operation !== generation || activeCallId !== callId) throw new Error('Joining the call was cancelled.');
        const peer = peerFor(remote.socketId);
        await enqueue(peer, async () => {
          await peer.pc.setLocalDescription(await peer.pc.createOffer());
          await request('webrtc:offer', { callId, targetId: remote.socketId, sdp: peer.pc.localDescription.toJSON() });
        });
      }
      if (operation !== generation || activeCallId !== callId) throw new Error('Joining the call was cancelled.');
      return data;
    } catch (error) {
      if (activeCallId === callId) {
        activeCallId = null;
        releaseMedia();
      }
      if (socket.connected) void request('call:leave', { callId }).catch(() => {});
      throw error;
    } finally {
      joining = false;
    }
  }

  async function leave() {
    const callId = activeCallId;
    generation += 1;
    activeCallId = null;
    joining = false;
    releaseMedia();
    if (callId && socket.connected) await request('call:leave', { callId });
  }

  async function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const [event, listener] of Object.entries(listeners)) socket.off(event, listener);
    await leave();
  }

  return { join, leave, destroy };
}
