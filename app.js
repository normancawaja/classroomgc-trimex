import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STORAGE_KEY = "classroomgc_trimex_ccs_state_v1";
const SESSION_KEY = "classroomgc_trimex_ccs_session_v1";
const THEME_KEY = "classroomgc_trimex_ccs_theme_v1";
const STORAGE_BUCKET = "classroom-files";

const FACULTY_CODE_HASH = "dddac4666da32139220bd8558d2e54b42b5f7821df50c034585ecd877a2ebf7e";

const SUPABASE_URL = "https://qtdcktysdocauzpzpxme.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF0ZGNrdHlzZG9jYXV6cHpweG1lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ3NzI5MjcsImV4cCI6MjExMDM0ODkyN30.yvkXJi0JYMR0xBw7OMFFgzhCyPJhmIqAA3e__VNh6cw";

let supabase = null;
let isSupabaseConnected = false;

async function isValidFacultyCode(input) {
  const clean = (input || "").trim();
  if (!clean) return false;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clean));
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex === FACULTY_CODE_HASH;
}

const CARD_ACCENTS = [
  "linear-gradient(90deg, #7f1d1d, #dc2626)",
  "linear-gradient(90deg, #881337, #e11d48)",
  "linear-gradient(90deg, #991b1b, #f43f5e)",
  "linear-gradient(90deg, #5c0f14, #be123c)",
  "linear-gradient(90deg, #701a75, #be185d)"
];

let appState = {
  users: [],
  announcements: [],
  messages: [],
  pms: []
};

let currentUser = null;
let selectedClass = null;
let workspaceMode = "chat";
let chatFilter = "all";
let selectedPmPartnerId = null;
let registerRole = "student";
let loginRole = "student";
let facultyAttempts = 0;

let replyTarget = null;
let pendingAttachment = null;
let editingClassTarget = null;
let notifications = [];

window.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  loadLocalState();
  await initSupabaseRealtime();
  restoreSession();
  setupSplashScreen();
  registerOfflineServiceWorker();
});

function setupSplashScreen() {
  const splash = document.getElementById("splashScreen");
  if (!splash) return;
  setTimeout(() => {
    splash.classList.add("fade-out");
    setTimeout(() => splash.remove(), 500);
  }, 1150);
}

function registerOfflineServiceWorker() {
  if ("serviceWorker" in navigator && window.location.protocol.startsWith("http")) {
    const swCode = `
      const CACHE_NAME = 'classroomgc-ccs-v4';
      self.addEventListener('install', (e) => {
        self.skipWaiting();
        e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(['./', './index.html', './style.css', './app.js'])));
      });
      self.addEventListener('fetch', (e) => {
        e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).catch(() => caches.match('./index.html'))));
      });
    `;
    const blob = new Blob([swCode], { type: "application/javascript" });
    navigator.serviceWorker.register(URL.createObjectURL(blob)).catch(() => {});
  }
}

function updateSyncBadges(online) {
  isSupabaseConnected = online;
  const authBadge = document.getElementById("syncStatusAuth");
  const appBadge = document.getElementById("syncStatusApp");
  [authBadge, appBadge].forEach((el) => {
    if (!el) return;
    if (online) {
      el.textContent = "🟢 Live Cloud Sync";
      el.className = "badge badge-online";
    } else {
      el.textContent = "⚡ Local Ready";
      el.className = "badge badge-offline";
    }
  });
}

async function initSupabaseRealtime() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    updateSyncBadges(false);
    return;
  }
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await supabase
      .from("classroomgc_state")
      .select("payload")
      .eq("id", "main")
      .single();

    if (!error && data && data.payload) {
      appState = {
        users: Array.isArray(data.payload.users) ? data.payload.users : appState.users,
        announcements: Array.isArray(data.payload.announcements) ? data.payload.announcements : appState.announcements,
        messages: Array.isArray(data.payload.messages) ? data.payload.messages : appState.messages,
        pms: Array.isArray(data.payload.pms) ? data.payload.pms : appState.pms
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
    }

    supabase
      .channel("classroomgc-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "classroomgc_state", filter: "id=eq.main" },
        (payload) => {
          if (payload.new && payload.new.payload) {
            appState = payload.new.payload;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
            if (currentUser) {
              currentUser = appState.users.find((u) => u.id === currentUser.id) || currentUser;
              if (selectedClass) {
                if (workspaceMode === "chat") renderApp();
                else renderPmWorkspace();
              } else {
                renderDashboard();
              }
            }
          }
        }
      )
      .subscribe((status) => {
        updateSyncBadges(status === "SUBSCRIBED");
      });
  } catch (err) {
    console.warn("Supabase fallback to offline storage:", err);
    updateSyncBadges(false);
  }
}

async function pushStateToSupabase() {
  if (!supabase || !isSupabaseConnected) return;
  try {
    await supabase
      .from("classroomgc_state")
      .upsert({ id: "main", payload: appState, updated_at: new Date().toISOString() });
  } catch (err) {
    console.warn("Cloud sync delayed:", err);
  }
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || "dark";
  document.documentElement.setAttribute("data-theme", saved);
  const toggleAuth = document.getElementById("themeToggleAuth");
  const toggleApp = document.getElementById("themeToggleApp");
  if (toggleAuth) toggleAuth.addEventListener("click", toggleTheme);
  if (toggleApp) toggleApp.addEventListener("click", toggleTheme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem(THEME_KEY, next);
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      appState = {
        users: Array.isArray(parsed.users) ? parsed.users : [],
        announcements: Array.isArray(parsed.announcements) ? parsed.announcements : [],
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        pms: Array.isArray(parsed.pms) ? parsed.pms : []
      };
    } else {
      seedSampleData();
    }
  } catch (err) {
    console.warn("Failed to load local state:", err);
    seedSampleData();
  }
}

