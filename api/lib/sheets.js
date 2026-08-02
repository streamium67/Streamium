const { google } = require("googleapis");
const { UAParser } = require("ua-parser-js");

/* =========================================================
   Google Sheets Database Helper for Streamium
   - Users sheet: Customer registration & login tracking
   - Orders sheet: Payment/subscription records
   - Sessions sheet: Session management & security tracking
   ========================================================= */

const SHEET_ID = process.env.GOOGLE_SHEETS_ID;
const SERVICE_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
let SERVICE_KEY = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "").trim();
// Strip surrounding quotes if user added quotes in env vars
if (SERVICE_KEY.startsWith('"') && SERVICE_KEY.endsWith('"')) {
  SERVICE_KEY = SERVICE_KEY.substring(1, SERVICE_KEY.length - 1);
}
SERVICE_KEY = SERVICE_KEY.replace(/\\n/g, "\n");

const USERS_SHEET = "Users";
const ORDERS_SHEET = "Orders";
const SESSIONS_SHEET = "Sessions";

// Column headers (must match Row 1 in each sheet tab)
const USER_HEADERS = [
  "User ID", "Full Name", "Email", "Login Method",
  "First Login", "Last Login", "Login Count", "Account Status",
  "Subscription Status", "Current Plan"
];

const ORDER_HEADERS = [
  "Order ID", "User ID", "Razorpay Payment ID", "Email", "Plan",
  "Amount Paid", "Purchase Date", "Expiry Date", "Payment Status", "Access Status"
];

const SESSION_HEADERS = [
  "Session ID", "User ID", "Full Name", "Email", "Login Method",
  "Login Date & Time", "Logout Date & Time", "Session Status",
  "IP Address", "Location", "Browser", "Browser Version", "OS",
  "Device Type", "Language", "Time Zone", "Referrer"
];

/* =========================================================
   FORMATTERS & HELPERS
   ========================================================= */

/**
 * Extracts a clean, human-readable full name from an email address
 * if a name is not provided. e.g. "rupayan.das@gmail.com" -> "Rupayan Das"
 */
function extractFullName(name, email) {
  if (name && name.trim()) {
    return name.trim();
  }
  if (!email) return "Customer";

  const handle = email.split("@")[0] || "Customer";
  let clean = handle.replace(/[._-]/g, " ").replace(/\d+$/g, "").trim();
  if (!clean) clean = handle;

  return clean
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Formats a Date object or timestamp string to a clean, human-readable format:
 * e.g. "02 Aug 2026, 01:23 PM" (Indian Standard Time / IST)
 */
function formatDateTime(d) {
  const dt = d ? new Date(d) : new Date();
  if (isNaN(dt.getTime())) return "—";

  return dt.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/* =========================================================
   AUTH & CLIENT (cached for serverless)
   ========================================================= */
let cachedSheets = null;

async function getSheetsClient() {
  if (cachedSheets) return cachedSheets;

  if (!SERVICE_EMAIL || !SERVICE_KEY || !SHEET_ID) {
    const missing = [];
    if (!SHEET_ID) missing.push("GOOGLE_SHEETS_ID");
    if (!SERVICE_EMAIL) missing.push("GOOGLE_SERVICE_ACCOUNT_EMAIL");
    if (!SERVICE_KEY) missing.push("GOOGLE_SERVICE_ACCOUNT_KEY");
    throw new Error(`Google Sheets credentials missing: ${missing.join(", ")}`);
  }

  const auth = new google.auth.JWT({
    email: SERVICE_EMAIL,
    key: SERVICE_KEY,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  await auth.authorize();

  cachedSheets = google.sheets({ version: "v4", auth });
  return cachedSheets;
}

/* =========================================================
   HELPER: Auto-create tabs if they do not exist
   ========================================================= */
let tabsChecked = false;
async function ensureTabsExist() {
  if (tabsChecked) return;
  try {
    const sheets = await getSheetsClient();
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const existingTitles = (spreadsheet.data.sheets || []).map(s => s.properties.title);

    const requests = [];
    if (!existingTitles.includes(USERS_SHEET)) {
      requests.push({ addSheet: { properties: { title: USERS_SHEET } } });
    }
    if (!existingTitles.includes(ORDERS_SHEET)) {
      requests.push({ addSheet: { properties: { title: ORDERS_SHEET } } });
    }
    if (!existingTitles.includes(SESSIONS_SHEET)) {
      requests.push({ addSheet: { properties: { title: SESSIONS_SHEET } } });
    }

    if (requests.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests },
      });
    }
    tabsChecked = true;
  } catch (err) {
    console.error("Error checking/creating sheet tabs:", err.message);
  }
}

/* =========================================================
   HELPER: Read all rows from a sheet tab
   ========================================================= */
async function readSheet(sheetName) {
  await ensureTabsExist();
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A:Z`,
  });
  return res.data.values || [];
}

/* =========================================================
   HELPER: Append a row to a sheet tab
   ========================================================= */
async function appendRow(sheetName, values) {
  await ensureTabsExist();
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A:Z`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [values] },
  });
}

