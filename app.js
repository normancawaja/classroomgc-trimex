import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STORAGE_KEY = "classroomgc_trimex_ccs_state_v1";
const SESSION_KEY = "classroomgc_trimex_ccs_session_v1";
const ADMIN_CODE_SESSION_KEY = "ccs_admin_verified_code";
const THEME_KEY = "classroomgc_trimex_ccs_theme_v1";
const STORAGE_BUCKET = "classroom-files";

const SUPABASE_URL = "https://qtdcktysdocauzpzpxme.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_RLvZXfEinKqdSuFF5JBKyg_7YKxELnW";

const STUDENT_EMAIL_DOMAIN = "@student.trimexcolleges.edu.ph";
const FACULTY_EMAIL_DOMAIN = "@faculty.trimexcolleges.edu.ph";

let supabase = null;
let isSupabaseConnected = false;

async function sha256Hex(text) {
  const clean = (text || "").trim();
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clean));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* Server-side RPC validation via Supabase app_secrets (zero hardcoded keys in frontend) */
async function verifyAccessCodeOnServer(role, inputCode) {
  const clean = (inputCode || "").trim();
  if (!clean) return false;

  if (supabase) {
    try {
      const { data, error } = await supabase.rpc("verify_role_access_code", {
        p_role: role,
        p_code: clean
      });
      if (!error) return data === true;
    } catch (err) {
      console.warn("RPC verification error:", err);
    }
  }
  return false;
}

function sanitizeSafeUrl(rawUrl) {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch {
    return "";
  }
  return "";
}

const CARD_ACCENTS = [
  "linear-gradient(90deg, #7f1d1d, #dc2626)",
  "linear-gradient(90deg, #881337, #e11d48)",
  "linear-gradient(90deg, #991b1b, #f43f5e)",
  "linear-gradient(90deg, #5c0f14, #be123c)",
  "linear-gradient(90deg, #701a75, #be185d)"
];