function seedSampleData() {
  const teacherId = "usr_prof_santos";
  appState = {
    users: [
      {
        id: teacherId,
        role: "teacher",
        name: "Prof. Elena Santos",
        email: "elena.santos@trimexcolleges.edu.ph",
        password: "password123",
        classes: [
          { sectionCode: "ITNSA3M1", subjectName: "Network Administration & Security" },
          { sectionCode: "ITNSA3M2", subjectName: "Network Administration & Security" },
          { sectionCode: "COMSCI3M1", subjectName: "Operating Systems & Architecture" }
        ]
      },
      {
        id: "usr_student_juan",
        role: "student",
        name: "Juan Dela Cruz",
        email: "juan.delacruz@student.trimexcolleges.edu.ph",
        password: "password123",
        sectionCode: "ITNSA3M1"
      }
    ],
    announcements: [
      {
        id: "ann_1",
        teacherId,
        teacherName: "Prof. Elena Santos",
        sectionCode: "ITNSA3M1",
        subjectName: "Network Administration & Security",
        title: "Midterm Cisco Packet Tracer Topology Submission",
        body: "Please upload your VLAN & Inter-VLAN routing .pkt file before Friday 5:00 PM. Drop any configuration questions in our Class Group Chat!",
        createdAt: new Date().toISOString()
      }
    ],
    messages: [
      {
        id: "msg_1",
        teacherId,
        sectionCode: "ITNSA3M1",
        subjectName: "Network Administration & Security",
        senderId: teacherId,
        senderName: "Prof. Elena Santos",
        senderRole: "teacher",
        text: "Good day ITNSA3M1! Welcome to our official ClassRoomGC subject hub. Use this space for subject announcements, lab files, and Q&A.",
        answered: false,
        reactions: { "👍": ["usr_student_juan"] },
        replyTo: null,
        attachment: null,
        createdAt: new Date().toISOString()
      }
    ],
    pms: []
  };
  saveState();
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
    pushStateToSupabase();
  } catch (err) {
    showToast("Storage limit reached. Try exporting a backup JSON.", "error");
  }
}

function restoreSession() {
  const userId = localStorage.getItem(SESSION_KEY);
  if (!userId) return;
  const found = appState.users.find((u) => u.id === userId);
  if (found) {
    currentUser = found;
    enterAppView();
  }
}

function showToast(msg, type = "info") {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 220);
  }, 3000);
}

function pushNotification(text) {
  notifications.unshift({ id: Date.now(), text, time: formatTime(new Date().toISOString()) });
  renderNotifications();
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("ClassRoomGC — Trimex CCS", { body: text });
  }
}

function renderNotifications() {
  const badge = document.getElementById("notifBellBadge");
  const list = document.getElementById("notifList");
  if (!badge || !list) return;

  if (notifications.length > 0) {
    badge.textContent = notifications.length;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }

  if (notifications.length === 0) {
    list.innerHTML = `<div style="font-size:0.78rem; color:var(--text-muted); padding:10px; text-align:center;">No new notifications</div>`;
    return;
  }

  list.innerHTML = notifications
    .map(
      (n) => `
      <div class="notif-item">
        <div>${escapeHtml(n.text)}</div>
        <div style="font-size:0.7rem; color:var(--text-muted); margin-top:3px;">${n.time}</div>
      </div>`
    )
    .join("");
}

window.toggleNotifDrawer = function () {
  const pop = document.getElementById("notifPopover");
  if (pop) {
    pop.classList.toggle("hidden");
    renderNotifications();
  }
};

window.clearNotifHistory = function () {
  notifications = [];
  renderNotifications();
};

window.enableBrowserNotifications = function () {
  if (!("Notification" in window)) {
    showToast("Browser notifications not supported on this device.", "error");
    return;
  }
  Notification.requestPermission().then((perm) => {
    showToast(perm === "granted" ? "Desktop/Mobile alerts enabled!" : "Notification permission declined.");
  });
};

window.switchAuthTab = function (tab) {
  const loginForm = document.getElementById("loginForm");
  const regForm = document.getElementById("registerForm");
  const tabLoginBtn = document.getElementById("tabLoginBtn");
  const tabRegisterBtn = document.getElementById("tabRegisterBtn");

  if (tab === "login") {
    loginForm.classList.remove("hidden");
    regForm.classList.add("hidden");
    tabLoginBtn.classList.add("active");
    tabRegisterBtn.classList.remove("active");
  } else {
    loginForm.classList.add("hidden");
    regForm.classList.remove("hidden");
    tabLoginBtn.classList.remove("active");
    tabRegisterBtn.classList.add("active");
  }
};

window.selectLoginRole = function (role) {
  loginRole = role;
  const sBtn = document.getElementById("loginRoleStudentBtn");
  const tBtn = document.getElementById("loginRoleTeacherBtn");
  const guard = document.getElementById("loginFacultyGuard");
  const label = document.getElementById("loginEmailLabel");
  const emailInput = document.getElementById("loginEmail");
  const submitBtn = document.getElementById("loginSubmitBtn");

  if (role === "teacher") {
    sBtn.classList.remove("active");
    tBtn.classList.add("active", "teacher-role");
    guard.classList.remove("hidden");
    label.textContent = "Faculty Email (@trimexcolleges.edu.ph)";
    emailInput.placeholder = "name@trimexcolleges.edu.ph";
    submitBtn.textContent = "Sign In to Faculty Admin Portal →";
    submitBtn.className = "btn btn-teacher";
  } else {
    tBtn.classList.remove("active", "teacher-role");
    sBtn.classList.add("active");
    guard.classList.add("hidden");
    label.textContent = "Student Email (@student.trimexcolleges.edu.ph)";
    emailInput.placeholder = "name@student.trimexcolleges.edu.ph";
    submitBtn.textContent = "Sign In as Student →";
    submitBtn.className = "btn btn-primary";
  }
};

