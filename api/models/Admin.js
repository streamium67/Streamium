const mongoose = require("mongoose");

const adminSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    name: {
      type: String,
      default: "Admin",
    },
    role: {
      type: String,
      default: "Website Manager",
      trim: true,
    },
    googleId: {
      type: String,
      default: null,
    },
    picture: {
      type: String,
      default: null,
    },
    lastLogin: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Prevent model recompilation in serverless (hot module reloading)
module.exports = mongoose.models.Admin || mongoose.model("Admin", adminSchema);
