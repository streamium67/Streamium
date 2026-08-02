const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const connectDB = require("./lib/db");
const Admin = require("./models/Admin");

/* =========================================================
   ENV & CONFIG
   ========================================================= */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || "dev-jwt-secret-change-me";
const JWT_EXPIRY = "7d";
const COOKIE_NAME = "token";

if (!GOOGLE_CLIENT_ID) {
  console.error("GOOGLE_CLIENT_ID is not set — Google sign-in will fail.");
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const app = express();

/* =========================================================
   MIDDLEWARE
   ========================================================= */
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

/* =========================================================
   DEBUG ROUTE (as requested)
   ========================================================= */
app.get(["/test", "/api/test"], (req, res) => {
  res.status(200).json({
    success: true,
    message: "Streamium API is working",
    originalUrl: req.originalUrl,
    url: req.url,
    path: req.path,
    method: req.method,
    vercel: process.env.VERCEL || false,
    nodeEnv: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString()
  });
});

/**
 * URL Prefix Normalization Middleware.
 * Strips leading "/api" so routes match whether Vercel passes "/api/config" or "/config".
 */
app.use((req, res, next) => {
  if (req.url.startsWith("/api/")) {
    req.url = req.url.substring(4);
  } else if (req.url === "/api") {
    req.url = "/";
  }
  next();
});

/**
 * Lightweight Cookie Parser Middleware
 */
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(";").forEach((cookie) => {
      const [name, ...rest] = cookie.trim().split("=");
      if (name) {
        req.cookies[name.trim()] = decodeURIComponent(rest.join("="));
      }
    });
  }
  next();
});

/**
 * JWT Authentication Middleware
 */
app.use((req, res, next) => {
  req.user = null;
  const token = req.cookies[COOKIE_NAME];
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (_) {
      req.user = null;
    }
  }
  next();
});

/* =========================================================
   PUBLIC ROUTES (No DB required)
   ========================================================= */

// Healthcheck: GET /api or /
app.get(["/", "/api"], (req, res) => {
  res.json({ status: "ok", message: "Streamium API is running" });
});

// GET /api/config or /config — returns Google Client ID
app.get(["/config", "/api/config"], (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || "" });
});

/* =========================================================
   DATABASE MIDDLEWARE (for Auth & Admin routes)
   ========================================================= */
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("MongoDB connection error:", err.message);
    return res.status(500).json({ error: "Database connection failed." });
  }
});

/* =========================================================
   ADMIN SEEDING
   ========================================================= */
let seeded = false;

async function seedAdmins() {
  if (seeded) return;
  try {
    const initialAdmins = [
      { email: "streamium67@gmail.com", role: "Owner", name: "Streamium Owner" },
      { email: "rupayandas2024@gmail.com", role: "Website Manager", name: "Rupayan Das" },
      { email: "alok.studioasthy@gmail.com", role: "Finance Manager", name: "Alok" },
    ];
    for (const a of initialAdmins) {
      await Admin.findOneAndUpdate(
        { email: a.email.toLowerCase() },
        { $setOnInsert: { email: a.email.toLowerCase(), role: a.role, name: a.name } },
        { upsert: true, new: true }
      );
    }
    seeded = true;
  } catch (err) {
    console.error("Admin seeding error:", err.message);
  }
}

/* =========================================================
   AUTH COOKIE HELPERS
   ========================================================= */
function setAuthCookie(res, payload) {
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  const secure = process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${7 * 24 * 60 * 60}; SameSite=Lax${secure ? "; Secure" : ""}`
  );
}

function clearAuthCookie(res) {
  const secure = process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure ? "; Secure" : ""}`
  );
}

/* =========================================================
   AUTHENTICATION ROUTES
   ========================================================= */

// POST /api/auth/google or /auth/google
app.post(["/auth/google", "/api/auth/google"], async (req, res) => {
  try {
    await seedAdmins();

    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ error: "Missing credential token." });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    let isAdmin = false;
    let role = null;
    const adminDoc = await Admin.findOne({ email: email.toLowerCase() });

    if (adminDoc) {
      isAdmin = true;
      role = adminDoc.role;
      adminDoc.googleId = googleId;
      adminDoc.picture = picture;
      adminDoc.name = name;
      adminDoc.lastLogin = new Date();
      await adminDoc.save();
    }

    const user = { googleId, email, name, picture, isAdmin, role };
    setAuthCookie(res, user);
    return res.json({ success: true, user });
  } catch (err) {
    console.error("Google auth error:", err.message);
    return res.status(401).json({ error: "Invalid or expired Google token." });
  }
});

// GET /api/auth/me or /auth/me
app.get(["/auth/me", "/api/auth/me"], (req, res) => {
  if (req.user) {
    return res.json({ user: req.user });
  }
  return res.status(401).json({ error: "Not authenticated." });
});

// POST /api/auth/logout or /auth/logout
app.post(["/auth/logout", "/api/auth/logout"], (req, res) => {
  clearAuthCookie(res);
  return res.json({ success: true });
});

/* =========================================================
   ADMIN GUARD MIDDLEWARE
   ========================================================= */
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

function requireOwner(req, res, next) {
  if (!req.user || !req.user.isAdmin || req.user.role !== "Owner") {
    return res.status(403).json({ error: "Owner permission required." });
  }
  next();
}

// GET /api/admin/list or /admin/list
app.get(["/admin/list", "/api/admin/list"], requireAdmin, async (req, res) => {
  try {
    await seedAdmins();
    const admins = await Admin.find().select("-__v").sort({ createdAt: -1 });
    return res.json({ admins });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch admins." });
  }
});

// POST /api/admin/add or /admin/add
app.post(["/admin/add", "/api/admin/add"], requireOwner, async (req, res) => {
  try {
    const { email, role } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required." });

    const existing = await Admin.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ error: "Admin already exists." });

    const admin = await Admin.create({
      email: email.toLowerCase(),
      role: role || "Website Manager",
    });
    return res.status(201).json({ admin });
  } catch (err) {
    return res.status(500).json({ error: "Failed to add admin." });
  }
});

// DELETE /api/admin/remove/:email or /admin/remove/:email
app.delete(["/admin/remove/:email", "/api/admin/remove/:email"], requireOwner, async (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
    if (req.user && email === req.user.email.toLowerCase()) {
      return res.status(400).json({ error: "Cannot remove yourself." });
    }
    const result = await Admin.findOneAndDelete({ email });
    if (!result) return res.status(404).json({ error: "Admin not found." });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Failed to remove admin." });
  }
});

/* =========================================================
   EXPORT FOR VERCEL
   ========================================================= */
module.exports = app;
