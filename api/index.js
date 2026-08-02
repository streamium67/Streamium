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
const JWT_EXPIRY = "7d"; // 7 days — matches the old session maxAge
const COOKIE_NAME = "token";

if (!GOOGLE_CLIENT_ID) {
  console.error("❌ GOOGLE_CLIENT_ID is not set — Google sign-in will fail.");
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const app = express();

/* =========================================================
   MIDDLEWARE
   ========================================================= */
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

/**
 * Cookie parser — lightweight, no external dependency needed.
 * Parses the Cookie header and populates req.cookies.
 */
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(";").forEach((cookie) => {
      const [name, ...rest] = cookie.trim().split("=");
      req.cookies[name.trim()] = decodeURIComponent(rest.join("="));
    });
  }
  next();
});

/**
 * JWT Auth Middleware — reads the JWT from the cookie,
 * verifies it, and populates req.user.
 * Does NOT reject unauthenticated requests (that's up to route guards).
 */
app.use((req, res, next) => {
  const token = req.cookies[COOKIE_NAME];
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
    } catch (err) {
      // Invalid/expired token — treat as unauthenticated
      req.user = null;
    }
  } else {
    req.user = null;
  }
  next();
});

/**
 * Connect to MongoDB on every request (uses cached connection).
 */
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("MongoDB connection error:", err.message);
    res.status(500).json({ error: "Database connection failed." });
  }
});

/* =========================================================
   ADMIN SEEDING (runs once per cold start)
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
    console.log("✅ Admin accounts verified & synced in MongoDB");
  } catch (err) {
    console.error("Admin seeding error:", err.message);
  }
}

/* =========================================================
   HELPER — set JWT cookie
   ========================================================= */
function setAuthCookie(res, payload) {
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  const isProduction = process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
  res.setHeader("Set-Cookie", [
    `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${7 * 24 * 60 * 60}; SameSite=Lax${isProduction ? "; Secure" : ""}`,
  ]);
}

function clearAuthCookie(res) {
  const isProduction = process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
  res.setHeader("Set-Cookie", [
    `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${isProduction ? "; Secure" : ""}`,
  ]);
}

/* =========================================================
   CONFIG ROUTE (exposes Google Client ID to frontend)
   ========================================================= */
app.get("/api/config", (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || "" });
});

/* =========================================================
   AUTH ROUTES
   ========================================================= */

/**
 * POST /api/auth/google
 * Body: { credential: "<Google ID token>" }
 *
 * Verifies the Google ID token, checks MongoDB for admin role,
 * signs a JWT, sets it as a cookie, and returns user info.
 */
app.post("/api/auth/google", async (req, res) => {
  try {
    // Seed admins on first auth request
    await seedAdmins();

    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ error: "Missing credential token." });
    }

    // Verify the Google ID token
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    const { sub: googleId, email, name, picture } = payload;

    // Check if this user is an admin in MongoDB
    let isAdmin = false;
    let role = null;
    const adminDoc = await Admin.findOne({ email: email.toLowerCase() });

    if (adminDoc) {
      isAdmin = true;
      role = adminDoc.role;
      // Update admin record with latest Google info
      adminDoc.googleId = googleId;
      adminDoc.picture = picture;
      adminDoc.name = name;
      adminDoc.lastLogin = new Date();
      await adminDoc.save();
    }

    // Build user object for JWT
    const user = {
      googleId,
      email,
      name,
      picture,
      isAdmin,
      role,
    };

    // Set JWT cookie
    setAuthCookie(res, user);

    res.json({
      success: true,
      user,
    });
  } catch (err) {
    console.error("Google auth error:", err.message);
    res.status(401).json({ error: "Invalid or expired Google token." });
  }
});

/**
 * GET /api/auth/me
 * Returns current user from JWT cookie, or 401 if not logged in.
 */
app.get("/api/auth/me", (req, res) => {
  if (req.user) {
    return res.json({ user: req.user });
  }
  res.status(401).json({ error: "Not authenticated." });
});

/**
 * POST /api/auth/logout
 * Clears the JWT cookie.
 */
app.post("/api/auth/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

/* =========================================================
   ADMIN ROUTES (protected)
   ========================================================= */

/** Middleware: require admin */
function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

/** Middleware: require Owner role */
function requireOwner(req, res, next) {
  if (!req.user?.isAdmin || req.user?.role !== "Owner") {
    return res.status(403).json({ error: "Owner permission required." });
  }
  next();
}

/**
 * GET /api/admin/list
 * Returns all admins from MongoDB.
 */
app.get("/api/admin/list", requireAdmin, async (req, res) => {
  try {
    await seedAdmins();
    const admins = await Admin.find().select("-__v").sort({ createdAt: -1 });
    res.json({ admins });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch admins." });
  }
});

/**
 * POST /api/admin/add
 * Body: { email, role? }
 * Adds a new admin to MongoDB.
 */
app.post("/api/admin/add", requireOwner, async (req, res) => {
  try {
    const { email, role } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required." });

    const existing = await Admin.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ error: "Admin already exists." });

    const admin = await Admin.create({
      email: email.toLowerCase(),
      role: role || "Website Manager",
    });
    res.status(201).json({ admin });
  } catch (err) {
    res.status(500).json({ error: "Failed to add admin." });
  }
});

/**
 * DELETE /api/admin/remove/:email
 * Removes an admin from MongoDB.
 */
app.delete("/api/admin/remove/:email", requireOwner, async (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
    // Prevent removing yourself
    if (email === req.user.email.toLowerCase()) {
      return res.status(400).json({ error: "Cannot remove yourself." });
    }
    const result = await Admin.findOneAndDelete({ email });
    if (!result) return res.status(404).json({ error: "Admin not found." });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to remove admin." });
  }
});

/* =========================================================
   EXPORT FOR VERCEL (no app.listen!)
   ========================================================= */
module.exports = app;
