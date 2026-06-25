// ═══════════════════════════════════════════════════════════════
// IILM AI Platform v2 — Backend Server
// Stack: Express + Supabase + Groq + File Upload
// ═══════════════════════════════════════════════════════════════
require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const bcrypt     = require("bcryptjs");
const jwt        = require("jsonwebtoken");
const rateLimit  = require("express-rate-limit");
const multer     = require("multer");
const path       = require("path");
const fs         = require("fs");
const fetch      = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

// ── Supabase client (service role for backend) ───────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Rate limiting ─────────────────────────────────────────────
const apiLimiter  = rateLimit({ windowMs:15*60*1000, max:200 });
const chatLimiter = rateLimit({ windowMs:60*1000, max:30 });

// ── File upload config ────────────────────────────────────────
const upload = multer({
  dest: "/tmp/uploads/",
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ["application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword", "text/plain"];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error("Only PDF, DOCX, TXT allowed"));
  }
});

// ════════════════════════════════════════════════════════════════
// MIDDLEWARE
// ════════════════════════════════════════════════════════════════
async function authenticate(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || "iilm_secret");
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}

// ════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════════════

// POST /api/auth/login
app.post("/api/auth/login", apiLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Username and password required" });

  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("username", username.toLowerCase().trim())
      .eq("is_active", true)
      .single();

    if (error || !user)
      return res.status(401).json({ error: "Invalid credentials" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid)
      return res.status(401).json({ error: "Invalid credentials" });

    // Update last login
    await supabase.from("users").update({ last_login: new Date() }).eq("id", user.id);

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, name: user.name },
      process.env.JWT_SECRET || "iilm_secret",
      { expiresIn: "8h" }
    );

    const { password: _, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/auth/me
app.get("/api/auth/me", authenticate, async (req, res) => {
  const { data: user } = await supabase.from("users").select("*").eq("id", req.user.id).single();
  if (!user) return res.status(404).json({ error: "Not found" });
  const { password: _, ...safe } = user;
  res.json(safe);
});

// PUT /api/auth/password — Change own password
app.put("/api/auth/password", authenticate, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const { data: user } = await supabase.from("users").select("*").eq("id", req.user.id).single();
  if (!user) return res.status(404).json({ error: "Not found" });
  const valid = await bcrypt.compare(currentPassword, user.password);
  if (!valid) return res.status(401).json({ error: "Current password incorrect" });
  const hashed = await bcrypt.hash(newPassword, 10);
  await supabase.from("users").update({ password: hashed }).eq("id", req.user.id);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════
// CHAT ROUTES — Groq API with Supabase history
// ════════════════════════════════════════════════════════════════

// POST /api/chat
app.post("/api/chat", authenticate, chatLimiter, async (req, res) => {
  const { gptId, gptName, message, systemPrompt, sessionId, fileContext } = req.body;
  if (!message || !systemPrompt || !gptId)
    return res.status(400).json({ error: "Missing fields" });

  try {
    // Get or create session
    let sid = sessionId;
    if (!sid) {
      const { data: session } = await supabase.from("chat_sessions").insert({
        user_id: req.user.id, gpt_id: gptId, gpt_name: gptName || gptId
      }).select().single();
      sid = session?.id;
    }

    // Save user message
    if (sid) {
      await supabase.from("chat_messages").insert({
        session_id: sid, role: "user", content: message
      });
    }

    // Get recent history from DB
    let historyMessages = [];
    if (sid) {
      const { data: history } = await supabase
        .from("chat_messages")
        .select("role, content")
        .eq("session_id", sid)
        .order("created_at", { ascending: true })
        .limit(20);
      historyMessages = history || [];
    }

    // Build system prompt with optional file context
    let fullSystem = systemPrompt +
      `\n\nUser role: ${req.user.role}. User name: ${req.user.name}. ` +
      `Be helpful, accurate, and appropriate for an academic university context.`;

    if (fileContext) {
      fullSystem += `\n\n--- UPLOADED DOCUMENT CONTEXT ---\n${fileContext.slice(0, 4000)}\n--- END DOCUMENT ---\n` +
        `Use the above document to answer the user's question when relevant.`;
    }

    // Stream response
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.write(`data: ${JSON.stringify({ sessionId: sid })}\n\n`);

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: fullSystem },
          ...historyMessages
        ],
        stream: true,
        max_tokens: 2048,
        temperature: 0.7
      })
    });

    if (!groqRes.ok) {
      res.write(`data: ${JSON.stringify({ error: "AI error. Please try again." })}\n\n`);
      return res.end();
    }

    let fullResponse = "";

    // node-fetch v2 uses Node.js streams
    groqRes.body.on("data", (chunk) => {
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;
          try {
            const obj  = JSON.parse(data);
            const text = obj.choices?.[0]?.delta?.content || "";
            if (text) {
              fullResponse += text;
              res.write(`data: ${JSON.stringify({ text })}\n\n`);
            }
          } catch {}
        }
      }
    });

    groqRes.body.on("end", async () => {
      try {
        if (sid) {
          await supabase.from("chat_messages").insert({
            session_id: sid, role: "assistant", content: fullResponse
          });
        }
        await supabase.from("usage_analytics").insert({
          user_id: req.user.id, gpt_id: gptId, gpt_name: gptName || gptId
        });
      } catch(e) { console.error("DB save error:", e); }
      res.write("data: [DONE]\n\n");
      res.end();
    });

    groqRes.body.on("error", (err) => {
      console.error("Stream error:", err);
      res.write(`data: ${JSON.stringify({ error: "Stream error" })}\n\n`);
      res.end();
    });

  } catch (err) {
    console.error("Chat error:", err);
    res.write(`data: ${JSON.stringify({ error: "Server error." })}\n\n`);
    res.end();
  }
});

