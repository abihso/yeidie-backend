import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createFixture, emit, event } from './helpers.js';

async function conversation(owner, members, kind = 'direct') {
  const response = await owner.request('post', '/api/conversations', {
    kind,
    memberIds: members.map(({ id }) => id),
    ...(kind === 'group' ? { title: 'Support group' } : {}),
  }).expect(201);
  return response.body.conversation;
}

function expectFailure(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
}

async function requestCall(socket, chat, target, type = 'audio') {
  const response = await emit(socket, 'call:request', { conversationId: chat.id, targetUserId: target.id, type });
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.data;
}

test('incoming calls reach every recipient device, sync on new pages, and create one correctly configured room on acceptance', async (t) => {
  const fixture = await createFixture(t);
  const alice = await fixture.account();
  const bob = await fixture.account();
  const direct = await conversation(alice, [bob]);
  const caller = await alice.socket();
  const callerOtherTab = await alice.socket();
  const callee = await bob.socket();
  const calleeOtherTab = await bob.socket();

  for (const type of ['audio', 'video']) {
    const incoming = [callee, calleeOtherTab].map((socket) => event(socket, 'call:request'));
    const invitation = await requestCall(caller, direct, bob, type);
    assert.equal(invitation.fromUserId, alice.id);
    assert.equal(invitation.fromUserName, alice.fullName);
    assert.equal(invitation.targetUserName, bob.fullName);
    assert.equal(invitation.callerSocketId, caller.id);
    assert.ok(Date.parse(invitation.expiresAt) > Date.now());
    for (const notification of incoming) assert.deepEqual(await notification, invitation);
    assert.deepEqual((await emit(calleeOtherTab, 'call:sync', {})).data, { incoming: invitation, outgoing: null });
    assert.deepEqual((await emit(callerOtherTab, 'call:sync', {})).data, { incoming: null, outgoing: invitation });
    const { rows: rooms } = await fixture.pool.query('SELECT * FROM call_rooms WHERE ended_at IS NULL');
    assert.equal(rooms.length, 0, 'ringing must not create a room');

    const acceptedEvents = [caller, callerOtherTab, callee, calleeOtherTab].map((socket) => event(socket, 'call:accepted'));
    const decisions = await Promise.all([
      emit(callee, 'call:accepted', { requestId: invitation.requestId }),
      emit(calleeOtherTab, 'call:accepted', { requestId: invitation.requestId }),
    ]);
    assert.equal(decisions.filter((decision) => decision.ok).length, 1);
    const accepted = decisions.find((decision) => decision.ok).data;
    const acceptedSocket = [callee, calleeOtherTab].find((socket) => socket.id === accepted.acceptedBySocketId);
    for (const notification of acceptedEvents) assert.deepEqual(await notification, accepted);
    const response = await bob.request('get', `/api/calls/${accepted.callId}`).expect(200);
    assert.equal(response.body.call.mode, type);
    assert.equal(response.body.call.conversationId, direct.id);
    assert.deepEqual((await emit(callee, 'call:sync', {})).data, { incoming: null, outgoing: null });
    expectFailure(await emit(callerOtherTab, 'call:join', { callId: accepted.callId }), 'ALREADY_IN_CALL');
    assert.equal((await emit(caller, 'call:join', { callId: accepted.callId })).ok, true);
    const joined = await emit(acceptedSocket, 'call:join', { callId: accepted.callId });
    assert.equal(joined.ok, true);
    assert.equal(joined.data.mode, type);
    assert.equal(joined.data.peers[0].socketId, caller.id);

    const endedEvents = [caller, callerOtherTab, callee, calleeOtherTab].map((socket) => event(socket, 'call:ended'));
    await alice.request('post', `/api/calls/${accepted.callId}/end`).expect(200);
    for (const ended of endedEvents) assert.deepEqual(await ended, { callId: accepted.callId, reason: 'ended' });
  }
});