/* =========================================================
   HELPER: Update a specific cell range
   ========================================================= */
async function updateCell(sheetName, range, values) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!${range}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] },
  });
}

/* =========================================================
   HELPER: Ensure headers exist in Row 1
   ========================================================= */
async function ensureHeaders(sheetName, headers) {
  const rows = await readSheet(sheetName);
  if (rows.length === 0 || rows[0][0] !== headers[0]) {
    // Insert headers as first row
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [headers] },
    });
  }
}

/* =========================================================
   GENERATE USER ID: STR000001, STR000002, ...
   ========================================================= */
async function generateUserId() {
  const rows = await readSheet(USERS_SHEET);
  // rows[0] is header, data starts at rows[1]
  const dataCount = Math.max(rows.length - 1, 0);
  const nextNum = dataCount + 1;
  return `STR${String(nextNum).padStart(6, "0")}`;
}

/* =========================================================
   FIND USER ROW BY EMAIL
   Returns { rowIndex, data } or null
   rowIndex is 1-based (row 1 = header, row 2 = first user)
   ========================================================= */
async function findUserByEmail(email) {
  const rows = await readSheet(USERS_SHEET);
  if (rows.length <= 1) return null; // only header or empty

  const emailCol = 2; // Column C (0-indexed = 2) is "Email"
  const lowerEmail = email.toLowerCase();

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][emailCol] && rows[i][emailCol].toLowerCase() === lowerEmail) {
      return {
        rowIndex: i + 1, // 1-based for Sheets API
        data: {
          userId: rows[i][0] || "",
          fullName: rows[i][1] || "",
          email: rows[i][2] || "",
          loginMethod: rows[i][3] || "",
          firstLogin: rows[i][4] || "",
          lastLogin: rows[i][5] || "",
          loginCount: parseInt(rows[i][6] || "0", 10),
          accountStatus: rows[i][7] || "Active",
          subscriptionStatus: rows[i][8] || "None",
          currentPlan: rows[i][9] || "None",
        },
      };
    }
  }
  return null;
}

/* =========================================================
   GET OR CREATE USER
   - If email exists: update lastLogin + increment loginCount
   - If new email: create new user row with auto-generated ID
   Returns the user object
   ========================================================= */
async function getOrCreateUser({ email, name, picture, loginMethod }) {
  await ensureHeaders(USERS_SHEET, USER_HEADERS);

  const existing = await findUserByEmail(email);
  const nowFormatted = formatDateTime(new Date());
  const fullName = extractFullName(name, email);

  if (existing) {
    // UPDATE existing user: Last Login (col F) + Login Count (col G)
    const newCount = existing.data.loginCount + 1;
    const rowIdx = existing.rowIndex;

    // Update Last Login (F) and Login Count (G) — columns 5 and 6 (0-indexed)
    await updateCell(USERS_SHEET, `F${rowIdx}:G${rowIdx}`, [nowFormatted, newCount]);

    // Also update name if it changed or was previously generic
    const updatedName = (name && name.trim()) ? name.trim() : (existing.data.fullName || fullName);
    await updateCell(USERS_SHEET, `B${rowIdx}:D${rowIdx}`, [
      updatedName, existing.data.email, existing.data.loginMethod
    ]);

    return {
      ...existing.data,
      fullName: updatedName,
      lastLogin: nowFormatted,
      loginCount: newCount,
    };
  }

  // CREATE new user
  const userId = await generateUserId();
  const newUser = [
    userId,                           // User ID
    fullName,                         // Full Name (extracted if missing)
    email.toLowerCase(),              // Email
    loginMethod || "Google",          // Login Method
    nowFormatted,                     // First Login (formatted date)
    nowFormatted,                     // Last Login (formatted date)
    1,                                // Login Count
    "Active",                         // Account Status
    "None",                           // Subscription Status
    "None",                           // Current Plan
  ];

  await appendRow(USERS_SHEET, newUser);

  return {
    userId,
    fullName: fullName,
    email: email.toLowerCase(),
    loginMethod: loginMethod || "Google",
    firstLogin: nowFormatted,
    lastLogin: nowFormatted,
    loginCount: 1,
    accountStatus: "Active",
    subscriptionStatus: "None",
    currentPlan: "None",
  };
}

/* =========================================================
   GET USER BY EMAIL (read-only lookup)
   ========================================================= */