window.selectRegisterRole = function (role) {
  registerRole = role;
  const sBtn = document.getElementById("roleStudentBtn");
  const tBtn = document.getElementById("roleTeacherBtn");
  const sFields = document.getElementById("studentFields");
  const tFields = document.getElementById("teacherFields");
  const emailLabel = document.getElementById("regEmailLabel");
  const emailInput = document.getElementById("regEmail");
  const submitBtn = document.getElementById("registerSubmitBtn");

  if (role === "teacher") {
    sBtn.classList.remove("active");
    tBtn.classList.add("active", "teacher-role");
    sFields.classList.add("hidden");
    tFields.classList.remove("hidden");
    emailLabel.textContent = "Faculty Email (@trimexcolleges.edu.ph)";
    emailInput.placeholder = "name@trimexcolleges.edu.ph";
    submitBtn.className = "btn btn-teacher";
  } else {
    tBtn.classList.remove("active", "teacher-role");
    sBtn.classList.add("active");
    tFields.classList.add("hidden");
    sFields.classList.remove("hidden");
    emailLabel.textContent = "Student Email (@student.trimexcolleges.edu.ph)";
    emailInput.placeholder = "name@student.trimexcolleges.edu.ph";
    submitBtn.className = "btn btn-primary";
  }
};

window.togglePassword = function (inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (input.type === "password") {
    input.type = "text";
    btn.textContent = "Hide";
  } else {
    input.type = "password";
    btn.textContent = "Show";
  }
};

window.updateStudentSectionPreview = function () {
  const raw = document.getElementById("regStudentSection").value;
  const clean = normalizeSection(raw);
  document.getElementById("studentSectionPreview").textContent = `SECTION: ${clean || "—"}`;
};

window.updateTeacherSectionsPreview = function () {
  const raw = document.getElementById("regTeacherSections").value;
  const list = parseSectionsList(raw);
  document.getElementById("teacherSectionsCount").textContent = `${list.length} section${list.length === 1 ? "" : "s"}`;
};

function normalizeSection(str) {
  return (str || "").replace(/\s+/g, "").toUpperCase();
}

function parseSectionsList(str) {
  return Array.from(
    new Set(
      (str || "")
        .split(",")
        .map((s) => normalizeSection(s))
        .filter(Boolean)
    )
  );
}

window.handleLogin = async function (e) {
  e.preventDefault();
  const email = document.getElementById("loginEmail").value.trim().toLowerCase();
  const password = document.getElementById("loginPassword").value;

  if (loginRole === "teacher") {
    const code = document.getElementById("loginFacultyCode").value.trim();
    const ok = await isValidFacultyCode(code);
    if (!ok) {
      facultyAttempts++;
      const alertEl = document.getElementById("loginFacultyLockoutMsg");
      alertEl.textContent = `Invalid Faculty Access Code (Attempt ${facultyAttempts}).`;
      alertEl.classList.remove("hidden");
      return;
    }
  }

  const user = appState.users.find(
    (u) => u.email.toLowerCase() === email && u.password === password && u.role === loginRole
  );

  if (!user) {
    showToast("Invalid credentials or role mismatch. Please verify your email and password.", "error");
    return;
  }

  currentUser = user;
  localStorage.setItem(SESSION_KEY, user.id);
  showToast(`Welcome back, ${user.name}!`, "success");
  enterAppView();
};

window.handleRegister = async function (e) {
  e.preventDefault();
  const name = document.getElementById("regName").value.trim();
  const email = document.getElementById("regEmail").value.trim().toLowerCase();
  const password = document.getElementById("regPassword").value;

  if (appState.users.some((u) => u.email.toLowerCase() === email)) {
    showToast("An account with this school email already exists.", "error");
    return;
  }

  if (registerRole === "student") {
    if (!email.endsWith("@student.trimexcolleges.edu.ph")) {
      showToast("Students must register using @student.trimexcolleges.edu.ph", "error");
      return;
    }
    const sectionCode = normalizeSection(document.getElementById("regStudentSection").value);
    if (!sectionCode) {
      showToast("Please enter your exact section code (e.g., ITNSA3M1).", "error");
      return;
    }

    const newUser = {
      id: "usr_" + Date.now(),
      role: "student",
      name,
      email,
      password,
      sectionCode
    };
    appState.users.push(newUser);
    saveState();
    currentUser = newUser;
    localStorage.setItem(SESSION_KEY, newUser.id);
    showToast(`Student account created for section ${sectionCode}!`, "success");
    enterAppView();
  } else {
    if (!email.endsWith("@trimexcolleges.edu.ph")) {
      showToast("Faculty must register using @trimexcolleges.edu.ph", "error");
      return;
    }
    const code = document.getElementById("regFacultyCode").value.trim();
    const ok = await isValidFacultyCode(code);
    if (!ok) {
      const alertEl = document.getElementById("facultyLockoutMsg");
      alertEl.textContent = "Invalid Official Faculty Access Code. Contact your CCS Department Chair.";
      alertEl.classList.remove("hidden");
      return;
    }
    const subjectName = document.getElementById("regTeacherSubject").value.trim();
    const sections = parseSectionsList(document.getElementById("regTeacherSections").value);
    if (!subjectName || sections.length === 0) {
      showToast("Please enter a subject name and at least one handled section.", "error");
      return;
    }

    const newTeacher = {
      id: "usr_" + Date.now(),
      role: "teacher",
      name,
      email,
      password,
      classes: sections.map((sec) => ({ sectionCode: sec, subjectName }))
    };
    appState.users.push(newTeacher);
    saveState();
    currentUser = newTeacher;
    localStorage.setItem(SESSION_KEY, newTeacher.id);
    showToast(`Faculty account created with ${sections.length} classroom(s)!`, "success");
    enterAppView();
  }
};

window.handleResetPassword = async function (e) {
  e.preventDefault();
  const email = document.getElementById("resetEmail").value.trim().toLowerCase();
  const verification = document.getElementById("resetVerification").value.trim();
  const newPassword = document.getElementById("resetNewPassword").value;

  const user = appState.users.find((u) => u.email.toLowerCase() === email);
  if (!user) {
    showToast("No account found with that registered email.", "error");
    return;
  }

  const isValid =
    user.role === "teacher"
      ? await isValidFacultyCode(verification)
      : normalizeSection(verification) === normalizeSection(user.sectionCode);

  if (!isValid) {
    showToast("Verification key or section code did not match.", "error");
    return;
  }

  user.password = newPassword;
  saveState();
  closeAllModals();
  e.target.reset();
  showToast("Password updated! You can now sign in with your new password.", "success");
};

