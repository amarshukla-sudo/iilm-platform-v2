// ═══════════════════════════════════════════════════════════════
// IILM AI Platform v2 — Frontend App
// Features: Auth, Chat History, File Upload, Analytics
// ═══════════════════════════════════════════════════════════════

const API = "";
let currentUser    = null;
let currentGPT     = null;
let currentSession = null;
let isStreaming    = false;
let fileContext    = null; // { id, filename, extractedText }
let uploadedFiles  = [];

const CAT_COLORS = {
  "Teaching":    { bg:"#e8f5ee", color:"#1a7a4a", icon:"📚" },
  "Research":    { bg:"#EBF3FB", color:"#1F3864", icon:"🔬" },
  "Admin":       { bg:"#FFF8E1", color:"#B8860B", icon:"🏛️" },
  "Evaluation":  { bg:"#f0ebff", color:"#6B4EAA", icon:"📊" },
  "HR & Career": { bg:"#FDEDEC", color:"#C0392B", icon:"💼" },
  "Learning":    { bg:"#e8f5ee", color:"#1a7a4a", icon:"💡" },
  "Assignments": { bg:"#EBF3FB", color:"#1F3864", icon:"📝" },
  "Exam Prep":   { bg:"#f0ebff", color:"#6B4EAA", icon:"📖" },
  "Projects":    { bg:"#FFF8E1", color:"#B8860B", icon:"🚀" },
  "Placement":   { bg:"#FDEDEC", color:"#C0392B", icon:"🎯" }
};

const SUGGESTED = {
  f01:["Create a lesson plan for Data Structures (1 hr, B.Tech 2nd year)","Plan a 45-min lecture on Machine Learning basics"],
  f02:["Create 10 MCQs on Python programming","Generate 5 short-answer questions on Neural Networks"],
  f11:["Help me write an abstract for my deep learning paper","Structure my paper on CNN for medical imaging"],
  f31:["Create a question paper for Operating Systems (3 hrs, 100 marks)"],
  s01:["Explain backpropagation in simple terms","What is the difference between process and thread?"],
  s05:["Create a study plan for 5 subjects in 30 days"],
  s21:["Generate a mock test for Data Structures"],
  s41:["Help me write a resume for TCS campus placement"],
  s42:["Ask me HR interview questions for software engineer role"]
};

// ════════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════════
async function doLogin() {
  const username = document.getElementById("loginUsername").value.trim();
  const password = document.getElementById("loginPassword").value;
  const btn = document.getElementById("loginBtn");
  if (!username || !password) { showLoginError("Enter username and password."); return; }
  btn.textContent = "Signing in..."; btn.disabled = true;
  document.getElementById("loginError").style.display = "none";
  try {
    const res  = await fetch(`${API}/api/auth/login`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({username,password})
    });
    const data = await res.json();
    if (!res.ok) { showLoginError(data.error||"Login failed"); btn.textContent="Sign In"; btn.disabled=false; return; }
    localStorage.setItem("iilm_token", data.token);
    localStorage.setItem("iilm_user",  JSON.stringify(data.user));
    currentUser = data.user;
    initApp();
  } catch {
    showLoginError("Cannot connect to server.");
    btn.textContent="Sign In"; btn.disabled=false;
  }
}
function showLoginError(msg) {
  const el=document.getElementById("loginError");
  el.textContent=msg; el.style.display="block";
}
function doLogout() {
  localStorage.removeItem("iilm_token");
  localStorage.removeItem("iilm_user");
  currentUser=null; currentGPT=null; currentSession=null; fileContext=null;
  document.getElementById("loginPage").style.display="flex";
  document.getElementById("mainApp").classList.remove("visible");
  document.getElementById("loginUsername").value="";
  document.getElementById("loginPassword").value="";
  document.getElementById("loginBtn").textContent="Sign In";
  document.getElementById("loginBtn").disabled=false;
  document.getElementById("loginError").style.display="none";
}
function getToken() { return localStorage.getItem("iilm_token"); }

// ════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════
function initApp() {
  document.getElementById("loginPage").style.display="none";
  document.getElementById("mainApp").classList.add("visible");
  document.getElementById("navUserName").textContent = currentUser.name;
  const badge = document.getElementById("navRoleBadge");
  badge.textContent = currentUser.role.charAt(0).toUpperCase()+currentUser.role.slice(1);
  badge.className   = `nav-role-badge role-${currentUser.role}`;
  buildSidebar();
  showDashboard();
  loadHistory();
  loadFiles();
}

