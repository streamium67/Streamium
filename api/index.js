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
} = require("./lib/sheets");

/* =========================================================
   ENV & CONFIG
   ========================================================= */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || "dev-jwt-secret-change-me";
const JWT_EXPIRY = "7d";
const COOKIE_NAME = "token";
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

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
   DATABASE MIDDLEWARE (MongoDB — for Admin routes only)
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

// POST /api/auth/google — Google Sign-In + Google Sheets user registration
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

    // Check admin status (MongoDB)
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

    // Register / update user in Google Sheets
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
      // Don't block login if Sheets fails — user can still access the site
    }

    const user = {
      googleId,
      email: email.toLowerCase(),
      name,
      picture,
      isAdmin,
      role,
      userId: sheetUser?.userId || null,
      subscriptionStatus: sheetUser?.subscriptionStatus || "None",
      currentPlan: sheetUser?.currentPlan || "None",
      loginCount: sheetUser?.loginCount || 1,
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
app.post(["/auth/logout", "/api/auth/logout"], (req, res) => {
  clearAuthCookie(res);
  return res.json({ success: true });
});

/* =========================================================
   USER DATA ROUTES
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
   EXPORT FOR VERCEL
   ========================================================= */
module.exports = app;
