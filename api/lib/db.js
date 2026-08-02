const mongoose = require("mongoose");

/**
 * Cached MongoDB connection for Vercel Serverless.
 * Prevents creating a new connection on every cold/warm invocation.
 */
let cached = global._mongooseCache;
if (!cached) {
  cached = global._mongooseCache = { conn: null, promise: null };
}

async function connectDB() {
  // Return existing connection if available
  if (cached.conn) {
    return cached.conn;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI environment variable is not set.");
  }

  // If a connection attempt is already in progress, await it
  if (!cached.promise) {
    cached.promise = mongoose.connect(uri, {
      bufferCommands: false,
    }).then((m) => m);
  }

  cached.conn = await cached.promise;
  return cached.conn;
}

module.exports = connectDB;