async function getUserByEmail(email) {
  const found = await findUserByEmail(email);
  return found ? found.data : null;
}

/* =========================================================
   CREATE ORDER
   Adds a row to the Orders sheet with formatted dates
   ========================================================= */
async function createOrder({
  orderId, userId, paymentId, email, plan,
  amountPaid, purchaseDate, expiryDate, paymentStatus, accessStatus
}) {
  await ensureHeaders(ORDERS_SHEET, ORDER_HEADERS);

  const formattedPurchaseDate = formatDateTime(purchaseDate || new Date());
  const formattedExpiryDate = expiryDate ? formatDateTime(expiryDate) : "—";

  const row = [
    orderId,
    userId,
    paymentId,
    email,
    plan,
    amountPaid,
    formattedPurchaseDate,
    formattedExpiryDate,
    paymentStatus || "Paid",
    accessStatus || "Granted",
  ];

  await appendRow(ORDERS_SHEET, row);
  return { orderId, userId, paymentId, plan, amountPaid, paymentStatus, accessStatus };
}

/* =========================================================
   UPDATE USER SUBSCRIPTION
   Updates Subscription Status (col I) and Current Plan (col J)
   ========================================================= */
async function updateUserSubscription(email, { subscriptionStatus, currentPlan }) {
  const existing = await findUserByEmail(email);
  if (!existing) return null;

  const rowIdx = existing.rowIndex;
  await updateCell(USERS_SHEET, `I${rowIdx}:J${rowIdx}`, [
    subscriptionStatus || "Active",
    currentPlan || "None",
  ]);

  return {
    ...existing.data,
    subscriptionStatus: subscriptionStatus || "Active",
    currentPlan: currentPlan || "None",
  };
}

/* =========================================================
   GET ORDERS BY EMAIL
   ========================================================= */
async function getOrdersByEmail(email) {
  const rows = await readSheet(ORDERS_SHEET);
  if (rows.length <= 1) return [];

  const lowerEmail = email.toLowerCase();
  const orders = [];

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][3] && rows[i][3].toLowerCase() === lowerEmail) {
      orders.push({
        orderId: rows[i][0] || "",
        userId: rows[i][1] || "",
        paymentId: rows[i][2] || "",
        email: rows[i][3] || "",
        plan: rows[i][4] || "",
        amountPaid: rows[i][5] || "",
        purchaseDate: rows[i][6] || "",
        expiryDate: rows[i][7] || "",
        paymentStatus: rows[i][8] || "",
        accessStatus: rows[i][9] || "",
      });
    }
  }

  return orders;
}

/* =========================================================
   SESSION MANAGEMENT
   ========================================================= */

async function generateSessionId() {
  const rows = await readSheet(SESSIONS_SHEET);
  const dataCount = Math.max(rows.length - 1, 0);
  const nextNum = dataCount + 1;
  return `SES${String(nextNum).padStart(6, "0")}`;
}

/**
 * Creates a new session record in Google Sheets for customer logins
 */
async function createSession({ userId, fullName, email, loginMethod, req, timeZone }) {
  await ensureHeaders(SESSIONS_SHEET, SESSION_HEADERS);

  const sessionId = await generateSessionId();
  const uaString = req?.headers?.["user-agent"] || "";
  const parser = new UAParser(uaString);
  const result = parser.getResult();

  const browserName = result.browser.name || "Unknown Browser";
  const browserVersion = result.browser.version || "1.0";
  const osName = result.os.name ? `${result.os.name} ${result.os.version || ""}`.trim() : "Unknown OS";

  let deviceType = "Desktop";
  if (result.device.type === "mobile") deviceType = "Mobile";
  else if (result.device.type === "tablet") deviceType = "Tablet";
  else if (/mobile|android|iphone|ipad/i.test(uaString)) deviceType = "Mobile";

  // IP Address & Vercel Geolocation
  const ipAddress = (req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim() || req?.socket?.remoteAddress || "127.0.0.1";

  const city = req?.headers?.["x-vercel-ip-city"] ? decodeURIComponent(req.headers["x-vercel-ip-city"]) : "";
  const region = req?.headers?.["x-vercel-ip-country-region"] || "";
  const country = req?.headers?.["x-vercel-ip-country"] || "IN";
  const location = [city, region, country].filter(Boolean).join(", ") || "India";

  const language = (req?.headers?.["accept-language"] || "en-US").split(",")[0].split(";")[0];
  const referrer = req?.headers?.["referer"] || req?.headers?.["referrer"] || "Direct";
  const nowFormatted = formatDateTime(new Date());

  const row = [
    sessionId,
    userId || "",
    fullName || "",
    email.toLowerCase(),
    loginMethod || "Google",
    nowFormatted,             // Login Date & Time
    "—",                       // Logout Date & Time
    "Active",                  // Session Status
    ipAddress,
    location,
    browserName,
    browserVersion,
    osName,
    deviceType,
    language,
    timeZone || "Asia/Kolkata",
    referrer
  ];

  await appendRow(SESSIONS_SHEET, row);

  return {
    sessionId,
    userId,
    fullName,
    email: email.toLowerCase(),
    loginMethod,
    loginDateTime: nowFormatted,
    logoutDateTime: "—",
    sessionStatus: "Active",
    ipAddress,
    location,
    browserName,
    browserVersion,
    osName,
    deviceType,
    language,
    timeZone: timeZone || "Asia/Kolkata",
    referrer
  };
}

/**
 * Marks a specific session as Logged Out or Revoked
 */
async function logoutSession(sessionId, logoutReason = "Logged Out") {
  if (!sessionId) return null;
  const rows = await readSheet(SESSIONS_SHEET);
  if (rows.length <= 1) return null;

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === sessionId) {
      const rowIdx = i + 1; // 1-based index
      const nowFormatted = formatDateTime(new Date());
      await updateCell(SESSIONS_SHEET, `G${rowIdx}:H${rowIdx}`, [nowFormatted, logoutReason]);
      return { sessionId, logoutDateTime: nowFormatted, sessionStatus: logoutReason };
    }
  }
  return null;
}