// ════════════════════════════════════════════════════════════════
// SIDEBAR
// ════════════════════════════════════════════════════════════════
function switchSidebarTab(tab) {
  ["assistants","history","files"].forEach(t => {
    document.getElementById(t+"Tab").style.display = t===tab?"block":"none";
    document.getElementById("tab"+t.charAt(0).toUpperCase()+t.slice(1)).classList.toggle("active", t===tab);
  });
  if (tab==="history") loadHistory();
  if (tab==="files")   loadFiles();
}

function buildSidebar(filterText="") {
  const role = currentUser.role;
  const cats = role==="faculty" ? FACULTY_CATEGORIES :
               role==="student" ? STUDENT_CATEGORIES :
               [...FACULTY_CATEGORIES,...STUDENT_CATEGORIES];
  const ft = filterText.toLowerCase();
  let html = "";

  if (role==="admin") {
    html += `<div class="category-section">
      <div class="category-header">Admin</div>
      <div class="gpt-item ${!currentGPT?'active':''}" onclick="showDashboard()">
        <span class="gpt-icon">🏠</span><div class="gpt-info"><h4>Dashboard</h4><p>Overview</p></div></div>
      <div class="gpt-item" onclick="showAdminPanel()">
        <span class="gpt-icon">⚙️</span><div class="gpt-info"><h4>Admin Panel</h4><p>Users & Analytics</p></div></div>
    </div>`;
  } else {
    html += `<div class="category-section">
      <div class="gpt-item ${!currentGPT?'active':''}" onclick="showDashboard()">
        <span class="gpt-icon">🏠</span><div class="gpt-info"><h4>Dashboard</h4><p>All AI assistants</p></div></div>
    </div>`;
  }

  cats.forEach(cat => {
    const gpts = GPTS.filter(g => {
      const roleOk = role==="admin" || g.role===role || g.role==="both";
      const catOk  = g.category===cat;
      const textOk = !ft || g.name.toLowerCase().includes(ft) || g.desc.toLowerCase().includes(ft);
      return roleOk && catOk && textOk;
    });
    if (!gpts.length) return;
    const cc = CAT_COLORS[cat]||{};
    html += `<div class="category-section">
      <div class="category-header" style="color:${cc.color||'#999'}">${cc.icon||''} ${cat}</div>`;
    gpts.forEach(g => {
      html += `<div class="gpt-item${currentGPT?.id===g.id?' active':''}" onclick="selectGPT('${g.id}')">
        <span class="gpt-icon">${g.icon}</span>
        <div class="gpt-info"><h4>${g.name}</h4><p>${g.desc.slice(0,38)}...</p></div></div>`;
    });
    html += `</div>`;
  });
  document.getElementById("sidebarContent").innerHTML = html;
}

function filterGPTs(text) { buildSidebar(text); }

// ════════════════════════════════════════════════════════════════
// HISTORY
// ════════════════════════════════════════════════════════════════
async function loadHistory() {
  try {
    const res  = await fetch(`${API}/api/chat/sessions`, { headers:{Authorization:`Bearer ${getToken()}`} });
    const data = await res.json();
    const list = document.getElementById("historyList");
    if (!data.length) { list.innerHTML=`<div style="padding:14px;font-size:12px;color:#888">No conversations yet.</div>`; return; }
    list.innerHTML = data.map(s => `
      <div class="history-item${currentSession===s.id?' active':''}" onclick="loadSession('${s.id}','${s.gpt_id}','${(s.gpt_name||s.gpt_id).replace(/'/g,"\\'")}')">
        <h5>${s.gpt_name||s.gpt_id}</h5>
        <p>${new Date(s.updated_at||s.created_at).toLocaleString("en-IN",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}</p>
      </div>`).join("");
  } catch { document.getElementById("historyList").innerHTML=`<div style="padding:14px;font-size:12px;color:#888">Load error.</div>`; }
}

