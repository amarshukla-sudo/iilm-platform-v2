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

// Serve frontend — try both paths
const frontendPath1 = path.join(__dirname, "../frontend");
const frontendPath2 = path.join(__dirname, "./frontend");
if (fs.existsSync(frontendPath1)) {
  app.use(express.static(frontendPath1));
} else {
  app.use(express.static(frontendPath2));
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const apiLimiter  = rateLimit({ windowMs:15*60*1000, max:200 });
const chatLimiter = rateLimit({ windowMs:60*1000, max:30 });

const upload = multer({
  dest: "/tmp/uploads/",
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword", "text/plain"];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error("Only PDF, DOCX, TXT allowed"));
  }
});

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

// AUTH
app.post("/api/auth/login", apiLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Username and password required" });
  try {
    const { data: user, error } = await supabase
      .from("users").select("*")
      .eq("username", username.toLowerCase().trim())
      .eq("is_active", true).single();
    if (error || !user)
      return res.status(401).json({ error: "Invalid credentials" });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid)
      return res.status(401).json({ error: "Invalid credentials" });
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

app.get("/api/auth/me", authenticate, async (req, res) => {
  const { data: user } = await supabase.from("users").select("*").eq("id", req.user.id).single();
  if (!user) return res.status(404).json({ error: "Not found" });
  const { password: _, ...safe } = user;
  res.json(safe);
});

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

// CHAT
app.post("/api/chat", authenticate, chatLimiter, async (req, res) => {
  const { gptId, gptName, message, systemPrompt, sessionId, fileContext } = req.body;
  if (!message || !systemPrompt || !gptId)
    return res.status(400).json({ error: "Missing fields" });
  try {
    let sid = sessionId;
    if (!sid) {
      const { data: session } = await supabase.from("chat_sessions").insert({
        user_id: req.user.id, gpt_id: gptId, gpt_name: gptName || gptId
      }).select().single();
      sid = session?.id;
    }
    if (sid) await supabase.from("chat_messages").insert({ session_id: sid, role: "user", content: message });
    let historyMessages = [];
    if (sid) {
      const { data: history } = await supabase.from("chat_messages")
        .select("role, content").eq("session_id", sid)
        .order("created_at", { ascending: true }).limit(20);
      historyMessages = history || [];
    }
    let fullSystem = systemPrompt +
      `\n\nUser role: ${req.user.role}. User name: ${req.user.name}. Be helpful and accurate.`;
    if (fileContext) {
      fullSystem += `\n\n--- DOCUMENT ---\n${fileContext.slice(0, 4000)}\n--- END ---\nUse this document to answer questions.`;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.write(`data: ${JSON.stringify({ sessionId: sid })}\n\n`);
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
        messages: [{ role: "system", content: fullSystem }, ...historyMessages],
        stream: true, max_tokens: 2048, temperature: 0.7
      })
    });
    if (!groqRes.ok) { res.write(`data: ${JSON.stringify({ error: "AI error." })}\n\n`); return res.end(); }
    let fullResponse = "";
    groqRes.body.on("data", (chunk) => {
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;
          try {
            const obj = JSON.parse(data);
            const text = obj.choices?.[0]?.delta?.content || "";
            if (text) { fullResponse += text; res.write(`data: ${JSON.stringify({ text })}\n\n`); }
          } catch {}
        }
      }
    });
    groqRes.body.on("end", async () => {
      try {
        if (sid) await supabase.from("chat_messages").insert({ session_id: sid, role: "assistant", content: fullResponse });
        await supabase.from("usage_analytics").insert({ user_id: req.user.id, gpt_id: gptId, gpt_name: gptName || gptId });
      } catch(e) { console.error("DB save error:", e); }
      res.write("data: [DONE]\n\n"); res.end();
    });
    groqRes.body.on("error", (err) => { res.write(`data: ${JSON.stringify({ error: "Stream error" })}\n\n`); res.end(); });
  } catch (err) { res.write(`data: ${JSON.stringify({ error: "Server error." })}\n\n`); res.end(); }
});

app.get("/api/chat/sessions", authenticate, async (req, res) => {
  const { data } = await supabase.from("chat_sessions")
    .select("id, gpt_id, gpt_name, created_at, updated_at")
    .eq("user_id", req.user.id).order("updated_at", { ascending: false }).limit(50);
  res.json(data || []);
});

app.get("/api/chat/sessions/:id", authenticate, async (req, res) => {
  const { data: session } = await supabase.from("chat_sessions").select("user_id").eq("id", req.params.id).single();
  if (!session || session.user_id !== req.user.id) return res.status(403).json({ error: "Access denied" });
  const { data: messages } = await supabase.from("chat_messages")
    .select("role, content, created_at").eq("session_id", req.params.id).order("created_at", { ascending: true });
  res.json(messages || []);
});

app.delete("/api/chat/sessions/:id", authenticate, async (req, res) => {
  await supabase.from("chat_sessions").delete().eq("id", req.params.id).eq("user_id", req.user.id);
  res.json({ success: true });
});