test('only direct-chat members may request calls and only the intended recipient may accept or decline', async (t) => {
  const fixture = await createFixture(t);
  const alice = await fixture.account();
  const bob = await fixture.account();
  const outsider = await fixture.account();
  const direct = await conversation(alice, [bob]);
  const group = await conversation(alice, [bob, outsider], 'group');
  const caller = await alice.socket();
  const callee = await bob.socket();
  const outsiderSocket = await outsider.socket();
  const leaked = [];
  outsiderSocket.on('call:request', (payload) => leaked.push(payload));

  expectFailure(await emit(outsiderSocket, 'call:request', { conversationId: direct.id, targetUserId: bob.id, type: 'video' }), 'CONVERSATION_NOT_FOUND');
  expectFailure(await emit(caller, 'call:request', { conversationId: direct.id, targetUserId: outsider.id, type: 'video' }), 'INVALID_TARGET');
  expectFailure(await emit(caller, 'call:request', { conversationId: group.id, targetUserId: bob.id, type: 'video' }), 'DIRECT_CALL_REQUIRED');
  expectFailure(await emit(caller, 'call:request', { conversationId: direct.id, targetUserId: alice.id, type: 'video' }), 'INVALID_TARGET');
  expectFailure(await emit(callee, 'call:accepted', { requestId: randomUUID() }), 'CALL_REQUEST_NOT_FOUND');
  const invitation = await requestCall(caller, direct, bob);
  for (const unauthorized of [caller, outsiderSocket]) {
    expectFailure(await emit(unauthorized, 'call:accepted', { requestId: invitation.requestId }), 'CALL_REQUEST_NOT_FOUND');
    expectFailure(await emit(unauthorized, 'call:rejected', { requestId: invitation.requestId }), 'CALL_REQUEST_NOT_FOUND');
  }
  expectFailure(await emit(callee, 'call:cancelled', { requestId: invitation.requestId }), 'CALL_REQUEST_NOT_FOUND');
  const rejections = [caller, callee].map((socket) => event(socket, 'call:rejected'));
  assert.equal((await emit(callee, 'call:rejected', { requestId: invitation.requestId })).ok, true);
  for (const rejection of rejections) assert.deepEqual(await rejection, { ...invitation, reason: 'declined' });
  expectFailure(await emit(callee, 'call:accepted', { requestId: invitation.requestId }), 'CALL_REQUEST_NOT_FOUND');
  const second = await requestCall(caller, direct, bob, 'video');
  const cancelled = event(callee, 'call:cancelled');
  assert.equal((await emit(caller, 'call:cancelled', { requestId: second.requestId })).ok, true);
  assert.deepEqual(await cancelled, { ...second, reason: 'cancelled' });
  assert.deepEqual((await emit(callee, 'call:sync', {})).data, { incoming: null, outgoing: null });
  assert.deepEqual(leaked, []);
  assert.equal((await fixture.pool.query('SELECT * FROM call_rooms')).rows.length, 0);
});

test('offline and busy users cannot be called, including concurrent requests and accepted calls awaiting room entry', async (t) => {
  const fixture = await createFixture(t);
  const alice = await fixture.account();
  const bob = await fixture.account();
  const carol = await fixture.account();
  const firstChat = await conversation(alice, [bob]);
  const secondChat = await conversation(carol, [bob]);
  const thirdChat = await conversation(alice, [carol]);
  const caller = await alice.socket();
  const callerOtherTab = await alice.socket();
  const otherCaller = await carol.socket();
  expectFailure(await emit(caller, 'call:request', { conversationId: firstChat.id, targetUserId: bob.id, type: 'audio' }), 'USER_OFFLINE');
  const callee = await bob.socket();
  const competing = await Promise.all([
    emit(caller, 'call:request', { conversationId: firstChat.id, targetUserId: bob.id, type: 'audio' }),
    emit(otherCaller, 'call:request', { conversationId: secondChat.id, targetUserId: bob.id, type: 'video' }),
  ]);
  assert.equal(competing.filter((result) => result.ok).length, 1);
  expectFailure(competing.find((result) => !result.ok), 'USER_BUSY');
  const invitation = competing.find((result) => result.ok).data;
  const winner = invitation.fromUserId === alice.id ? caller : otherCaller;
  const loser = winner === caller ? otherCaller : caller;
  const losingChat = winner === caller ? secondChat : firstChat;
  const accepted = await emit(callee, 'call:accepted', { requestId: invitation.requestId });
  assert.equal(accepted.ok, true);
  expectFailure(await emit(loser, 'call:request', { conversationId: losingChat.id, targetUserId: bob.id, type: 'audio' }), 'USER_BUSY');
  const separate = await alice.request('post', '/api/calls', { conversationId: thirdChat.id }).expect(201);
  const winnerOtherTab = winner === caller ? callerOtherTab : await carol.socket();
  expectFailure(await emit(winnerOtherTab, 'call:join', { callId: separate.body.call.id }), 'ALREADY_IN_CALL');

  // Ending before either participant enters the room still reaches both users
  // and releases their reservations for a subsequent invitation.
  const ending = [winner, callee].map((socket) => event(socket, 'call:ended'));
  await bob.request('post', `/api/calls/${accepted.data.callId}/end`).expect(200);
  for (const ended of ending) assert.equal((await ended).callId, accepted.data.callId);
  const subsequent = await requestCall(caller, firstChat, bob);
  assert.equal((await emit(callee, 'call:rejected', { requestId: subsequent.requestId })).ok, true);

  assert.equal((await emit(caller, 'call:join', { callId: separate.body.call.id })).ok, true);
  expectFailure(await emit(callerOtherTab, 'call:request', { conversationId: firstChat.id, targetUserId: bob.id, type: 'audio' }), 'ALREADY_IN_CALL');
  assert.equal((await emit(caller, 'call:leave', { callId: separate.body.call.id })).ok, true);
});

