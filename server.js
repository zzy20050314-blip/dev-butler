require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const { experts, expertMap } = require('./experts');

const app = express();
const PORT = process.env.PORT || 3000;

// Init DB
db.init();

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── User token middleware ──
// Use a simple token from header or query, fallback to anonymous
function getUserToken(req) {
  return req.headers['x-user-token'] || req.query.token || 'anonymous';
}

// ── API Routes ──

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', experts: experts.length, timestamp: Date.now() });
});

// List all experts
app.get('/api/experts', (req, res) => {
  const summary = experts.map(e => ({
    id: e.id,
    num: e.num,
    name: e.name,
    nameShort: e.nameShort,
    role: e.role,
    emoji: e.emoji,
    tags: e.tags,
    dept: e.dept,
    deptColor: e.deptColor,
  }));
  res.json(summary);
});

// Get single expert
app.get('/api/experts/:id', (req, res) => {
  const expert = expertMap[req.params.id];
  if (!expert) return res.status(404).json({ error: 'Expert not found' });
  const { systemPrompt, ...info } = expert;
  res.json(info);
});

// ── Sessions ──

// List user's sessions
app.get('/api/sessions', (req, res) => {
  const token = getUserToken(req);
  const sessions = db.listSessions(token);
  // Enrich with expert info
  const enriched = sessions.map(s => ({
    ...s,
    expert: expertMap[s.expertId] ? {
      name: expertMap[s.expertId].nameShort,
      emoji: expertMap[s.expertId].emoji,
      deptColor: expertMap[s.expertId].deptColor,
    } : null,
  }));
  res.json(enriched);
});

// Create new session
app.post('/api/sessions', (req, res) => {
  const token = getUserToken(req);
  const { expertId, title } = req.body;

  if (!expertId || !expertMap[expertId]) {
    return res.status(400).json({ error: 'Invalid expertId' });
  }

  const session = db.createSession(token, expertId, title);
  res.status(201).json(session);
});

// Get session with messages
app.get('/api/sessions/:id', (req, res) => {
  const session = db.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const messages = db.getMessages(session.id);
  res.json({ ...session, messages });
});

// Delete session
app.delete('/api/sessions/:id', (req, res) => {
  const session = db.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  db.deleteSession(session.id);
  res.json({ success: true });
});

// ── Chat ──

// Send message and get AI response (streaming)
app.post('/api/chat', async (req, res) => {
  const token = getUserToken(req);
  const { sessionId, expertId, message } = req.body;

  // Validate
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  let session;
  if (sessionId) {
    session = db.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
  } else if (expertId && expertMap[expertId]) {
    // Auto-create session
    const title = message.substring(0, 30) + (message.length > 30 ? '...' : '');
    session = db.createSession(token, expertId, title);
  } else {
    return res.status(400).json({ error: 'sessionId or valid expertId required' });
  }

  const expert = expertMap[session.expertId];
  if (!expert) return res.status(400).json({ error: 'Expert not found' });

  // Validate API config — server-only key
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server API key not configured.' });
  }
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.deepseek.com';
  const model = process.env.OPENAI_MODEL || 'deepseek-chat';

  // Save user message
  db.addMessage(session.id, 'user', message.trim());
  db.touchSession(session.id);

  // Auto-update title on first message
  if (db.countMessages(session.id) <= 2) {
    db.updateSessionTitle(session.id, message.substring(0, 30) + (message.length > 30 ? '...' : ''));
  }

  // Build conversation context
  const history = db.getMessages(session.id);
  const messages = [
    { role: 'system', content: expert.systemPrompt },
  ];

  // Add last N messages as context (max 20 to avoid token limits)
  const recentHistory = history.slice(-20);
  for (const msg of recentHistory) {
    // Skip the last one (just added user message) - it will be added at the end
    if (msg.id === recentHistory[recentHistory.length - 1].id) continue;
    messages.push({ role: msg.role, content: msg.content });
  }
  // Add current user message
  messages.push({ role: 'user', content: message.trim() });

  // Call LLM API (streaming)
  const apiUrl = baseUrl.replace(/\/+$/, '') + '/chat/completions';

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: 0.7,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('LLM API error:', response.status, errorText);
      return res.status(502).json({ error: `LLM API error: ${response.status}`, detail: errorText.substring(0, 200) });
    }

    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Session-Id': session.id,
    });

    let fullResponse = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim() !== '');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              // Save full response
              if (fullResponse.trim()) {
                db.addMessage(session.id, 'assistant', fullResponse);
                db.touchSession(session.id);
              }
              res.write(`data: [DONE]\n\n`);
              continue;
            }

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content || '';
              if (content) {
                fullResponse += content;
                res.write(`data: ${JSON.stringify({ content, sessionId: session.id })}\n\n`);
              }
            } catch (e) {
              // skip malformed lines
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
      res.end();
    }

  } catch (error) {
    console.error('Chat error:', error);

    // If headers already sent (SSE started), we can't send JSON
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: 'Internal server error', detail: error.message });
    }
  }
});

// ── Non-streaming fallback for simpler clients ──
app.post('/api/chat/sync', async (req, res) => {
  const token = getUserToken(req);
  const { sessionId, expertId, message } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  let session;
  if (sessionId) {
    session = db.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
  } else if (expertId && expertMap[expertId]) {
    const title = message.substring(0, 30) + (message.length > 30 ? '...' : '');
    session = db.createSession(token, expertId, title);
  } else {
    return res.status(400).json({ error: 'sessionId or valid expertId required' });
  }

  const expert = expertMap[session.expertId];
  if (!expert) return res.status(400).json({ error: 'Expert not found' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server API key not configured' });
  }

  db.addMessage(session.id, 'user', message.trim());
  db.touchSession(session.id);

  if (db.countMessages(session.id) <= 2) {
    db.updateSessionTitle(session.id, message.substring(0, 30) + (message.length > 30 ? '...' : ''));
  }

  const history = db.getMessages(session.id);
  const messages = [
    { role: 'system', content: expert.systemPrompt },
  ];

  const recentHistory = history.slice(-20);
  for (const msg of recentHistory) {
    if (msg.id === recentHistory[recentHistory.length - 1].id) continue;
    messages.push({ role: msg.role, content: msg.content });
  }
  messages.push({ role: 'user', content: message.trim() });

  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.deepseek.com';
  const model = process.env.OPENAI_MODEL || 'deepseek-chat';
  const apiUrl = baseUrl.replace(/\/+$/, '') + '/chat/completions';

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 4096 }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(502).json({ error: `LLM API error: ${response.status}` });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || '';

    if (reply) {
      db.addMessage(session.id, 'assistant', reply);
      db.touchSession(session.id);
    }

    res.json({ sessionId: session.id, reply });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
});

// ── Serve frontend ──
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

app.listen(PORT, () => {
  console.log(`\n  🏢 你的专属开发管家 · Dev Butler`);
  console.log(`  ────────────────────────────────`);
  console.log(`  服务地址: http://localhost:${PORT}`);
  console.log(`  API 文档: http://localhost:${PORT}/api/health`);
  console.log(`  专家数量: ${experts.length} 位`);
  console.log(`  ────────────────────────────────\n`);

  if (!process.env.OPENAI_API_KEY) {
    console.log('  ⚠️  未配置 OPENAI_API_KEY，聊天功能暂不可用');
    console.log('  请在 .env 中设置 OPENAI_API_KEY\n');
  } else {
    console.log(`  ✅ API Key 已配置 (${process.env.OPENAI_MODEL || 'deepseek-chat'})\n`);
  }
});
