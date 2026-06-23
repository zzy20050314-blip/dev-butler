const { v4: uuidv4 } = require('uuid');

// ── In-memory storage for Vercel serverless compatibility ──
// State persists within a warm function instance (minutes to hours)
// Resets on cold start — acceptable for a demo/shared chat tool

let sessions = new Map();
let messages = new Map();
let messageIdSeq = 0;

function init() {
  // no-op: in-memory store is always ready
  return { ready: true };
}

// ── Sessions ──

function createSession(userToken, expertId, title) {
  const id = uuidv4();
  const now = Date.now();
  const session = {
    id,
    user_token: userToken,
    expert_id: expertId,
    title: title || '新对话',
    created_at: now,
    updated_at: now,
  };
  sessions.set(id, session);
  return {
    id,
    expertId,
    title: title || '新对话',
    createdAt: now,
  };
}

function listSessions(userToken, limit = 50) {
  const result = [];
  for (const s of sessions.values()) {
    if (s.user_token === userToken) {
      result.push({
        id: s.id,
        expertId: s.expert_id,
        title: s.title,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
      });
    }
  }
  result.sort((a, b) => b.updatedAt - a.updatedAt);
  return result.slice(0, limit);
}

function getSession(id) {
  const s = sessions.get(id);
  if (!s) return null;
  return {
    id: s.id,
    userToken: s.user_token,
    expertId: s.expert_id,
    title: s.title,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

function updateSessionTitle(id, title) {
  const s = sessions.get(id);
  if (s) {
    s.title = title;
    s.updated_at = Date.now();
  }
}

function touchSession(id) {
  const s = sessions.get(id);
  if (s) s.updated_at = Date.now();
}

function deleteSession(id) {
  sessions.delete(id);
  // Also delete all messages for this session
  for (const [mid, msg] of messages) {
    if (msg.session_id === id) messages.delete(mid);
  }
}

// ── Messages ──

function addMessage(sessionId, role, content) {
  const now = Date.now();
  const id = ++messageIdSeq;
  const msg = {
    id,
    session_id: sessionId,
    role,
    content,
    created_at: now,
  };
  messages.set(id, msg);
  return {
    id,
    sessionId,
    role,
    content,
    createdAt: now,
  };
}

function getMessages(sessionId, limit = 100) {
  const result = [];
  for (const msg of messages.values()) {
    if (msg.session_id === sessionId) {
      result.push({
        id: msg.id,
        sessionId: msg.session_id,
        role: msg.role,
        content: msg.content,
        createdAt: msg.created_at,
      });
    }
  }
  result.sort((a, b) => a.createdAt - b.createdAt);
  return result.slice(0, limit);
}

function countMessages(sessionId) {
  let count = 0;
  for (const msg of messages.values()) {
    if (msg.session_id === sessionId) count++;
  }
  return count;
}

module.exports = {
  init,
  createSession,
  listSessions,
  getSession,
  updateSessionTitle,
  touchSession,
  deleteSession,
  addMessage,
  getMessages,
  countMessages,
};
