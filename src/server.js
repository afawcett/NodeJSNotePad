'use strict';

require('dotenv').config();

const path = require('path');
const os = require('os');
const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const sockjs = require('sockjs');
const { RedisStore } = require('connect-redis');
const { createClient: createRedisClient } = require('redis');
const swaggerUi = require('swagger-ui-express');

const { buildFrame, parseFrames } = require('./lib/stomp');

const REDIS_CHANNEL_NOTEPAD_UPDATES = 'notepad-updates';
const PORT = Number(process.env.PORT) || 8080;
const NODE_ENV = process.env.NODE_ENV || 'development';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL || process.env.SPRING_REDIS_URL;

/**
 * Managed DB URLs often include ?sslmode=require. Newer pg-connection-string treats that
 * like verify-full, which conflicts with relaxed TLS for non-prod (self-signed chain).
 * Drop URL SSL params so Pool `ssl` is the only TLS config.
 */
function pgConnectionString(rawUrl) {
  if (!rawUrl) return rawUrl;
  try {
    const u = new URL(rawUrl);
    for (const key of [
      'sslmode',
      'ssl',
      'sslcert',
      'sslkey',
      'sslrootcert',
      'sslcrl',
      'uselibpqcompat',
    ]) {
      u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

function pgSslConfig() {
  if (!DATABASE_URL) return false;
  if (process.env.PGSSLMODE === 'disable') return false;
  try {
    const u = new URL(DATABASE_URL);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return false;
  } catch {
    // ignore
  }
  // Remote managed Postgres (e.g. DigitalOcean) expects TLS. Provider CAs are often
  // not in Node's default trust store unless you set ssl.ca; this matches common DO setups.
  return { rejectUnauthorized: false };
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: pgConnectionString(DATABASE_URL),
      ssl: pgSslConfig(),
      max: 2,
    })
  : null;

let redisClient = null;
let redisSubscriber = null;

async function initRedis() {
  if (!REDIS_URL) return;
  const useTls = REDIS_URL.startsWith('rediss://');
  const socket = useTls ? { tls: true, rejectUnauthorized: false } : undefined;
  redisClient = createRedisClient({ url: REDIS_URL, ...(socket ? { socket } : {}) });
  await redisClient.connect();
  redisSubscriber = redisClient.duplicate();
  await redisSubscriber.connect();
}

function mapNoteRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    color: row.color,
    positionX: row.position_x,
    positionY: row.position_y,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function formatErrorBody(status, message, reqPath) {
  const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  return {
    timestamp: ts,
    status,
    error: status === 404 ? 'Not Found' : 'Bad Request',
    message,
    path: reqPath,
  };
}

/** Match JPA Integer columns — client may send floats from drag math. */
function toIntOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function wrapAsync(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** @type {Set<{ write: (s: string) => void, subscriptions: Map<string, string> }>} */
const stompConnections = new Set();
let messageIdSeq = 1;

function broadcastStompMessage(payloadObj) {
  const body = JSON.stringify(payloadObj);
  for (const conn of stompConnections) {
    const subId = conn.subscriptions.get('/topic/notes');
    if (!subId || !conn.write) continue;
    const msg = buildFrame(
      'MESSAGE',
      {
        subscription: subId,
        'message-id': `msg-${messageIdSeq++}`,
        destination: '/topic/notes',
        'content-type': 'application/json',
      },
      body,
    );
    conn.write(msg);
  }
}

async function publishNoteEvent(action, note) {
  const hostname = os.hostname();
  const message = { action, payload: note, processedByHost: hostname };
  if (redisClient && redisClient.isReady) {
    await redisClient.publish(REDIS_CHANNEL_NOTEPAD_UPDATES, JSON.stringify(message));
    return;
  }
  broadcastStompMessage(message);
}

async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      content TEXT,
      color VARCHAR(255),
      position_x INTEGER,
      position_y INTEGER,
      created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

const openApiSpec = {
  openapi: '3.0.1',
  info: {
    title: 'twelvefactor-notepad',
    version: '0.0.1-SNAPSHOT',
    description: 'A simple note-taking application demonstrating 12-Factor App principles (Node.js port).',
    license: { name: 'Apache 2.0', url: 'http://springdoc.org' },
  },
  paths: {
    '/api/v1/notes': {
      get: { summary: 'Get all notes', responses: { 200: { description: 'OK' } } },
      post: { summary: 'Create a new note', responses: { 201: { description: 'Created' } } },
    },
    '/api/v1/notes/{id}': {
      get: { summary: 'Get a note by ID', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] },
      put: { summary: 'Update an existing note', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] },
      delete: { summary: 'Delete a note by ID', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] },
    },
  },
};

