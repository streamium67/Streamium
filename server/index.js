require("dotenv").config();
const express = require("express");
const session = require("express-session");
const cors = require("cors");
const path = require("path");
const mongoose = require("mongoose");
const { OAuth2Client } = require("google-auth-library");
const Admin = require("./models/Admin");

/* =========================================================
   ENV & CONFIG
   ========================================================= */
const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/streamium";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-change-me";

if (!GOOGLE_CLIENT_ID) {
  console.error("❌  GOOGLE_CLIENT_ID is not set in .env — Google sign-in will fail.");
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const app = express();

/* =========================================================
   MIDDLEWARE
   ========================================================= */
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false, // set true in production with HTTPS
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

// Serve the static HTML/CSS/JS files from project root
app.use(express.static(path.join(__dirname, "..")));

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
 * starts a session, and returns user info.
 */
app.post("/api/auth/google", async (req, res) => {
  try {
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

    // Store user in session
    req.session.user = {
      googleId,
      email,
      name,
      picture,
      isAdmin,
      role,
    };

    res.json({
      success: true,
      user: req.session.user,
    });
  } catch (err) {
    console.error("Google auth error:", err.message);
    res.status(401).json({ error: "Invalid or expired Google token." });
  }
});

/**
 * GET /api/auth/me
 * Returns current session user, or 401 if not logged in.
 */
app.get("/api/auth/me", (req, res) => {
  if (req.session.user) {
    return res.json({ user: req.session.user });
  }
  res.status(401).json({ error: "Not authenticated." });
});

/**
 * POST /api/auth/logout
 * Destroys session.
 */
app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

/* =========================================================
   ADMIN ROUTES (protected)
   ========================================================= */

/** Middleware: require admin */
function requireAdmin(req, res, next) {
  if (!req.session.user?.isAdmin) {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

/** Middleware: require Owner role */
function requireOwner(req, res, next) {
  if (!req.session.user?.isAdmin || req.session.user?.role !== "Owner") {
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
    if (email === req.session.user.email.toLowerCase()) {
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
   START SERVER
   ========================================================= */
async function start() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✅  Connected to MongoDB");

    // Seed initial admins if they don't exist
    const initialAdmins = [
      { email: "streamium67@gmail.com", role: "Owner", name: "Streamium Owner" },
      { email: "rupayandas2024@gmail.com", role: "Website Manager", name: "Rupayan Das" },
      { email: "alok.studioasthy@gmail.com", role: "Finance Manager", name: "Alok" }
    ];

    for (const a of initialAdmins) {
      await Admin.findOneAndUpdate(
        { email: a.email.toLowerCase() },
        { $setOnInsert: { email: a.email.toLowerCase(), role: a.role, name: a.name } },
        { upsert: true, new: true }
      );
    }
    console.log("✅  Admin accounts verified & synced in MongoDB");

    app.listen(PORT, () => {
      console.log(`🚀  Streamium server running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("❌  Failed to start:", err.message);
    process.exit(1);
  }
}

start();
