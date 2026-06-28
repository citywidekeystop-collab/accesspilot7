require("dotenv").config();

const express = require("express");
const path = require("path");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");
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

let db;

async function connectDB() {
db = await mysql.createPool({
host: process.env.DB_HOST,
user: process.env.DB_USER,
password: process.env.DB_PASSWORD,
database: process.env.DB_NAME,
waitForConnections: true,
connectionLimit: 10
});
console.log("✅ Database connected");
}

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

app.get("/", (req, res) => {
res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/api/register", async (req, res) => {
const { name, email, password, role = "hoa_admin" } = req.body;
const hash = await bcrypt.hash(password, 10);

await db.query(
"INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)",
[name, email, hash, role]
);

res.json({ success: true });
});

app.post("/api/login", async (req, res) => {
const { email, password } = req.body;

const [rows] = await db.query("SELECT * FROM users WHERE email=?", [email]);
const user = rows[0];

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
});

app.get("/api/properties", auth, async (req, res) => {
const [rows] = await db.query("SELECT * FROM properties ORDER BY id DESC");
res.json(rows);
});

app.get("/api/residents", auth, async (req, res) => {
const [rows] = await db.query(`
SELECT residents.*, fobs.fob_id
FROM residents
LEFT JOIN fobs ON residents.id = fobs.resident_id
ORDER BY residents.id DESC
`);
res.json(rows);
});

app.post("/api/residents", auth, async (req, res) => {
const { property_id, name, unit, phone, email, fob_id } = req.body;

const [result] = await db.query(
"INSERT INTO residents (property_id,name,unit,phone,email) VALUES (?,?,?,?,?)",
[property_id, name, unit, phone, email]
);

if (fob_id) {
await db.query(
"INSERT INTO fobs (resident_id,fob_id,status) VALUES (?,?,?)",
[result.insertId, fob_id, "active"]
);
}

await addLog(property_id, result.insertId, fob_id, null, "resident_created", "success", `${name} added`);

res.json({ success: true, id: result.insertId });
});

app.put("/api/residents/:id", auth, async (req, res) => {
const { name, unit, phone, email, status } = req.body;

await db.query(
"UPDATE residents SET name=?, unit=?, phone=?, email=?, status=? WHERE id=?",
[name, unit, phone, email, status, req.params.id]
);

res.json({ success: true });
});

app.delete("/api/residents/:id", auth, async (req, res) => {
await db.query("DELETE FROM fobs WHERE resident_id=?", [req.params.id]);
await db.query("DELETE FROM residents WHERE id=?", [req.params.id]);
res.json({ success: true });
});

app.get("/api/fobs", auth, async (req, res) => {
const [rows] = await db.query(`
SELECT fobs.*, residents.name, residents.unit
FROM fobs
LEFT JOIN residents ON fobs.resident_id = residents.id
ORDER BY fobs.id DESC
`);
res.json(rows);
});

app.put("/api/fobs/:id/status", auth, async (req, res) => {
const { status } = req.body;

await db.query("UPDATE fobs SET status=? WHERE id=?", [status, req.params.id]);

io.emit("fob_status_changed", { id: req.params.id, status });

res.json({ success: true });
});

app.post("/api/door/unlock", auth, async (req, res) => {
const { property_id = 1, door_id = 1 } = req.body;

await addLog(property_id, null, null, door_id, "remote_unlock", "success", `Unlocked by ${req.user.email}`);

io.emit("door_unlocked", {
property_id,
door_id,
unlocked_by: req.user.email,
time: new Date()
});

res.json({ success: true, message: "Unlock command sent" });
});

app.post("/api/rfid/event", async (req, res) => {
const { property_id = 1, door_id = 1, fob_id } = req.body;

const [rows] = await db.query(
"SELECT fobs.*, residents.id AS resident_id FROM fobs LEFT JOIN residents ON fobs.resident_id=residents.id WHERE fobs.fob_id=?",
[fob_id]
);

const fob = rows[0];

if (!fob || fob.status !== "active") {
await addLog(property_id, null, fob_id, door_id, "rfid_scan", "denied", "Unknown or disabled fob");
io.emit("access_event", { result: "denied", fob_id });
return res.json({ access: "denied" });
}

await addLog(property_id, fob.resident_id, fob_id, door_id, "rfid_scan", "granted", "Access granted");
io.emit("access_event", { result: "granted", fob_id });

res.json({ access: "granted" });
});

app.get("/api/audit-logs", auth, async (req, res) => {
const [rows] = await db.query("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200");
res.json(rows);
});

async function addLog(property_id, resident_id, fob_id, door_id, action, result, notes) {
await db.query(
"INSERT INTO audit_logs (property_id,resident_id,fob_id,door_id,action,result,notes) VALUES (?,?,?,?,?,?,?)",
[property_id, resident_id, fob_id, door_id, action, result, notes]
);
}

io.on("connection", socket => {
console.log("🔌 Live dashboard connected");
});

connectDB()
.then(() => {
server.listen(PORT, () => {
console.log(`✅ AccessPilot running on port ${PORT}`);
});
})
.catch(err => {
console.error("❌ Database connection failed:", err.message);
server.listen(PORT, () => {
console.log(`⚠️ AccessPilot running without database on port ${PORT}`);
});
});