window.handleLogout = function () {
  currentUser = null;
  selectedClass = null;
  localStorage.removeItem(SESSION_KEY);
  document.getElementById("appView").classList.add("hidden");
  document.getElementById("authView").classList.remove("hidden");
  showToast("Signed out safely.");
};

function enterAppView() {
  document.getElementById("authView").classList.add("hidden");
  document.getElementById("appView").classList.remove("hidden");

  document.getElementById("headerUserName").textContent = currentUser.name;
  const tagEl = document.getElementById("headerUserTag");
  const roleIcon = document.getElementById("headerUserRoleIcon");

  if (currentUser.role === "teacher") {
    tagEl.textContent = "FACULTY ADMIN";
    tagEl.className = "badge badge-teacher";
    roleIcon.textContent = "👩‍🏫";
    roleIcon.classList.remove("hidden");
    document.getElementById("dashAddSectionBtn").classList.remove("hidden");
  } else {
    tagEl.textContent = currentUser.sectionCode;
    tagEl.className = "badge badge-section";
    roleIcon.textContent = "🎒";
    roleIcon.classList.remove("hidden");
    document.getElementById("dashAddSectionBtn").classList.add("hidden");
  }

  goToDashboard();
}

window.goToDashboard = function () {
  selectedClass = null;
  document.getElementById("roomView").classList.add("hidden");
  document.getElementById("dashboardView").classList.remove("hidden");
  renderDashboard();
};

function getAvailableClassesForUser() {
  if (!currentUser) return [];
  if (currentUser.role === "teacher") {
    return (currentUser.classes || []).map((cls) => ({
      teacherId: currentUser.id,
      teacherName: currentUser.name,
      sectionCode: cls.sectionCode,
      subjectName: cls.subjectName
    }));
  }

  const list = [];
  appState.users
    .filter((u) => u.role === "teacher")
    .forEach((teacher) => {
      (teacher.classes || []).forEach((cls) => {
        if (normalizeSection(cls.sectionCode) === normalizeSection(currentUser.sectionCode)) {
          list.push({
            teacherId: teacher.id,
            teacherName: teacher.name,
            sectionCode: cls.sectionCode,
            subjectName: cls.subjectName
          });
        }
      });
    });
  return list;
}

