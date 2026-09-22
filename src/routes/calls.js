import { createHmac, randomUUID } from 'node:crypto';
import { Router } from 'express';
import Joi from 'joi';
import { AppError } from '../lib/errors.js';
import { transaction } from '../db/transaction.js';

const idSchema = Joi.string().guid({ version: ['uuidv4'] }).required();
const createSchema = Joi.object({
  conversationId: idSchema.optional(),
  bookingId: idSchema.optional(),
  mode: Joi.string().valid('audio', 'video').default('video'),
}).xor('conversationId', 'bookingId').required();

function parse(schema, input) {
  const result = schema.validate(input, { abortEarly: true, convert: false });
  if (result.error) throw new AppError(400, 'VALIDATION_ERROR', result.error.details[0].message);
  if (typeof result.value === 'string') return result.value.toLowerCase();
  for (const key of ['conversationId', 'bookingId']) {
    if (result.value[key]) result.value[key] = result.value[key].toLowerCase();
  }
  return result.value;
}

function publicCall(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    bookingId: row.booking_id,
    createdBy: row.created_by,
    mode: row.mode,
    createdAt: row.created_at,
    endedAt: row.ended_at,
  };
}

async function assertBookingAccess(db, bookingId, userId, requireActive, lock = false) {
  const { rows: [booking] } = await db.query(`
    SELECT b.id, b.client_id, b.counsellor_id, b.status, s.starts_at, s.ends_at,
           (CURRENT_TIMESTAMP >= s.starts_at - INTERVAL '15 minutes'
             AND CURRENT_TIMESTAMP < s.ends_at) AS in_call_window
    FROM bookings b JOIN availability_slots s ON s.id = b.slot_id
    WHERE b.id = $1 ${lock ? 'FOR UPDATE OF b' : ''}
  `, [bookingId]);
  if (!booking || ![booking.client_id, booking.counsellor_id].includes(userId)) {
    throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  }
  if (requireActive && (booking.status !== 'confirmed' || !booking.in_call_window)) {
    throw new AppError(409, 'BOOKING_CALL_UNAVAILABLE', 'Booking calls are available from 15 minutes before a confirmed session until its end.');
  }
  return booking;
}

async function assertConversationAccess(db, conversationId, userId) {
  const { rows: [conversation] } = await db.query(`
    SELECT c.id, c.kind FROM conversations c
    JOIN conversation_members m ON m.conversation_id = c.id
    WHERE c.id = $1 AND m.user_id = $2
  `, [conversationId, userId]);
  if (!conversation) throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
  return conversation;
}

/** Invitations are only valid for the two members of an existing direct chat. */
export async function assertDirectCallAccess(db, conversationId, userId, targetUserId) {
  const conversation = await assertConversationAccess(db, conversationId, userId);
  if (conversation.kind !== 'direct') {
    throw new AppError(400, 'DIRECT_CALL_REQUIRED', 'Start individual calls from a direct conversation.');
  }
  const { rows: members } = await db.query(`
    SELECT u.id, u.full_name FROM conversation_members m
    JOIN users u ON u.id = m.user_id WHERE m.conversation_id = $1
  `, [conversationId]);
  const target = members.find((member) => member.id === targetUserId);
  if (!target || targetUserId === userId || members.length !== 2) {
    throw new AppError(400, 'INVALID_TARGET', 'Call the other member of this conversation.');
  }
  return target;
}