let appState = {
  termLabel: "A.Y. 2026–2027 • 1st Sem",
  users: [],
  announcements: [],
  messages: [],
  pms: [],
  tickets: []
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
let editingStudentId = null;
let reenrollingStudentId = null;
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
      const CACHE_NAME = 'classroomgc-ccs-v12';
      self.addEventListener('install', (e) => {
        self.skipWaiting();
        e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(['./', './index.html', './style.css', './app.js'])));
      });
      self.addEventListener('activate', (e) => {
        e.waitUntil(
          caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
          )
        );
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
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.includes("PASTE_YOUR_FULL")) {
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
        termLabel: data.payload.termLabel || appState.termLabel,
        users: Array.isArray(data.payload.users) ? data.payload.users : appState.users,
        announcements: Array.isArray(data.payload.announcements) ? data.payload.announcements : appState.announcements,
        messages: Array.isArray(data.payload.messages) ? data.payload.messages : appState.messages,
        pms: Array.isArray(data.payload.pms) ? data.payload.pms : appState.pms,
        tickets: Array.isArray(data.payload.tickets) ? data.payload.tickets : appState.tickets
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
            appState = {
              termLabel: payload.new.payload.termLabel || "A.Y. 2026–2027 • 1st Sem",
              users: payload.new.payload.users || [],
              announcements: payload.new.payload.announcements || [],
              messages: payload.new.payload.messages || [],
              pms: payload.new.payload.pms || [],
              tickets: payload.new.payload.tickets || []
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
            if (currentUser) {
              const latest = appState.users.find((u) => u.id === currentUser.id);
              if (!latest || isGraduatedStudent(latest)) {
                handleLogout();
                showToast("Your Trimex Colleges account has been graduated and locked.", "error");
                return;
              }
              currentUser = latest;
              syncHeaderChip();
              if (currentUser.role === "admin") renderAdminPortal();
              else if (isDroppedStudent(currentUser)) renderDroppedPortal();
              else if (selectedClass) {
                if (workspaceMode === "chat") renderApp();
                else if (workspaceMode === "pm") renderPmWorkspace();
                else renderTicketsWorkspace();
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

/* Server-Side Gatekeeper RPC Save (compatible with Strict RLS lockdown) */
async function pushStateToSupabase() {
  if (!supabase || !isSupabaseConnected) return;
  try {
    const actorId = currentUser ? currentUser.id : "";
    const adminCode = sessionStorage.getItem(ADMIN_CODE_SESSION_KEY) || "";

    const { error } = await supabase.rpc("save_classroomgc_state", {
      new_payload: appState,
      actor_id: actorId,
      admin_code: adminCode
    });

    if (error) {
      console.warn("Server security policy rejected update:", error.message);
      showToast(error.message || "Unauthorized action blocked by server.", "error");
    }
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
        termLabel: parsed.termLabel || "A.Y. 2026–2027 • 1st Sem",
        users: Array.isArray(parsed.users) ? parsed.users : [],
        announcements: Array.isArray(parsed.announcements) ? parsed.announcements : [],
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        pms: Array.isArray(parsed.pms) ? parsed.pms : [],
        tickets: Array.isArray(parsed.tickets) ? parsed.tickets : []
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
    termLabel: "A.Y. 2026–2027 • 1st Sem",
    users: [
      {
        id: "usr_ccs_admin",
        role: "admin",
        name: "CCS Department Chair",
        email: "ccs.admin@faculty.trimexcolleges.edu.ph",
        password: "PrivateAdminPass2026!"
      },
      {
        id: teacherId,
        role: "teacher",
        name: "Prof. Elena Santos",
        email: "elena.santos@faculty.trimexcolleges.edu.ph",
        password: "password123",
        securityQuestion: "pet",
        securityAnswerHash: "7902699be42c8a8e46fbbb4501726517e86b22c56a189f7625a6da49081b2451", // "max"
        consultationHours: {
          enabled: true,
          start: "08:00",
          end: "17:00",
          days: "weekdays"
        },
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
        studentNumber: "2023-00123",
        email: "juan.delacruz@student.trimexcolleges.edu.ph",
        password: "password123",
        securityQuestion: "pet",
        securityAnswerHash: "7902699be42c8a8e46fbbb4501726517e86b22c56a189f7625a6da49081b2451", // "max"
        yearLevel: "3rd Year",
        enrollmentStatus: "active",
        graduationBatch: "",
        droppedTerm: "",
        sectionCode: "ITNSA3M1"
      }
    ],
    announcements: [
      {
        id: "ann_1",
        type: "announcement",
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
    pms: [],
    tickets: []
  };
  saveState();
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
    pushStateToSupabase();
  } catch (err) {
    showToast("Storage limit reached. Try exporting a backup CSV.", "error");
  }
}

function restoreSession() {
  const userId = localStorage.getItem(SESSION_KEY);
  if (!userId) return;
  const found = appState.users.find((u) => u.id === userId);
  if (found && !isGraduatedStudent(found)) {
    currentUser = found;
    enterAppView();
  } else {
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(ADMIN_CODE_SESSION_KEY);
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
  }, 3200);
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

function isGraduatedStudent(user) {
  return (
    user &&
    user.role === "student" &&
    (user.enrollmentStatus === "graduated" ||
      user.yearLevel === "Graduated" ||
      user.yearLevel === "Alumni" ||
      user.isGraduated === true ||
      user.isAlumni === true)
  );
}

function isDroppedStudent(user) {
  return user && user.role === "student" && (user.enrollmentStatus === "dropped" || user.isDropped === true);
}

/* ==========================================================================
   FACULTY CONSULTATION HOURS / TIME LIMIT CHECKER
   ========================================================================== */
function getTeacherConsultationStatus(teacher) {
  const cfg = (teacher && teacher.consultationHours) || {
    enabled: true,
    start: "08:00",
    end: "17:00",
    days: "weekdays"
  };

  const scheduleText = `${format24To12(cfg.start)} – ${format24To12(cfg.end)} (${
    cfg.days === "weekdays" ? "Mon–Fri" : cfg.days === "mon_sat" ? "Mon–Sat" : "Daily"
  })`;

  if (!cfg.enabled) {
    return {
      isOpen: true,
      scheduleText: "24/7 Open Consultation",
      reason: "Faculty accepts direct messages anytime."
    };
  }

  const now = new Date();
  const day = now.getDay();
  if (cfg.days === "weekdays" && (day === 0 || day === 6)) {
    return {
      isOpen: false,
      scheduleText,
      reason: `Weekend cutoff active. Live PM resumes Monday at ${format24To12(cfg.start)}.`
    };
  }
  if (cfg.days === "mon_sat" && day === 0) {
    return {
      isOpen: false,
      scheduleText,
      reason: `Sunday cutoff active. Live PM resumes Monday at ${format24To12(cfg.start)}.`
    };
  }

  const [sH, sM] = (cfg.start || "08:00").split(":").map(Number);
  const [eH, eM] = (cfg.end || "17:00").split(":").map(Number);
  const currentMins = now.getHours() * 60 + now.getMinutes();
  const startMins = sH * 60 + sM;
  const endMins = eH * 60 + eM;

  if (currentMins < startMins || currentMins > endMins) {
    return {
      isOpen: false,
      scheduleText,
      reason: `Outside faculty contact hours (${scheduleText}). Live PM is paused; submit a Consultation Ticket instead.`
    };
  }

  return {
    isOpen: true,
    scheduleText,
    reason: `Faculty is within active consultation hours (${scheduleText}).`
  };
}

function format24To12(hhmm) {
  if (!hhmm) return "";
  const [hStr, mStr] = hhmm.split(":");
  let h = parseInt(hStr, 10);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${mStr} ${ampm}`;
}

window.openConsultationHoursModal = function () {
  if (!currentUser || currentUser.role !== "teacher") return;
  const cfg = currentUser.consultationHours || {
    enabled: true,
    start: "08:00",
    end: "17:00",
    days: "weekdays"
  };
  document.getElementById("hoursEnabledInput").checked = cfg.enabled !== false;
  document.getElementById("hoursStartInput").value = cfg.start || "08:00";
  document.getElementById("hoursEndInput").value = cfg.end || "17:00";
  document.getElementById("hoursDaysInput").value = cfg.days || "weekdays";
  openModal("consultationHoursModal");
};

window.handleSaveConsultationHours = function (e) {
  e.preventDefault();
  if (!currentUser || currentUser.role !== "teacher") return;
  currentUser.consultationHours = {
    enabled: document.getElementById("hoursEnabledInput").checked,
    start: document.getElementById("hoursStartInput").value,
    end: document.getElementById("hoursEndInput").value,
    days: document.getElementById("hoursDaysInput").value
  };
  saveState();
  closeAllModals();
  if (selectedClass) {
    updateRoomConsultationBadge();
    if (workspaceMode === "pm") renderPmWorkspace();
  }
  showToast("Faculty contact time limit saved!", "success");
};

/* ==========================================================================
   AUTHENTICATION & ROLE SWITCHING
   ========================================================================== */
window.switchAuthTab = function (tab) {
  const loginForm = document.getElementById("loginForm");
  const regForm = document.getElementById("registerForm");
  const tabLoginBtn = document.getElementById("tabLoginBtn");
  const tabRegisterBtn = document.getElementById("tabRegisterBtn");
  const lockBanner = document.getElementById("loginLockedAccountBanner");
  if (lockBanner) lockBanner.classList.add("hidden");

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
  const aBtn = document.getElementById("loginRoleAdminBtn");
  const guard = document.getElementById("loginFacultyGuard");
  const codeLabel = document.getElementById("loginCodeLabel");
  const label = document.getElementById("loginEmailLabel");
  const emailInput = document.getElementById("loginEmail");
  const submitBtn = document.getElementById("loginSubmitBtn");
  const lockBanner = document.getElementById("loginLockedAccountBanner");
  if (lockBanner) lockBanner.classList.add("hidden");

  [sBtn, tBtn, aBtn].forEach((b) => b && b.classList.remove("active", "teacher-role"));

  if (role === "teacher") {
    tBtn.classList.add("active", "teacher-role");
    guard.classList.remove("hidden");
    codeLabel.textContent = "🛡️ Faculty Access Code";
    label.textContent = `Faculty Email (${FACULTY_EMAIL_DOMAIN})`;
    emailInput.placeholder = `name${FACULTY_EMAIL_DOMAIN}`;
    submitBtn.textContent = "Sign In to Faculty Portal →";
    submitBtn.className = "btn btn-teacher";
  } else if (role === "admin") {
    aBtn.classList.add("active", "teacher-role");
    guard.classList.remove("hidden");
    codeLabel.textContent = "🛡️ CCS Admin Master Code";
    label.textContent = `Admin Email (${FACULTY_EMAIL_DOMAIN})`;
    emailInput.placeholder = `ccs.admin${FACULTY_EMAIL_DOMAIN}`;
    submitBtn.textContent = "Sign In to CCS Admin Portal →";
    submitBtn.className = "btn btn-teacher";
  } else {
    sBtn.classList.add("active");
    guard.classList.add("hidden");
    label.textContent = `Student Email (${STUDENT_EMAIL_DOMAIN})`;
    emailInput.placeholder = `name${STUDENT_EMAIL_DOMAIN}`;
    submitBtn.textContent = "Sign In as Student →";
    submitBtn.className = "btn btn-primary";
  }
};

window.selectRegisterRole = function (role) {
  /* Closed Admin Sign-Up: only 'student' and 'teacher' allowed */
  registerRole = role === "teacher" ? "teacher" : "student";
  const sBtn = document.getElementById("roleStudentBtn");
  const tBtn = document.getElementById("roleTeacherBtn");
  const sFields = document.getElementById("studentFields");
  const guardBox = document.getElementById("facultyOrAdminGuard");
  const tFields = document.getElementById("teacherFields");
  const codeLabel = document.getElementById("regCodeLabel");
  const emailLabel = document.getElementById("regEmailLabel");
  const emailInput = document.getElementById("regEmail");
  const submitBtn = document.getElementById("registerSubmitBtn");

  [sBtn, tBtn].forEach((b) => b && b.classList.remove("active", "teacher-role"));

  if (registerRole === "teacher") {
    tBtn.classList.add("active", "teacher-role");
    sFields.classList.add("hidden");
    guardBox.classList.remove("hidden");
    tFields.classList.remove("hidden");
    codeLabel.textContent = "🛡️ Faculty Access Code (Required)";
    emailLabel.textContent = `Faculty Email (${FACULTY_EMAIL_DOMAIN})`;
    emailInput.placeholder = `name${FACULTY_EMAIL_DOMAIN}`;
    submitBtn.className = "btn btn-teacher";
  } else {
    sBtn.classList.add("active");
    guardBox.classList.add("hidden");
    tFields.classList.add("hidden");
    sFields.classList.remove("hidden");
    emailLabel.textContent = `Student Email (${STUDENT_EMAIL_DOMAIN})`;
    emailInput.placeholder = `name${STUDENT_EMAIL_DOMAIN}`;
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
  const year = document.getElementById("regStudentYear").value;
  const raw = document.getElementById("regStudentSection").value;
  const clean = normalizeSection(raw);
  const shortYr = year.toUpperCase().replace(" YEAR", " YR");
  document.getElementById("studentSectionPreview").textContent = `${shortYr} • ${clean || "—"}`;
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
  const lockBanner = document.getElementById("loginLockedAccountBanner");
  if (lockBanner) lockBanner.classList.add("hidden");

  let verifiedAdminCode = "";

  if (loginRole === "teacher" || loginRole === "admin") {
    if (!email.endsWith(FACULTY_EMAIL_DOMAIN)) {
      showToast(`Faculty & Admins must sign in using ${FACULTY_EMAIL_DOMAIN}`, "error");
      return;
    }
    const code = document.getElementById("loginFacultyCode").value.trim();
    const ok = await verifyAccessCodeOnServer(loginRole, code);
    if (!ok) {
      facultyAttempts++;
      const alertEl = document.getElementById("loginFacultyLockoutMsg");
      alertEl.textContent = `Invalid ${loginRole === "admin" ? "CCS Admin Master Code" : "Faculty Access Code"} (Attempt ${facultyAttempts}).`;
      alertEl.classList.remove("hidden");
      return;
    }
    if (loginRole === "admin") {
      verifiedAdminCode = code;
    }
  } else {
    if (!email.endsWith(STUDENT_EMAIL_DOMAIN)) {
      showToast(`Students must sign in using ${STUDENT_EMAIL_DOMAIN}`, "error");
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

  if (isGraduatedStudent(user)) {
    if (lockBanner) {
      lockBanner.innerHTML = `🔒 <strong>Account Deactivated (Graduated):</strong> Your Trimex Colleges student account (${escapeHtml(
        user.email
      )}) has been locked following graduation${
        user.graduationBatch ? ` (${escapeHtml(user.graduationBatch)})` : ""
      }.`;
      lockBanner.classList.remove("hidden");
    }
    showToast("Graduated student accounts are locked by Trimex IT Policy.", "error");
    return;
  }

  if (user.role === "admin" && verifiedAdminCode) {
    sessionStorage.setItem(ADMIN_CODE_SESSION_KEY, verifiedAdminCode);
  } else {
    sessionStorage.removeItem(ADMIN_CODE_SESSION_KEY);
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
  const securityQuestion = document.getElementById("regSecurityQuestion").value;
  const securityAnswerRaw = document.getElementById("regSecurityAnswer").value.trim().toLowerCase();

  if (!securityAnswerRaw) {
    showToast("Please provide a Security Answer for account recovery.", "error");
    return;
  }

  if (appState.users.some((u) => u.email.toLowerCase() === email)) {
    showToast("An account with this school email already exists.", "error");
    return;
  }

  const securityAnswerHash = await sha256Hex(securityAnswerRaw);

  if (registerRole === "student") {
    if (!email.endsWith(STUDENT_EMAIL_DOMAIN)) {
      showToast(`Students must register using ${STUDENT_EMAIL_DOMAIN}`, "error");
      return;
    }
    const studentNumber = (document.getElementById("regStudentNumber").value || "").trim().toUpperCase();
    const yearLevel = document.getElementById("regStudentYear").value;
    const sectionCode = normalizeSection(document.getElementById("regStudentSection").value);

    if (!studentNumber) {
      showToast("Please enter your official Trimex Student Number.", "error");
      return;
    }
    if (!sectionCode) {
      showToast("Please enter your exact section code (e.g., ITNSA3M1).", "error");
      return;
    }

    const newUser = {
      id: "usr_" + Date.now(),
      role: "student",
      name,
      studentNumber,
      email,
      password,
      securityQuestion,
      securityAnswerHash,
      yearLevel,
      enrollmentStatus: "active",
      graduationBatch: "",
      droppedTerm: "",
      sectionCode
    };
    sessionStorage.removeItem(ADMIN_CODE_SESSION_KEY);
    appState.users.push(newUser);
    currentUser = newUser;
    saveState();
    localStorage.setItem(SESSION_KEY, newUser.id);
    showToast(`Student account created (${yearLevel} • ${sectionCode})!`, "success");
    enterAppView();
  } else if (registerRole === "teacher") {
    if (!email.endsWith(FACULTY_EMAIL_DOMAIN)) {
      showToast(`Faculty must register using ${FACULTY_EMAIL_DOMAIN}`, "error");
      return;
    }
    const code = document.getElementById("regFacultyCode").value.trim();
    const ok = await verifyAccessCodeOnServer("teacher", code);
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
      securityQuestion,
      securityAnswerHash,
      consultationHours: { enabled: true, start: "08:00", end: "17:00", days: "weekdays" },
      classes: sections.map((sec) => ({ sectionCode: sec, subjectName }))
    };
    sessionStorage.removeItem(ADMIN_CODE_SESSION_KEY);
    appState.users.push(newTeacher);
    currentUser = newTeacher;
    saveState();
    localStorage.setItem(SESSION_KEY, newTeacher.id);
    showToast(`Faculty account created with ${sections.length} classroom(s)!`, "success");
    enterAppView();
  } else {
    showToast("Admin self-registration is disabled by CCS Security Policy.", "error");
  }
};

window.handleResetPassword = async function (e) {
  e.preventDefault();
  const email = document.getElementById("resetEmail").value.trim().toLowerCase();
  const verification = document.getElementById("resetVerification").value.trim();
  const secQuestion = document.getElementById("resetSecurityQuestion").value;
  const secAnswerRaw = document.getElementById("resetSecurityAnswer").value.trim().toLowerCase();
  const newPassword = document.getElementById("resetNewPassword").value;

  const user = appState.users.find((u) => u.email.toLowerCase() === email);
  if (!user) {
    showToast("No account found with that registered email.", "error");
    return;
  }

  if (user.role === "admin") {
    showToast("CCS Admin passwords cannot be reset via public form.", "error");
    return;
  }

  if (isGraduatedStudent(user)) {
    showToast("Graduated accounts are permanently locked and cannot reset passwords.", "error");
    return;
  }

  /* Factor 1: Student Number (for Student) or Server-Side Faculty Code (for Teacher) */
  const isIdValid =
    user.role === "teacher"
      ? await verifyAccessCodeOnServer("teacher", verification)
      : user.studentNumber && verification.toUpperCase() === user.studentNumber.trim().toUpperCase();

  if (!isIdValid) {
    showToast(
      user.role === "teacher"
        ? "Invalid Faculty Access Code."
        : "Student Number did not match our institutional records.",
      "error"
    );
    return;
  }

  /* Factor 2: Security Question & Hashed Security Answer */
  const answerHash = await sha256Hex(secAnswerRaw);
  if (user.securityQuestion !== secQuestion || user.securityAnswerHash !== answerHash) {
    showToast("Incorrect Security Question or Security Answer.", "error");
    return;
  }

  user.password = newPassword;
  saveState();
  closeAllModals();
  e.target.reset();
  showToast("Identity verified & password updated! You can now sign in.", "success");
};

window.handleLogout = function () {
  currentUser = null;
  selectedClass = null;
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(ADMIN_CODE_SESSION_KEY);
  document.getElementById("appView").classList.add("hidden");
  document.getElementById("authView").classList.remove("hidden");
  showToast("Signed out safely.");
};

function hideAllWorkspaceViews() {
  ["dashboardView", "roomView", "adminView", "droppedView"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  });
}

function syncHeaderChip() {
  if (!currentUser) return;
  document.getElementById("headerTermTag").textContent = `Trimex CCS • ${appState.termLabel}`;
  document.getElementById("headerUserName").textContent = currentUser.name;
  const tagEl = document.getElementById("headerUserTag");
  const roleIcon = document.getElementById("headerUserRoleIcon");

  if (currentUser.role === "admin") {
    tagEl.textContent = "CCS ADMIN";
    tagEl.className = "badge badge-teacher";
    roleIcon.textContent = "🛡️";
    roleIcon.classList.remove("hidden");
  } else if (isDroppedStudent(currentUser)) {
    tagEl.textContent = "⚠️ DROPPED / LOA";
    tagEl.className = "badge badge-dropped";
    roleIcon.textContent = "⚠️";
    roleIcon.classList.remove("hidden");
  } else if (currentUser.role === "teacher") {
    tagEl.textContent = "FACULTY";
    tagEl.className = "badge badge-teacher";
    roleIcon.textContent = "👩‍🏫";
    roleIcon.classList.remove("hidden");
  } else {
    const yr = currentUser.yearLevel || "1st Year";
    tagEl.textContent = `${yr} • ${currentUser.sectionCode}`;
    tagEl.className = "badge badge-section";
    roleIcon.textContent = "🎒";
    roleIcon.classList.remove("hidden");
  }
}

function enterAppView() {
  if (isGraduatedStudent(currentUser)) {
    handleLogout();
    return;
  }

  document.getElementById("authView").classList.add("hidden");
  document.getElementById("appView").classList.remove("hidden");

  syncHeaderChip();

  document.getElementById("headerHoursBtn").classList.add("hidden");
  document.getElementById("dashHoursBtn").classList.add("hidden");
  document.getElementById("dashAddSectionBtn").classList.add("hidden");

  if (currentUser.role === "admin") {
    goToAdminPortal();
    return;
  }

  if (isDroppedStudent(currentUser)) {
    goToDroppedPortal();
    return;
  }

  if (currentUser.role === "teacher") {
    document.getElementById("headerHoursBtn").classList.remove("hidden");
    document.getElementById("dashHoursBtn").classList.remove("hidden");
    document.getElementById("dashAddSectionBtn").classList.remove("hidden");
  }

  goToDashboard();
}

window.goToDashboard = function () {
  if (!currentUser) return;
  if (currentUser.role === "admin") {
    goToAdminPortal();
    return;
  }
  if (isDroppedStudent(currentUser)) {
    goToDroppedPortal();
    return;
  }
  selectedClass = null;
  hideAllWorkspaceViews();
  document.getElementById("dashboardView").classList.remove("hidden");
  renderDashboard();
};

function goToAdminPortal() {
  selectedClass = null;
  hideAllWorkspaceViews();
  document.getElementById("adminView").classList.remove("hidden");
  renderAdminPortal();
}

function goToDroppedPortal() {
  selectedClass = null;
  hideAllWorkspaceViews();
  document.getElementById("droppedView").classList.remove("hidden");
  renderDroppedPortal();
}

function renderDroppedPortal() {
  if (!currentUser) return;
  document.getElementById("droppedNameTitle").textContent = currentUser.name;
  const termTxt = currentUser.droppedTerm ? ` • Tagged On: ${currentUser.droppedTerm}` : "";
  document.getElementById("droppedSubtitle").textContent =
    `${currentUser.yearLevel || "Student"} • Last Section: ${currentUser.sectionCode || "CCS"}${termTxt}`;
}

/* ==========================================================================
   CCS ADMIN PORTAL LOGIC (EDIT YEAR/SECTION, DROPPED/LOA, RE-ENROLL, GRADUATED)
   ========================================================================== */
function renderAdminPortal() {
  document.getElementById("adminCurrentTermBadge").textContent = appState.termLabel;
  const teachers = appState.users.filter((u) => u.role === "teacher");
  const activeStudents = appState.users.filter(
    (u) => u.role === "student" && !isGraduatedStudent(u) && !isDroppedStudent(u)
  );
  const droppedStudents = appState.users.filter((u) => isDroppedStudent(u));
  const graduatedStudents = appState.users.filter((u) => isGraduatedStudent(u));
  const totalRooms = teachers.reduce((acc, t) => acc + (t.classes ? t.classes.length : 0), 0);
  const openTickets = (appState.tickets || []).filter((t) => t.status === "open").length;

  document.getElementById("adminStatsGrid").innerHTML = `
    <div class="admin-stat-card">
      <div style="font-size:0.75rem; color:var(--text-muted); font-weight:700;">FACULTY</div>
      <div class="admin-stat-num">${teachers.length}</div>
    </div>
    <div class="admin-stat-card">
      <div style="font-size:0.75rem; color:var(--text-muted); font-weight:700;">ACTIVE STUDENTS</div>
      <div class="admin-stat-num" style="color:#10b981;">${activeStudents.length}</div>
    </div>
    <div class="admin-stat-card">
      <div style="font-size:0.75rem; color:var(--text-muted); font-weight:700;">DROPPED / LOA</div>
      <div class="admin-stat-num" style="color:#f87171;">${droppedStudents.length}</div>
    </div>
    <div class="admin-stat-card">
      <div style="font-size:0.75rem; color:var(--text-muted); font-weight:700;">GRADUATED (LOCKED)</div>
      <div class="admin-stat-num" style="color:#94a3b8;">${graduatedStudents.length}</div>
    </div>
    <div class="admin-stat-card">
      <div style="font-size:0.75rem; color:var(--text-muted); font-weight:700;">CLASSROOMS</div>
      <div class="admin-stat-num">${totalRooms}</div>
    </div>
    <div class="admin-stat-card">
      <div style="font-size:0.75rem; color:var(--text-muted); font-weight:700;">OPEN TICKETS</div>
      <div class="admin-stat-num">${openTickets}</div>
    </div>
  `;

  document.getElementById("adminFacultyTableBody").innerHTML =
    teachers.length === 0
      ? `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No faculty registered yet.</td></tr>`
      : teachers
          .map((t) => {
            const status = getTeacherConsultationStatus(t);
            const classesList = (t.classes || [])
              .map((c) => `${escapeHtml(c.sectionCode)} (${escapeHtml(c.subjectName)})`)
              .join(", ") || "None";
            return `
              <tr>
                <td><strong>${escapeHtml(t.name)}</strong></td>
                <td>${escapeHtml(t.email)}</td>
                <td>${classesList}</td>
                <td><span class="badge ${status.isOpen ? "badge-online" : "badge-teacher"}">${escapeHtml(status.scheduleText)}</span></td>
                <td><button type="button" class="action-link danger" onclick="adminRemoveUser('${t.id}')">Remove</button></td>
              </tr>`;
          })
          .join("");

  const allStudents = appState.users.filter((u) => u.role === "student");
  document.getElementById("adminStudentTableBody").innerHTML =
    allStudents.length === 0
      ? `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No students registered yet.</td></tr>`
      : allStudents
          .map((s) => {
            const graduated = isGraduatedStudent(s);
            const dropped = isDroppedStudent(s);

            let statusBadge = `<span class="badge badge-online">${escapeHtml(s.yearLevel || "1st Year")} • Active</span>`;
            if (graduated) {
              statusBadge = `<span class="badge badge-graduated">🔒 Graduated (${escapeHtml(s.graduationBatch || "Locked")})</span>`;
            } else if (dropped) {
              statusBadge = `<span class="badge badge-dropped">⚠️ Dropped / LOA (${escapeHtml(s.yearLevel || "Student")})</span>`;
            }

            let actionsHtml = "";
            if (dropped) {
              actionsHtml = `<button type="button" class="action-link" style="color:#10b981; font-weight:700;" onclick="openReenrollModal('${s.id}')">🔄 Re-Enroll</button>`;
            } else if (!graduated) {
              actionsHtml = `
                <button type="button" class="action-link" style="color:var(--teacher-accent); font-weight:700;" onclick="openEditStudentModal('${s.id}')" title="Edit Year Level & Section">✏️ Edit</button>
                <button type="button" class="action-link" onclick="adminGraduateStudent('${s.id}')" title="Graduate & Lock Student Account">🎓 Graduate &amp; Lock</button>
                <button type="button" class="action-link danger" onclick="adminDropStudent('${s.id}')" title="Tag as Dropped / LOA">⚠️ Drop / LOA</button>
              `;
            }

            return `
              <tr>
                <td><strong>${escapeHtml(s.name)}</strong>${s.studentNumber ? `<div style="font-size:0.72rem; color:var(--text-muted);">ID: ${escapeHtml(s.studentNumber)}</div>` : ""}</td>
                <td>${escapeHtml(s.email)}</td>
                <td>${statusBadge}</td>
                <td><span class="badge badge-section">${escapeHtml(s.sectionCode)}</span></td>
                <td style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
                  ${actionsHtml}
                  <button type="button" class="action-link danger" onclick="adminRemoveUser('${s.id}')">Remove</button>
                </td>
              </tr>`;
          })
          .join("");

  const ticketsEl = document.getElementById("adminTicketsList");
  const allTickets = appState.tickets || [];
  if (allTickets.length === 0) {
    ticketsEl.innerHTML = `<div class="empty-state"><p>No student consultation tickets submitted across CCS yet.</p></div>`;
  } else {
    ticketsEl.innerHTML = allTickets
      .map(
        (tk) => `
        <div class="ticket-card">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
            <div>
              <span class="badge badge-section">${escapeHtml(tk.sectionCode)}</span>
              <strong>${escapeHtml(tk.subject)}</strong>
            </div>
            <span class="badge ${tk.status === "resolved" ? "ticket-status-resolved" : "ticket-status-open"}">
              ${tk.status === "resolved" ? "✅ Resolved" : "⏳ Open"}
            </span>
          </div>
          <div style="font-size:0.8rem; color:var(--text-secondary);">${escapeHtml(tk.details)}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">
            Student: <strong>${escapeHtml(tk.studentName)}</strong> • Instructor: <strong>${escapeHtml(tk.teacherName)}</strong> (${escapeHtml(tk.subjectName)})
          </div>
        </div>`
      )
      .join("");
  }
}

window.openEditStudentModal = function (userId) {
  if (!currentUser || currentUser.role !== "admin") return;
  const student = appState.users.find((u) => u.id === userId && u.role === "student");
  if (!student) return;
  editingStudentId = student.id;
  document.getElementById("editStudentLabel").textContent =
    `Editing institutional record for ${student.email}:`;
  document.getElementById("editStudentNameInput").value = student.name || "";
  const yrSel = document.getElementById("editStudentYearInput");
  yrSel.value = ["1st Year", "2nd Year", "3rd Year", "4th Year"].includes(student.yearLevel)
    ? student.yearLevel
    : "1st Year";
  document.getElementById("editStudentSectionInput").value = student.sectionCode || "";
  openModal("editStudentModal");
};

window.handleEditStudentDetails = function (e) {
  e.preventDefault();
  if (!currentUser || currentUser.role !== "admin" || !editingStudentId) return;
  const student = appState.users.find((u) => u.id === editingStudentId && u.role === "student");
  if (!student) return;

  const newName = document.getElementById("editStudentNameInput").value.trim();
  const newYear = document.getElementById("editStudentYearInput").value;
  const newSection = normalizeSection(document.getElementById("editStudentSectionInput").value);
  if (!newName || !newSection) return;

  student.name = newName;
  student.yearLevel = newYear;
  student.sectionCode = newSection;

  editingStudentId = null;
  saveState();
  closeAllModals();
  renderAdminPortal();
  showToast(`Updated ${student.name} to ${newYear} • ${newSection}!`, "success");
};

window.adminDropStudent = function (userId) {
  if (!currentUser || currentUser.role !== "admin") return;
  const student = appState.users.find((u) => u.id === userId && u.role === "student");
  if (!student) return;
  if (!confirm(`Tag ${student.name} as Dropped / LOA? Their access to active subject group chats will be suspended until re-enrolled.`)) return;
  student.enrollmentStatus = "dropped";
  student.isDropped = true;
  student.droppedTerm = appState.termLabel;
  saveState();
  renderAdminPortal();
  showToast(`${student.name} marked as Dropped / LOA.`, "info");
};

window.openReenrollModal = function (userId) {
  if (!currentUser || currentUser.role !== "admin") return;
  const student = appState.users.find((u) => u.id === userId && u.role === "student");
  if (!student) return;
  reenrollingStudentId = student.id;
  document.getElementById("reenrollStudentLabel").textContent =
    `Reactivating ${student.name} (${student.email}). Confirm their returning year level and section code:`;
  const yrSel = document.getElementById("reenrollYearInput");
  if (["1st Year", "2nd Year", "3rd Year", "4th Year"].includes(student.yearLevel)) {
    yrSel.value = student.yearLevel;
  }
  document.getElementById("reenrollSectionInput").value = student.sectionCode || "";
  openModal("reenrollModal");
};

window.handleReenrollStudent = function (e) {
  e.preventDefault();
  if (!currentUser || currentUser.role !== "admin" || !reenrollingStudentId) return;
  const student = appState.users.find((u) => u.id === reenrollingStudentId && u.role === "student");
  if (!student) return;

  const newYear = document.getElementById("reenrollYearInput").value;
  const newSection = normalizeSection(document.getElementById("reenrollSectionInput").value);
  if (!newSection) return;

  student.enrollmentStatus = "active";
  student.isDropped = false;
  student.droppedTerm = "";
  student.yearLevel = newYear;
  student.sectionCode = newSection;

  reenrollingStudentId = null;
  saveState();
  closeAllModals();
  renderAdminPortal();
  showToast(`${student.name} re-enrolled into ${newYear} • ${newSection}!`, "success");
};

window.adminGraduateStudent = function (userId) {
  if (!currentUser || currentUser.role !== "admin") return;
  const student = appState.users.find((u) => u.id === userId && u.role === "student");
  if (!student) return;
  if (!confirm(`Mark ${student.name} as Graduated? Their Trimex Colleges account will be locked and deactivated.`)) return;
  student.yearLevel = "Graduated";
  student.enrollmentStatus = "graduated";
  student.isGraduated = true;
  student.isDropped = false;
  student.graduationBatch = appState.termLabel;
  saveState();
  renderAdminPortal();
  showToast(`${student.name} marked as Graduated & account locked.`, "success");
};

window.adminRemoveUser = function (userId) {
  if (!currentUser || currentUser.role !== "admin") return;
  if (!confirm("Permanently remove this institutional account from ClassRoomGC?")) return;
  appState.users = appState.users.filter((u) => u.id !== userId);
  saveState();
  renderAdminPortal();
  showToast("Account removed.");
};

window.handleSemesterRollover = function (e) {
  e.preventDefault();
  if (!currentUser || currentUser.role !== "admin") return;
  const newLabel = document.getElementById("newTermLabelInput").value.trim();
  const advanceYears = document.getElementById("advanceYearLevelsInput").checked;
  const clearChats = document.getElementById("clearOldChatsInput").checked;
  if (!newLabel) return;

  const previousTerm = appState.termLabel;
  appState.termLabel = newLabel;

  let graduatedCount = 0;
  if (advanceYears) {
    const nextYearMap = {
      "1st Year": "2nd Year",
      "2nd Year": "3rd Year",
      "3rd Year": "4th Year",
      "4th Year": "Graduated"
    };
    appState.users.forEach((u) => {
      if (u.role === "student" && !isGraduatedStudent(u) && !isDroppedStudent(u)) {
        const cur = u.yearLevel || "1st Year";
        const next = nextYearMap[cur] || "Graduated";
        u.yearLevel = next;
        if (next === "Graduated") {
          u.isGraduated = true;
          u.enrollmentStatus = "graduated";
          u.graduationBatch = previousTerm;
          graduatedCount++;
        }
      }
    });
  }

  if (clearChats) {
    appState.messages = [];
    appState.pms = [];
  }

  saveState();
  closeAllModals();
  e.target.reset();
  document.getElementById("headerTermTag").textContent = `Trimex CCS • ${appState.termLabel}`;
  renderAdminPortal();
  showToast(
    advanceYears
      ? `Rolled over to ${newLabel}! Promoted active students & locked ${graduatedCount} graduated 4th-year account(s).`
      : `Rolled over to ${newLabel}!`,
    "success"
  );
};

window.exportDepartmentCsv = function () {
  const rows = [["Role", "Student_Number", "Name", "Email", "Enrollment_Status_&_Year", "Section_or_Classes", "Contact_Hours"]];
  appState.users.forEach((u) => {
    let yrStatus = u.role.toUpperCase();
    if (u.role === "student") {
      if (isGraduatedStudent(u)) yrStatus = `Graduated / Locked (${u.graduationBatch || "Completed"})`;
      else if (isDroppedStudent(u)) yrStatus = `Dropped / LOA (${u.yearLevel || "Student"})`;
      else yrStatus = `${u.yearLevel || "1st Year"} (Active)`;
    }
    const info =
      u.role === "student"
        ? u.sectionCode
        : u.role === "teacher"
        ? (u.classes || []).map((c) => `${c.sectionCode}:${c.subjectName}`).join(" | ")
        : "CCS Admin";
    const hrs = u.role === "teacher" ? getTeacherConsultationStatus(u).scheduleText : "N/A";
    rows.push([u.role, u.studentNumber || "", u.name, u.email, yrStatus, info, hrs]);
  });

  const csv = rows.map((r) => r.map((v) => `"${String(v || "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `Trimex_CCS_ClassRoomGC_Report_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  showToast("CCS Department CSV exported!", "success");
};

/* ==========================================================================
   SUBJECT DASHBOARD
   ========================================================================== */
function getAvailableClassesForUser() {
  if (!currentUser || isGraduatedStudent(currentUser) || isDroppedStudent(currentUser)) return [];
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
      : `My Section Subjects (${currentUser.yearLevel || "1st Year"} • ${currentUser.sectionCode})`;
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
      const teacher = appState.users.find((u) => u.id === cls.teacherId);
      const status = getTeacherConsultationStatus(teacher);

      const msgCount = appState.messages.filter(
        (m) =>
          m.teacherId === cls.teacherId &&
          m.sectionCode === cls.sectionCode &&
          m.subjectName === cls.subjectName
      ).length;
      const studentCount = appState.users.filter(
        (u) =>
          u.role === "student" &&
          !isGraduatedStudent(u) &&
          !isDroppedStudent(u) &&
          normalizeSection(u.sectionCode) === normalizeSection(cls.sectionCode)
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
              <div style="margin-top:8px;">
                <span class="badge ${status.isOpen ? "badge-online" : "badge-teacher"}">
                  ${status.isOpen ? "🟢 Open:" : "⏰ Hours:"} ${escapeHtml(status.scheduleText)}
                </span>
              </div>
            </div>
          </div>
          <div class="card-footer">
            <span>👥 ${studentCount} Active Student${studentCount === 1 ? "" : "s"}</span>
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

/* ==========================================================================
   CLASSROOM ROOM WORKSPACE
   ========================================================================== */
function updateRoomConsultationBadge() {
  if (!selectedClass) return;
  const teacher = appState.users.find((u) => u.id === selectedClass.teacherId);
  const status = getTeacherConsultationStatus(teacher);
  const badge = document.getElementById("roomHoursBadge");
  if (!badge) return;
  if (status.isOpen) {
    badge.textContent = `🟢 Available (${status.scheduleText})`;
    badge.className = "badge badge-online";
  } else {
    badge.textContent = `⏰ Outside Hours (${status.scheduleText})`;
    badge.className = "badge badge-teacher";
  }
}

window.openClassRoom = function (teacherId, sectionCode, subjectName) {
  if (isDroppedStudent(currentUser)) {
    goToDroppedPortal();
    return;
  }
  if (isGraduatedStudent(currentUser)) {
    handleLogout();
    return;
  }
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
    (u) =>
      u.role === "student" &&
      !isGraduatedStudent(u) &&
      !isDroppedStudent(u) &&
      normalizeSection(u.sectionCode) === normalizeSection(sectionCode)
  ).length;
  document.getElementById("roomMemberCount").textContent = `👥 ${studentCount} Active Student${studentCount === 1 ? "" : "s"}`;

  updateRoomConsultationBadge();

  if (currentUser.role === "teacher") {
    document.getElementById("roomHoursBtn").classList.remove("hidden");
    document.getElementById("newPinLinkBtn").classList.remove("hidden");
    document.getElementById("newAnnouncementBtn").classList.remove("hidden");
    document.getElementById("pmTabLabel").textContent = "📥 Student PM Inbox";
  } else {
    document.getElementById("roomHoursBtn").classList.add("hidden");
    document.getElementById("newPinLinkBtn").classList.add("hidden");
    document.getElementById("newAnnouncementBtn").classList.add("hidden");
    document.getElementById("pmTabLabel").textContent = `🔒 PM ${teacher.name}`;
  }

  workspaceMode = "chat";
  chatFilter = "all";
  clearComposerAttachments();
  updateTicketOpenBadge();
  switchWorkspaceMode("chat");
};

window.switchWorkspaceMode = function (mode) {
  workspaceMode = mode;
  const tabChat = document.getElementById("tabGroupChat");
  const tabPm = document.getElementById("tabPrivateMsg");
  const tabTickets = document.getElementById("tabTickets");
  const chatSpace = document.getElementById("groupChatWorkspace");
  const pmSpace = document.getElementById("pmWorkspace");
  const ticketsSpace = document.getElementById("ticketsWorkspace");

  [tabChat, tabPm, tabTickets].forEach((t) => t && t.classList.remove("active"));
  [chatSpace, pmSpace, ticketsSpace].forEach((s) => s && s.classList.add("hidden"));

  if (mode === "chat") {
    tabChat.classList.add("active");
    chatSpace.classList.remove("hidden");
    renderApp();
  } else if (mode === "pm") {
    tabPm.classList.add("active");
    pmSpace.classList.remove("hidden");
    renderPmWorkspace();
  } else {
    tabTickets.classList.add("active");
    ticketsSpace.classList.remove("hidden");
    renderTicketsWorkspace();
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
  updateTicketOpenBadge();
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
    listEl.innerHTML = `<div style="font-size:0.78rem; color:var(--text-muted);">No pinned announcements or links for this subject yet.</div>`;
    return;
  }

  listEl.innerHTML = anns
    .map((a) => {
      const delBtn =
        currentUser.role === "teacher"
          ? `<button class="action-link danger" onclick="deleteAnnouncement('${a.id}')" title="Unpin">✕</button>`
          : "";

      if (a.type === "link" && a.url) {
        const safeUrl = sanitizeSafeUrl(a.url);
        if (!safeUrl) return "";
        return `
          <div class="pinned-link-pill">
            <div class="pinned-link-info">
              <span style="font-size:1.1rem;">🔗</span>
              <div style="min-width:0;">
                <div style="font-size:0.82rem; font-weight:700;">${escapeHtml(a.title)}</div>
                <div class="pinned-link-url">${escapeHtml(safeUrl)}</div>
              </div>
            </div>
            <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
              <a href="${escapeAttr(safeUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm">Open Link ↗</a>
              ${delBtn}
            </div>
          </div>`;
      }

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

window.handlePinLink = function (e) {
  e.preventDefault();
  if (!currentUser || currentUser.role !== "teacher" || !selectedClass) return;
  const title = document.getElementById("pinLinkTitle").value.trim();
  const safeUrl = sanitizeSafeUrl(document.getElementById("pinLinkUrl").value);
  if (!title || !safeUrl) {
    showToast("Please enter a valid http:// or https:// URL.", "error");
    return;
  }

  appState.announcements.unshift({
    id: "ann_" + Date.now(),
    type: "link",
    teacherId: selectedClass.teacherId,
    teacherName: currentUser.name,
    sectionCode: selectedClass.sectionCode,
    subjectName: selectedClass.subjectName,
    title,
    url: safeUrl,
    body: safeUrl,
    createdAt: new Date().toISOString()
  });

  saveState();
  closeAllModals();
  e.target.reset();
  renderPinnedAnnouncements();
  pushNotification(`New pinned link in ${selectedClass.subjectName}: ${title}`);
  showToast("Class link pinned!", "success");
};

window.handlePostAnnouncement = function (e) {
  e.preventDefault();
  if (!currentUser || currentUser.role !== "teacher" || !selectedClass) return;
  const title = document.getElementById("annTitleInput").value.trim();
  const body = document.getElementById("annBodyInput").value.trim();
  if (!title || !body) return;

  appState.announcements.unshift({
    id: "ann_" + Date.now(),
    type: "announcement",
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
  showToast("Pinned item removed.");
};

window.handleAttachLink = function (e) {
  e.preventDefault();
  const name = document.getElementById("chatLinkName").value.trim();
  const safeUrl = sanitizeSafeUrl(document.getElementById("chatLinkUrl").value);
  if (!name || !safeUrl) {
    showToast("Please enter a valid http:// or https:// URL.", "error");
    return;
  }

  pendingAttachment = {
    type: "link",
    name,
    url: safeUrl
  };
  document.getElementById("attachmentPreviewName").textContent = `🔗 ${name}`;
  document.getElementById("attachmentPreviewBar").classList.remove("hidden");
  closeAllModals();
  e.target.reset();
  document.getElementById("chatMessageInput").focus();
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
      if (url.includes("meet.google.com") || url.includes("zoom.us")) {
        label = "Online Class Meeting Link";
        icon = "📹";
      } else if (url.includes("drive.google.com") || url.includes("docs.google.com")) {
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
          attachmentHtml = `<img src="${escapeAttr(m.attachment.url)}" alt="Attachment" class="msg-attachment-img" onclick="openLightbox('${escapeAttr(m.attachment.url)}')" />`;
        } else if (m.attachment.type === "link") {
          const safeLink = sanitizeSafeUrl(m.attachment.url);
          if (safeLink) {
            attachmentHtml = `<a href="${escapeAttr(safeLink)}" target="_blank" rel="noopener noreferrer" class="msg-attachment-card">🔗 <span>${escapeHtml(m.attachment.name)}</span></a>`;
          }
        } else {
          attachmentHtml = `<a href="${escapeAttr(m.attachment.url)}" target="_blank" rel="noopener" download="${escapeAttr(m.attachment.name)}" class="msg-attachment-card">📎 <span>${escapeHtml(m.attachment.name)}</span></a>`;
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

  const MAX_BUCKET_FILE_BYTES = 5 * 1024 * 1024;
  const isImage = file.type.startsWith("image/");

  if (!isImage && file.size > MAX_BUCKET_FILE_BYTES) {
    showToast("File is over 5MB. Upload to Google Drive/OneDrive and attach the share link in chat!", "error");
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
      showToast("File over 300KB: create 'classroom-files' bucket in Supabase or attach a Google Drive link.", "error");
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
  if (idx >= 0) {
    msg.reactions[emoji].splice(idx, 1);
  } else {
    msg.reactions[emoji].push(currentUser.id);
    if (emoji === "✅" && currentUser.role === "teacher") {
      msg.answered = true;
    }
  }
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
   1-ON-1 PRIVATE MESSAGING (WITH FACULTY TIME LIMIT GUARD)
   ========================================================================== */
function renderPmWorkspace() {
  if (!selectedClass || !currentUser) return;
  const threadList = document.getElementById("pmThreadList");
  const teacher = appState.users.find((u) => u.id === selectedClass.teacherId);
  const status = getTeacherConsultationStatus(teacher);

  const banner = document.getElementById("pmHoursStatusBanner");
  const pmInput = document.getElementById("pmMessageInput");
  const pmSendBtn = document.getElementById("pmSendBtn");

  if (status.isOpen) {
    banner.className = "hours-banner open";
    banner.innerHTML = `<span>🟢 ${escapeHtml(status.reason)}</span>`;
    pmInput.disabled = false;
    pmSendBtn.disabled = false;
    pmInput.placeholder = "Send a private 1-on-1 message...";
  } else {
    banner.className = "hours-banner closed";
    if (currentUser.role === "student") {
      banner.innerHTML = `
        <span>⏰ ${escapeHtml(status.reason)}</span>
        <button type="button" class="btn btn-teacher btn-sm" onclick="switchWorkspaceMode('tickets'); openModal('createTicketModal');">🎫 File Consultation Ticket</button>
      `;
      pmInput.disabled = true;
      pmSendBtn.disabled = true;
      pmInput.placeholder = "Live PM paused outside faculty consultation hours. Use Consultation Tickets.";
    } else {
      banner.innerHTML = `
        <span>⏰ Currently outside your configured consultation hours (${escapeHtml(status.scheduleText)}). Students cannot send new live PMs right now, but you may still reply.</span>
        <button type="button" class="btn btn-secondary btn-sm" onclick="openConsultationHoursModal()">Edit Hours</button>
      `;
      pmInput.disabled = false;
      pmSendBtn.disabled = false;
    }
  }

  let partners = [];
  if (currentUser.role === "student") {
    if (teacher) partners = [teacher];
    selectedPmPartnerId = selectedClass.teacherId;
  } else {
    partners = appState.users.filter(
      (u) =>
        u.role === "student" &&
        !isGraduatedStudent(u) &&
        !isDroppedStudent(u) &&
        normalizeSection(u.sectionCode) === normalizeSection(selectedClass.sectionCode)
    );
    if (!selectedPmPartnerId && partners.length > 0) {
      selectedPmPartnerId = partners[0].id;
    }
  }

  if (partners.length === 0) {
    threadList.innerHTML = `<div style="font-size:0.78rem; color:var(--text-muted); padding:8px;">No active students registered in ${escapeHtml(selectedClass.sectionCode)} yet.</div>`;
    document.getElementById("pmFeed").innerHTML = "";
    return;
  }

  threadList.innerHTML = partners
    .map((p) => {
      const active = p.id === selectedPmPartnerId ? "active" : "";
      return `
        <button type="button" class="mode-tab ${active}" style="justify-content:space-between; width:100%; text-align:left;" onclick="selectPmPartner('${p.id}')">
          <span>${escapeHtml(p.name)}</span>
          <span class="badge badge-section">${p.role === "teacher" ? "Prof" : escapeHtml(p.yearLevel || p.sectionCode)}</span>
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

  if (currentUser.role === "student") {
    const teacher = appState.users.find((u) => u.id === selectedClass.teacherId);
    const status = getTeacherConsultationStatus(teacher);
    if (!status.isOpen) {
      showToast("Outside faculty contact hours. Please submit a Consultation Ticket instead.", "error");
      return;
    }
  }

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
   CONSULTATION TICKETS (24/7 STUDENT QUEUE)
   ========================================================================== */
function updateTicketOpenBadge() {
  const badge = document.getElementById("ticketOpenBadge");
  if (!badge || !selectedClass) return;
  const openCount = (appState.tickets || []).filter(
    (t) =>
      t.teacherId === selectedClass.teacherId &&
      t.sectionCode === selectedClass.sectionCode &&
      t.subjectName === selectedClass.subjectName &&
      t.status === "open" &&
      (currentUser.role === "teacher" || t.studentId === currentUser.id)
  ).length;

  if (openCount > 0) {
    badge.textContent = openCount;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

function renderTicketsWorkspace() {
  if (!selectedClass || !currentUser) return;
  const feed = document.getElementById("ticketsFeed");
  const newBtn = document.getElementById("newTicketBtn");
  if (newBtn) newBtn.classList.toggle("hidden", currentUser.role !== "student");

  const list = (appState.tickets || []).filter(
    (t) =>
      t.teacherId === selectedClass.teacherId &&
      t.sectionCode === selectedClass.sectionCode &&
      t.subjectName === selectedClass.subjectName &&
      (currentUser.role === "teacher" || t.studentId === currentUser.id)
  );

  if (list.length === 0) {
    feed.innerHTML = `
      <div class="empty-state">
        <h4>No Consultation Tickets Yet</h4>
        <p>${
          currentUser.role === "student"
            ? "Need help outside faculty hours? Click '+ Submit Ticket' above to queue your concern."
            : "No student consultation tickets have been submitted for this subject yet."
        }</p>
      </div>`;
    return;
  }

  feed.innerHTML = list
    .map((tk) => {
      const replySection = tk.facultyReply
        ? `<div style="padding:8px 12px; border-radius:10px; background:var(--teacher-soft); border:1px solid var(--teacher-border); font-size:0.8rem;">
             <strong>👩‍🏫 Faculty Response:</strong> ${escapeHtml(tk.facultyReply)}
           </div>`
        : "";

      const teacherAction =
        currentUser.role === "teacher"
          ? `<div style="display:flex; gap:8px; margin-top:4px; flex-wrap:wrap;">
               <button type="button" class="btn btn-teacher btn-sm" onclick="replyAndResolveTicket('${tk.id}')">
                 ${tk.status === "resolved" ? "Update Response" : "✅ Reply & Resolve Ticket"}
               </button>
             </div>`
          : "";

      return `
        <div class="ticket-card">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
            <div>
              <span class="badge badge-section">${escapeHtml(tk.category)}</span>
              <strong style="margin-left:6px;">${escapeHtml(tk.subject)}</strong>
            </div>
            <span class="badge ${tk.status === "resolved" ? "ticket-status-resolved" : "ticket-status-open"}">
              ${tk.status === "resolved" ? "✅ Resolved" : "⏳ Pending Faculty Review"}
            </span>
          </div>
          <div style="font-size:0.82rem; color:var(--text-secondary);">${escapeHtml(tk.details)}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">
            Submitted by <strong>${escapeHtml(tk.studentName)}</strong> • ${formatTime(tk.createdAt)}
          </div>
          ${replySection}
          ${teacherAction}
        </div>`;
    })
    .join("");
}

window.handleCreateTicket = function (e) {
  e.preventDefault();
  if (!selectedClass || !currentUser || currentUser.role !== "student") return;
  const category = document.getElementById("ticketCategoryInput").value;
  const subject = document.getElementById("ticketSubjectInput").value.trim();
  const details = document.getElementById("ticketDetailsInput").value.trim();
  if (!subject || !details) return;

  appState.tickets = appState.tickets || [];
  appState.tickets.unshift({
    id: "tkt_" + Date.now(),
    teacherId: selectedClass.teacherId,
    teacherName: selectedClass.teacherName,
    sectionCode: selectedClass.sectionCode,
    subjectName: selectedClass.subjectName,
    studentId: currentUser.id,
    studentName: currentUser.name,
    category,
    subject,
    details,
    status: "open",
    facultyReply: "",
    createdAt: new Date().toISOString()
  });

  saveState();
  closeAllModals();
  e.target.reset();
  updateTicketOpenBadge();
  renderTicketsWorkspace();
  showToast("Consultation ticket submitted to instructor!", "success");
};

window.replyAndResolveTicket = function (ticketId) {
  if (!currentUser || currentUser.role !== "teacher") return;
  const tk = (appState.tickets || []).find((t) => t.id === ticketId);
  if (!tk) return;
  const response = prompt(`Enter your official response for ${tk.studentName}:`, tk.facultyReply || "");
  if (response === null) return;
  tk.facultyReply = response.trim();
  tk.status = "resolved";
  saveState();
  updateTicketOpenBadge();
  renderTicketsWorkspace();
  showToast("Ticket marked as resolved!", "success");
};

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