async function loadSession(sessionId, gptId, gptName) {
  const gpt = getGPTById(gptId) || { id:gptId, name:gptName, icon:"💬", desc:"Previous conversation", systemPrompt:"You are a helpful AI assistant." };
  currentGPT     = gpt;
  currentSession = sessionId;

  document.getElementById("dashboardHome").style.display = "none";
  document.getElementById("chatArea").style.display      = "flex";
  document.getElementById("adminPanel").style.display    = "none";
  document.getElementById("chatHeaderIcon").textContent  = gpt.icon;
  document.getElementById("chatHeaderName").textContent  = gpt.name;
  document.getElementById("chatHeaderDesc").textContent  = gpt.desc;
  buildSidebar();

  const res  = await fetch(`${API}/api/chat/sessions/${sessionId}`, { headers:{Authorization:`Bearer ${getToken()}`} });
  const msgs = await res.json();
  const container = document.getElementById("chatMessages");
  container.innerHTML = msgs.map(m => createMessageHTML(m.role, m.content)).join("");
  container.scrollTop = container.scrollHeight;
}

// ════════════════════════════════════════════════════════════════
// FILE MANAGEMENT
// ════════════════════════════════════════════════════════════════
async function loadFiles() {
  try {
    const res  = await fetch(`${API}/api/files`, { headers:{Authorization:`Bearer ${getToken()}`} });
    uploadedFiles = await res.json();
    const list = document.getElementById("filesList");
    if (!uploadedFiles.length) {
      list.innerHTML = `<div style="padding:14px;font-size:12px;color:#888">No files uploaded yet.</div>`;
      return;
    }
    list.innerHTML = uploadedFiles.map(f => `
      <div style="padding:8px 14px;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-size:12px;font-weight:700;color:#333">${f.filename}</div>
          <div style="font-size:11px;color:#888">${(f.file_size/1024).toFixed(1)}KB · ${new Date(f.created_at).toLocaleDateString("en-IN")}</div>
        </div>
        <div style="display:flex;gap:6px;">
          <button onclick="attachFileToChat('${f.id}','${f.filename.replace(/'/g,"\\'")}','${f.id}')" 
            style="background:#EBF3FB;color:#1F3864;border:none;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer">Use</button>
          <button onclick="deleteFile('${f.id}')" 
            style="background:#FDEDEC;color:#C0392B;border:none;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer">✕</button>
        </div>
      </div>`).join("");
  } catch {}
}

async function uploadFile(input) {
  if (!input.files[0]) return;
  const file = input.files[0];
  const formData = new FormData();
  formData.append("file", file);
  showToast("Uploading " + file.name + "...");
  try {
    const res  = await fetch(`${API}/api/files/upload`, {
      method:"POST", headers:{Authorization:`Bearer ${getToken()}`}, body:formData
    });
    const data = await res.json();
    if (res.ok) {
      showToast(`✅ ${file.name} uploaded (${data.wordCount} words extracted)`);
      loadFiles();
    } else { showToast("❌ " + (data.error||"Upload failed")); }
  } catch { showToast("❌ Upload error"); }
  input.value = "";
}

async function handleChatFile(input) {
  if (!input.files[0]) return;
  const file = input.files[0];
  const statusEl = document.getElementById("fileUploadStatus");
  statusEl.style.display = "block";
  statusEl.textContent = "⏳ Extracting text from " + file.name + "...";
  statusEl.style.color = "#1F3864";

  const formData = new FormData();
  formData.append("file", file);
  try {
    const res  = await fetch(`${API}/api/files/upload`, {
      method:"POST", headers:{Authorization:`Bearer ${getToken()}`}, body:formData
    });
    const data = await res.json();
    if (res.ok) {
      fileContext = { id:data.id, filename:file.name, extractedText:data.extractedText };
      statusEl.textContent = `✅ Ready! ${data.wordCount} words extracted from ${file.name}`;
      statusEl.style.color = "#1a7a4a";
      showFileContextBanner(file.name);
      closeModal("fileModal");
      loadFiles();
    } else {
      statusEl.textContent = "❌ " + (data.error||"Failed");
      statusEl.style.color = "#C0392B";
    }
  } catch {
    statusEl.textContent = "❌ Upload error";
    statusEl.style.color = "#C0392B";
  }
}

