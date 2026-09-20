const express = require("express");
const http = require("http");
const cors = require("cors");
const multer = require("multer");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");
const { google } = require("googleapis");

const PORT = process.env.PORT || 3000;
const WOPER_SECRET = process.env.WOPER_SECRET || "";
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || "";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",").map(x => x.trim()).filter(Boolean);

if (!WOPER_SECRET) {
  console.warn("WARNING: WOPER_SECRET is empty. Set it before public deployment.");
}

function corsOrigin(origin, cb) {
  if (!origin || ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) {
    return cb(null, true);
  }
  cb(new Error("Origin not allowed"));
}

const app = express();
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ["GET", "POST"] },
  maxHttpBufferSize: 2e6
});

const upload = multer({
  dest: path.join(os.tmpdir(), "woper-uploads"),
  limits: { fileSize: 600 * 1024 * 1024 }
});

function cleanRoom(room) {
  return String(room || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

function validSecret(secret) {
  return !!WOPER_SECRET && String(secret || "") === WOPER_SECRET;
}

const presence = new Map();

function roomPresence(room) {
  const p = presence.get(room) || { camera: new Set(), control: new Set() };
  presence.set(room, p);
  return p;
}

function emitPresence(room) {
  const p = roomPresence(room);
  io.to(room).emit("presence", {
    room,
    camera: p.camera.size > 0,
    control: p.control.size > 0
  });
}

io.use((socket, next) => {
  const { room, secret, role } = socket.handshake.auth || {};
  const safeRoom = cleanRoom(room);

  if (!safeRoom) return next(new Error("Sala inválida"));
  if (!validSecret(secret)) return next(new Error("Clave inválida"));
  if (!["camera", "control"].includes(role)) return next(new Error("Rol inválido"));

  socket.data.room = safeRoom;
  socket.data.role = role;
  next();
});

io.on("connection", socket => {
  const { room, role } = socket.data;
  socket.join(room);

  const p = roomPresence(room);
  p[role].add(socket.id);
  emitPresence(room);

  socket.on("relay", payload => {
    // Sender does not receive its own relay; the other phone does.
    socket.to(room).emit("relay", payload);
  });

  socket.on("disconnect", () => {
    const p2 = roomPresence(room);
    p2[role].delete(socket.id);
    emitPresence(room);
  });
});

function driveAuth() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_B64) {
    const raw = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_B64, "base64").toString("utf8");
    const credentials = JSON.parse(raw);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/drive"]
    });
  }

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/drive"]
    });
  }

  if (
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REFRESH_TOKEN
  ) {
    const oauth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    oauth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    return oauth;
  }

  throw new Error("Google Drive no configurado en el servidor");
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    relay: true,
    driveConfigured: !!DRIVE_FOLDER_ID && !!(
      process.env.GOOGLE_SERVICE_ACCOUNT_B64 ||
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
      process.env.GOOGLE_REFRESH_TOKEN
    )
  });
});

app.post("/upload/:room", upload.single("file"), async (req, res) => {
  const room = cleanRoom(req.params.room);
  const secret = req.get("X-Woper-Secret");

  if (!validSecret(secret)) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    return res.status(401).json({ ok: false, error: "Clave inválida" });
  }
  if (!room || !req.file) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ ok: false, error: "Archivo o sala inválida" });
  }
  if (!DRIVE_FOLDER_ID) {
    fs.unlink(req.file.path, () => {});
    return res.status(503).json({ ok: false, error: "DRIVE_FOLDER_ID no configurado" });
  }

  const safeName = path.basename(req.file.originalname || `woper-${Date.now()}.webm`);
  const finalName = `${room}_${safeName}`;

  try {
    const auth = driveAuth();
    const drive = google.drive({ version: "v3", auth });

    const result = await drive.files.create({
      requestBody: {
        name: finalName,
        parents: [DRIVE_FOLDER_ID]
      },
      media: {
        mimeType: req.file.mimetype || "video/webm",
        body: fs.createReadStream(req.file.path)
      },
      fields: "id,name,webViewLink"
    });

    res.json({
      ok: true,
      id: result.data.id,
      name: result.data.name,
      webViewLink: result.data.webViewLink || null
    });
  } catch (err) {
    console.error("Drive upload failed:", err?.response?.data || err);
    res.status(500).json({
      ok: false,
      error: err?.response?.data?.error?.message || err.message || "Drive upload failed"
    });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

server.listen(PORT, () => {
  console.log(`Woper relay listening on :${PORT}`);
});
