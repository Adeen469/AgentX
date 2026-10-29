const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { WebSocketServer } = require("ws");
const { Pool } = require("pg");

const rootEnvPath = path.resolve(__dirname, "../../../.env.local");
if (fs.existsSync(rootEnvPath)) {
  for (const line of fs.readFileSync(rootEnvPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
  }
}

// Vercel's container runtime routes traffic to $PORT (default 80).
// Locally, COLLABORATION_PORT (default 8787) still wins when PORT is unset.
// PORT must win on Vercel, otherwise the container listens on a port Vercel
// never routes to and the service looks dead.
const port = Number(process.env.PORT || process.env.COLLABORATION_PORT || 8787);
const statePath = path.resolve(process.env.COLLABORATION_STATE_FILE || "data/collaboration-rooms.json");
const developmentMode = process.env.COLLABORATION_DEV_MODE === "true";
const authSecret = process.env.AUTH_SECRET;
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const clients = new Map();
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl && !databaseUrl.includes("******") ? new Pool({ connectionString: databaseUrl, max: 10 }) : null;
const metrics = { connections: 0, messages: 0, errors: 0, startedAt: new Date().toISOString() };
const connectionAttempts = new Map();

async function loadRooms() {
  if (pool) {
    const result = await pool.query("SELECT code, owner_id, state FROM collaboration_rooms");
    for (const row of result.rows) {
      const state = row.state || {};
      const ownerId = row.owner_id || state.ownerId;
      if (ownerId) {
        await ensureRoomOwner(ownerId, state.members?.find((member) => member.userId === ownerId)?.displayName || "Room owner");
      }
    }
    return Object.fromEntries(result.rows.map((row) => [row.code, row.state]));
  }
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {};
  }
}

let rooms = {};
let roomsLoaded = false;

async function saveRooms() {
  if (pool) {
    for (const room of Object.values(rooms)) {
      if (!room?.code || !room.ownerId) continue;
      await ensureRoomOwner(room.ownerId, room.members?.find((member) => member.userId === room.ownerId)?.displayName || "Room owner");
      await pool.query(
        "INSERT INTO collaboration_rooms (code, owner_id, state) VALUES ($1, $2, $3) ON CONFLICT (code) DO UPDATE SET owner_id = EXCLUDED.owner_id, state = EXCLUDED.state, updated_at = now()",
        [room.code, room.ownerId, JSON.stringify(room)]
      );
    }
    return;
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(rooms, null, 2), "utf8");
  fs.renameSync(temporaryPath, statePath);
}

function createRoomCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
  } while (rooms[code]);
  return code;
}

function send(socket, event) {
  if (socket.readyState === 1) socket.send(JSON.stringify(event));
}

function log(level, message, details = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, message, ...details }));
}

function error(socket, code, message) {
  send(socket, { type: "error", code, message });
}

function roomFor(code) {
  const room = rooms[code];
  if (!room) throw new Error("Room does not exist.");
  return room;
}

function memberFor(room, userId) {
  return room.members.find((member) => member.userId === userId);
}

function authenticateToken(token) {
  if (!authSecret) throw new Error("AUTH_SECRET is not configured.");
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) throw new Error("Invalid collaboration token.");
  const expected = crypto.createHmac("sha256", authSecret).update(payload).digest("base64url");
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new Error("Invalid collaboration token signature.");
  }
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!parsed.user?.id || !parsed.user?.name || parsed.exp <= Date.now()) throw new Error("Expired collaboration token.");
  return parsed.user;
}

function requireOwner(socket, room) {
  if (room.ownerId !== socket.userId) throw new Error("Only the room owner can perform this action.");
}

function requireApproved(socket, room) {
  const member = memberFor(room, socket.userId);
  if (!member || member.status !== "approved") throw new Error("Room owner approval is required.");
}