async function attachFileToChat(fileId, filename, id) {
  try {
    const res  = await fetch(`${API}/api/files/${fileId}`, { headers:{Authorization:`Bearer ${getToken()}`} });
    const data = await res.json();
    if (res.ok) {
      fileContext = { id:fileId, filename:data.filename, extractedText:data.extracted_text };
      showFileContextBanner(data.filename);
      closeModal("fileModal");
      showToast("📄 " + data.filename + " attached to chat");
    }
  } catch { showToast("Error loading file"); }
}

function showFileContextBanner(filename) {
  const banner = document.getElementById("fileContextBanner");
  banner.style.display = "flex";
  document.getElementById("fileContextLabel").textContent = `📄 ${filename} — AI will use this document to answer your questions`;
}

function removeFileContext() {
  fileContext = null;
  document.getElementById("fileContextBanner").style.display = "none";
}

async function deleteFile(id) {
  await fetch(`${API}/api/files/${id}`, { method:"DELETE", headers:{Authorization:`Bearer ${getToken()}`} });
  if (fileContext?.id === id) removeFileContext();
  loadFiles();
  showToast("File deleted");
}

function showFileAttach() {
  document.getElementById("fileUploadStatus").style.display = "none";
  document.getElementById("chatFileInput").value = "";
  // Load recent files
  const optionsEl = document.getElementById("recentFilesOptions");
  if (uploadedFiles.length) {
    optionsEl.innerHTML = uploadedFiles.slice(0,5).map(f =>
      `<div style="padding:7px 10px;border:1px solid #ddd;border-radius:7px;margin-bottom:6px;cursor:pointer;font-size:12px;display:flex;justify-content:space-between;align-items:center;" 
        onclick="attachFileToChat('${f.id}','${f.filename.replace(/'/g,"\\'")}','${f.id}')">
        <span>📄 ${f.filename}</span>
        <span style="color:#888">${(f.file_size/1024).toFixed(0)}KB</span>
      </div>`).join("");
  } else {
    optionsEl.innerHTML = `<div style="font-size:12px;color:#888">No previous files. Upload one above.</div>`;
  }
  document.getElementById("fileModal").classList.add("open");
}

// ════════════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════════════
function showDashboard() {
  currentGPT = null; currentSession = null;
  document.getElementById("dashboardHome").style.display = "block";
  document.getElementById("chatArea").style.display      = "none";
  document.getElementById("adminPanel").style.display    = "none";
  buildSidebar();
  renderDashboard();
}

function renderDashboard() {
  const role = currentUser.role;
  const name = currentUser.name.split(" ")[0];
  document.getElementById("welcomeHeading").textContent  = `Welcome, ${name}! 👋`;
  document.getElementById("welcomeSubtitle").textContent =
    role==="admin" ? "Manage users and monitor IILM AI Platform." :
    role==="faculty" ? "Choose an AI assistant for teaching, research, or administration." :
    "Choose an AI assistant for learning, assignments, and exam preparation.";

  const cats  = role==="faculty" ? FACULTY_CATEGORIES : role==="student" ? STUDENT_CATEGORIES : [...FACULTY_CATEGORIES,...STUDENT_CATEGORIES];
  const total = role==="admin" ? GPTS.length : GPTS.filter(g=>g.role===role||g.role==="both").length;
  document.getElementById("statsRow").innerHTML = `
    <div class="stat-card"><div class="stat-num">${total}</div><div class="stat-lbl">AI Assistants</div></div>
    <div class="stat-card"><div class="stat-num">${cats.length}</div><div class="stat-lbl">Categories</div></div>
    <div class="stat-card"><div class="stat-num">${uploadedFiles.length}</div><div class="stat-lbl">My Files</div></div>
    <div class="stat-card"><div class="stat-num">24/7</div><div class="stat-lbl">Available</div></div>
  `;

  let html = "";
  cats.forEach(cat => {
    const gpts = GPTS.filter(g=>g.category===cat&&(role==="admin"||g.role===role||g.role==="both"));
    if (!gpts.length) return;
    const cc = CAT_COLORS[cat]||{};
    html += `<div class="category-card" onclick="filterAndSelect('${cat}')" style="border-color:${cc.color}22;">
      <div class="cat-icon">${cc.icon||'📁'}</div>
      <h3>${cat}</h3>
      <p>${gpts.length} specialized AI assistants</p>
      <span class="gpt-count" style="background:${cc.bg};color:${cc.color}">${gpts.length} assistants</span>
    </div>`;
  });
  document.getElementById("categoryGrid").innerHTML = html;
}

