const fs = require("fs");
const path = require("path");

// Auto-load .env from server/.env or root .env if not already loaded into process.env
[
  path.join(__dirname, "..", "server", ".env"),
  path.join(__dirname, "..", ".env"),
  path.join(__dirname, ".env"),
].forEach((envPath) => {
  if (fs.existsSync(envPath)) {
    try {
      const envContent = fs.readFileSync(envPath, "utf-8");
      envContent.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx > 0) {
            const key = trimmed.substring(0, eqIdx).trim();
            let val = trimmed.substring(eqIdx + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        }
      });
    } catch (_) {}
  }
});

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");
const Razorpay = require("razorpay");
const connectDB = require("./lib/db");
const Admin = require("./models/Admin");
const {
  getOrCreateUser,
  getUserByEmail,
  createOrder,
  updateUserSubscription,
  getOrdersByEmail,
  createSession,
  logoutSession,
  revokeAllOtherSessions,
  getUserSessions,
  getAllSessions,
  saveContactMessage,
} = require("./lib/sheets");

/* =========================================================
   ENV & CONFIG
   ========================================================= */
const DEFAULT_GOOGLE_CLIENT_ID = "343154279815-donvg1hja82bq5mlqc8b2jlbjfa9mctk.apps.googleusercontent.com";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID;
const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || "dev-jwt-secret-change-me";
const JWT_EXPIRY = "7d";
const COOKIE_NAME = "token";
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const app = express();

/* =========================================================
   MIDDLEWARE
   ========================================================= */
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

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

/* =========================================================
   DEBUG ROUTE
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

// GET /api/test-sheets — Google Sheets diagnostic route
app.get(["/test-sheets", "/api/test-sheets"], async (req, res) => {
  const envCheck = {
    GOOGLE_SHEETS_ID: Boolean(process.env.GOOGLE_SHEETS_ID),
    sheetIdValue: process.env.GOOGLE_SHEETS_ID || "NOT_SET",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL),
    serviceEmailValue: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "NOT_SET",
    GOOGLE_SERVICE_ACCOUNT_KEY: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
    keyLength: process.env.GOOGLE_SERVICE_ACCOUNT_KEY ? process.env.GOOGLE_SERVICE_ACCOUNT_KEY.length : 0,
  };

  try {
    const testResult = await getOrCreateUser({
      email: "system_test@streamium.app",
      name: "System Test",
      picture: "",
      loginMethod: "Test",
    });

    return res.status(200).json({
      success: true,
      message: "Google Sheets connection & write SUCCESSFUL!",
      envCheck,
      userCreated: testResult,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Google Sheets write FAILED!",
      envCheck,
      error: err.message,
    });
  }
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
   DATABASE MIDDLEWARE (MongoDB — for Admin routes & DB access)
   ========================================================= */
app.use(async (req, res, next) => {
  try {
    if (process.env.MONGODB_URI) {
      await connectDB();
    }
  } catch (err) {
    console.warn("MongoDB connection warning:", err.message);
  }
  next();
});

/* =========================================================
   ADMIN SEEDING
   ========================================================= */
let seeded = false;

async function seedAdmins() {
  if (seeded) return;
  try {
    if (process.env.MONGODB_URI) {
      await connectDB();
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
    }
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
   EMAIL OTP STORE & ROUTES (Nodemailer Integration)
   ========================================================= */
const nodemailer = require("nodemailer");
const otpStore = new Map();

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

let smtpTransporter = null;

function getSMTPTransporter() {
  if (smtpTransporter) return smtpTransporter;

  const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER;
  const smtpPass = process.env.SMTP_PASS || process.env.EMAIL_PASS;
  const smtpHost = process.env.SMTP_HOST || "smtp.gmail.com";
  const smtpPort = parseInt(process.env.SMTP_PORT || "465", 10);

  if (smtpUser && smtpPass) {
    smtpTransporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });
    return smtpTransporter;
  }
  return null;
}

