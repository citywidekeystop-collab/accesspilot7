require("dotenv").config();

const express = require("express");
const path = require("path");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || "change_this_secret";

const db = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: { rejectUnauthorized: false }
});

function auth(req, res, next) {
const token = req.headers.authorization?.split(" ")[1];
if (!token) return res.status(401).json({ error: "No token" });

try {
req.user = jwt.verify(token, JWT_SECRET);
next();
} catch {
res.status(401).json({ error: "Invalid token" });
}
}

async function initDB() {
await db.query(`
CREATE TABLE IF NOT EXISTS users (
id SERIAL PRIMARY KEY,
name VARCHAR(100) NOT NULL,
email VARCHAR(150) NOT NULL UNIQUE,
password_hash VARCHAR(255) NOT NULL,
role VARCHAR(50) DEFAULT 'hoa_admin',
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS properties (
id SERIAL PRIMARY KEY,
name VARCHAR(150) NOT NULL,
address VARCHAR(255) NOT NULL,
city VARCHAR(100),
state VARCHAR(50),
zip VARCHAR(20),
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS residents (
id SERIAL PRIMARY KEY,
property_id INTEGER NOT NULL,
name VARCHAR(120) NOT NULL,
unit VARCHAR(50) NOT NULL,
phone VARCHAR(40),
email VARCHAR(150),
status VARCHAR(30) DEFAULT 'active',
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fobs (
id SERIAL PRIMARY KEY,
resident_id INTEGER NOT NULL,
fob_id VARCHAR(100) NOT NULL UNIQUE,
status VARCHAR(30) DEFAULT 'active',
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS doors (
id SERIAL PRIMARY KEY,
property_id INTEGER NOT NULL,
name VARCHAR(120) NOT NULL,
status VARCHAR(30) DEFAULT 'online',
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
id SERIAL PRIMARY KEY,
property_id INTEGER,
resident_id INTEGER,
fob_id VARCHAR(100),
door_id INTEGER,
action VARCHAR(100) NOT NULL,
result VARCHAR(50) NOT NULL,
notes TEXT,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`);

await db.query(`
INSERT INTO properties (id, name, address, city, state, zip)
VALUES (1, 'Carls Court HOA', '8925 Carls Court', 'Ellicott City', 'MD', '21043')
ON CONFLICT (id) DO NOTHING;
`);

await db.query(`
INSERT INTO doors (id, property_id, name, status)
VALUES (1, 1, 'Clubhouse Entrance', 'online')
ON CONFLICT (id) DO NOTHING;
`);

console.log("✅ PostgreSQL tables ready");
}

app.get("/", (req, res) => {
res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/health", async (req, res) => {
try {
const result = await db.query("SELECT NOW()");
res.json({ ok: true, database: true, time: result.rows[0].now });
} catch (err) {
res.status(500).json({ ok: false, database: false, error: err.message });
}
});