window.renderDashboard = function () {
  const grid = document.getElementById("subjectGrid");
  const query = (document.getElementById("subjectSearchInput").value || "").trim().toLowerCase();
  const classes = getAvailableClassesForUser();

  document.getElementById("dashGreeting").textContent =
    currentUser.role === "teacher"
      ? `Faculty Subjects • ${currentUser.name}`
      : `My Section Subjects (${currentUser.sectionCode})`;
  document.getElementById("slotCounterBadge").textContent = `${classes.length} Subject${classes.length === 1 ? "" : "s"}`;

  const filtered = classes.filter(
    (c) =>
      c.subjectName.toLowerCase().includes(query) ||
      c.sectionCode.toLowerCase().includes(query) ||
      c.teacherName.toLowerCase().includes(query)
  );

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <h3>No Subject Rooms Found</h3>
        <p>${
          currentUser.role === "teacher"
            ? "Click '+ Add Subject / Class' above to create a section classroom."
            : `No faculty has created a subject room for section <strong>${escapeHtml(currentUser.sectionCode)}</strong> yet.`
        }</p>
      </div>`;
    return;
  }

  grid.innerHTML = filtered
    .map((cls, idx) => {
      const accent = CARD_ACCENTS[idx % CARD_ACCENTS.length];
      const msgCount = appState.messages.filter(
        (m) =>
          m.teacherId === cls.teacherId &&
          m.sectionCode === cls.sectionCode &&
          m.subjectName === cls.subjectName
      ).length;
      const studentCount = appState.users.filter(
        (u) => u.role === "student" && normalizeSection(u.sectionCode) === normalizeSection(cls.sectionCode)
      ).length;

      const teacherControls =
        currentUser.role === "teacher"
          ? `<div style="display:flex; gap:6px;" onclick="event.stopPropagation()">
               <button class="action-link" onclick="openEditClassModal('${escapeAttr(cls.sectionCode)}', '${escapeAttr(cls.subjectName)}')">✏️</button>
               <button class="action-link danger" onclick="deleteClassRoom('${escapeAttr(cls.sectionCode)}', '${escapeAttr(cls.subjectName)}')">🗑️</button>
             </div>`
          : "";

      return `
        <div class="subject-card" onclick="openClassRoom('${escapeAttr(cls.teacherId)}', '${escapeAttr(cls.sectionCode)}', '${escapeAttr(cls.subjectName)}')">
          <div>
            <div class="card-accent-bar" style="background: ${accent};"></div>
            <div class="card-body">
              <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
                <span class="badge badge-section">${escapeHtml(cls.sectionCode)}</span>
                ${teacherControls}
              </div>
              <h3 class="card-title">${escapeHtml(cls.subjectName)}</h3>
              <div class="card-prof">👩‍🏫 ${escapeHtml(cls.teacherName)}</div>
            </div>
          </div>
          <div class="card-footer">
            <span>👥 ${studentCount} Student${studentCount === 1 ? "" : "s"}</span>
            <span>💬 ${msgCount} Message${msgCount === 1 ? "" : "s"} →</span>
          </div>
        </div>`;
    })
    .join("");
};

window.handleCreateClass = function (e) {
  e.preventDefault();
  if (!currentUser || currentUser.role !== "teacher") return;
  const subjectName = document.getElementById("newClassSubject").value.trim();
  const sectionCode = normalizeSection(document.getElementById("newClassSection").value);
  if (!subjectName || !sectionCode) return;

  currentUser.classes = currentUser.classes || [];
  const exists = currentUser.classes.some(
    (c) => normalizeSection(c.sectionCode) === sectionCode && c.subjectName.toLowerCase() === subjectName.toLowerCase()
  );
  if (exists) {
    showToast("That subject & section room already exists.", "error");
    return;
  }

  currentUser.classes.push({ sectionCode, subjectName });
  saveState();
  closeAllModals();
  e.target.reset();
  renderDashboard();
  showToast(`Created ${subjectName} (${sectionCode})!`, "success");
};

window.openEditClassModal = function (sectionCode, subjectName) {
  editingClassTarget = { sectionCode, subjectName };
  document.getElementById("editClassSubject").value = subjectName;
  document.getElementById("editClassSection").value = sectionCode;
  openModal("editSubjectModal");
};

window.handleEditClass = function (e) {
  e.preventDefault();
  if (!currentUser || currentUser.role !== "teacher" || !editingClassTarget) return;
  const newSubject = document.getElementById("editClassSubject").value.trim();
  const newSection = normalizeSection(document.getElementById("editClassSection").value);
  if (!newSubject || !newSection) return;

  const target = (currentUser.classes || []).find(
    (c) => c.sectionCode === editingClassTarget.sectionCode && c.subjectName === editingClassTarget.subjectName
  );
  if (target) {
    target.subjectName = newSubject;
    target.sectionCode = newSection;
    saveState();
    renderDashboard();
    showToast("Subject classroom updated.", "success");
  }
  editingClassTarget = null;
  closeAllModals();
};

window.deleteClassRoom = function (sectionCode, subjectName) {
  if (!currentUser || currentUser.role !== "teacher") return;
  if (!confirm(`Delete ${subjectName} (${sectionCode})?`)) return;
  currentUser.classes = (currentUser.classes || []).filter(
    (c) => !(c.sectionCode === sectionCode && c.subjectName === subjectName)
  );
  saveState();
  renderDashboard();
  showToast("Classroom removed.");
};

window.openClassRoom = function (teacherId, sectionCode, subjectName) {
  const teacher = appState.users.find((u) => u.id === teacherId);
  if (!teacher) return;

  selectedClass = {
    teacherId: teacher.id,
    teacherName: teacher.name,
    sectionCode,
    subjectName
  };

  document.getElementById("dashboardView").classList.add("hidden");
  document.getElementById("roomView").classList.remove("hidden");

  document.getElementById("roomSubjectTitle").textContent = subjectName;
  document.getElementById("roomSectionBadge").textContent = sectionCode;
  document.getElementById("roomTeacherSubtitle").textContent = `Instructor: ${teacher.name} (${teacher.email})`;

  const studentCount = appState.users.filter(
    (u) => u.role === "student" && normalizeSection(u.sectionCode) === normalizeSection(sectionCode)
  ).length;
  document.getElementById("roomMemberCount").textContent = `👥 ${studentCount} Student${studentCount === 1 ? "" : "s"}`;

  if (currentUser.role === "teacher") {
    document.getElementById("newAnnouncementBtn").classList.remove("hidden");
    document.getElementById("pmTabLabel").textContent = "📥 Student PM Inbox";
  } else {
    document.getElementById("newAnnouncementBtn").classList.add("hidden");
    document.getElementById("pmTabLabel").textContent = `🔒 PM ${teacher.name}`;
  }

  workspaceMode = "chat";
  chatFilter = "all";
  clearComposerAttachments();
  switchWorkspaceMode("chat");
};

window.switchWorkspaceMode = function (mode) {
  workspaceMode = mode;
  const tabChat = document.getElementById("tabGroupChat");
  const tabPm = document.getElementById("tabPrivateMsg");
  const chatSpace = document.getElementById("groupChatWorkspace");
  const pmSpace = document.getElementById("pmWorkspace");

  if (mode === "chat") {
    tabChat.classList.add("active");
    tabPm.classList.remove("active");
    chatSpace.classList.remove("hidden");
    pmSpace.classList.add("hidden");
    renderApp();
  } else {
    tabPm.classList.add("active");
    tabChat.classList.remove("active");
    chatSpace.classList.add("hidden");
    pmSpace.classList.remove("hidden");
    renderPmWorkspace();
  }
};

window.setChatFilter = function (filter) {
  chatFilter = filter;
  document.getElementById("filterAllBtn").classList.toggle("active", filter === "all");
  document.getElementById("filterAnsweredBtn").classList.toggle("active", filter === "answered");
  document.getElementById("filterMediaBtn").classList.toggle("active", filter === "media");
  renderApp();
};

window.renderApp = function () {
  if (!selectedClass) return;
  renderPinnedAnnouncements();
  renderGroupMessages();
  updatePmUnreadBadge();
};

function renderPinnedAnnouncements() {
  const listEl = document.getElementById("pinnedList");
  const anns = appState.announcements.filter(
    (a) =>
      a.teacherId === selectedClass.teacherId &&
      a.sectionCode === selectedClass.sectionCode &&
      a.subjectName === selectedClass.subjectName
  );

  if (anns.length === 0) {
    listEl.innerHTML = `<div style="font-size:0.78rem; color:var(--text-muted);">No pinned announcements for this subject yet.</div>`;
    return;
  }

  listEl.innerHTML = anns
    .map((a) => {
      const delBtn =
        currentUser.role === "teacher"
          ? `<button class="action-link danger" onclick="deleteAnnouncement('${a.id}')" title="Unpin">✕</button>`
          : "";
      return `
        <div class="pinned-card">
          <div class="pinned-card-head">
            <span>${escapeHtml(a.title)}</span>
            ${delBtn}
          </div>
          <div style="color:var(--text-secondary); font-size:0.76rem;">${formatMessageWithResourceCards(a.body)}</div>
          <div style="color:var(--text-muted); font-size:0.68rem; margin-top:4px;">${formatTime(a.createdAt)}</div>
        </div>`;
    })
    .join("");
}

window.handlePostAnnouncement = function (e) {
  e.preventDefault();
  if (!currentUser || currentUser.role !== "teacher" || !selectedClass) return;
  const title = document.getElementById("annTitleInput").value.trim();
  const body = document.getElementById("annBodyInput").value.trim();
  if (!title || !body) return;

  appState.announcements.unshift({
    id: "ann_" + Date.now(),
    teacherId: selectedClass.teacherId,
    teacherName: currentUser.name,
    sectionCode: selectedClass.sectionCode,
    subjectName: selectedClass.subjectName,
    title,
    body,
    createdAt: new Date().toISOString()
  });

  saveState();
  closeAllModals();
  e.target.reset();
  renderPinnedAnnouncements();
  pushNotification(`New announcement in ${selectedClass.subjectName}: ${title}`);
  showToast("Announcement pinned!", "success");
};

window.deleteAnnouncement = function (annId) {
  appState.announcements = appState.announcements.filter((a) => a.id !== annId);
  saveState();
  renderPinnedAnnouncements();
  showToast("Announcement unpinned.");
};

function formatMessageWithResourceCards(rawText) {
  const escaped = escapeHtml(rawText || "");
  const urlRegex = /(https?:\/\/[^\s<]+)/g;
  const links = [];

  const linkedText = escaped.replace(urlRegex, (url) => {
    links.push(url);
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color: var(--accent-primary, #60a5fa); text-decoration: underline; word-break: break-all;">${url}</a>`;
  });

  if (links.length === 0) return linkedText;

  const cardsHtml = links
    .map((url) => {
      let label = "External Web Resource";
      let icon = "🔗";
      if (url.includes("drive.google.com") || url.includes("docs.google.com")) {
        label = "Google Drive / Docs Resource";
        icon = "📁";
      } else if (url.includes("onedrive.live.com") || url.includes("sharepoint.com")) {
        label = "OneDrive / Office File";
        icon = "📊";
      } else if (url.includes("canva.com")) {
        label = "Canva Presentation / Design";
        icon = "🎨";
      } else if (url.includes("youtube.com") || url.includes("youtu.be")) {
        label = "YouTube Video Lesson";
        icon = "▶️";
      }
      return `
        <a href="${url}" target="_blank" rel="noopener noreferrer" style="display:flex; align-items:center; gap:10px; margin-top:8px; padding:10px 12px; border-radius:10px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); text-decoration:none; color:inherit;">
          <span style="font-size:1.3rem;">${icon}</span>
          <div style="overflow:hidden;">
            <div style="font-size:0.8rem; font-weight:700;">${label}</div>
            <div style="font-size:0.72rem; opacity:0.75; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${url}</div>
          </div>
        </a>
      `;
    })
    .join("");

  return `${linkedText}${cardsHtml}`;
}