test('unanswered invitations expire for every device and cannot be accepted afterwards', async (t) => {
  const fixture = await createFixture(t, { callInvitationTimeoutMs: 100 });
  const alice = await fixture.account();
  const bob = await fixture.account();
  const direct = await conversation(alice, [bob]);
  const caller = await alice.socket();
  const callee = await bob.socket();
  const expired = [caller, callee].map((socket) => event(socket, 'call:expired'));
  const invitation = await requestCall(caller, direct, bob);
  for (const notification of expired) assert.deepEqual(await notification, { ...invitation, reason: 'no_answer' });
  expectFailure(await emit(callee, 'call:accepted', { requestId: invitation.requestId }), 'CALL_REQUEST_NOT_FOUND');
  assert.deepEqual((await emit(caller, 'call:sync', {})).data, { incoming: null, outgoing: null });
  assert.equal((await fixture.pool.query('SELECT * FROM call_rooms')).rows.length, 0);
});

test('disconnecting the caller or last recipient device clears ringing, while another recipient tab can still accept', async (t) => {
  const fixture = await createFixture(t);
  const alice = await fixture.account();
  const bob = await fixture.account();
  const direct = await conversation(alice, [bob]);
  const caller = await alice.socket();
  const callerOtherTab = await alice.socket();
  const callee = await bob.socket();
  const calleeOtherTab = await bob.socket();
  const invitation = await requestCall(caller, direct, bob);
  callee.disconnect();
  assert.equal((await emit(calleeOtherTab, 'call:sync', {})).data.incoming.requestId, invitation.requestId);
  const cancelled = [callerOtherTab, calleeOtherTab].map((socket) => event(socket, 'call:cancelled'));
  caller.disconnect();
  for (const notification of cancelled) assert.deepEqual(await notification, { ...invitation, reason: 'disconnected' });
  const second = await requestCall(callerOtherTab, direct, bob);
  const recipientDisconnected = event(callerOtherTab, 'call:cancelled');
  calleeOtherTab.disconnect();
  assert.deepEqual(await recipientDisconnected, { ...second, reason: 'disconnected' });
  const reconnectedCallee = await bob.socket();
  assert.deepEqual((await emit(reconnectedCallee, 'call:sync', {})).data, { incoming: null, outgoing: null });
});

test('accepted invitation mode replaces an unused room mode and leaving during room entry cannot leave a ghost participant', async (t) => {
  const fixture = await createFixture(t);
  const alice = await fixture.account();
  const bob = await fixture.account();
  const direct = await conversation(alice, [bob]);
  const unused = await alice.request('post', '/api/calls', { conversationId: direct.id, mode: 'video' }).expect(201);
  const caller = await alice.socket();
  const callee = await bob.socket();
  const invitation = await requestCall(caller, direct, bob, 'audio');
  const accepted = await emit(callee, 'call:accepted', { requestId: invitation.requestId });
  assert.equal(accepted.data.callId, unused.body.call.id);
  const { body: { call } } = await alice.request('get', `/api/calls/${accepted.data.callId}`).expect(200);
  assert.equal(call.mode, 'audio');
  const [joined, left] = await Promise.all([
    emit(caller, 'call:join', { callId: call.id }),
    emit(caller, 'call:leave', { callId: call.id }),
  ]);
  assert.equal(joined.ok, true);
  assert.equal(left.ok, true);
  assert.equal(fixture.io.sockets.adapter.rooms.has(`call:${call.id}`), false);
  assert.equal(fixture.io.sockets.sockets.get(caller.id).data.acceptedCallId, null);
  assert.equal((await emit(callee, 'call:leave', { callId: call.id })).ok, true);
});