async function ensureUser(user) {
  if (!pool || !user?.id || !user?.name) return;
  const email = (user.email || `${String(user.id).replace(/[^A-Za-z0-9._-]/g, "-")}@agentx.local`).trim();
  const name = String(user.name || "AgentX User").trim() || "AgentX User";
  await pool.query(
    `INSERT INTO users (id, email, name, picture, provider)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name,
       picture = EXCLUDED.picture, provider = EXCLUDED.provider, updated_at = now()`,
    [user.id, email, name, user.picture || null, user.provider || "local"]
  );
}

async function ensureRoomOwner(userId, displayName) {
  if (!userId) return;
  await ensureUser({
    id: userId,
    name: displayName || "Room owner",
    email: `${String(userId).replace(/[^A-Za-z0-9._-]/g, "-")}@agentx.local`,
    provider: "local"
  });
}

function broadcast(code, event, approvedOnly = true) {
  for (const socket of clients.get(code) || []) {
    if (!approvedOnly || memberFor(rooms[code], socket.userId)?.status === "approved") send(socket, event);
  }
}

async function handle(socket, message) {
  metrics.messages += 1;
  if (!message || typeof message.type !== "string") throw new Error("Invalid collaboration message.");
  if (message.type === "auth") {
    const user = developmentMode && !authSecret
      ? { id: "development-user", name: "Development User" }
      : authenticateToken(message.token);
    socket.userId = user.id;
    socket.displayName = user.name;
    socket.authUser = user;
    socket.authenticated = true;
    await ensureUser(user);
    send(socket, { type: "authenticated", user: { id: user.id, name: user.name, email: user.email } });
    return;
  }
  if (!socket.authenticated) throw new Error("Authenticate the WebSocket before sending collaboration commands.");
  if (message.type === "room.create") {
    message.userId = socket.userId;
    message.displayName = socket.displayName;
    if (!message.userId || !message.displayName) throw new Error("A signed-in user is required.");
    await ensureUser(socket.authUser || { id: message.userId, name: message.displayName });
    const code = createRoomCode();
    rooms[code] = { code, ownerId: message.userId, members: [{ userId: message.userId, displayName: message.displayName, status: "approved" }] };
    socket.userId = message.userId;
    socket.displayName = message.displayName;
    socket.roomCode = code;
    if (!clients.has(code)) clients.set(code, new Set());
    clients.get(code).add(socket);
    await saveRooms();
    send(socket, { type: "room.created", room: rooms[code] });
    return;
  }

  const code = message.code;
  const room = roomFor(code);
  if (message.type === "room.join.request") {
    message.userId = socket.userId;
    message.displayName = socket.displayName;
    if (!message.userId || !message.displayName) throw new Error("A signed-in user is required.");
    const existing = memberFor(room, message.userId);
    // Reconnect, not a duplicate join: on Vercel a connection can close
    // when its function duration is reached or its instance is recycled,
    // and the new socket must re-attach to the room. Previously this
    // threw "You are already in this room", making reconnect impossible
    // for an approved member. No membership change, no re-approval.
    if (existing && existing.status === "approved") {
      socket.roomCode = code;
      if (!clients.has(code)) clients.set(code, new Set());
      clients.get(code).add(socket);
      send(socket, { type: "room.updated", room });
      return;
    }
    if (existing) existing.status = "pending";
    else room.members.push({ userId: message.userId, displayName: message.displayName, status: "pending" });
    socket.userId = message.userId;
    socket.displayName = message.displayName;
    socket.roomCode = code;
    if (!clients.has(code)) clients.set(code, new Set());
    clients.get(code).add(socket);
    await saveRooms();
    broadcast(code, { type: "room.join.requested", room, userId: message.userId }, false);
    return;
  }

  if (message.type === "room.join.approve") {
    requireOwner(socket, room);
    const member = memberFor(room, message.userId);
    if (!member || member.status !== "pending") throw new Error("No pending request exists for that user.");
    member.status = "approved";
    await saveRooms();
    broadcast(code, { type: "room.updated", room }, false);
    return;
  }

  if (message.type === "room.member.remove") {
    requireOwner(socket, room);
    if (message.userId === room.ownerId) throw new Error("The owner cannot remove themselves.");
    const member = memberFor(room, message.userId);
    if (!member) throw new Error("Member does not exist.");
    member.status = "removed";
    await saveRooms();
    broadcast(code, { type: "room.updated", room }, false);
    return;
  }

  if (message.type === "room.leave") {
    requireApproved(socket, room);
    if (socket.userId === room.ownerId) throw new Error("The owner must close the room instead of leaving it.");
    room.members = room.members.filter((member) => member.userId !== socket.userId);
    await saveRooms();
    socket.roomCode = undefined;
    broadcast(code, { type: "room.updated", room }, false);
    return;
  }

  if (message.type === "editor.change") {
    requireApproved(socket, room);
    if (!message.path || typeof message.content !== "string" || !Number.isInteger(message.revision)) {
      throw new Error("Invalid editor change.");
    }
    broadcast(code, { type: "editor.changed", code, path: message.path, content: message.content, revision: message.revision, by: socket.userId });
    return;
  }

  throw new Error("Unsupported collaboration message.");
}