// GET /api/chat/sessions — Get all sessions for user
app.get("/api/chat/sessions", authenticate, async (req, res) => {
  const { data } = await supabase
    .from("chat_sessions")
    .select("id, gpt_id, gpt_name, created_at, updated_at")
    .eq("user_id", req.user.id)
    .order("updated_at", { ascending: false })
    .limit(50);
  res.json(data || []);
});

// GET /api/chat/sessions/:id — Get messages for a session
app.get("/api/chat/sessions/:id", authenticate, async (req, res) => {
  const { data: session } = await supabase
    .from("chat_sessions").select("user_id").eq("id", req.params.id).single();
  if (!session || session.user_id !== req.user.id)
    return res.status(403).json({ error: "Access denied" });

  const { data: messages } = await supabase
    .from("chat_messages")
    .select("role, content, created_at")
    .eq("session_id", req.params.id)
    .order("created_at", { ascending: true });
  res.json(messages || []);
});

// DELETE /api/chat/sessions/:id — Delete a session
app.delete("/api/chat/sessions/:id", authenticate, async (req, res) => {
  await supabase.from("chat_sessions")
    .delete().eq("id", req.params.id).eq("user_id", req.user.id);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════
// FILE UPLOAD & EXTRACTION
// ════════════════════════════════════════════════════════════════

// POST /api/files/upload — Upload and extract text from PDF/DOCX/TXT
app.post("/api/files/upload", authenticate, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const { originalname, mimetype, path: tmpPath, size } = req.file;
  let extractedText = "";

  try {
    // Extract text based on file type
    if (mimetype === "application/pdf") {
      const pdfParse = require("pdf-parse");
      const buffer   = fs.readFileSync(tmpPath);
      const data     = await pdfParse(buffer);
      extractedText  = data.text;

    } else if (mimetype.includes("wordprocessingml") || mimetype === "application/msword") {
      const mammoth = require("mammoth");
      const result  = await mammoth.extractRawText({ path: tmpPath });
      extractedText = result.value;

    } else if (mimetype === "text/plain") {
      extractedText = fs.readFileSync(tmpPath, "utf-8");
    }

    // Clean up temp file
    fs.unlinkSync(tmpPath);

    // Save to Supabase
    const { data: fileRecord } = await supabase.from("uploaded_files").insert({
      user_id:        req.user.id,
      filename:       originalname,
      file_type:      mimetype,
      file_size:      size,
      extracted_text: extractedText.slice(0, 50000) // limit to 50k chars
    }).select().single();

    res.json({
      id:            fileRecord?.id,
      filename:      originalname,
      extractedText: extractedText.slice(0, 50000),
      wordCount:     extractedText.split(/\s+/).length,
      success:       true
    });

  } catch (err) {
    console.error("File error:", err);
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    res.status(500).json({ error: "Could not extract text from file" });
  }
});

// GET /api/files — List user's uploaded files
app.get("/api/files", authenticate, async (req, res) => {
  const { data } = await supabase
    .from("uploaded_files")
    .select("id, filename, file_type, file_size, created_at")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false })
    .limit(20);
  res.json(data || []);
});