function filterAndSelect(cat) {
  document.getElementById("searchInput").value = cat;
  filterGPTs(cat);
  const role  = currentUser.role;
  const first = GPTS.find(g=>g.category===cat&&(role==="admin"||g.role===role||g.role==="both"));
  if (first) selectGPT(first.id);
}

// ════════════════════════════════════════════════════════════════
// GPT & CHAT
// ════════════════════════════════════════════════════════════════
function selectGPT(id) {
  const gpt = getGPTById(id);
  if (!gpt) return;
  currentGPT = gpt; currentSession = null;
  document.getElementById("dashboardHome").style.display = "none";
  document.getElementById("chatArea").style.display      = "flex";
  document.getElementById("adminPanel").style.display    = "none";
  document.getElementById("chatHeaderIcon").textContent  = gpt.icon;
  document.getElementById("chatHeaderName").textContent  = gpt.name;
  document.getElementById("chatHeaderDesc").textContent  = gpt.desc;
  document.getElementById("fileContextBanner").style.display = "none";
  buildSidebar();
  renderWelcome();
  document.getElementById("messageInput").focus();
}

function renderWelcome() {
  const prompts = SUGGESTED[currentGPT.id] || ["How can you help me?","Tell me what you can do","Give me an example of your capabilities"];
  document.getElementById("chatMessages").innerHTML = `
    <div class="welcome-screen">
      <div class="welcome-icon">${currentGPT.icon}</div>
      <h2>${currentGPT.name}</h2>
      <p>${currentGPT.desc}</p>
      <p style="font-size:12px;color:#888;margin-top:8px">💡 Tip: Click 📎 Attach File to upload PDF/DOCX and ask questions about it</p>
      <div class="suggested-prompts">
        ${prompts.map(p=>`<div class="suggested-prompt" onclick="sendSuggested('${p.replace(/'/g,"\\'")}')">${p}</div>`).join("")}
      </div>
    </div>`;
}

async function sendMessage() {
  if (isStreaming || !currentGPT) return;
  const input = document.getElementById("messageInput");
  const msg   = input.value.trim();
  if (!msg) return;
  input.value = ""; autoResize(input);
  appendMessage("user", msg);
  await streamResponse(msg);
}

function sendSuggested(text) {
  document.getElementById("messageInput").value = text;
  sendMessage();
}

async function streamResponse(userMessage) {
  isStreaming = true;
  document.getElementById("sendBtn").disabled = true;

  const container = document.getElementById("chatMessages");
  const typingId  = "typing_" + Date.now();
  container.insertAdjacentHTML("beforeend", `
    <div class="message ai" id="${typingId}">
      <div class="message-avatar">🤖</div>
      <div class="message-bubble">
        <div class="typing-indicator">
          <div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>
        </div>
      </div>
    </div>`);
  container.scrollTop = container.scrollHeight;

  try {
    const res = await fetch(`${API}/api/chat`, {
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${getToken()}`},
      body: JSON.stringify({
        gptId:       currentGPT.id,
        gptName:     currentGPT.name,
        message:     userMessage,
        systemPrompt: currentGPT.systemPrompt,
        sessionId:   currentSession,
        fileContext:  fileContext?.extractedText || null
      })
    });

    if (!res.ok) throw new Error("Server error");

    document.getElementById(typingId)?.remove();
    const aiDiv = document.createElement("div");
    aiDiv.className = "message ai";
    aiDiv.innerHTML = `<div class="message-avatar">🤖</div><div class="message-bubble" id="streaming_bubble"></div>`;
    container.appendChild(aiDiv);

    const bubble = document.getElementById("streaming_bubble");
    let fullText = "";
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value).split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") break;
          try {
            const obj = JSON.parse(data);
            if (obj.sessionId) currentSession = obj.sessionId;
            if (obj.text) {
              fullText += obj.text;
              bubble.innerHTML = formatAIMessage(fullText);
              container.scrollTop = container.scrollHeight;
            }
            if (obj.error) bubble.innerHTML = `<span style="color:red">${obj.error}</span>`;
          } catch {}
        }
      }
    }
    bubble.removeAttribute("id");
    loadHistory(); // refresh history sidebar

  } catch {
    document.getElementById(typingId)?.remove();
    appendMessage("assistant", "Sorry, something went wrong. Please try again.");
  }

  isStreaming = false;
  document.getElementById("sendBtn").disabled = false;
  document.getElementById("messageInput").focus();
}