app.post("/api/register", async (req, res) => {
try {
const { name, email, password, role = "hoa_admin" } = req.body;

if (!name || !email || !password) {
return res.status(400).json({ error: "Name, email, and password required" });
}

const hash = await bcrypt.hash(password, 10);

const result = await db.query(
"INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id,name,email,role",
[name, email, hash, role]
);

res.json({ success: true, user: result.rows[0] });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.post("/api/login", async (req, res) => {
try {
const { email, password } = req.body;

const result = await db.query("SELECT * FROM users WHERE email=$1", [email]);
const user = result.rows[0];

if (!user) return res.status(401).json({ error: "Invalid login" });

const ok = await bcrypt.compare(password, user.password_hash);
if (!ok) return res.status(401).json({ error: "Invalid login" });

const token = jwt.sign(
{ id: user.id, email: user.email, role: user.role },
JWT_SECRET,
{ expiresIn: "12h" }
);

res.json({
token,
user: {
id: user.id,
name: user.name,
email: user.email,
role: user.role
}
});
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get("/api/properties", auth, async (req, res) => {
const result = await db.query("SELECT * FROM properties ORDER BY id DESC");
res.json(result.rows);
});

app.get("/api/residents", auth, async (req, res) => {
const result = await db.query(`
SELECT residents.*, fobs.id AS fob_db_id, fobs.fob_id
FROM residents
LEFT JOIN fobs ON residents.id = fobs.resident_id
ORDER BY residents.id DESC
`);

res.json(result.rows);
});

app.post("/api/residents", auth, async (req, res) => {
try {
const { property_id = 1, name, unit, phone, email, fob_id } = req.body;

const result = await db.query(
"INSERT INTO residents (property_id,name,unit,phone,email,status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
[property_id, name, unit, phone || "", email || "", "active"]
);

const residentId = result.rows[0].id;

if (fob_id) {
await db.query(
"INSERT INTO fobs (resident_id,fob_id,status) VALUES ($1,$2,$3)",
[residentId, fob_id, "active"]
);
}

await addLog(property_id, residentId, fob_id, null, "resident_created", "success", `${name} added`);

io.emit("resident_created", { id: residentId, name });

res.json({ success: true, id: residentId });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.put("/api/residents/:id", auth, async (req, res) => {
try {
const { name, unit, phone, email, status } = req.body;

await db.query(
"UPDATE residents SET name=$1, unit=$2, phone=$3, email=$4, status=$5 WHERE id=$6",
[name, unit, phone || "", email || "", status || "active", req.params.id]
);

res.json({ success: true });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.delete("/api/residents/:id", auth, async (req, res) => {
try {
await db.query("DELETE FROM fobs WHERE resident_id=$1", [req.params.id]);
await db.query("DELETE FROM residents WHERE id=$1", [req.params.id]);
res.json({ success: true });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get("/api/fobs", auth, async (req, res) => {
const result = await db.query(`
SELECT fobs.*, residents.name, residents.unit
FROM fobs
LEFT JOIN residents ON fobs.resident_id = residents.id
ORDER BY fobs.id DESC
`);

res.json(result.rows);
});

app.put("/api/fobs/:id/status", auth, async (req, res) => {
try {
const { status } = req.body;

await db.query("UPDATE fobs SET status=$1 WHERE id=$2", [status, req.params.id]);

io.emit("fob_status_changed", { id: req.params.id, status });

res.json({ success: true });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.post("/api/door/unlock", auth, async (req, res) => {
try {
const { property_id = 1, door_id = 1 } = req.body;

await addLog(
property_id,
null,
null,
door_id,
"remote_unlock",
"success",
`Unlocked by ${req.user.email}`
);

io.emit("door_unlocked", {
property_id,
door_id,
unlocked_by: req.user.email,
time: new Date()
});

res.json({ success: true, message: "Unlock command sent" });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.post("/api/rfid/event", async (req, res) => {
try {
const { property_id = 1, door_id = 1, fob_id } = req.body;

const result = await db.query(
`SELECT fobs.*, residents.id AS resident_id
FROM fobs
LEFT JOIN residents ON fobs.resident_id = residents.id
WHERE fobs.fob_id=$1`,
[fob_id]
);

const fob = result.rows[0];

if (!fob || fob.status !== "active") {
await addLog(property_id, null, fob_id, door_id, "rfid_scan", "denied", "Unknown or disabled fob");
io.emit("access_event", { result: "denied", fob_id });
return res.json({ access: "denied" });
}

await addLog(property_id, fob.resident_id, fob_id, door_id, "rfid_scan", "granted", "Access granted");
io.emit("access_event", { result: "granted", fob_id });

res.json({ access: "granted" });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get("/api/audit-logs", auth, async (req, res) => {
const result = await db.query("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200");
res.json(result.rows);
});

async function addLog(property_id, resident_id, fob_id, door_id, action, result, notes) {
await db.query(
"INSERT INTO audit_logs (property_id,resident_id,fob_id,door_id,action,result,notes) VALUES ($1,$2,$3,$4,$5,$6,$7)",
[property_id, resident_id, fob_id, door_id, action, result, notes]
);
}

io.on("connection", socket => {
console.log("🔌 Live dashboard connected");
});

initDB()
.then(() => {
server.listen(PORT, () => {
console.log(`✅ AccessPilot running on port ${PORT}`);
});
})
.catch(err => {
console.error("❌ PostgreSQL startup failed:", err.message);
server.listen(PORT, () => {
console.log(`⚠️ AccessPilot running without database on port ${PORT}`);
});
});