function renderGroupMessages() {
  const feed = document.getElementById("chatFeed");
  const query = (document.getElementById("chatSearchInput").value || "").trim().toLowerCase();

  let msgs = appState.messages.filter(
    (m) =>
      m.teacherId === selectedClass.teacherId &&
      m.sectionCode === selectedClass.sectionCode &&
      m.subjectName === selectedClass.subjectName
  );

  if (chatFilter === "answered") {
    msgs = msgs.filter((m) => m.answered);
  } else if (chatFilter === "media") {
    msgs = msgs.filter((m) => m.attachment !== null || (m.text && /https?:\/\//i.test(m.text)));
  }

  if (query) {
    msgs = msgs.filter(
      (m) =>
        (m.text && m.text.toLowerCase().includes(query)) ||
        (m.senderName && m.senderName.toLowerCase().includes(query))
    );
  }

  if (msgs.length === 0) {
    feed.innerHTML = `
      <div class="empty-state">
        <h4>No messages here yet</h4>
        <p>Start the discussion for <strong>${escapeHtml(selectedClass.subjectName)}</strong> (${escapeHtml(selectedClass.sectionCode)}).</p>
      </div>`;
    return;
  }

  feed.innerHTML = msgs
    .map((m) => {
      const isSelf = m.senderId === currentUser.id;
      const isTeacher = m.senderRole === "teacher";
      const rowClass = `msg-row ${isSelf ? "self" : "other"} ${isTeacher ? "teacher-msg" : ""}`;

      const replyHtml = m.replyTo
        ? `<div class="reply-quote"><strong>↩ ${escapeHtml(m.replyTo.senderName)}:</strong> ${escapeHtml(m.replyTo.text)}</div>`
        : "";

      let attachmentHtml = "";
      if (m.attachment) {
        if (m.attachment.type === "image") {
          attachmentHtml = `<img src="${m.attachment.url}" alt="Attachment" class="msg-attachment-img" onclick="openLightbox('${m.attachment.url}')" />`;
        } else if (m.attachment.type === "link") {
          attachmentHtml = `<a href="${escapeAttr(m.attachment.url)}" target="_blank" rel="noopener" class="msg-attachment-card">🔗 <span>${escapeHtml(m.attachment.name)}</span></a>`;
        } else {
          attachmentHtml = `<a href="${m.attachment.url}" target="_blank" rel="noopener" download="${escapeAttr(m.attachment.name)}" class="msg-attachment-card">📎 <span>${escapeHtml(m.attachment.name)}</span></a>`;
        }
      }

      const emojis = ["👍", "❤️", "✅"];
      const reactionsHtml = emojis
        .map((em) => {
          const users = (m.reactions && m.reactions[em]) || [];
          const reacted = users.includes(currentUser.id);
          return `<button type="button" class="reaction-pill ${reacted ? "reacted" : ""}" onclick="toggleReaction('${m.id}', '${em}')">${em} ${users.length || ""}</button>`;
        })
        .join("");

      const teacherModBtns =
        currentUser.role === "teacher"
          ? `<button type="button" class="action-link" onclick="toggleMessageAnswered('${m.id}')">${m.answered ? "Unmark" : "✅ Mark Answered"}</button>
             <button type="button" class="action-link danger" onclick="deleteGroupMessage('${m.id}')">🗑️</button>`
          : isSelf
          ? `<button type="button" class="action-link danger" onclick="deleteGroupMessage('${m.id}')">🗑️</button>`
          : "";

      return `
        <div class="${rowClass}">
          <div class="msg-meta">
            <strong>${escapeHtml(m.senderName)}</strong>
            ${isTeacher ? `<span class="badge badge-teacher">Faculty</span>` : ""}
            ${m.answered ? `<span class="badge badge-answered">✓ Answered</span>` : ""}
            <span>${formatTime(m.createdAt)}</span>
          </div>
          <div class="msg-bubble">
            ${replyHtml}
            <div>${formatMessageWithResourceCards(m.text)}</div>
            ${attachmentHtml}
          </div>
          <div class="msg-actions">
            ${reactionsHtml}
            <button type="button" class="action-link" onclick="setReplyTarget('${m.id}')">↩ Reply</button>
            ${teacherModBtns}
          </div>
        </div>`;
    })
    .join("");

  feed.scrollTop = feed.scrollHeight;
}

window.handleChatKeydown = function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendGroupMessage();
  }
};