function appendMessage(role, content) {
  const container = document.getElementById("chatMessages");
  const welcome   = container.querySelector(".welcome-screen");
  if (welcome) welcome.remove();
  container.insertAdjacentHTML("beforeend", createMessageHTML(role, content));
  container.scrollTop = container.scrollHeight;
}

function createMessageHTML(role, content) {
  const isAI  = role === "assistant";
  const avatar = isAI ? "🤖" : currentUser.name.charAt(0).toUpperCase();
  const formatted = isAI ? formatAIMessage(content) : escapeHtml(content);
  return `<div class="message ${isAI?'ai':'user'}">
    <div class="message-avatar">${avatar}</div>
    <div class="message-bubble">${formatted}</div>
  </div>`;
}

function formatAIMessage(text) {
  return text
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/```(\w*)\n?([\s\S]*?)```/g,(_,lang,code)=>`<pre><code>${code.trim()}</code></pre>`)
    .replace(/`([^`]+)`/g,"<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>")
    .replace(/\*(.+?)\*/g,"<em>$1</em>")
    .replace(/^### (.+)$/gm,"<h4>$1</h4>")
    .replace(/^## (.+)$/gm,"<h3>$1</h3>")
    .replace(/^# (.+)$/gm,"<h2>$1</h2>")
    .replace(/^- (.+)$/gm,"<li>$1</li>")
    .replace(/(<li>.*<\/li>)+/gs,m=>`<ul>${m}</ul>`)
    .replace(/\n\n/g,"</p><p>")
    .replace(/\n/g,"<br>");
}
function escapeHtml(t) { return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

async function clearChat() {
  if (!currentGPT) return;
  if (currentSession) {
    await fetch(`${API}/api/chat/sessions/${currentSession}`, {
      method:"DELETE", headers:{Authorization:`Bearer ${getToken()}`}
    });
    currentSession = null;
  }
  removeFileContext();
  renderWelcome();
  loadHistory();
  showToast("Chat cleared");
}

// ════════════════════════════════════════════════════════════════
// PASSWORD CHANGE
// ════════════════════════════════════════════════════════════════
function showPasswordModal() { document.getElementById("passwordModal").classList.add("open"); }

async function changePassword() {
  const cur = document.getElementById("currentPassword").value;
  const nw  = document.getElementById("newPassword").value;
  const cf  = document.getElementById("confirmPassword").value;
  const msg = document.getElementById("passwordMsg");

  if (!cur||!nw||!cf) { msg.innerHTML=`<span style="color:red">All fields required.</span>`; return; }
  if (nw !== cf) { msg.innerHTML=`<span style="color:red">New passwords don't match.</span>`; return; }
  if (nw.length < 6) { msg.innerHTML=`<span style="color:red">Minimum 6 characters.</span>`; return; }

  const res = await fetch(`${API}/api/auth/password`, {
    method:"PUT", headers:{"Content-Type":"application/json","Authorization":`Bearer ${getToken()}`},
    body: JSON.stringify({ currentPassword:cur, newPassword:nw })
  });
  const data = await res.json();
  if (res.ok) {
    msg.innerHTML=`<span style="color:green">Password changed successfully!</span>`;
    document.getElementById("currentPassword").value="";
    document.getElementById("newPassword").value="";
    document.getElementById("confirmPassword").value="";
    setTimeout(()=>closeModal("passwordModal"),1500);
  } else {
    msg.innerHTML=`<span style="color:red">${data.error}</span>`;
  }
}

// ════════════════════════════════════════════════════════════════
// ADMIN PANEL
// ════════════════════════════════════════════════════════════════
function showAdminPanel() {
  currentGPT = null; currentSession = null;
  document.getElementById("dashboardHome").style.display = "none";
  document.getElementById("chatArea").style.display      = "none";
  document.getElementById("adminPanel").style.display    = "block";
  buildSidebar();
  showAdminTab("users", document.querySelector(".admin-tab"));
}