function createStompSockJSServer() {
  const sj = sockjs.createServer();

  sj.on('connection', (conn) => {
    const stompConn = {
      write: (s) => conn.write(s),
      subscriptions: new Map(),
    };
    let buffer = '';

    conn.on('data', (data) => {
      buffer += data;
      const { frames, rest } = parseFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        handleStompFrame(stompConn, frame);
      }
    });

    conn.on('close', () => {
      stompConnections.delete(stompConn);
    });
  });

  return sj;
}

function handleStompFrame(conn, frame) {
  const { command, headers, body } = frame;
  if (command === 'CONNECT') {
    const out = buildFrame('CONNECTED', { version: '1.1', 'heart-beat': '0,0' });
    conn.write(out);
    return;
  }
  if (command === 'SUBSCRIBE') {
    const dest = headers.destination;
    const subId = headers.id;
    if (dest && subId) {
      conn.subscriptions.set(dest, subId);
      stompConnections.add(conn);
    }
    return;
  }
  if (command === 'UNSUBSCRIBE') {
    const subId = headers.id;
    for (const [d, sid] of conn.subscriptions.entries()) {
      if (sid === subId) conn.subscriptions.delete(d);
    }
    return;
  }
  if (command === 'DISCONNECT') {
    stompConnections.delete(conn);
    return;
  }
}