/**
 * Revokes all other active sessions for a user (e.g. "Sign out of all other devices")
 */
async function revokeAllOtherSessions(email, currentSessionId = null) {
  if (!email) return 0;
  const rows = await readSheet(SESSIONS_SHEET);
  if (rows.length <= 1) return 0;

  const lowerEmail = email.toLowerCase();
  let revokedCount = 0;
  const nowFormatted = formatDateTime(new Date());

  for (let i = 1; i < rows.length; i++) {
    const sId = rows[i][0];
    const sEmail = rows[i][3];
    const status = rows[i][7];

    if (sEmail && sEmail.toLowerCase() === lowerEmail && status === "Active" && sId !== currentSessionId) {
      const rowIdx = i + 1;
      await updateCell(SESSIONS_SHEET, `G${rowIdx}:H${rowIdx}`, [nowFormatted, "Revoked"]);
      revokedCount++;
    }
  }
  return revokedCount;
}

/**
 * Retrieves session history for a specific user email
 */
async function getUserSessions(email) {
  const rows = await readSheet(SESSIONS_SHEET);
  if (rows.length <= 1) return [];

  const lowerEmail = email.toLowerCase();
  const sessions = [];

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][3] && rows[i][3].toLowerCase() === lowerEmail) {
      sessions.push({
        sessionId: rows[i][0] || "",
        userId: rows[i][1] || "",
        fullName: rows[i][2] || "",
        email: rows[i][3] || "",
        loginMethod: rows[i][4] || "",
        loginDateTime: rows[i][5] || "",
        logoutDateTime: rows[i][6] || "",
        sessionStatus: rows[i][7] || "",
        ipAddress: rows[i][8] || "",
        location: rows[i][9] || "",
        browserName: rows[i][10] || "",
        browserVersion: rows[i][11] || "",
        osName: rows[i][12] || "",
        deviceType: rows[i][13] || "",
        language: rows[i][14] || "",
        timeZone: rows[i][15] || "",
        referrer: rows[i][16] || "",
      });
    }
  }
  return sessions;
}

/**
 * Retrieves ALL session records from Google Sheets for Admin Dashboard (newest first)
 */
async function getAllSessions() {
  const rows = await readSheet(SESSIONS_SHEET);
  if (rows.length <= 1) return [];

  const sessions = [];
  for (let i = 1; i < rows.length; i++) {
    sessions.push({
      sessionId: rows[i][0] || "",
      userId: rows[i][1] || "",
      fullName: rows[i][2] || "",
      email: rows[i][3] || "",
      loginMethod: rows[i][4] || "",
      loginDateTime: rows[i][5] || "",
      logoutDateTime: rows[i][6] || "",
      sessionStatus: rows[i][7] || "",
      ipAddress: rows[i][8] || "",
      location: rows[i][9] || "",
      browserName: rows[i][10] || "",
      browserVersion: rows[i][11] || "",
      osName: rows[i][12] || "",
      deviceType: rows[i][13] || "",
      language: rows[i][14] || "",
      timeZone: rows[i][15] || "",
      referrer: rows[i][16] || "",
    });
  }
  return sessions.reverse();
}

/* =========================================================
   EXPORTS
   ========================================================= */
module.exports = {
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
  ensureHeaders,
  USER_HEADERS,
  ORDER_HEADERS,
  SESSION_HEADERS,
};