async function showAdminTab(tab, el) {
  document.querySelectorAll(".admin-tab").forEach(t=>t.classList.remove("active"));
  if(el) el.classList.add("active");
  const content = document.getElementById("adminTabContent");

  if (tab === "users") {
    const res   = await fetch(`${API}/api/admin/users`, { headers:{Authorization:`Bearer ${getToken()}`} });
    const users = await res.json();
    content.innerHTML = `
      <div class="admin-table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Dept/Batch</th><th>Last Login</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>${users.map(u=>`
            <tr>
              <td>${u.name}</td>
              <td>${u.username}</td>
              <td><span class="badge role-${u.role}" style="background:${u.role==='faculty'?'#e8f5ee':u.role==='student'?'#EBF3FB':'#FFF8E1'};color:${u.role==='faculty'?'#1a7a4a':u.role==='student'?'#1F3864':'#B8860B'}">${u.role}</span></td>
              <td>${u.department||u.batch||'-'}</td>
              <td>${u.last_login?new Date(u.last_login).toLocaleDateString("en-IN"):'-'}</td>
              <td><span style="color:${u.is_active?'#1a7a4a':'#C0392B'}">${u.is_active?'Active':'Inactive'}</span></td>
              <td style="display:flex;gap:4px;">
                ${u.role!=='admin'?`<button class="btn-danger" onclick="deleteUser('${u.id}')">Delete</button>
                <button style="background:#EBF3FB;color:#1F3864;border:none;border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer" onclick="resetPwd('${u.id}')">Reset Pwd</button>`:'—'}
              </td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>`;

  } else if (tab === "add") {
    content.innerHTML = `
      <div class="add-user-form">
        <h3>Add New User</h3>
        <div class="form-grid">
          <input class="form-control" id="newName" placeholder="Full Name" type="text">
          <input class="form-control" id="newUsername" placeholder="Username (e.g. john.doe)" type="text">
          <input class="form-control" id="newPassword" placeholder="Password (min 6 chars)" type="password">
          <input class="form-control" id="newEmail" placeholder="Email address" type="email">
          <select class="form-control" id="newRole">
            <option value="student">Student</option>
            <option value="faculty">Faculty</option>
            <option value="admin">Admin</option>
          </select>
          <input class="form-control" id="newDept" placeholder="Department (faculty) / Batch year (student)" type="text">
          <input class="form-control" id="newProg" placeholder="Programme (e.g. B.Tech CSE)" type="text">
        </div>
        <button class="btn-primary" style="margin-top:14px" onclick="addUser()">Add User</button>
        <div id="addUserMsg" style="margin-top:10px;font-size:13px"></div>
      </div>`;

  } else if (tab === "stats") {
    const res  = await fetch(`${API}/api/admin/stats`, { headers:{Authorization:`Bearer ${getToken()}`} });
    const data = await res.json();
    const dailyRes  = await fetch(`${API}/api/admin/analytics/daily`, { headers:{Authorization:`Bearer ${getToken()}`} });
    const dailyData = await dailyRes.json();

    const maxCount = Math.max(...(data.topGPTs||[]).map(g=>g.count), 1);
    content.innerHTML = `
      <div class="stats-row" style="flex-wrap:wrap;gap:12px;margin-bottom:20px;">
        <div class="stat-card"><div class="stat-num">${data.totalUsers}</div><div class="stat-lbl">Total Users</div></div>
        <div class="stat-card"><div class="stat-num">${data.faculty}</div><div class="stat-lbl">Faculty</div></div>
        <div class="stat-card"><div class="stat-num">${data.students}</div><div class="stat-lbl">Students</div></div>
        <div class="stat-card"><div class="stat-num">${data.totalSessions}</div><div class="stat-lbl">Sessions</div></div>
        <div class="stat-card"><div class="stat-num">${data.totalMessages}</div><div class="stat-lbl">Messages</div></div>
      </div>
      <div class="analytics-grid">
        <div class="analytics-card" style="grid-column:1/-1;">
          <h4>Daily Usage (Last 30 days)</h4>
          <div style="display:flex;align-items:flex-end;gap:4px;height:80px;overflow-x:auto;">
            ${dailyData.slice(-30).map(d=>{
              const maxD = Math.max(...dailyData.map(x=>x.count), 1);
              const h    = Math.round((d.count/maxD)*70);
              return `<div title="${d.date}: ${d.count} chats" style="flex-shrink:0;width:18px;height:${h}px;background:#1F3864;border-radius:3px 3px 0 0;cursor:default;opacity:.8"></div>`;
            }).join("")}
          </div>
        </div>
        <div class="analytics-card" style="grid-column:1/-1;">
          <h4>Top AI Assistants Used</h4>
          ${(data.topGPTs||[]).map(g=>`
            <div class="bar-row">
              <div class="bar-label">${g.name}</div>
              <div class="bar-track"><div class="bar-fill" style="width:${Math.round(g.count/maxCount*100)}%"></div></div>
              <div class="bar-count">${g.count}</div>
            </div>`).join("")||'<p style="color:#888;font-size:13px">No data yet.</p>'}
        </div>
      </div>`;
  }
}

async function addUser() {
  const data = {
    name:      document.getElementById("newName").value.trim(),
    username:  document.getElementById("newUsername").value.trim(),
    password:  document.getElementById("newPassword").value,
    email:     document.getElementById("newEmail").value.trim(),
    role:      document.getElementById("newRole").value,
    department: document.getElementById("newDept").value.trim(),
    programme: document.getElementById("newProg").value.trim()
  };
  if (!data.name||!data.username||!data.password)
    { document.getElementById("addUserMsg").innerHTML=`<span style="color:red">Name, username, password required.</span>`; return; }
  const res    = await fetch(`${API}/api/admin/users`, {
    method:"POST", headers:{"Content-Type":"application/json","Authorization":`Bearer ${getToken()}`},
    body: JSON.stringify(data)
  });
  const result = await res.json();
  if (res.ok) {
    document.getElementById("addUserMsg").innerHTML=`<span style="color:green">✅ User "${data.username}" added! They can login now.</span>`;
    ["newName","newUsername","newPassword","newEmail","newDept","newProg"].forEach(id=>document.getElementById(id).value="");
  } else {
    document.getElementById("addUserMsg").innerHTML=`<span style="color:red">${result.error}</span>`;
  }
}

async function deleteUser(id) {
  if (!confirm("Delete this user? This will also delete their chat history.")) return;
  const res = await fetch(`${API}/api/admin/users/${id}`, { method:"DELETE", headers:{Authorization:`Bearer ${getToken()}`} });
  if (res.ok) { showToast("User deleted"); showAdminTab("users", document.querySelector(".admin-tab.active")); }
}

async function resetPwd(id) {
  const pwd = prompt("Enter new password for this user (min 6 chars):");
  if (!pwd || pwd.length < 6) { showToast("Password too short"); return; }
  const res = await fetch(`${API}/api/admin/users/${id}/password`, {
    method:"PUT", headers:{"Content-Type":"application/json","Authorization":`Bearer ${getToken()}`},
    body: JSON.stringify({ newPassword:pwd })
  });
  if (res.ok) showToast("✅ Password reset successfully");
  else showToast("Error resetting password");
}

// ════════════════════════════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════════════════════════════
function closeModal(id) { document.getElementById(id).classList.remove("open"); }
function handleKeyDown(e) { if (e.key==="Enter"&&!e.shiftKey) { e.preventDefault(); sendMessage(); } }
function autoResize(el) { el.style.height="auto"; el.style.height=Math.min(el.scrollHeight,120)+"px"; }
function showToast(msg) {
  const t=document.getElementById("toast");
  t.textContent=msg; t.classList.add("show");
  setTimeout(()=>t.classList.remove("show"),2500);
}

document.addEventListener("keydown",e=>{
  if (e.key==="Escape") {
    if (document.querySelector(".modal-overlay.open")) {
      document.querySelectorAll(".modal-overlay.open").forEach(m=>m.classList.remove("open"));
    } else if (currentGPT) showDashboard();
  }
});

document.addEventListener("DOMContentLoaded",()=>{
  document.getElementById("loginPassword").addEventListener("keydown",e=>{ if(e.key==="Enter") doLogin(); });
  document.getElementById("loginUsername").addEventListener("keydown",e=>{ if(e.key==="Enter") document.getElementById("loginPassword").focus(); });
  const savedToken = localStorage.getItem("iilm_token");
  const savedUser  = localStorage.getItem("iilm_user");
  if (savedToken && savedUser) { currentUser=JSON.parse(savedUser); initApp(); }
});
