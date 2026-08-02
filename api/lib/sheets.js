const { google } = require("googleapis");

/* =========================================================
   Google Sheets Database Helper for Streamium
   - Users sheet: Customer registration & login tracking
   - Orders sheet: Payment/subscription records
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

// Column headers (must match Row 1 in each sheet tab)
const USER_HEADERS = [
  "User ID", "Full Name", "Email", "Login Method", "Profile Picture",
  "First Login", "Last Login", "Login Count", "Account Status",
  "Subscription Status", "Current Plan"
];

const ORDER_HEADERS = [
  "Order ID", "User ID", "Razorpay Payment ID", "Email", "Plan",
  "Amount Paid", "Purchase Date", "Expiry Date", "Payment Status", "Access Status"
];

/* =========================================================
   AUTH & CLIENT (cached for serverless)
   ========================================================= */
let cachedSheets = null;

function getSheetsClient() {
  if (cachedSheets) return cachedSheets;

  if (!SERVICE_EMAIL || !SERVICE_KEY || !SHEET_ID) {
    const missing = [];
    if (!SHEET_ID) missing.push("GOOGLE_SHEETS_ID");
    if (!SERVICE_EMAIL) missing.push("GOOGLE_SERVICE_ACCOUNT_EMAIL");
    if (!SERVICE_KEY) missing.push("GOOGLE_SERVICE_ACCOUNT_KEY");
    throw new Error(`Google Sheets credentials missing: ${missing.join(", ")}`);
  }

  const auth = new google.auth.JWT(
    SERVICE_EMAIL,
    null,
    SERVICE_KEY,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );

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
    const sheets = getSheetsClient();
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const existingTitles = (spreadsheet.data.sheets || []).map(s => s.properties.title);

    const requests = [];
    if (!existingTitles.includes(USERS_SHEET)) {
      requests.push({ addSheet: { properties: { title: USERS_SHEET } } });
    }
    if (!existingTitles.includes(ORDERS_SHEET)) {
      requests.push({ addSheet: { properties: { title: ORDERS_SHEET } } });
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
    // Continue anyway; range errors will be caught if tabs are missing
  }
}

/* =========================================================
   HELPER: Read all rows from a sheet tab
   ========================================================= */
async function readSheet(sheetName) {
  await ensureTabsExist();
  const sheets = getSheetsClient();
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
  const sheets = getSheetsClient();
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
  const sheets = getSheetsClient();
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
    const sheets = getSheetsClient();
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
          profilePicture: rows[i][4] || "",
          firstLogin: rows[i][5] || "",
          lastLogin: rows[i][6] || "",
          loginCount: parseInt(rows[i][7] || "0", 10),
          accountStatus: rows[i][8] || "Active",
          subscriptionStatus: rows[i][9] || "None",
          currentPlan: rows[i][10] || "None",
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
  const now = new Date().toISOString();

  if (existing) {
    // UPDATE existing user: Last Login (col G) + Login Count (col H)
    const newCount = existing.data.loginCount + 1;
    const rowIdx = existing.rowIndex;

    // Update Last Login (G) and Login Count (H) — columns 7 and 8
    await updateCell(USERS_SHEET, `G${rowIdx}:H${rowIdx}`, [now, newCount]);

    // Also update name and picture if provided (they may have changed on Google)
    if (name || picture) {
      const updatedName = name || existing.data.fullName;
      const updatedPic = picture || existing.data.profilePicture;
      await updateCell(USERS_SHEET, `B${rowIdx}:E${rowIdx}`, [
        updatedName, existing.data.email, existing.data.loginMethod, updatedPic
      ]);
    }

    return {
      ...existing.data,
      fullName: name || existing.data.fullName,
      profilePicture: picture || existing.data.profilePicture,
      lastLogin: now,
      loginCount: newCount,
    };
  }

  // CREATE new user
  const userId = await generateUserId();
  const newUser = [
    userId,                           // User ID
    name || "",                       // Full Name
    email.toLowerCase(),              // Email
    loginMethod || "Google",          // Login Method
    picture || "",                    // Profile Picture
    now,                              // First Login
    now,                              // Last Login
    1,                                // Login Count
    "Active",                         // Account Status
    "None",                           // Subscription Status
    "None",                           // Current Plan
  ];

  await appendRow(USERS_SHEET, newUser);

  return {
    userId,
    fullName: name || "",
    email: email.toLowerCase(),
    loginMethod: loginMethod || "Google",
    profilePicture: picture || "",
    firstLogin: now,
    lastLogin: now,
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
   Adds a row to the Orders sheet
   ========================================================= */
async function createOrder({
  orderId, userId, paymentId, email, plan,
  amountPaid, purchaseDate, expiryDate, paymentStatus, accessStatus
}) {
  await ensureHeaders(ORDERS_SHEET, ORDER_HEADERS);

  const row = [
    orderId,
    userId,
    paymentId,
    email,
    plan,
    amountPaid,
    purchaseDate || new Date().toISOString(),
    expiryDate || "",
    paymentStatus || "Paid",
    accessStatus || "Granted",
  ];

  await appendRow(ORDERS_SHEET, row);
  return { orderId, userId, paymentId, plan, amountPaid, paymentStatus, accessStatus };
}

/* =========================================================
   UPDATE USER SUBSCRIPTION
   Updates Subscription Status (col J) and Current Plan (col K)
   ========================================================= */
async function updateUserSubscription(email, { subscriptionStatus, currentPlan }) {
  const existing = await findUserByEmail(email);
  if (!existing) return null;

  const rowIdx = existing.rowIndex;
  await updateCell(USERS_SHEET, `J${rowIdx}:K${rowIdx}`, [
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
   EXPORTS
   ========================================================= */
module.exports = {
  getOrCreateUser,
  getUserByEmail,
  createOrder,
  updateUserSubscription,
  getOrdersByEmail,
  ensureHeaders,
  USER_HEADERS,
  ORDER_HEADERS,
};