/** Called only after a pending invitation has been accepted by its recipient. */
export async function createAcceptedDirectCall(pool, invitation) {
  return transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`call:conversation_id:${invitation.conversationId}`]);
    await assertDirectCallAccess(db, invitation.conversationId, invitation.fromUserId, invitation.targetUserId);
    const { rows: [existing] } = await db.query(
      'SELECT * FROM call_rooms WHERE conversation_id = $1 AND ended_at IS NULL',
      [invitation.conversationId],
    );
    // Both members have passed realtime busy checks. An unused REST-created room
    // can be reused, but its media mode must match the accepted invitation.
    if (existing) {
      const { rows: [call] } = await db.query('UPDATE call_rooms SET mode = $2 WHERE id = $1 RETURNING *', [existing.id, invitation.type]);
      return call;
    }
    const { rows: [call] } = await db.query(`
      INSERT INTO call_rooms (id, conversation_id, created_by, mode)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [randomUUID(), invitation.conversationId, invitation.fromUserId, invitation.type]);
    return call;
  });
}

/** Shared REST/signaling authorization. Always rechecks persisted membership/status. */
export async function getAuthorizedCall(pool, callId, userId, { requireActive = true } = {}) {
  const { rows: [call] } = await pool.query('SELECT * FROM call_rooms WHERE id = $1', [callId]);
  if (!call) throw new AppError(404, 'CALL_NOT_FOUND', 'Call not found.');
  if (call.conversation_id) {
    const conversation = await assertConversationAccess(pool, call.conversation_id, userId);
    call.conversation_kind = conversation.kind;
  } else {
    await assertBookingAccess(pool, call.booking_id, userId, requireActive);
  }
  if (requireActive && call.ended_at) throw new AppError(409, 'CALL_ENDED', 'This call has ended.');
  return call;
}

/** Call after a committed end/cancellation so clients release their media connections. */
export async function closeCallRoom(io, callId, reason = 'ended') {
  const room = `call:${callId}`;
  // Include accepted participants that have not finished navigating/joining yet,
  // and notify their other tabs so no call prompt survives an ended room.
  const sockets = [...io.sockets.sockets.values()].filter((socket) =>
    socket.data.callId === callId || socket.data.acceptedCallId === callId,
  );
  const rooms = [room, ...sockets.map((socket) => `user:${socket.data.userId}`)];
  io.to(rooms).emit('call:ended', { callId, reason });
  for (const socket of sockets) {
    if (socket.data.callId === callId) socket.data.callId = null;
    if (socket.data.acceptedCallId === callId) socket.data.acceptedCallId = null;
    await socket.leave(room);
  }
}

export function callRoutes({ pool, io, config }) {
  const router = Router();

  router.get('/ice', (req, res) => {
    const iceServers = [];
    if (config.stunUrls.length) iceServers.push({ urls: config.stunUrls });
    let expiresAt = null;
    if (config.turnUrls.length && config.turnSecret) {
      const expires = Math.floor(Date.now() / 1000) + 3600;
      const username = `${expires}:${req.user.id}`;
      const credential = createHmac('sha1', config.turnSecret).update(username).digest('base64');
      iceServers.push({ urls: config.turnUrls, username, credential });
      expiresAt = new Date(expires * 1000).toISOString();
    }
    res.set('Cache-Control', 'no-store').json({ iceServers, expiresAt });
  });

  router.post('/', async (req, res) => {
    const input = parse(createSchema, req.body);
    const result = await transaction(pool, async (db) => {
      const scope = input.conversationId ? 'conversation_id' : 'booking_id';
      const targetId = input.conversationId || input.bookingId;
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`call:${scope}:${targetId}`]);
      if (input.conversationId) await assertConversationAccess(db, targetId, req.user.id);
      else await assertBookingAccess(db, targetId, req.user.id, true, true);
      const existing = await db.query(`SELECT * FROM call_rooms WHERE ${scope} = $1 AND ended_at IS NULL`, [targetId]);
      if (existing.rows[0]) return { call: existing.rows[0], created: false };
      const { rows: [call] } = await db.query(`
        INSERT INTO call_rooms (id, conversation_id, booking_id, created_by, mode)
        VALUES ($1, $2, $3, $4, $5) RETURNING *
      `, [randomUUID(), input.conversationId || null, input.bookingId || null, req.user.id, input.mode]);
      return { call, created: true };
    });
    if (result.created) {
      const { rows: recipients } = result.call.conversation_id
        ? await pool.query('SELECT user_id FROM conversation_members WHERE conversation_id = $1', [result.call.conversation_id])
        : await pool.query('SELECT client_id AS user_id FROM bookings WHERE id = $1 UNION SELECT counsellor_id AS user_id FROM bookings WHERE id = $1', [result.call.booking_id]);
      for (const recipient of recipients) {
        if (recipient.user_id !== req.user.id) io.to(`user:${recipient.user_id}`).emit('call:invited', { callId: result.call.id, call: publicCall(result.call) });
      }
    }
    res.status(result.created ? 201 : 200).json({ call: publicCall(result.call) });
  });

  router.get('/:id', async (req, res) => {
    const callId = parse(idSchema, req.params.id);
    const call = await getAuthorizedCall(pool, callId, req.user.id, { requireActive: false });
    res.json({ call: publicCall(call) });
  });

  router.post('/:id/end', async (req, res) => {
    const callId = parse(idSchema, req.params.id);
    const call = await getAuthorizedCall(pool, callId, req.user.id, { requireActive: false });
    if (call.conversation_kind === 'group' && call.created_by !== req.user.id) {
      throw new AppError(403, 'CALL_END_FORBIDDEN', 'Only the call creator can end a group call. Other participants can leave.');
    }
    const { rows: [ended] } = await pool.query('UPDATE call_rooms SET ended_at = COALESCE(ended_at, NOW()) WHERE id = $1 RETURNING *', [callId]);
    await closeCallRoom(io, callId);
    res.json({ call: publicCall(ended) });
  });

  return router;
}