const server = http.createServer((request, response) => {
  // Vercel routes this service at /collab, and the service receives the
  // original path (see docs/VERCEL.md), so /collab/health arrives here as
  // /collab/health, not /health. Strip that one public prefix for the
  // HTTP health/ready routes only. WebSocket upgrades are path-agnostic
  // in this server (no `path` option on WebSocketServer), so /collab
  // upgrades work without any stripping. Locally there is no prefix, so
  // plain /health and /ready keep working unchanged.
  const publicPath = request.url === "/collab" ? "/" : request.url.replace(/^\/collab\//, "/");
  if (publicPath === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, status: "healthy", rooms: Object.keys(rooms).length, metrics }));
    return;
  }
  if (publicPath === "/ready") {
    const ready = roomsLoaded;
    response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: ready, status: ready ? "ready" : "starting", persistence: pool ? "postgresql" : "file" }));
    return;
  }
  response.writeHead(404);
  response.end("Not found");
});

const websocket = new WebSocketServer({ server });
websocket.on("connection", (socket) => {
  metrics.connections += 1;
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });
  socket.on("error", (caught) => {
    metrics.errors += 1;
    log("error", "WebSocket error", { error: caught.message });
  });
  socket.on("message", async (raw) => {
    try {
      const now = Date.now();
      const attempts = connectionAttempts.get(socket) || [];
      const recent = attempts.filter((timestamp) => now - timestamp < 60000);
      recent.push(now);
      connectionAttempts.set(socket, recent);
      if (recent.length > 120) throw new Error("Rate limit exceeded. Try again shortly.");
      if (raw.length > 1024 * 1024) throw new Error("Collaboration message is too large.");
      await handle(socket, JSON.parse(raw.toString()));
    } catch (caught) {
      metrics.errors += 1;
      error(socket, "COLLABORATION_REQUEST_FAILED", caught instanceof Error ? caught.message : "Request failed.");
    }
  });
  socket.on("close", () => {
    metrics.connections -= 1;
    connectionAttempts.delete(socket);
    if (socket.roomCode) clients.get(socket.roomCode)?.delete(socket);
  });
});

const heartbeat = setInterval(() => {
  for (const socket of websocket.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30000);
heartbeat.unref();

async function start() {
  rooms = await loadRooms();
  roomsLoaded = true;
  server.listen(port, () => {
    log("info", "Collaboration server listening", { port, persistence: pool ? "postgresql" : "file" });
  });
}

start().catch((error) => {
  console.error("Unable to start collaboration server:", error);
  process.exitCode = 1;
});

async function shutdown(signal) {
  clearInterval(heartbeat);
  log("info", "Shutting down collaboration server", { signal });
  await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
}

process.once("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)));
