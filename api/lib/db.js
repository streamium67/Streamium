const mongoose = require("mongoose");

/**
 * Cached MongoDB connection for Vercel Serverless.
 * Reuses the existing connection across warm invocations
 * instead of creating a new one every time.
 */
let cachedConnection = null;

async function connectDB() {
  if (cachedConnection && cachedConnection.readyState === 1) {
    return cachedConnection;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI environment variable is not set.");
  }

  // Mongoose 8+ returns the connection directly
  const conn = await mongoose.connect(uri, {
    // Serverless-friendly settings
    bufferCommands: false,
    maxPoolSize: 5,
  });

  cachedConnection = conn.connection;
  console.log("✅ Connected to MongoDB (serverless)");
  return cachedConnection;
}

module.exports = connectDB;