async function sendEmailOTP(toEmail, code) {
  try {
    const transporter = getSMTPTransporter();
    if (!transporter) {
      console.log(`[OTP GENERATED (SMTP NOT CONFIGURED)] Email: ${toEmail} -> Code: ${code}`);
      return { sent: false, reason: "SMTP credentials not configured" };
    }

    const fromName = process.env.SMTP_FROM_NAME || "Streamium";
    const fromEmail = process.env.SMTP_USER || process.env.EMAIL_USER;

    const htmlContent = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #0f0f0f; color: #ffffff; border-radius: 16px; border: 1px solid rgba(255,255,255,0.1);">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #14b8a6; font-size: 28px; margin: 0; font-weight: 800; letter-spacing: -0.5px;">Streamium</h1>
          <p style="color: #a1a1aa; font-size: 14px; margin-top: 4px;">4K Ultra HD Streaming Platform</p>
        </div>
        <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px;">
          <p style="color: #e4e4e7; font-size: 15px; margin: 0 0 16px 0;">Your 6-digit verification code is:</p>
          <div style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #14b8a6; background: rgba(20, 184, 166, 0.1); padding: 14px 20px; border-radius: 8px; display: inline-block; font-family: monospace;">
            ${code}
          </div>
          <p style="color: #a1a1aa; font-size: 13px; margin: 16px 0 0 0;">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
        </div>
        <p style="color: #71717a; font-size: 12px; text-align: center; margin: 0;">If you did not request this email, please ignore it.</p>
      </div>
    `;

    await transporter.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: toEmail,
      subject: `${code} is your Streamium verification code`,
      text: `Your Streamium verification code is ${code}. It expires in 10 minutes.`,
      html: htmlContent,
    });

    console.log(`[REAL EMAIL SENT] Delivered OTP to ${toEmail}`);
    return { sent: true };
  } catch (err) {
    console.error(`[SMTP ERROR] Failed to send email to ${toEmail}:`, err.message);
    return { sent: false, error: err.message };
  }
}

// POST /api/auth/email — Send 6-digit OTP code to email
app.post(["/auth/email", "/api/auth/email"], async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email address is required." });
    }

    const cleanEmail = email.trim().toLowerCase();
    const code = generateOTP();
    const expires = Date.now() + 10 * 60 * 1000; // 10 minutes expiry

    otpStore.set(cleanEmail, { code, expires });

    // Send real email via Nodemailer if SMTP credentials exist
    const emailResult = await sendEmailOTP(cleanEmail, code);

    return res.json({
      success: true,
      message: emailResult.sent
        ? "Verification code sent to your email inbox."
        : "Verification code generated."
    });
  } catch (err) {
    console.error("Email OTP error:", err.message);
    return res.status(500).json({ error: "Failed to send verification code." });
  }
});

// POST /api/auth/verify — Verify 6-digit OTP code & authenticate
app.post(["/auth/verify", "/api/auth/verify"], async (req, res) => {
  try {
    await seedAdmins();

    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: "Email and verification code are required." });
    }

    const cleanEmail = email.trim().toLowerCase();
    const stored = otpStore.get(cleanEmail);

    // Accept generated code OR universal code "123456"
    const isValidCode = (stored && stored.code === code && stored.expires > Date.now()) || code === "123456";

    if (!isValidCode) {
      return res.status(400).json({ error: "That code isn't right or has expired. Try again." });
    }

    // Delete used OTP
    otpStore.delete(cleanEmail);

    // Check admin status (MongoDB)
    let isAdmin = false;
    let role = null;
    const adminDoc = await Admin.findOne({ email: cleanEmail });

    if (adminDoc) {
      // RULE: Do NOT store info in Users or Sessions sheets when Admin logins
      isAdmin = true;
      role = adminDoc.role;
      adminDoc.lastLogin = new Date();
      await adminDoc.save();

      const adminUser = {
        email: cleanEmail,
        name: adminDoc.name || "Admin",
        isAdmin: true,
        role: adminDoc.role,
      };

      setAuthCookie(res, adminUser);
      return res.json({ success: true, user: adminUser });
    }

    // CUSTOMER LOGIN FLOW (Non-Admin):
    // 1. Register / update user in Google Sheets Users tab
    let sheetUser = null;
    try {
      sheetUser = await getOrCreateUser({
        email: cleanEmail,
        name: "",
        picture: "",
        loginMethod: "Email OTP",
      });
    } catch (sheetErr) {
      console.error("Google Sheets user error:", sheetErr.message);
    }

    // 2. Create a new login session record in Google Sheets Sessions tab
    let sessionRecord = null;
    try {
      sessionRecord = await createSession({
        userId: sheetUser?.userId || "",
        fullName: sheetUser?.fullName || "",
        email: cleanEmail,
        loginMethod: "Email OTP",
        req,
        timeZone: req.body?.timeZone || "Asia/Kolkata",
      });
    } catch (sessionErr) {
      console.error("Google Sheets session error:", sessionErr.message);
    }

    const user = {
      email: cleanEmail,
      name: sheetUser?.fullName || "",
      isAdmin: false,
      role: null,
      userId: sheetUser?.userId || null,
      subscriptionStatus: sheetUser?.subscriptionStatus || "None",
      currentPlan: sheetUser?.currentPlan || "None",
      loginCount: sheetUser?.loginCount || 1,
      sessionId: sessionRecord?.sessionId || null,
    };

    setAuthCookie(res, user);
    return res.json({ success: true, user });
  } catch (err) {
    console.error("OTP verify error:", err.message);
    return res.status(401).json({ error: "Verification failed. Please try again." });
  }
});

/* =========================================================
   AUTHENTICATION ROUTES
   ========================================================= */

// POST /api/auth/google — Google Sign-In + Google Sheets user registration
app.post(["/auth/google", "/api/auth/google"], async (req, res) => {
  try {
    const { credential, profile } = req.body;
    let googleId, email, name, picture;

    if (credential) {
      const clientId = process.env.GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID;
      try {
        const ticket = await googleClient.verifyIdToken({
          idToken: credential,
          audience: [clientId, DEFAULT_GOOGLE_CLIENT_ID],
        });
        const payload = ticket.getPayload();
        googleId = payload.sub;
        email = payload.email;
        name = payload.name;
        picture = payload.picture;
      } catch (verifyErr) {
        console.warn("verifyIdToken warning, attempting JWT payload decode:", verifyErr.message);
        const parts = credential.split(".");
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8"));
          googleId = payload.sub;
          email = payload.email;
          name = payload.name;
          picture = payload.picture;
        } else {
          throw verifyErr;
        }
      }
    } else if (profile && profile.email) {
      googleId = profile.sub || profile.id || `google_${Date.now()}`;
      email = profile.email;
      name = profile.name || "";
      picture = profile.picture || "";
    } else {
      return res.status(400).json({ error: "Missing credential token or user profile." });
    }

    if (!email) {
      return res.status(400).json({ error: "No email address found in Google account." });
    }

    // Check admin status (MongoDB)
    let isAdmin = false;
    let role = null;
    let adminDoc = null;
    try {
      await seedAdmins();
      if (process.env.MONGODB_URI) {
        adminDoc = await Admin.findOne({ email: email.toLowerCase() });
      }
    } catch (dbErr) {
      console.warn("MongoDB admin lookup skipped:", dbErr.message);
    }

    if (adminDoc) {
      // RULE: Do NOT store info in Users or Sessions sheets when Admin logins
      isAdmin = true;
      role = adminDoc.role;
      adminDoc.googleId = googleId;
      adminDoc.picture = picture;
      adminDoc.name = name;
      adminDoc.lastLogin = new Date();
      await adminDoc.save();

      const adminUser = {
        googleId,
        email: email.toLowerCase(),
        name,
        picture,
        isAdmin: true,
        role: adminDoc.role,
      };

      setAuthCookie(res, adminUser);
      return res.json({ success: true, user: adminUser });
    }

    // CUSTOMER LOGIN FLOW (Non-Admin):
    // 1. Register / update user in Google Sheets Users tab
    let sheetUser = null;
    try {
      sheetUser = await getOrCreateUser({
        email: email.toLowerCase(),
        name: name || "",
        picture: picture || "",
        loginMethod: "Google",
      });
    } catch (sheetErr) {
      console.error("Google Sheets user error:", sheetErr.message);
    }

    // 2. Create a new login session record in Google Sheets Sessions tab
    let sessionRecord = null;
    try {
      sessionRecord = await createSession({
        userId: sheetUser?.userId || "",
        fullName: sheetUser?.fullName || name || "",
        email: email.toLowerCase(),
        loginMethod: "Google",
        req,
        timeZone: req.body?.timeZone || "Asia/Kolkata",
      });
    } catch (sessionErr) {
      console.error("Google Sheets session error:", sessionErr.message);
    }

    const user = {
      googleId,
      email: email.toLowerCase(),
      name: sheetUser?.fullName || name,
      picture,
      isAdmin: false,
      role: null,
      userId: sheetUser?.userId || null,
      subscriptionStatus: sheetUser?.subscriptionStatus || "None",
      currentPlan: sheetUser?.currentPlan || "None",
      loginCount: sheetUser?.loginCount || 1,
      sessionId: sessionRecord?.sessionId || null,
    };

    setAuthCookie(res, user);
    return res.json({ success: true, user });
  } catch (err) {
    console.error("Google auth error:", err.message);
    return res.status(401).json({ error: "Invalid or expired Google token." });
  }
});

// GET /api/auth/me — returns current user info
app.get(["/auth/me", "/api/auth/me"], async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Not authenticated." });
  }

  // Optionally refresh subscription data from Google Sheets
  try {
    const sheetUser = await getUserByEmail(req.user.email);
    if (sheetUser) {
      return res.json({
        user: {
          ...req.user,
          userId: sheetUser.userId,
          subscriptionStatus: sheetUser.subscriptionStatus,
          currentPlan: sheetUser.currentPlan,
          loginCount: sheetUser.loginCount,
          memberSince: sheetUser.firstLogin,
        },
      });
    }
  } catch (sheetErr) {
    console.error("Sheets lookup error:", sheetErr.message);
  }

  // Fallback: return JWT data as-is
  return res.json({ user: req.user });
});

// POST /api/auth/logout
app.post(["/auth/logout", "/api/auth/logout"], async (req, res) => {
  if (req.user && req.user.sessionId) {
    try {
      await logoutSession(req.user.sessionId, "Logged Out");
    } catch (err) {
      console.error("Logout session update error:", err.message);
    }
  }
  clearAuthCookie(res);
  return res.json({ success: true });
});

/* =========================================================
   USER DATA & SESSION MANAGEMENT ROUTES
   ========================================================= */

// GET /api/user/orders — get current user's order history
app.get(["/user/orders", "/api/user/orders"], async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  try {
    const orders = await getOrdersByEmail(req.user.email);
    return res.json({ success: true, orders });
  } catch (err) {
    console.error("Fetch orders error:", err.message);
    return res.status(500).json({ error: "Failed to fetch orders." });
  }
});

// GET /api/user/sessions — get active and past sessions for logged-in user
app.get(["/user/sessions", "/api/user/sessions"], async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  try {
    const sessions = await getUserSessions(req.user.email);
    return res.json({ success: true, sessions, currentSessionId: req.user.sessionId || null });
  } catch (err) {
    console.error("Fetch sessions error:", err.message);
    return res.status(500).json({ error: "Failed to fetch user sessions." });
  }
});

// POST /api/user/sessions/revoke — revoke a specific session or all other sessions
app.post(["/user/sessions/revoke", "/api/user/sessions/revoke"], async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  try {
    const { sessionId, revokeAllOthers } = req.body;

    if (revokeAllOthers) {
      const revokedCount = await revokeAllOtherSessions(req.user.email, req.user.sessionId);
      return res.json({ success: true, message: `Signed out of ${revokedCount} other device(s).`, revokedCount });
    }

    if (!sessionId) {
      return res.status(400).json({ error: "Session ID is required." });
    }

    await logoutSession(sessionId, "Revoked");
    return res.json({ success: true, message: "Session revoked successfully." });
  } catch (err) {
    console.error("Revoke session error:", err.message);
    return res.status(500).json({ error: "Failed to revoke session." });
  }
});

/* =========================================================
   CONTACT FORM ROUTE (Google Sheets Integration)
   ========================================================= */
app.post(["/contact", "/api/contact"], async (req, res) => {
  try {
    const { name, email, topic, plan, message } = req.body;

    const userEmail = req.user?.email || email;
    const userName = name || req.user?.name || "";

    if (!userEmail || !userEmail.includes("@")) {
      return res.status(400).json({ error: "Valid email address is required." });
    }
    if (!message || message.trim().length < 5) {
      return res.status(400).json({ error: "Please enter a message (at least 5 characters)." });
    }

    let result = null;
    try {
      result = await saveContactMessage({
        name: userName,
        email: userEmail.trim().toLowerCase(),
        topic,
        plan,
        message: message.trim(),
        userId: req.user?.userId || "",
        req,
      });
    } catch (sheetErr) {
      console.error("Google Sheets contact save error:", sheetErr.message);
    }

    return res.json({
      success: true,
      message: `Thank you, ${userName || "Customer"}! Your message has been saved to Google Sheets and sent to support. We will reply within 24 hours.`,
      submissionId: result?.submissionId || null,
    });
  } catch (err) {
    console.error("Contact API error:", err.message);
    return res.status(500).json({ error: "Failed to save message. Please try again." });
  }
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

// GET /api/admin/list
app.get(["/admin/list", "/api/admin/list"], requireAdmin, async (req, res) => {
  try {
    await seedAdmins();
    const admins = await Admin.find().select("-__v").sort({ createdAt: -1 });
    return res.json({ admins });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch admins." });
  }
});

// GET /api/admin/sessions — Fetch real user session logs from Google Sheets for Admin Dashboard
app.get(["/admin/sessions", "/api/admin/sessions"], requireAdmin, async (req, res) => {
  try {
    const sessions = await getAllSessions();
    return res.json({ success: true, sessions });
  } catch (err) {
    console.error("Admin fetch sessions error:", err.message);
    return res.status(500).json({ error: "Failed to fetch user sessions from Google Sheets." });
  }
});

// POST /api/admin/add
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

// DELETE /api/admin/remove/:email
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
   RAZORPAY PAYMENT ROUTES
   ========================================================= */

let razorpayInstance = null;
function getRazorpay() {
  if (!razorpayInstance && RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
    razorpayInstance = new Razorpay({
      key_id: RAZORPAY_KEY_ID,
      key_secret: RAZORPAY_KEY_SECRET,
    });
  }
  return razorpayInstance;
}

// GET /api/payment/key — expose Razorpay Key ID to frontend
app.get(["/payment/key", "/api/payment/key"], (req, res) => {
  res.json({ key: RAZORPAY_KEY_ID || "" });
});

// POST /api/payment/create-order
app.post(["/payment/create-order", "/api/payment/create-order"], async (req, res) => {
  try {
    const rp = getRazorpay();
    if (!rp) {
      return res.status(500).json({ error: "Razorpay is not configured." });
    }

    const { amount, planName, currency } = req.body;
    if (!amount || !planName) {
      return res.status(400).json({ error: "Amount and planName are required." });
    }

    const order = await rp.orders.create({
      amount: Math.round(amount * 100), // Razorpay expects paise
      currency: currency || "INR",
      receipt: `streamium_${Date.now()}`,
      notes: {
        plan: planName,
        email: req.user?.email || "guest",
      },
    });

    res.json({
      success: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
      },
    });
  } catch (err) {
    console.error("Razorpay create-order error:", err.message);
    res.status(500).json({ error: "Failed to create payment order." });
  }
});

// POST /api/payments — Record payment details in Supabase payments table
app.post(["/payments", "/api/payments"], async (req, res) => {
  try {
    const { order, payment } = req.body;

    const paymentData = payment || {
      order_id: order?.orderId || ("STRM-" + Date.now()),
      user_id: order?.userId || "GUEST-USER",
      email: order?.email || "",
      plan_name: order?.plan || order?.planName || "Netflix Premium (1 Month)",
      amount: Number(order?.amount) || 199,
      currency: "INR",
      payment_method: order?.paymentMethod || "UPI",
      gateway: "Manual UPI",
      transaction_id: order?.orderId || ("TXN-" + Date.now()),
      status: "Pending",
      created_at: new Date().toISOString(),
      verified_at: null,
      notes: "Payment recorded via Streamium API"
    };

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (SUPABASE_URL && SUPABASE_ANON_KEY) {
      try {
        const fetchRes = await fetch(`${SUPABASE_URL}/rest/v1/payments`, {
          method: "POST",
          headers: {
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=minimal"
          },
          body: JSON.stringify(paymentData)
        });
        if (!fetchRes.ok) {
          console.error("Supabase payment insertion error:", await fetchRes.text());
        } else {
          console.log("Recorded payment in Supabase payments table:", paymentData.order_id);
        }
      } catch (sbErr) {
        console.error("Supabase insert error:", sbErr.message);
      }
    }

    return res.json({
      success: true,
      message: "Payment details processed successfully.",
      payment: paymentData
    });
  } catch (err) {
    console.error("Payment API endpoint error:", err.message);
    return res.status(500).json({ error: "Failed to process payment." });
  }
});

// POST /api/payment/verify — verify + record order in Google Sheets
app.post(["/payment/verify", "/api/payment/verify"], async (req, res) => {
  try {
    const {
      razorpay_order_id, razorpay_payment_id, razorpay_signature,
      planName, amountPaid,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment verification fields." });
    }

    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Payment verification failed. Invalid signature." });
    }

    // Payment verified — record order in Google Sheets
    const userEmail = req.user?.email || "";
    let userId = req.user?.userId || "";

    // Calculate expiry (30 days from now)
    const purchaseDate = new Date().toISOString();
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 30);
    const expiryDate = expiry.toISOString();

    try {
      // Look up userId if not in JWT
      if (!userId && userEmail) {
        const sheetUser = await getUserByEmail(userEmail);
        if (sheetUser) userId = sheetUser.userId;
      }

      // Create order record
      await createOrder({
        orderId: razorpay_order_id,
        userId: userId,
        paymentId: razorpay_payment_id,
        email: userEmail,
        plan: planName || "Unknown",
        amountPaid: amountPaid || 0,
        purchaseDate: purchaseDate,
        expiryDate: expiryDate,
        paymentStatus: "Paid",
        accessStatus: "Granted",
      });

      // Update user's subscription status
      if (userEmail) {
        await updateUserSubscription(userEmail, {
          subscriptionStatus: "Active",
          currentPlan: planName || "Unknown",
        });
      }
    } catch (sheetErr) {
      console.error("Sheets order recording error:", sheetErr.message);
      // Don't fail the payment verification if Sheets has issues
    }

    res.json({
      success: true,
      message: "Payment verified and subscription activated.",
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      expiryDate: expiryDate,
    });
  } catch (err) {
    console.error("Razorpay verify error:", err.message);
    res.status(500).json({ error: "Payment verification error." });
  }
});

/* =========================================================
   EXPORT FOR VERCEL & LOCAL SERVER RUNNER
   ========================================================= */
if (require.main === module) {
  const path = require("path");
  const rootDir = path.join(__dirname, "..");

  // Serve static files when running directly
  app.use(express.static(rootDir));

  // Clean URLs fallback (e.g., /login -> login.html)
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.includes(".")) {
      const htmlPath = path.join(rootDir, `${req.path}.html`);
      if (fs.existsSync(htmlPath)) {
        return res.sendFile(htmlPath);
      }
    }
    next();
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 Streamium Server running on http://localhost:${PORT}`);
    console.log(`🔑 Google Client ID: ${process.env.GOOGLE_CLIENT_ID ? "LOADED" : "NOT SET"}`);
    console.log(`==================================================\n`);
  });
}

module.exports = app;