window.sendGroupMessage = function () {
  if (!selectedClass || !currentUser) return;
  const input = document.getElementById("chatMessageInput");
  const text = input.value.trim();
  if (!text && !pendingAttachment) return;

  appState.messages.push({
    id: "msg_" + Date.now(),
    teacherId: selectedClass.teacherId,
    sectionCode: selectedClass.sectionCode,
    subjectName: selectedClass.subjectName,
    senderId: currentUser.id,
    senderName: currentUser.name,
    senderRole: currentUser.role,
    text,
    answered: false,
    reactions: {},
    replyTo: replyTarget,
    attachment: pendingAttachment,
    createdAt: new Date().toISOString()
  });

  input.value = "";
  clearReplyTarget();
  clearComposerAttachments();
  saveState();
  renderGroupMessages();
};

window.setReplyTarget = function (msgId) {
  const target = appState.messages.find((m) => m.id === msgId);
  if (!target) return;
  replyTarget = { id: target.id, senderName: target.senderName, text: target.text || "[Attachment]" };
  document.getElementById("replyPreviewText").textContent = `Replying to ${target.senderName}: ${replyTarget.text.slice(0, 60)}`;
  document.getElementById("replyPreviewBar").classList.remove("hidden");
  document.getElementById("chatMessageInput").focus();
};

window.clearReplyTarget = function () {
  replyTarget = null;
  const bar = document.getElementById("replyPreviewBar");
  if (bar) bar.classList.add("hidden");
};

function compressImageToBlob(file, maxDim = 1000, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (evt) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("Compression failed"))),
          "image/jpeg",
          quality
        );
      };
      img.onerror = reject;
      img.src = evt.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

window.handleGroupFileSelect = async function (e) {
  const file = e.target.files[0];
  if (!file) return;

  const MAX_BUCKET_FILE_BYTES = 5 * 1024 * 1024; // 5 MB max in external storage bucket
  const isImage = file.type.startsWith("image/");

  if (!isImage && file.size > MAX_BUCKET_FILE_BYTES) {
    showToast("File is over 5MB. Upload to Google Drive/OneDrive and paste the share link in chat!", "error");
    e.target.value = "";
    return;
  }

  const previewBar = document.getElementById("attachmentPreviewBar");
  const previewName = document.getElementById("attachmentPreviewName");
  previewName.textContent = `⏳ Uploading ${file.name} to Cloud Storage...`;
  previewBar.classList.remove("hidden");

  try {
    let uploadBody = file;
    let contentType = file.type || "application/octet-stream";
    let safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");

    if (isImage) {
      uploadBody = await compressImageToBlob(file, 1000, 0.72);
      contentType = "image/jpeg";
      safeName = safeName.replace(/\.[^.]+$/, "") + ".jpg";
    }

    const folderName = selectedClass ? selectedClass.sectionCode : "general";
    const filePath = `${folderName}/${Date.now()}_${safeName}`;

    if (supabase) {
      const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(filePath, uploadBody, { contentType, upsert: false });

      if (uploadError) throw uploadError;

      const { data: pubData } = supabase.storage
        .from(STORAGE_BUCKET)
        .getPublicUrl(filePath);

      pendingAttachment = {
        type: isImage ? "image" : "file",
        name: file.name,
        url: pubData.publicUrl
      };

      previewName.textContent = `${isImage ? "🖼️" : "📎"} ${file.name} (Cloud Storage Ready)`;
      showToast("Uploaded to external cloud storage!", "success");
      return;
    }
    throw new Error("Supabase client unavailable");
  } catch (err) {
    if (!isImage && file.size > 300 * 1024) {
      clearComposerAttachments();
      showToast("File over 300KB: create 'classroom-files' bucket in Supabase or paste a Google Drive link.", "error");
      return;
    }
    const blobToRead = isImage ? await compressImageToBlob(file, 800, 0.6) : file;
    const reader = new FileReader();
    reader.onload = function (evt) {
      pendingAttachment = {
        type: isImage ? "image" : "file",
        name: file.name,
        url: evt.target.result
      };
      previewName.textContent = `${isImage ? "🖼️" : "📎"} ${file.name}`;
    };
    reader.readAsDataURL(blobToRead);
  }
};

window.clearComposerAttachments = function () {
  pendingAttachment = null;
  const bar = document.getElementById("attachmentPreviewBar");
  const fileIn = document.getElementById("groupFileInput");
  if (bar) bar.classList.add("hidden");
  if (fileIn) fileIn.value = "";
};

window.toggleReaction = function (msgId, emoji) {
  const msg = appState.messages.find((m) => m.id === msgId);
  if (!msg) return;
  msg.reactions = msg.reactions || {};
  msg.reactions[emoji] = msg.reactions[emoji] || [];
  const idx = msg.reactions[emoji].indexOf(currentUser.id);
  if (idx >= 0) msg.reactions[emoji].splice(idx, 1);
  else msg.reactions[emoji].push(currentUser.id);
  saveState();
  renderGroupMessages();
};

window.toggleMessageAnswered = function (msgId) {
  const msg = appState.messages.find((m) => m.id === msgId);
  if (!msg) return;
  msg.answered = !msg.answered;
  saveState();
  renderGroupMessages();
};

