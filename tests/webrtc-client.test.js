import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createCallClient } from '../examples/webrtc-client.js';

const drain = () => new Promise((resolve) => setImmediate(resolve));

function harness({ initialPeers = [], rejectJoin = false, deferJoin = false } = {}) {
  const connections = [];
  class Stream {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    addTrack(track) { this.tracks.push(track); }
  }
  class Peer {
    constructor() { this.candidates = []; this.closed = false; connections.push(this); }
    addTrack() {}
    async setRemoteDescription(sdp) { this.remoteDescription = sdp; }
    async addIceCandidate(candidate) {
      assert.ok(this.remoteDescription, 'ICE must wait for the remote description');
      this.candidates.push(candidate);
    }
    async createAnswer() { return { type: 'answer', sdp: 'answer-sdp' }; }
    async createOffer() { return { type: 'offer', sdp: 'offer-sdp' }; }
    async setLocalDescription(sdp) { this.localDescription = { ...sdp, toJSON: () => sdp }; }
    close() { this.closed = true; }
  }
  globalThis.MediaStream = Stream;
  globalThis.RTCPeerConnection = Peer;
  class Socket extends EventEmitter {
    connected = true;
    outgoing = [];
    pendingJoin;
    timeout() {
      return { emit: (event, payload, ack) => {
        this.outgoing.push({ event, payload });
        const respond = () => ack(null, event === 'call:join' && rejectJoin
          ? { ok: false, error: { code: 'CALL_FULL', message: 'This call is full.' } }
          : { ok: true, data: event === 'call:join' ? { callId: payload.callId, mode: 'video', peers: initialPeers } : null });
        if (event === 'call:join' && deferJoin) this.pendingJoin = respond;
        else queueMicrotask(respond);
      } };
    }
  }
  const socket = new Socket();
  const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
  const errors = [];
  const left = [];
  const ended = [];
  const client = createCallClient({
    socket, localStream: new Stream([track]),
    onError: (error) => errors.push(error), onPeerLeft: (peer) => left.push(peer), onEnded: (event) => ended.push(event),
  });
  return { client, socket, track, errors, left, ended, connections };
}

test('buffers ICE arriving before an offer, answers, and releases media/listeners', async () => {
  const { client, socket, track, errors, left, connections } = harness();
  await client.join('call-1');
  socket.emit('webrtc:ice-candidate', { callId: 'call-1', fromId: 'peer-1', candidate: { candidate: 'early-ice' } });
  socket.emit('webrtc:offer', { callId: 'call-1', fromId: 'peer-1', sdp: { type: 'offer', sdp: 'offer-sdp' } });
  await drain();
  assert.deepEqual(connections[0].candidates, [{ candidate: 'early-ice' }]);
  assert.ok(socket.outgoing.some((item) => item.event === 'webrtc:answer'));
  assert.deepEqual(errors, []);
  await client.destroy();
  assert.equal(connections[0].closed, true);
  assert.equal(track.readyState, 'ended');
  assert.deepEqual(left, [{ socketId: 'peer-1' }]);
  assert.equal(socket.listenerCount('webrtc:offer'), 0);
});

test('only the newcomer offers to peers in its ACK; existing peers wait for offers', async () => {
  const { client, socket } = harness({ initialPeers: [{ socketId: 'peer-1' }, { socketId: 'peer-2' }] });
  await client.join('call-1');
  assert.deepEqual(socket.outgoing.filter((item) => item.event === 'webrtc:offer').map((item) => item.payload.targetId), ['peer-1', 'peer-2']);
  socket.emit('call:peer-joined', { callId: 'call-1', socketId: 'peer-3' });
  await drain();
  assert.equal(socket.outgoing.filter((item) => item.event === 'webrtc:offer').length, 2);
  await client.destroy();
});

test('late signaling cannot resurrect a departed peer; a new join event permits rejoining', async () => {
  const { client, socket, connections } = harness();
  await client.join('call-1');
  socket.emit('call:peer-left', { callId: 'call-1', socketId: 'peer-1' });
  socket.emit('webrtc:ice-candidate', { callId: 'call-1', fromId: 'peer-1', candidate: null });
  socket.emit('webrtc:offer', { callId: 'call-1', fromId: 'peer-1', sdp: { type: 'offer', sdp: 'late' } });
  await drain();
  assert.equal(connections.length, 0);
  socket.emit('call:peer-joined', { callId: 'call-1', socketId: 'peer-1' });
  socket.emit('webrtc:offer', { callId: 'call-1', fromId: 'peer-1', sdp: { type: 'offer', sdp: 'fresh' } });
  await drain();
  assert.equal(connections.length, 1);
  assert.equal(connections[0].remoteDescription.sdp, 'fresh');
  await client.destroy();
});

test('a rejected join surfaces the server error and releases the camera/microphone', async () => {
  const { client, socket, track } = harness({ rejectJoin: true });
  await assert.rejects(client.join('call-1'), { code: 'CALL_FULL', message: 'This call is full.' });
  assert.equal(track.readyState, 'ended');
  assert.ok(socket.outgoing.some((item) => item.event === 'call:leave'));
  await client.destroy();
});

test('leaving during a pending join prevents late ACKs from creating peer connections', async () => {
  const { client, socket, track, connections } = harness({ initialPeers: [{ socketId: 'peer-1' }], deferJoin: true });
  const joining = client.join('call-1');
  const rejected = assert.rejects(joining, /cancelled/);
  await client.leave();
  socket.pendingJoin();
  await rejected;
  assert.equal(connections.length, 0);
  assert.equal(track.readyState, 'ended');
  await client.destroy();
});

test('server call end and socket disconnect release peer connections and local media', async () => {
  for (const event of ['call:ended', 'disconnect']) {
    const { client, socket, track, connections, ended } = harness({ initialPeers: [{ socketId: 'peer-1' }] });
    await client.join('call-1');
    socket.emit(event, event === 'call:ended' ? { callId: 'call-1', reason: 'ended' } : 'transport close');
    assert.equal(track.readyState, 'ended');
    assert.equal(connections[0].closed, true);
    assert.equal(ended.length, 1);
    await client.destroy();
  }
});