// FILES
app.post("/api/files/upload", authenticate, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const { originalname, mimetype, path: tmpPath, size } = req.file;
  let extractedText = "";
  try {
    if (mimetype === "application/pdf") {
      const pdfParse = require("pdf-parse");
      const buffer = fs.readFileSync(tmpPath);
      const data = await pdfParse(buffer);
      extractedText = data.text;
    } else if (mimetype.includes("wordprocessingml") || mimetype === "application/msword") {
      const mammoth = require("mammoth");
      const result = await mammoth.extractRawText({ path: tmpPath });
      extractedText = result.value;
    } else if (mimetype === "text/plain") {
      extractedText = fs.readFileSync(tmpPath, "utf-8");
    }
    fs.unlinkSync(tmpPath);
    const { data: fileRecord } = await supabase.from("uploaded_files").insert({
      user_id: req.user.id, filename: originalname, file_type: mimetype,
      file_size: size, extracted_text: extractedText.slice(0, 50000)
    }).select().single();
    res.json({ id: fileRecord?.id, filename: originalname, extractedText: extractedText.slice(0, 50000), wordCount: extractedText.split(/\s+/).length, success: true });
  } catch (err) {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    res.status(500).json({ error: "Could not extract text from file" });
  }
});

app.get("/api/files", authenticate, async (req, res) => {
  const { data } = await supabase.from("uploaded_files")
    .select("id, filename, file_type, file_size, created_at")
    .eq("user_id", req.user.id).order("created_at", { ascending: false }).limit(20);
  res.json(data || []);
});

app.get("/api/files/:id", authenticate, async (req, res) => {
  const { data } = await supabase.from("uploaded_files").select("*")
    .eq("id", req.params.id).eq("user_id", req.user.id).single();
  if (!data) return res.status(404).json({ error: "File not found" });
  res.json(data);
});

app.delete("/api/files/:id", authenticate, async (req, res) => {
  await supabase.from("uploaded_files").delete().eq("id", req.params.id).eq("user_id", req.user.id);
  res.json({ success: true });
});

// ADMIN
app.get("/api/admin/users", authenticate, adminOnly, async (req, res) => {
  const { data } = await supabase.from("users")
    .select("id,username,role,name,email,department,batch,programme,is_active,created_at,last_login")
    .order("created_at", { ascending: false });
  res.json(data || []);
});

app.post("/api/admin/users", authenticate, adminOnly, async (req, res) => {
  const { username, password, role, name, email, department, batch, programme } = req.body;
  if (!username || !password || !role || !name)
    return res.status(400).json({ error: "Required: username, password, role, name" });
  const hashed = await bcrypt.hash(password, 10);
  const { data, error } = await supabase.from("users").insert({
    username: username.toLowerCase().trim(), password: hashed, role, name, email, department, batch, programme
  }).select("id,username,role,name,email").single();
  if (error) return res.status(409).json({ error: error.message });
  res.status(201).json(data);
});

app.put("/api/admin/users/:id", authenticate, adminOnly, async (req, res) => {
  const { name, email, department, batch, programme, is_active } = req.body;
  const { data, error } = await supabase.from("users")
    .update({ name, email, department, batch, programme, is_active })
    .eq("id", req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.put("/api/admin/users/:id/password", authenticate, adminOnly, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6)
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  const hashed = await bcrypt.hash(newPassword, 10);
  await supabase.from("users").update({ password: hashed }).eq("id", req.params.id);
  res.json({ success: true });
});

app.delete("/api/admin/users/:id", authenticate, adminOnly, async (req, res) => {
  const { data: user } = await supabase.from("users").select("role").eq("id", req.params.id).single();
  if (user?.role === "admin") return res.status(403).json({ error: "Cannot delete admin" });
  await supabase.from("users").delete().eq("id", req.params.id);
  res.json({ success: true });
});

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
    gptUsage[a.gpt_id] = { name: a.gpt_name || a.gpt_id, count: (gptUsage[a.gpt_id]?.count || 0) + 1 };
  });
  res.json({
    totalUsers: userList.length,
    faculty: userList.filter(u => u.role === "faculty").length,
    students: userList.filter(u => u.role === "student").length,
    admins: userList.filter(u => u.role === "admin").length,
    totalSessions: sessions.count || 0,
    totalMessages: messages.count || 0,
    topGPTs: Object.values(gptUsage).sort((a,b) => b.count - a.count).slice(0, 10)
  });
});

app.get("/api/admin/analytics/daily", authenticate, adminOnly, async (req, res) => {
  const { data } = await supabase.from("usage_analytics")
    .select("created_at, gpt_id, gpt_name")
    .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false });
  const daily = {};
  (data || []).forEach(row => { const day = row.created_at.slice(0, 10); daily[day] = (daily[day] || 0) + 1; });
  res.json(Object.entries(daily).map(([date, count]) => ({ date, count })).sort((a,b) => a.date.localeCompare(b.date)));
});

// Serve frontend for all routes
app.get("*", (req, res) => {
  const p1 = path.join(__dirname, "../frontend/index.html");
  const p2 = path.join(__dirname, "./frontend/index.html");
  res.sendFile(fs.existsSync(p1) ? p1 : p2);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`IILM AI Platform v2 running on port ${PORT}`);
  console.log(`Groq: ${process.env.GROQ_MODEL || "llama-3.3-70b-versatile"}`);
  console.log(`Supabase: ${process.env.SUPABASE_URL || "NOT SET"}`);
});