async function main() {
  if (!pool) {
    console.error('DATABASE_URL is required (Postgres).');
    process.exit(1);
  }

  await ensureSchema();
  await initRedis();

  if (redisSubscriber && redisSubscriber.isReady) {
    await redisSubscriber.subscribe(REDIS_CHANNEL_NOTEPAD_UPDATES, (message) => {
      try {
        const parsed = JSON.parse(String(message));
        broadcastStompMessage(parsed);
      } catch (e) {
        console.error('Invalid Redis pub/sub message', e);
      }
    });
  }

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());

  const sessionSecret = process.env.SESSION_SECRET || 'dev-session-secret-change-me';
  const sessionMiddleware = session({
    store:
      redisClient && redisClient.isReady
        ? new RedisStore({ client: redisClient, prefix: 'spring:session:' })
        : undefined,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: true,
    name: 'SESSION',
    cookie: { maxAge: 30 * 60 * 1000, httpOnly: true, secure: NODE_ENV === 'production' },
  });
  app.use(sessionMiddleware);

  app.get('/actuator/health', (req, res) => {
    res.json({ status: 'UP' });
  });

  app.get('/actuator/info', (req, res) => {
    res.json({
      app: {
        name: '12-Factor Notepad Application',
        description: 'A Node.js application demonstrating 12-Factor principles.',
        version: '0.0.1-SNAPSHOT',
      },
    });
  });

  app.use('/v3/api-docs', (req, res) => res.json(openApiSpec));
  app.use('/swagger-ui', swaggerUi.serve, swaggerUi.setup(openApiSpec));

  app.get('/api/session/test', (req, res) => {
    const key = 'sessionCounter';
    let counter = req.session[key];
    if (counter == null) counter = 0;
    counter += 1;
    req.session[key] = counter;
    const hostname = os.hostname();
    res.type('text/plain').send(`Counter: ${counter}, Session ID: ${req.sessionID}, Processed by Host: ${hostname}`);
  });

  app.get(
    '/api/v1/notes',
    wrapAsync(async (req, res) => {
      const r = await pool.query(
        'SELECT id, title, content, color, position_x, position_y, created_at, updated_at FROM notes ORDER BY id ASC',
      );
      res.json(r.rows.map(mapNoteRow));
    }),
  );

  app.get(
    '/api/v1/notes/:id',
    wrapAsync(async (req, res) => {
      const id = Number(req.params.id);
      const r = await pool.query(
        'SELECT id, title, content, color, position_x, position_y, created_at, updated_at FROM notes WHERE id = $1',
        [id],
      );
      if (r.rows.length === 0) {
        return res.status(404).json(formatErrorBody(404, `Note not found with id: ${id}`, req.path));
      }
      res.json(mapNoteRow(r.rows[0]));
    }),
  );

  app.post(
    '/api/v1/notes',
    wrapAsync(async (req, res) => {
      const { title, content, color, positionX, positionY } = req.body || {};
      if (title == null || String(title).trim() === '') {
        return res.status(400).json(formatErrorBody(400, 'Title is required', req.path));
      }
      const r = await pool.query(
        `INSERT INTO notes (title, content, color, position_x, position_y, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING id, title, content, color, position_x, position_y, created_at, updated_at`,
        [title, content ?? '', color ?? null, toIntOrNull(positionX), toIntOrNull(positionY)],
      );
      const note = mapNoteRow(r.rows[0]);
      await publishNoteEvent('CREATE', note);
      res.status(201).json(note);
    }),
  );

  app.put(
    '/api/v1/notes/:id',
    wrapAsync(async (req, res) => {
      const id = Number(req.params.id);
      const existing = await pool.query('SELECT * FROM notes WHERE id = $1', [id]);
      if (existing.rows.length === 0) {
        return res.status(404).json(formatErrorBody(404, `Note not found with id: ${id}`, req.path));
      }
      const cur = existing.rows[0];
      const body = req.body || {};
      const title = body.title != null ? body.title : cur.title;
      const content = body.content != null ? body.content : cur.content;
      const color = body.color !== undefined ? body.color : cur.color;
      const positionX = body.positionX !== undefined ? toIntOrNull(body.positionX) : cur.position_x;
      const positionY = body.positionY !== undefined ? toIntOrNull(body.positionY) : cur.position_y;
      const r = await pool.query(
        `UPDATE notes SET title = $1, content = $2, color = $3, position_x = $4, position_y = $5, updated_at = CURRENT_TIMESTAMP
         WHERE id = $6
         RETURNING id, title, content, color, position_x, position_y, created_at, updated_at`,
        [title, content, color, positionX, positionY, id],
      );
      const note = mapNoteRow(r.rows[0]);
      await publishNoteEvent('UPDATE', note);
      res.json(note);
    }),
  );

  app.delete(
    '/api/v1/notes/:id',
    wrapAsync(async (req, res) => {
      const id = Number(req.params.id);
      const existing = await pool.query('SELECT * FROM notes WHERE id = $1', [id]);
      if (existing.rows.length === 0) {
        return res.status(404).json(formatErrorBody(404, `Note not found with id: ${id}`, req.path));
      }
      const note = mapNoteRow(existing.rows[0]);
      await pool.query('DELETE FROM notes WHERE id = $1', [id]);
      await publishNoteEvent('DELETE', note);
      res.status(204).send();
    }),
  );

  app.use(express.static(path.join(__dirname, 'public')));

  app.use((err, req, res, next) => {
    console.error(err);
    const status = Number(err.status) || 500;
    const message = err.message || 'Internal Server Error';
    res.status(status).json({
      timestamp: new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
      status,
      error: status === 500 ? 'Internal Server Error' : 'Error',
      message,
      path: req.path,
    });
  });

  const server = app.listen(PORT, () => {
    console.log(`Listening on ${PORT} (NODE_ENV=${NODE_ENV})`);
  });

  const stompServer = createStompSockJSServer();
  stompServer.installHandlers(server, { prefix: '/ws-notepad' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