window.deleteGroupMessage = function (msgId) {
  appState.messages = appState.messages.filter((m) => m.id !== msgId);
  saveState();
  renderGroupMessages();
  showToast("Message deleted.");
};

/* ==========================================================================
   1-ON-1 PRIVATE MESSAGING
   ========================================================================== */
function renderPmWorkspace() {
  if (!selectedClass || !currentUser) return;
  const threadList = document.getElementById("pmThreadList");

  let partners = [];
  if (currentUser.role === "student") {
    const teacher = appState.users.find((u) => u.id === selectedClass.teacherId);
    if (teacher) partners = [teacher];
    selectedPmPartnerId = selectedClass.teacherId;
  } else {
    partners = appState.users.filter(
      (u) => u.role === "student" && normalizeSection(u.sectionCode) === normalizeSection(selectedClass.sectionCode)
    );
    if (!selectedPmPartnerId && partners.length > 0) {
      selectedPmPartnerId = partners[0].id;
    }
  }

  if (partners.length === 0) {
    threadList.innerHTML = `<div style="font-size:0.78rem; color:var(--text-muted); padding:8px;">No students registered in ${escapeHtml(selectedClass.sectionCode)} yet.</div>`;
    document.getElementById("pmFeed").innerHTML = "";
    return;
  }

  threadList.innerHTML = partners
    .map((p) => {
      const active = p.id === selectedPmPartnerId ? "active" : "";
      return `
        <button type="button" class="mode-tab ${active}" style="justify-content:space-between; width:100%; text-align:left;" onclick="selectPmPartner('${p.id}')">
          <span>${escapeHtml(p.name)}</span>
          <span class="badge badge-section">${p.role === "teacher" ? "Prof" : escapeHtml(p.sectionCode)}</span>
        </button>`;
    })
    .join("");

  renderPmMessages();
}

window.selectPmPartner = function (partnerId) {
  selectedPmPartnerId = partnerId;
  renderPmWorkspace();
};

function renderPmMessages() {
  const feed = document.getElementById("pmFeed");
  const header = document.getElementById("pmPartnerHeader");
  const partner = appState.users.find((u) => u.id === selectedPmPartnerId);

  if (!partner) {
    header.textContent = "Select a conversation on the left.";
    feed.innerHTML = "";
    return;
  }

  header.innerHTML = `🔒 Private Consultation with <strong>${escapeHtml(partner.name)}</strong> (${escapeHtml(selectedClass.subjectName)})`;

  const thread = appState.pms.filter(
    (pm) =>
      pm.sectionCode === selectedClass.sectionCode &&
      pm.subjectName === selectedClass.subjectName &&
      ((pm.senderId === currentUser.id && pm.receiverId === partner.id) ||
        (pm.senderId === partner.id && pm.receiverId === currentUser.id))
  );

  thread.forEach((pm) => {
    if (pm.receiverId === currentUser.id) pm.read = true;
  });
  updatePmUnreadBadge();

  if (thread.length === 0) {
    feed.innerHTML = `<div class="empty-state"><h4>Private 1-on-1 Channel</h4><p>Messages here are strictly private between you and <strong>${escapeHtml(partner.name)}</strong>.</p></div>`;
    return;
  }

  feed.innerHTML = thread
    .map((pm) => {
      const isSelf = pm.senderId === currentUser.id;
      return `
        <div class="msg-row ${isSelf ? "self" : "other"}">
          <div class="msg-meta">
            <strong>${escapeHtml(pm.senderName)}</strong>
            <span>${formatTime(pm.createdAt)}</span>
          </div>
          <div class="msg-bubble">${formatMessageWithResourceCards(pm.text)}</div>
        </div>`;
    })
    .join("");

  feed.scrollTop = feed.scrollHeight;
}

window.handlePmKeydown = function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendPmMessage();
  }
};

window.sendPmMessage = function () {
  if (!selectedClass || !currentUser || !selectedPmPartnerId) return;
  const input = document.getElementById("pmMessageInput");
  const text = input.value.trim();
  if (!text) return;

  appState.pms.push({
    id: "pm_" + Date.now(),
    teacherId: selectedClass.teacherId,
    sectionCode: selectedClass.sectionCode,
    subjectName: selectedClass.subjectName,
    senderId: currentUser.id,
    senderName: currentUser.name,
    receiverId: selectedPmPartnerId,
    text,
    read: false,
    createdAt: new Date().toISOString()
  });

  input.value = "";
  saveState();
  renderPmMessages();
};

function updatePmUnreadBadge() {
  const badge = document.getElementById("pmUnreadBadge");
  if (!badge || !currentUser || !selectedClass) return;
  const unread = appState.pms.filter(
    (pm) =>
      pm.sectionCode === selectedClass.sectionCode &&
      pm.subjectName === selectedClass.subjectName &&
      pm.receiverId === currentUser.id &&
      !pm.read
  ).length;

  if (unread > 0) {
    badge.textContent = unread;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

/* ==========================================================================
   MODALS & HELPERS
   ========================================================================== */
window.openModal = function (modalId) {
  const backdrop = document.getElementById("modalBackdrop");
  if (!backdrop) return;
  backdrop.classList.remove("hidden");
  backdrop.querySelectorAll(".modal-card, #lightboxModal").forEach((m) => m.classList.add("hidden"));
  const target = document.getElementById(modalId);
  if (target) target.classList.remove("hidden");
};

window.closeAllModals = function () {
  const backdrop = document.getElementById("modalBackdrop");
  if (!backdrop) return;
  backdrop.classList.add("hidden");
  backdrop.querySelectorAll(".modal-card, #lightboxModal").forEach((m) => m.classList.add("hidden"));
};

window.openLightbox = function (url) {
  const img = document.getElementById("lightboxImg");
  if (img) img.src = url;
  openModal("lightboxModal");
};

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(str) {
  return String(str || "").replace(/'/g, "\\'").replace(/"/g, "&quot;");
}