// GET /api/files/:id — Get extracted text of a file
app.get("/api/files/:id", authenticate, async (req, res) => {
  const { data } = await supabase
    .from("uploaded_files")
    .select("*")
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)
    .single();
  if (!data) return res.status(404).json({ error: "File not found" });
  res.json(data);
});

// DELETE /api/files/:id
app.delete("/api/files/:id", authenticate, async (req, res) => {
  await supabase.from("uploaded_files")
    .delete().eq("id", req.params.id).eq("user_id", req.user.id);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ════════════════════════════════════════════════════════════════

// GET /api/admin/users
app.get("/api/admin/users", authenticate, adminOnly, async (req, res) => {
  const { data } = await supabase
    .from("users").select("id,username,role,name,email,department,batch,programme,is_active,created_at,last_login")
    .order("created_at", { ascending: false });
  res.json(data || []);
});

// POST /api/admin/users — Add user
app.post("/api/admin/users", authenticate, adminOnly, async (req, res) => {
  const { username, password, role, name, email, department, batch, programme } = req.body;
  if (!username || !password || !role || !name)
    return res.status(400).json({ error: "Required: username, password, role, name" });

  const hashed = await bcrypt.hash(password, 10);
  const { data, error } = await supabase.from("users").insert({
    username: username.toLowerCase().trim(),
    password: hashed, role, name, email, department, batch, programme
  }).select("id,username,role,name,email").single();

  if (error) return res.status(409).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/admin/users/:id — Update user
app.put("/api/admin/users/:id", authenticate, adminOnly, async (req, res) => {
  const { name, email, department, batch, programme, is_active } = req.body;
  const { data, error } = await supabase.from("users")
    .update({ name, email, department, batch, programme, is_active })
    .eq("id", req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// PUT /api/admin/users/:id/password — Reset password
app.put("/api/admin/users/:id/password", authenticate, adminOnly, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6)
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  const hashed = await bcrypt.hash(newPassword, 10);
  await supabase.from("users").update({ password: hashed }).eq("id", req.params.id);
  res.json({ success: true });
});

// DELETE /api/admin/users/:id
app.delete("/api/admin/users/:id", authenticate, adminOnly, async (req, res) => {
  const { data: user } = await supabase.from("users").select("role").eq("id", req.params.id).single();
  if (user?.role === "admin") return res.status(403).json({ error: "Cannot delete admin" });
  await supabase.from("users").delete().eq("id", req.params.id);
  res.json({ success: true });
});

// GET /api/admin/stats — Platform analytics
app.get("/api/admin/stats", authenticate, adminOnly, async (req, res) => {
  const [users, sessions, messages, analytics] = await Promise.all([
    supabase.from("users").select("role"),
    supabase.from("chat_sessions").select("id", { count: "exact" }),
    supabase.from("chat_messages").select("id", { count: "exact" }),
    supabase.from("usage_analytics").select("gpt_id, gpt_name")
  ]);

  const userList = users.data || [];
  const gptUsage = {};
  (analytics.data || []).forEach(a => {
    const key = a.gpt_id;
    gptUsage[key] = { name: a.gpt_name || a.gpt_id, count: (gptUsage[key]?.count || 0) + 1 };
  });
  const topGPTs = Object.values(gptUsage).sort((a,b) => b.count - a.count).slice(0, 10);

  res.json({
    totalUsers:   userList.length,
    faculty:      userList.filter(u => u.role === "faculty").length,
    students:     userList.filter(u => u.role === "student").length,
    admins:       userList.filter(u => u.role === "admin").length,
    totalSessions: sessions.count || 0,
    totalMessages: messages.count || 0,
    topGPTs
  });
});

// GET /api/admin/analytics/daily — Daily usage
app.get("/api/admin/analytics/daily", authenticate, adminOnly, async (req, res) => {
  const { data } = await supabase
    .from("usage_analytics")
    .select("created_at, gpt_id, gpt_name")
    .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false });

  // Group by day
  const daily = {};
  (data || []).forEach(row => {
    const day = row.created_at.slice(0, 10);
    daily[day] = (daily[day] || 0) + 1;
  });

  res.json(Object.entries(daily).map(([date, count]) => ({ date, count })).sort((a,b) => a.date.localeCompare(b.date)));
});

// ── Serve frontend ────────────────────────────────────────────
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "../frontend/index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`IILM AI Platform v2 → http://localhost:${PORT}`);
  console.log(`Groq model: ${process.env.GROQ_MODEL || "llama-3.3-70b-versatile"}`);
  console.log(`Supabase: ${process.env.SUPABASE_URL || "NOT SET"}`);
});
