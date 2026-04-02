require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors({ origin: process.env.ALLOWED_ORIGINS || "*" }));
app.use(express.json({ limit: "20mb" }));

// E-Sign routes
const esignRoutes = require("./lib/esign-routes");
app.use("/api/esign", esignRoutes);

// Serve frontend
const staticDir = path.join(__dirname, "web", "dist");
app.use(express.static(staticDir));
app.get("*", (_req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(`E-Sign server running on port ${PORT}`);
});
