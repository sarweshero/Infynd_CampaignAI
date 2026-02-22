"use client";

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  Fragment,
} from "react";
import {
  authLogin,
  authRegister,
  authRefresh,
  getProfile,
  updateProfile,
  changePassword,
  createCampaign,
  listCampaigns,
  getCampaignCount,
  getCampaign,
  editContactContent,
  editCommonContent,
  fetchCallTemplateAudio,
  fetchCallTemplateVoices,
  approveCampaign,
  regenerateCampaignContent,
  getCampaignAnalytics,
  getCampaignLogs,
  getCampaignMessages,
  getTrackingEvents,
  getAllTrackingEvents,
  sendgridWebhook,
  callTracking,
  linkedinTracking,
  openApprovalWs,
  setTokens,
  clearTokens,
  loadTokens,
  getAccessToken,
  isLoggedIn,
  type Campaign,
  type CampaignAnalytics,
  type HourlyActivity,
  type TopContact,
  type TrackingEvent,
  type TrackingFeed,
  type WsMessage,
  type WsAction,
  type LogEntry,
  type MessageEntry,
  type ProfileResponse,
} from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────────────────────
type View =
  | "login"
  | "dashboard"
  | "create"
  | "detail"
  | "analytics"
  | "approval"
  | "history"
  | "tracking"
  | "settings";

interface Toast {
  id: number;
  msg: string;
  kind: "success" | "error" | "info";
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────
const STATE_COLORS: Record<string, string> = {
  CREATED:              "bg-slate-100 text-slate-600 border border-slate-200",
  CLASSIFIED:           "bg-blue-50 text-blue-700 border border-blue-200",
  CONTACTS_RETRIEVED:   "bg-cyan-50 text-cyan-700 border border-cyan-200",
  CHANNEL_DECIDED:      "bg-indigo-50 text-indigo-700 border border-indigo-200",
  CONTENT_GENERATED:    "bg-violet-50 text-violet-700 border border-violet-200",
  AWAITING_APPROVAL:    "bg-amber-50 text-amber-700 border border-amber-200",
  APPROVED:             "bg-green-50 text-green-700 border border-green-200",
  DISPATCHED:           "bg-blue-50 text-blue-800 border border-blue-300",
  COMPLETED:            "bg-emerald-50 text-emerald-700 border border-emerald-200",
  FAILED:               "bg-red-50 text-red-700 border border-red-200",
};

const PIPELINE_STEPS = [
  "CREATED",
  "CLASSIFIED",
  "CONTACTS_RETRIEVED",
  "CHANNEL_DECIDED",
  "CONTENT_GENERATED",
  "AWAITING_APPROVAL",
  "APPROVED",
  "DISPATCHED",
  "COMPLETED",
];

function stateColor(s: string) {
  return STATE_COLORS[s] ?? "bg-slate-100 text-slate-600";
}

function stepDone(current: string, step: string) {
  const ci = PIPELINE_STEPS.indexOf(current);
  const si = PIPELINE_STEPS.indexOf(step);
  if (current === "FAILED") return false;
  return si <= ci;
}

// Ensure bare ISO strings (no Z/offset) are treated as UTC so local-time display is correct
function asUTC(iso: string): string {
  if (!iso || typeof iso !== "string") return iso;
  // Already has timezone info
  if (/[Zz]$/.test(iso) || /[+-]\d{2}:\d{2}$/.test(iso) || /[+-]\d{4}$/.test(iso)) return iso;
  return iso + "Z";
}

function fmt(iso: string) {
  if (!iso || typeof iso !== "string") return "—";
  const d = new Date(asUTC(iso));
  if (isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function fmtDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function pct(num: number, total: number) {
  if (!total) return 0;
  return Math.round((num / total) * 100);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Toast System
// ─────────────────────────────────────────────────────────────────────────────
let _toastId = 0;

function Toasts({ toasts, remove }: { toasts: Toast[]; remove: (id: number) => void }) {
  return (
    <div className="fixed top-5 right-5 z-[9999] flex flex-col gap-3 min-w-[320px] max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast-anim flex items-start gap-3 rounded-2xl px-5 py-3.5 shadow-premium-lg text-sm font-medium cursor-pointer ${
            t.kind === "success"
              ? "bg-white border border-emerald-200 text-emerald-800 shadow-[0_4px_20px_rgba(16,185,129,0.15)]"
              : t.kind === "error"
              ? "bg-white border border-red-200 text-red-800 shadow-[0_4px_20px_rgba(239,68,68,0.15)]"
              : "bg-white border border-blue-200 text-blue-800 shadow-[0_4px_20px_rgba(59,130,246,0.15)]"
          }`}
          onClick={() => remove(t.id)}
        >
          <span
            className={`mt-0.5 text-base w-6 h-6 rounded-full flex items-center justify-center text-xs flex-shrink-0 ${
              t.kind === "success"
                ? "bg-emerald-100 text-emerald-600"
                : t.kind === "error"
                ? "bg-red-100 text-red-600"
                : "bg-blue-100 text-blue-600"
            }`}
          >
            {t.kind === "success" ? "✓" : t.kind === "error" ? "✕" : "ℹ"}
          </span>
          <span className="flex-1 leading-snug">{t.msg}</span>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Sidebar
// ─────────────────────────────────────────────────────────────────────────────
const NAV: { id: string; label: string; icon: React.ReactNode }[] = [
  { id: "create", label: "New Campaign", icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg> },
  { id: "dashboard", label: "Dashboard", icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg> },
  { id: "history", label: "History", icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> },
  { id: "tracking", label: "Tracking", icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg> },
  { id: "settings", label: "Settings", icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/></svg> },
];

function Sidebar({
  view,
  setView,
  userEmail,
  role,
  onLogout,
}: {
  view: View;
  setView: (v: View) => void;
  userEmail: string;
  role: string;
  onLogout: () => void;
}) {
  return (
    <aside className="flex flex-col w-[260px] h-screen overflow-y-auto shrink-0 sticky top-0 bg-[#0f172a] py-5 relative">
      {/* Logo */}
      <div className="px-5 mb-8">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-white font-bold text-xs">
            <span className="font-display tracking-tight">In</span>
          </div>
          <div>
            <div className="text-white font-bold text-[15px] leading-tight font-display tracking-tight">InFynd</div>
            <div className="text-blue-400 text-[10px] font-medium tracking-widest uppercase">Campaign Engine</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 space-y-0.5">
        {NAV.map((item) => (
          <button
            key={item.id}
            onClick={() => setView(item.id as View)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13px] transition-all duration-150 ${
              view === item.id
                ? "bg-white/[0.08] text-white font-medium"
                : "text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]"
            }`}
          >
            <span className={`w-[18px] h-[18px] flex-shrink-0 ${view === item.id ? "text-blue-400" : ""}`}>
              {item.icon}
            </span>
            {item.label}
            {item.id === "create" && (
              <span className="ml-auto text-[9px] bg-blue-600 text-white px-1.5 py-0.5 rounded font-bold tracking-wide">
                AI
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* Divider */}
      <div className="mx-4 border-t border-white/[0.06]" />

      {/* User */}
      <div className="px-4 pt-4 pb-2">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-md bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-xs font-bold uppercase">
            {userEmail.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-slate-300 truncate font-medium">{userEmail}</div>
            <div
              className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium mt-0.5 ${
                role === "ADMIN"
                  ? "bg-blue-500/20 text-blue-300"
                  : "bg-white/[0.05] text-slate-500"
              }`}
            >
              {role}
            </div>
          </div>
        </div>
        <button
          onClick={onLogout}
          className="w-full flex items-center gap-2 text-xs text-slate-500 hover:text-red-400 transition-all px-1 py-1.5 rounded-md hover:bg-white/[0.04]"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          Sign out
        </button>
      </div>
    </aside>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Login / Register View
// ─────────────────────────────────────────────────────────────────────────────
function LoginView({ onSuccess }: { onSuccess: (email: string, role: string) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr("");
    const { data, error } = await authLogin(email, password);
    setLoading(false);
    if (error || !data) { setErr(error ?? "Login failed"); return; }
    setTokens(data.access_token, data.refresh_token);
    onSuccess(data.email, data.role);
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr("");
    setSuccessMsg("");

    if (password.length < 6) {
      setErr("Password must be at least 6 characters");
      setLoading(false);
      return;
    }

    const { data, error } = await authRegister(email, password, fullName || undefined);
    setLoading(false);
    if (error || !data) { setErr(error ?? "Registration failed"); return; }

    setSuccessMsg("Account created! Signing you in…");

    // Auto-login after successful registration
    const { data: loginData, error: loginErr } = await authLogin(email, password);
    if (loginErr || !loginData) {
      setSuccessMsg("");
      setErr("Account created but auto-login failed. Please sign in manually.");
      setMode("login");
      return;
    }
    setTokens(loginData.access_token, loginData.refresh_token);
    onSuccess(loginData.email, loginData.role);
  }

  function switchMode() {
    setMode(mode === "login" ? "register" : "login");
    setErr("");
    setSuccessMsg("");
  }

  return (
    <div className="min-h-screen bg-[#f8fafc] flex items-center justify-center p-4 relative overflow-hidden">
      {/* Subtle gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-blue-50/50 via-transparent to-indigo-50/30" />

      <div className="w-full max-w-md relative z-10">
        {/* Logo & heading */}
        <div className="text-center mb-8 animate-fade-in-up">
          <div className="inline-flex w-14 h-14 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 items-center justify-center text-white text-lg font-bold mb-4">
            <span className="font-display">In</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight font-display">
            InFynd{" "}
            <span className="text-blue-600">Campaign Engine</span>
          </h1>
          <p className="text-slate-400 mt-1.5 text-sm">
            {mode === "login"
              ? "Sign in to your account"
              : "Create a new account"}
          </p>
        </div>

        {/* Card */}
        <div
          className="bg-white border border-slate-200 rounded-xl p-7 space-y-5 shadow-sm animate-fade-in-up"
          style={{ animationDelay: "0.1s" }}
        >
          {/* Mode toggle tabs */}
          <div className="flex rounded-xl bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => { setMode("login"); setErr(""); setSuccessMsg(""); }}
              className={`flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all ${
                mode === "login"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => { setMode("register"); setErr(""); setSuccessMsg(""); }}
              className={`flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all ${
                mode === "register"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              Register
            </button>
          </div>

          {/* Registration: Full Name */}
          {mode === "register" && (
            <div>
              <label className="block text-sm text-slate-700 mb-2 font-semibold">
                Full Name
              </label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="input-premium"
                placeholder="John Doe"
              />
            </div>
          )}

          <div>
            <label className="block text-sm text-slate-700 mb-2 font-semibold">
              Email Address
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input-premium"
              placeholder="you@company.com"
              required
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-2 font-semibold">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-premium"
              placeholder="••••••••"
              required
            />
            {mode === "register" && (
              <p className="text-xs text-slate-400 mt-1">Minimum 6 characters</p>
            )}
          </div>

          {err && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-red-100 flex items-center justify-center text-xs text-red-600 shrink-0">
                ✕
              </span>
              {err}
            </div>
          )}

          {successMsg && (
            <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl px-4 py-3 text-sm flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-emerald-100 flex items-center justify-center text-xs text-emerald-600 shrink-0">
                ✓
              </span>
              {successMsg}
            </div>
          )}

          <button
            type="button"
            onClick={mode === "login" ? handleLogin : handleRegister}
            disabled={loading}
            className="btn-brand w-full py-3.5 text-sm rounded-xl font-semibold"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-3">
                <span className="btn-spinner" />
                {mode === "login" ? "Signing in…" : "Creating account…"}
              </span>
            ) : mode === "login" ? (
              "Sign in to InFynd →"
            ) : (
              "Create Account →"
            )}
          </button>

          <p className="text-center text-xs text-slate-400">
            {mode === "login" ? (
              <>
                Don&apos;t have an account?{" "}
                <button type="button" onClick={switchMode} className="text-blue-500 font-medium hover:underline">
                  Register
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button type="button" onClick={switchMode} className="text-blue-500 font-medium hover:underline">
                  Sign in
                </button>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Expandable Textarea  (collapsed by default, ^ to expand)
// ─────────────────────────────────────────────────────────────────────────────
function ExpandableTextarea({
  value,
  onChange,
  className = "",
  expandedRows = 5,
}: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  className?: string;
  expandedRows?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="relative">
      <textarea
        value={value}
        onChange={onChange}
        rows={expanded ? expandedRows : 1}
        className={`${className} resize-none pr-8`}
      />
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        title={expanded ? "Collapse" : "Expand"}
        className="absolute right-2 top-2 w-5 h-5 flex items-center justify-center rounded text-slate-400 hover:text-blue-500 hover:bg-slate-100 transition-all select-none"
        style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Metric Card
// ─────────────────────────────────────────────────────────────────────────────
function Metric({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <div className="text-slate-400 text-[11px] uppercase tracking-wider font-medium mb-1.5">
        {label}
      </div>
      <div
        className={`text-2xl font-bold tracking-tight font-display ${
          accent ?? "text-slate-900"
        }`}
      >
        {value}
      </div>
      {sub && (
        <div className="text-blue-500 text-xs mt-1 font-medium">{sub}</div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Chart helpers (pure SVG / CSS)
// ─────────────────────────────────────────────────────────────────────────────
const CHART_BG: Record<string, string> = {
  CREATED:              "bg-slate-400",
  CLASSIFIED:           "bg-sky-500",
  CONTACTS_RETRIEVED:   "bg-cyan-500",
  CHANNEL_DECIDED:      "bg-blue-500",
  CONTENT_GENERATED:    "bg-violet-500",
  AWAITING_APPROVAL:    "bg-amber-500",
  APPROVED:             "bg-green-500",
  DISPATCHED:           "bg-blue-600",
  COMPLETED:            "bg-emerald-500",
  FAILED:               "bg-red-500",
};

const CHART_HEX: Record<string, string> = {
  CREATED:              "#94a3b8",
  CLASSIFIED:           "#0ea5e9",
  CONTACTS_RETRIEVED:   "#06b6d4",
  CHANNEL_DECIDED:      "#3b82f6",
  CONTENT_GENERATED:    "#8b5cf6",
  AWAITING_APPROVAL:    "#f59e0b",
  APPROVED:             "#22c55e",
  DISPATCHED:           "#2563eb",
  COMPLETED:            "#10b981",
  FAILED:               "#ef4444",
  // platforms
  email:                "#0ea5e9",
  linkedin:             "#2563eb",
  call:                 "#8b5cf6",
  sms:                  "#14b8a6",
};

const PLATFORM_BG: Record<string, string> = {
  email:    "bg-sky-500",
  linkedin: "bg-blue-600",
  call:     "bg-violet-500",
  sms:      "bg-teal-500",
};

function HBarChart({ items, maxVal }: { items: { label: string; value: number; bg: string }[]; maxVal: number }) {
  return (
    <div className="space-y-3">
      {items.map(({ label, value, bg }) => (
        <div key={label}>
          <div className="flex justify-between items-center text-xs mb-1">
            <span className="text-slate-600 capitalize truncate max-w-[180px]">
              {label.replace(/_/g, " ")}
            </span>
            <span className="text-slate-500 font-mono tabular-nums ml-2">{value}</span>
          </div>
          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full bar-fill progress-bar-animated ${bg}`}
              style={{ width: maxVal > 0 ? `${Math.max((value / maxVal) * 100, value > 0 ? 3 : 0)}%` : "0%" }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function RingChart({
  pct: pctVal,
  hex,
  centerLabel,
  centerSub,
}: {
  pct: number;
  hex: string;
  centerLabel: string;
  centerSub: string;
}) {
  const r = 34;
  const circ = 2 * Math.PI * r;
  const dash = (Math.min(pctVal, 100) / 100) * circ;
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative w-24 h-24">
        <svg width="96" height="96" viewBox="0 0 96 96" className="-rotate-90">
          <circle cx="48" cy="48" r={r} fill="none" stroke="#e2e8f0" strokeWidth="10" />
          <circle
            cx="48" cy="48" r={r}
            fill="none"
            stroke={hex}
            strokeWidth="10"
            strokeDasharray={`${dash} ${circ - dash}`}
            strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 4px ${hex}60)` }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-lg font-bold text-slate-800 leading-tight font-display">{centerLabel}</span>
          <span className="text-[10px] text-slate-400 leading-tight">{centerSub}</span>
        </div>
      </div>
    </div>
  );
}

function MiniVBar({ items, maxVal }: { items: { label: string; value: number; bg: string }[]; maxVal: number }) {
  return (
    <div className="flex items-end gap-1 h-20">
      {items.map(({ label, value, bg }) => {
        const barH = maxVal > 0 ? Math.max((value / maxVal) * 56, value > 0 ? 4 : 0) : 0;
        return (
          <div key={label} className="flex flex-col items-center flex-1 gap-0.5 min-w-0">
            {value > 0 && (
              <span className="text-[10px] text-slate-500 leading-none">{value}</span>
            )}
            <div className="flex-1 w-full flex items-end">
              <div
                className={`w-full rounded-t transition-all duration-700 ${bg}`}
                style={{ height: `${barH}px` }}
              />
            </div>
            <span className="text-[9px] text-slate-400 truncate w-full text-center leading-none">
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  DonutChart — pure SVG pie/donut with legend
// ─────────────────────────────────────────────────────────────────────────────
function DonutChart({
  segments,
  centerLabel,
  centerSub,
}: {
  segments: { value: number; hex: string; label: string }[];
  centerLabel: string;
  centerSub?: string;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total === 0)
    return <p className="text-slate-300 text-xs py-10 text-center">No data yet</p>;

  const cx = 70; const cy = 70;
  const R = 54;  const r = 34;
  let angle = -Math.PI / 2;

  const paths = segments
    .filter((s) => s.value > 0)
    .map(({ value, hex }) => {
      const sweep = (value / total) * 2 * Math.PI;
      const x1 = cx + R * Math.cos(angle);
      const y1 = cy + R * Math.sin(angle);
      const x2 = cx + R * Math.cos(angle + sweep);
      const y2 = cy + R * Math.sin(angle + sweep);
      const ix1 = cx + r * Math.cos(angle);
      const iy1 = cy + r * Math.sin(angle);
      const ix2 = cx + r * Math.cos(angle + sweep);
      const iy2 = cy + r * Math.sin(angle + sweep);
      const large = sweep > Math.PI ? 1 : 0;
      const d = `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L ${ix2.toFixed(2)} ${iy2.toFixed(2)} A ${r} ${r} 0 ${large} 0 ${ix1.toFixed(2)} ${iy1.toFixed(2)} Z`;
      angle += sweep;
      return { d, hex };
    });

  return (
    <div className="flex items-center gap-5">
      <svg
        width="140" height="140"
        viewBox="0 0 140 140"
        className="flex-shrink-0"
      >
        {paths.map((p, i) => (
          <path
            key={i}
            d={p.d}
            fill={p.hex}
            className="hover:opacity-80 transition-opacity cursor-pointer"
          />
        ))}
        {/* center hole */}
        <circle cx={cx} cy={cy} r={r - 2} fill="white" />
        <text
          x={cx} y={cy - 5}
          textAnchor="middle"
          style={{ fontSize: 22, fontWeight: 800, fill: "#0f172a" }}
        >
          {centerLabel}
        </text>
        <text
          x={cx} y={cy + 11}
          textAnchor="middle"
          style={{ fontSize: 10, fill: "#94a3b8" }}
        >
          {centerSub ?? "total"}
        </text>
      </svg>

      <div className="flex-1 space-y-2 min-w-0">
        {segments
          .filter((s) => s.value > 0)
          .map(({ label, value, hex }) => (
            <div key={label} className="flex items-center gap-2">
              <div
                className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                style={{ background: hex }}
              />
              <span className="text-xs text-slate-600 capitalize truncate flex-1" style={{ maxWidth: 110 }}>
                {label.replace(/_/g, " ")}
              </span>
              <span className="text-xs font-bold text-slate-700 tabular-nums ml-auto">
                {value}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  AreaSparkline — pure SVG area + line chart with dots
// ─────────────────────────────────────────────────────────────────────────────
function AreaSparkline({
  data,
  color = "#3b82f6",
  gradId,
}: {
  data: { label: string; value: number }[];
  color?: string;
  gradId: string;
}) {
  const W = 260; const H = 80;
  const padX = 6; const padY = 10;
  const maxVal = Math.max(...data.map((d) => d.value), 1);

  const pts = data.map((d, i) => ({
    x: padX + (i / Math.max(data.length - 1, 1)) * (W - 2 * padX),
    y: H - padY - (d.value / maxVal) * (H - 2 * padY),
    value: d.value,
    label: d.label,
  }));

  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L ${pts[pts.length - 1].x.toFixed(1)} ${H} L ${pts[0].x.toFixed(1)} ${H} Z`;

  return (
    <div>
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ overflow: "visible" }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0.01" />
          </linearGradient>
        </defs>
        {/* horizontal grid lines */}
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1={padX} y1={(H - padY) - f * (H - 2 * padY)}
            x2={W - padX} y2={(H - padY) - f * (H - 2 * padY)}
            stroke="#f1f5f9" strokeWidth="1"
          />
        ))}
        <path d={areaPath} fill={`url(#${gradId})`} />
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {pts.map((p) => (
          <g key={p.label}>
            <circle cx={p.x} cy={p.y} r="4.5" fill="white" stroke={color} strokeWidth="2.5" />
            {p.value > 0 && (
              <text
                x={p.x} y={p.y - 8}
                textAnchor="middle"
                style={{ fontSize: 9, fill: "#64748b", fontWeight: 600 }}
              >
                {p.value}
              </text>
            )}
          </g>
        ))}
      </svg>
      <div className="flex justify-between mt-2 px-1">
        {data.map((d) => (
          <span key={d.label} className="text-[9px] text-slate-400 font-medium">{d.label}</span>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Stat Card — icon-accented KPI card
// ─────────────────────────────────────────────────────────────────────────────
function StatCard({
  icon,
  label,
  value,
  sub,
  iconBg,
  accentClass,
  urgent,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  sub?: string;
  iconBg: string;
  accentClass: string;
  urgent?: boolean;
}) {
  return (
    <div
      className={`bg-white border border-slate-200 rounded-xl p-5 flex items-start gap-4 hover:shadow-md transition-shadow ${
        urgent ? "border-amber-300 bg-amber-50/30" : ""
      }`}
    >
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${iconBg}`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{label}</p>
        <p className={`text-2xl font-bold font-display mt-0.5 leading-tight ${accentClass}`}>{value}</p>
        {sub && (
          <p className={`text-xs mt-1 font-medium ${urgent ? "text-amber-600" : "text-slate-400"}`}>{sub}</p>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Dashboard
// ─────────────────────────────────────────────────────────────────────────────
function DashboardView({
  campaigns,
  loading,
  refreshCampaigns,
  onSelect,
  onAnalytics,
  onApproval,
  toast,
}: {
  campaigns: Campaign[];
  loading: boolean;
  refreshCampaigns: () => void;
  onSelect: (c: Campaign) => void;
  onAnalytics: (c: Campaign) => void;
  onApproval: (c: Campaign) => void;
  toast: (msg: string, kind?: Toast["kind"]) => void;
}) {
  const total      = campaigns.length;
  const completed  = campaigns.filter((c) => c.pipeline_state === "COMPLETED").length;
  const failed     = campaigns.filter((c) => c.pipeline_state === "FAILED").length;
  const awaiting   = campaigns.filter((c) => c.pipeline_state === "AWAITING_APPROVAL").length;
  const dispatched = campaigns.filter((c) => c.pipeline_state === "DISPATCHED").length;
  const inProgress = campaigns.filter(
    (c) => !["COMPLETED","FAILED","CREATED","AWAITING_APPROVAL"].includes(c.pipeline_state),
  ).length;
  const autoApprove = campaigns.filter((c) => c.auto_approve_content).length;

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const stateItems = ([...PIPELINE_STEPS, "FAILED"] as string[])
    .map((s) => ({ label: s, value: campaigns.filter((c) => c.pipeline_state === s).length, bg: CHART_BG[s] ?? "bg-slate-400" }))
    .filter((x) => x.value > 0);
  const maxState = Math.max(...stateItems.map((x) => x.value), 1);

  const rawPlatforms = campaigns.map((c) =>
    (c.platform ?? "email").toLowerCase().split(/[,+/\s]/)[0].trim(),
  );
  const uniquePlatforms = [...new Set(rawPlatforms)].filter(Boolean);
  const platformItems = uniquePlatforms.map((p) => ({
    label: p,
    value: rawPlatforms.filter((x) => x === p).length,
    bg: PLATFORM_BG[p] ?? "bg-blue-500",
  }));
  const maxPlatform = Math.max(...platformItems.map((x) => x.value), 1);

  const approvalItems = [
    { label: "Auto-approved", value: autoApprove, bg: "bg-emerald-500" },
    { label: "Manual review", value: total - autoApprove, bg: "bg-amber-500" },
  ].filter((x) => x.value > 0);
  const maxApproval = Math.max(...approvalItems.map((x) => x.value), 1);

  const DAY_SHORT = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const dayItems = mounted
    ? Array.from({ length: 7 }, (_, i) => {
        const d = new Date(Date.now() - (6 - i) * 86_400_000);
        const dateStr = d.toISOString().slice(0, 10);
        return { label: DAY_SHORT[d.getDay()], value: campaigns.filter((c) => c.created_at.slice(0, 10) === dateStr).length, bg: "bg-blue-500" };
      })
    : Array.from({ length: 7 }, (_, i) => ({ label: DAY_SHORT[i], value: 0, bg: "bg-blue-500" }));
  const maxDay = Math.max(...dayItems.map((x) => x.value), 1);

  async function handleApprove(c: Campaign) {
    const { error } = await approveCampaign(c.id);
    if (error) { toast(error, "error"); return; }
    toast(`Campaign "${c.name}" approved!`, "success");
    refreshCampaigns();
  }

  return (
    <div className="view-enter space-y-6">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 tracking-tight font-display">Overview</h2>
          <p className="text-slate-400 text-sm mt-0.5">
            {total > 0
              ? `${total} campaign${total !== 1 ? "s" : ""} total · live analytics`
              : "Create your first campaign to get started"}
          </p>
        </div>
        <button onClick={refreshCampaigns} className="btn-ghost text-sm flex items-center gap-2">
          {loading
            ? <span className="btn-spinner-blue" />
            : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>}
          Refresh
        </button>
      </div>

      {/* ── KPI Strip ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-600">
              <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
              <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
            </svg>
          }
          label="Total Campaigns" value={total} sub="all time"
          iconBg="bg-blue-50" accentClass="text-slate-900"
        />
        <StatCard
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-600">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          }
          label="Completed" value={completed}
          sub={total > 0 ? `${pct(completed, total)}% success rate` : "—"}
          iconBg="bg-emerald-50" accentClass="text-emerald-700"
        />
        <StatCard
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-violet-600">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
          }
          label="Active"
          value={inProgress + dispatched}
          sub={inProgress > 0 ? `${inProgress} in pipeline` : dispatched > 0 ? `${dispatched} dispatched` : "none running"}
          iconBg="bg-violet-50" accentClass="text-violet-700"
        />
        <StatCard
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={awaiting > 0 ? "text-amber-600" : "text-slate-400"}>
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          }
          label="Needs Approval" value={awaiting}
          sub={awaiting > 0 ? "action required" : "all clear"}
          iconBg={awaiting > 0 ? "bg-amber-50" : "bg-slate-50"}
          accentClass={awaiting > 0 ? "text-amber-700" : "text-slate-900"}
          urgent={awaiting > 0}
        />
      </div>

      {/* ── Needs Attention Banner ──────────────────────────────────────── */}
      {awaiting > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl overflow-hidden">
          <div className="flex items-center gap-2.5 px-5 py-3 border-b border-amber-200/70">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-amber-600">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <span className="text-sm font-semibold text-amber-800">
              {awaiting} campaign{awaiting !== 1 ? "s" : ""} awaiting your approval
            </span>
          </div>
          <div className="divide-y divide-amber-100/80">
            {campaigns
              .filter((c) => c.pipeline_state === "AWAITING_APPROVAL")
              .map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-4 px-5 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-800 truncate">{c.name}</p>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">{c.company} · {c.platform ?? "email"} · {fmt(c.created_at)}</p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => handleApprove(c)} className="btn-success text-xs px-3 py-1.5">✓ Approve</button>
                    <button onClick={() => onApproval(c)} className="btn-warning text-xs px-3 py-1.5">Review</button>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* ── Charts ───────────────────────────────────────────────────────── */}
      {total > 0 && (() => {
        /* derive hex-based data for donut + sparkline */
        const pipelineDonut = ([...PIPELINE_STEPS, "FAILED"] as string[])
          .map((s) => ({
            label: s,
            value: campaigns.filter((c) => c.pipeline_state === s).length,
            hex: CHART_HEX[s] ?? "#94a3b8",
          }))
          .filter((x) => x.value > 0);

        const platformDonut = uniquePlatforms.map((p) => ({
          label: p,
          value: rawPlatforms.filter((x) => x === p).length,
          hex: CHART_HEX[p] ?? "#3b82f6",
        }));

        const sparkData = dayItems.map((d) => ({ label: d.label, value: d.value }));

        return (
          <div className="space-y-4">
            {/* Row 1: donut (wider) + channels + sparkline */}
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">

              {/* Pipeline Donut — spans 2 cols */}
              <div className="bg-white border border-slate-200 rounded-xl p-5 lg:col-span-2">
                <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-4">Campaign Status Distribution</p>
                <DonutChart
                  segments={pipelineDonut}
                  centerLabel={String(total)}
                  centerSub="campaigns"
                />
              </div>

              {/* Channel + Approval mix */}
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-5">
                <div>
                  <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-4">Channel Mix</p>
                  {platformDonut.length > 0 ? (
                    <DonutChart
                      segments={platformDonut}
                      centerLabel={String(total)}
                      centerSub="sent"
                    />
                  ) : (
                    <p className="text-slate-300 text-xs py-6 text-center">No data yet</p>
                  )}
                </div>
                {approvalItems.length > 0 && (
                  <div className="pt-4 border-t border-slate-100">
                    <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-3">Approval Mode</p>
                    <HBarChart items={approvalItems} maxVal={maxApproval} />
                  </div>
                )}
              </div>

              {/* 7-day Area Sparkline */}
              <div className="bg-white border border-slate-200 rounded-xl p-5">
                <div className="flex items-center justify-between mb-5">
                  <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Campaigns Created</p>
                  <span className="text-[10px] text-slate-400 bg-slate-50 border border-slate-100 px-2 py-0.5 rounded-full">7 days</span>
                </div>
                <AreaSparkline data={sparkData} color="#3b82f6" gradId="dash-spark" />
                <div className="mt-5 pt-4 border-t border-slate-100 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-base font-bold text-emerald-600 font-display leading-tight">{completed}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">Done</p>
                  </div>
                  <div>
                    <p className="text-base font-bold text-blue-600 font-display leading-tight">{dispatched}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">Sent</p>
                  </div>
                  <div>
                    <p className="text-base font-bold text-red-500 font-display leading-tight">{failed}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">Failed</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Row 2: Performance Ring Strip */}
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-5">Performance Overview</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-6">
                {[
                  { hex: "#10b981", label: `${pct(completed, total)}%`, sub: "completion",   title: "Completion Rate",  pctVal: pct(completed, total) },
                  { hex: "#3b82f6", label: `${inProgress + dispatched}`, sub: "running",    title: "Active Now",       pctVal: pct(inProgress + dispatched, total) },
                  { hex: "#ef4444", label: `${pct(failed, total)}%`,     sub: "failure",     title: "Failure Rate",    pctVal: pct(failed, total) },
                  { hex: "#f59e0b", label: `${pct(autoApprove, total)}%`,sub: "auto-send",   title: "Auto-Approve",    pctVal: pct(autoApprove, total) },
                  { hex: "#8b5cf6", label: `${awaiting}`,               sub: "pending",     title: "Awaiting Approval",pctVal: pct(awaiting, total) },
                ].map((ring) => (
                  <div key={ring.title} className="flex flex-col items-center gap-2">
                    <RingChart pct={ring.pctVal} hex={ring.hex} centerLabel={ring.label} centerSub={ring.sub} />
                    <span className="text-[11px] text-slate-500 font-medium text-center">{ring.title}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Campaign Table ──────────────────────────────────────────────── */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <h3 className="text-sm font-semibold text-slate-800">All Campaigns</h3>
            {total > 0 && (
              <span className="text-[11px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full font-medium">{total}</span>
            )}
          </div>
          {failed > 0 && (
            <span className="text-[11px] text-red-600 bg-red-50 border border-red-100 px-2.5 py-1 rounded-full font-semibold">
              {failed} failed
            </span>
          )}
        </div>

        {loading ? (
          <div className="py-16 flex flex-col items-center justify-center gap-4">
            <div className="loader-orbit" />
            <span className="text-slate-400 text-sm">Loading campaigns…</span>
          </div>
        ) : campaigns.length === 0 ? (
          <div className="py-16 flex flex-col items-center gap-3">
            <div className="w-14 h-14 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-slate-300">
                <path d="M3 9h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z"/>
                <path d="M3 9l2.45-4.9A2 2 0 0 1 7.24 3h9.52a2 2 0 0 1 1.8 1.1L21 9"/>
                <path d="M12 3v6"/>
              </svg>
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold text-slate-700">No campaigns yet</p>
              <p className="text-xs text-slate-400 mt-1">Use "New Campaign" in the sidebar to get started</p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/60">
                  <th className="px-5 py-3 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Campaign</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Status</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider hidden md:table-cell">Platform</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider hidden lg:table-cell">Company</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider hidden xl:table-cell">Created</th>
                  <th className="px-5 py-3 text-right text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b border-slate-50 hover:bg-slate-50/70 transition-colors group"
                  >
                    <td className="px-5 py-4">
                      <button
                        onClick={() => onSelect(c)}
                        className="font-semibold text-slate-800 hover:text-blue-600 transition-colors text-left max-w-[260px] block truncate"
                      >
                        {c.name}
                      </button>
                      {c.approval_required && (
                        <span className="text-[10px] text-slate-400">approval required</span>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <span className={`text-[11px] px-2.5 py-0.5 rounded-full font-semibold whitespace-nowrap ${stateColor(c.pipeline_state)}`}>
                        {c.pipeline_state.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-4 py-4 hidden md:table-cell">
                      <span className="text-xs text-slate-500 capitalize">{c.platform ?? "email"}</span>
                    </td>
                    <td className="px-4 py-4 hidden lg:table-cell">
                      <span className="text-xs text-slate-500 truncate max-w-[160px] block">{c.company ?? "—"}</span>
                    </td>
                    <td className="px-4 py-4 hidden xl:table-cell">
                      <span className="text-xs text-slate-400 font-mono tabular-nums">{fmt(c.created_at)}</span>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <div className="flex items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        {c.pipeline_state === "AWAITING_APPROVAL" && (
                          <button onClick={() => onApproval(c)} className="btn-warning text-xs px-2.5 py-1">Review</button>
                        )}
                        <button onClick={() => onAnalytics(c)} className="btn-ghost text-xs px-2.5 py-1">Analytics</button>
                        <button onClick={() => onSelect(c)} className="btn-ghost text-xs px-2.5 py-1">View</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Create Campaign — ChatGPT-style clean centered UI
// ─────────────────────────────────────────────────────────────────────────────
const PROMPT_EXAMPLES = [
  "Reach out to HR Directors in Chennai about InFynd AI's time-to-hire reduction tool. Use cold email style, short and punchy, with a CTA to book a 15-min demo.",
  "Promote our SaaS analytics platform to CTOs at mid-size fintech companies in Bangalore. Use LinkedIn, focus on ROI and ease of integration.",
  "Call startup founders in Mumbai to introduce our funding advisory services from VentureEdge. Target founders who recently raised a Seed round.",
];

const SUGGESTION_CHIPS = [
  { icon: "📧", label: "Cold email campaign", prompt: "Write a cold email campaign for " },
  { icon: "💼", label: "LinkedIn outreach", prompt: "Run a LinkedIn outreach campaign targeting " },
  { icon: "📞", label: "Sales call scripts", prompt: "Generate call scripts to pitch " },
  { icon: "🎯", label: "Multi-channel blast", prompt: "Launch a multi-channel campaign across email, LinkedIn and calls for " },
];

function CreateView({
  onCreated,
  toast,
}: {
  onCreated: (c: Campaign) => void;
  toast: (msg: string, kind?: Toast["kind"]) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [productLink, setProductLink] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showOptions, setShowOptions] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [prompt]);

  async function handleSubmit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!prompt.trim()) { toast("Please describe your campaign", "error"); return; }
    setLoading(true);
    const { data, error } = await createCampaign({
      prompt: prompt.trim(),
      product_link: productLink.trim() || undefined,
      auto_approve_content: autoApprove,
    });
    setLoading(false);
    if (error || !data) { toast(error ?? "Failed to create", "error"); return; }
    toast("Campaign created! AI pipeline running…", "success");
    onCreated(data);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (prompt.trim() && !loading) handleSubmit();
    }
  }

  return (
    <div className="create-chat-wrapper">
      {/* Center content area */}
      <div className="create-chat-center">
        {/* Greeting */}
        <div className="create-chat-greeting animate-fade-in-up">
          <h1 className="create-chat-title font-display">
            What would you like to<br />
            <span className="text-blue-600">campaign today?</span>
          </h1>
          <p className="create-chat-subtitle">
            Describe your outreach goal. Our AI agents will find the right audience, pick the best channels, and craft personalized messages.
          </p>
        </div>

        {/* Suggestion chips — only show when prompt is empty */}
        {!prompt && (
          <div className="create-chat-chips animate-fade-in-up" style={{ animationDelay: "0.1s" }}>
            {SUGGESTION_CHIPS.map((chip) => (
              <button
                key={chip.label}
                type="button"
                onClick={() => {
                  setPrompt(chip.prompt);
                  textareaRef.current?.focus();
                }}
                className="create-chip"
              >
                <span className="create-chip-icon">{chip.icon}</span>
                <span>{chip.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Bottom-anchored composer */}
      <div className="create-chat-bottom">
        <form onSubmit={handleSubmit} className="create-composer">
          {/* Options panel — expand above input */}
          {showOptions && (
            <div className="create-options-panel animate-fade-in-up">
              <div className="create-option-row">
                <label className="create-option-label">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
                  Product link
                </label>
                <input
                  type="url"
                  value={productLink}
                  onChange={(e) => setProductLink(e.target.value)}
                  placeholder="https://yourproduct.com"
                  className="create-option-input"
                />
              </div>
              <div className="create-option-row">
                <label className="create-option-label">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="m9 12 2 2 4-4"/></svg>
                  Review mode
                </label>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setAutoApprove((v) => !v)}
                    className={`create-toggle ${autoApprove ? "create-toggle-on" : ""}`}
                  >
                    <span className="create-toggle-thumb" />
                  </button>
                  <span className="text-xs text-slate-500">
                    {autoApprove ? "Auto-send" : "Review first"}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Input bar */}
          <div className="create-input-bar">
            <button
              type="button"
              onClick={() => setShowOptions((v) => !v)}
              className={`create-action-btn ${showOptions ? "create-action-btn-active" : ""}`}
              title="Campaign options"
              style={{ transition: "transform 0.2s", transform: showOptions ? "rotate(180deg)" : "rotate(0deg)" }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
            </button>

            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe your campaign…"
              rows={1}
              className="create-textarea"
            />

            <button
              type="submit"
              disabled={loading || !prompt.trim()}
              className="create-send-btn"
              title="Launch campaign"
            >
              {loading ? (
                <span className="create-send-spinner" />
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              )}
            </button>
          </div>

          <p className="create-hint">
            Press <kbd>Enter</kbd> to launch &middot; <kbd>Shift+Enter</kbd> for new line &middot; AI will auto-detect audience, channels &amp; tone
          </p>
        </form>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pipeline Progress
// ─────────────────────────────────────────────────────────────────────────────
function PipelineProgress({ state }: { state: string }) {
  return (
    <div className="flex items-center gap-0 overflow-x-auto pb-1">
      {PIPELINE_STEPS.map((step, i) => {
        const done    = stepDone(state, step);
        const current = state === step;
        const failed  = state === "FAILED";
        return (
          <Fragment key={step}>
            <div className="flex flex-col items-center shrink-0">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-all duration-300 ${
                  failed && current
                    ? "border-red-400 bg-red-50 text-red-600"
                    : current
                    ? "border-blue-400 bg-blue-500 text-white shadow-glow-sm active-pulse"
                    : done
                    ? "border-blue-300 bg-blue-50 text-blue-600"
                    : "border-slate-200 bg-slate-50 text-slate-300"
                }`}
              >
                {done && !current ? "✓" : i + 1}
              </div>
              <div
                className={`text-[9px] mt-1 whitespace-nowrap max-w-[68px] text-center leading-tight ${
                  current ? "text-blue-600 font-semibold" : done ? "text-slate-500" : "text-slate-300"
                }`}
              >
                {step.replace(/_/g, " ")}
              </div>
            </div>
            {i < PIPELINE_STEPS.length - 1 && (
              <div
                className={`step-line mx-0.5 ${done && !current ? "done" : ""}`}
                style={{ width: 24 }}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Campaign Detail
// ─────────────────────────────────────────────────────────────────────────────
function DetailView({
  campaign: initial,
  onAnalytics,
  onApproval,
  toast,
  onBack,
}: {
  campaign: Campaign;
  onAnalytics: (c: Campaign) => void;
  onApproval: (c: Campaign) => void;
  toast: (msg: string, kind?: Toast["kind"]) => void;
  onBack: () => void;
}) {
  const [campaign, setCampaign] = useState(initial);
  const [polling, setPolling] = useState(false);

  useEffect(() => {
    const inFlight = !["COMPLETED","FAILED","AWAITING_APPROVAL"].includes(campaign.pipeline_state);
    if (!inFlight) { setPolling(false); return; }
    setPolling(true);
    const t = setInterval(async () => {
      const { data } = await getCampaign(campaign.id);
      if (data) setCampaign(data);
    }, 4000);
    return () => clearInterval(t);
  }, [campaign.id, campaign.pipeline_state]);

  async function handleApprove() {
    const { error } = await approveCampaign(campaign.id);
    if (error) { toast(error, "error"); return; }
    toast("Campaign approved!", "success");
    const { data } = await getCampaign(campaign.id);
    if (data) setCampaign(data);
  }

  const genContent = (campaign.generated_content ?? {}) as Record<string, any>;
  const common: Record<string, any> = genContent.common ?? {};
  // contacts is now a flat map { "email": "Channel" } stored under genContent.contacts
  const contactsMap: Record<string, string> = genContent.contacts ?? {};
  const contacts = Object.keys(contactsMap).filter(
    (email) => typeof email === "string" && email.includes("@")
  );

  const [previewChannel, setPreviewChannel] = useState<string | null>(null);
  const [approvedChannels, setApprovedChannels] = useState<Set<string>>(new Set());
  const [approving, setApproving] = useState(false);
  const [editingCommonChannel, setEditingCommonChannel] = useState<string | null>(null);
  const [editingCommonFields, setEditingCommonFields] = useState<Record<string, string>>({});
  const [savingCommon, setSavingCommon] = useState(false);
  const [editingContactEmail, setEditingContactEmail] = useState<string | null>(null);
  const [editingContactFields, setEditingContactFields] = useState<Record<string, string>>({});
  const [savingContact, setSavingContact] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [callAudioUrl, setCallAudioUrl] = useState<string | null>(null);
  const [callAudioLoading, setCallAudioLoading] = useState(false);
  const [callAudioError, setCallAudioError] = useState<string | null>(null);
  const [callAudioRate, setCallAudioRate] = useState(168);
  const [callVoices, setCallVoices] = useState<Array<{ id: string; name: string }>>([]);
  const [callVoiceId, setCallVoiceId] = useState("");
  const [voicesLoading, setVoicesLoading] = useState(false);

  useEffect(() => {
    return () => { if (callAudioUrl) URL.revokeObjectURL(callAudioUrl); };
  }, [callAudioUrl]);

  async function loadCallTemplateVoices(silent = true) {
    setVoicesLoading(true);
    const { data, error } = await fetchCallTemplateVoices(campaign.id, "Call");
    setVoicesLoading(false);
    if (error) { if (!silent) toast(error, "error"); return; }
    const safeVoices = data ?? [];
    setCallVoices(safeVoices);
    if (!callVoiceId && safeVoices.length > 0) setCallVoiceId(safeVoices[0].id);
  }

  async function loadCallTemplateAudio(silent = false) {
    setCallAudioLoading(true);
    setCallAudioError(null);
    const { data, error } = await fetchCallTemplateAudio(campaign.id, "Call", {
      rate: callAudioRate,
      voiceId: callVoiceId || undefined,
    });
    setCallAudioLoading(false);
    if (error) { setCallAudioError(error); if (!silent) toast(error, "error"); return; }
    if (data) {
      setCallAudioUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return data; });
      if (!silent) toast("Call template audio generated", "success");
    }
  }

  useEffect(() => {
    if (previewChannel !== "Call") return;
    if (editingCommonChannel === "Call") return;
    if (!common.Call) return;
    loadCallTemplateVoices(true);
    loadCallTemplateAudio(true);
  }, [previewChannel, editingCommonChannel, campaign.id, campaign.generated_content]);

  function startEditCommon(channel: string) {
    const tpl = common[channel] ?? {};
    setEditingCommonFields(Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, String(v)])));
    setEditingCommonChannel(channel);
    setPreviewChannel(channel);
  }

  // Replace placeholders in templates and personalized content.
  // Supports {field}, {Field}, [FIELD] and fallback lookups from contact, content and campaign.
  function substitutePlaceholders(str: string, contact: Record<string, any> = {}, contentBlock: Record<string, any> = {}) {
    if (typeof str !== "string") return str;
    // helper to lookup keys in multiple sources
    const lookup = (key: string) => {
      const k = key.toLowerCase();
      // contact fields (name, first_name, last_name, company, email)
      if (contact) {
        if (k === "first_name" && contact.name) return String(contact.name).split(" ")[0];
        if (k === "last_name" && contact.name) return String(contact.name).split(" ").slice(1).join(" ") || "";
        if (contact[k] !== undefined) return String(contact[k]);
        // common variants
        const lowerKeys = Object.keys(contact).reduce((acc: Record<string,string>, kk) => { acc[kk.toLowerCase()] = String(contact[kk]); return acc; }, {} as Record<string,string>);
        if (lowerKeys[k] !== undefined) return lowerKeys[k];
      }
      // content block specific fields (cta_link, body, etc.)
      if (contentBlock && contentBlock[k] !== undefined) return String(contentBlock[k]);
      // campaign-level fallbacks
      if (k === "product_link" || k === "cta_link") return campaign.product_link ?? "";
      // handle both underscore and space variants, e.g. [Your Name] lowercases to "your name"
      if (k === "your_name" || k === "yourname" || k === "your name" || k === "sender") return campaign.created_by ?? "";
      if (k === "company") return campaign.company ?? "";
      return "";
    };

    // replace {field} tokens
    let out = str.replace(/\{(\w+)\}/g, (_, key) => lookup(key) || `{${key}}`);
    // replace [ANY TOKEN] tokens — use [^\]]+ so multi-word tokens like [Your Name] also match
    out = out.replace(/\[([^\]]+)\]/g, (full, key) => lookup(key.trim()) || full);
    return out;
  }

  async function saveCommon() {
    if (!editingCommonChannel) return;
    setSavingCommon(true);
    const { error } = await editCommonContent(campaign.id, editingCommonChannel, editingCommonFields);
    setSavingCommon(false);
    if (error) { toast(error, "error"); return; }
    toast(`${editingCommonChannel} template saved`, "success");
    setEditingCommonChannel(null);
    const { data } = await getCampaign(campaign.id);
    if (data) setCampaign(data);
  }

  function cancelEditCommon() {
    setEditingCommonChannel(null);
    setEditingCommonFields({});
    setCallAudioError(null);
  }

  function startEditContact(email: string) {
    // With common-template model, editing contact = editing common template for their channel
    const ch = contactsMap[email] ?? "Email";
    const tpl = common[ch] ?? {};
    setEditingContactFields(Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, String(v)])));
    setEditingContactEmail(email);
  }

  async function saveContact() {
    if (!editingContactEmail) return;
    setSavingContact(true);
    const { error } = await editContactContent(campaign.id, editingContactEmail, editingContactFields);
    setSavingContact(false);
    if (error) { toast(error, "error"); return; }
    toast("Contact content saved", "success");
    setEditingContactEmail(null);
    const { data } = await getCampaign(campaign.id);
    if (data) setCampaign(data);
  }

  function cancelEditContact() {
    setEditingContactEmail(null);
    setEditingContactFields({});
  }

  async function handleRegenerate() {
    setRegenerating(true);
    setApprovedChannels(new Set());
    setCallAudioError(null);
    const { error } = await regenerateCampaignContent(campaign.id);
    if (error) { toast(error, "error"); setRegenerating(false); return; }
    toast("Regeneration started… polling for updates", "info");
    const poll = setInterval(async () => {
      const { data } = await getCampaign(campaign.id);
      if (data) {
        setCampaign(data);
        if (["CONTENT_GENERATED","AWAITING_APPROVAL","FAILED"].includes(data.pipeline_state)) {
          clearInterval(poll);
          setRegenerating(false);
          toast("Content regenerated!", "success");
        }
      }
    }, 3000);
  }

  async function approveTemplateChannel(channel: string) {
    const newApproved = new Set(approvedChannels).add(channel);
    setApprovedChannels(newApproved);
    const allChannels = Object.keys(common);
    if (allChannels.every((ch) => newApproved.has(ch))) {
      setApproving(true);
      const { error } = await approveCampaign(campaign.id);
      setApproving(false);
      if (error) { toast(error, "error"); return; }
      toast("All templates approved! Campaign dispatching…", "success");
      const { data } = await getCampaign(campaign.id);
      if (data) setCampaign(data);
    } else {
      const remaining = allChannels.filter((ch) => !newApproved.has(ch));
      toast(`${channel} template approved. Still pending: ${remaining.join(", ")}`, "info");
    }
  }

  function renderCommonPreview(channel: string) {
    const tpl = editingCommonChannel === channel ? editingCommonFields : (common[channel] ?? {});
    if (!tpl || Object.keys(tpl).length === 0)
      return <div className="text-slate-400 text-xs">No template</div>;
    // Pick a sample contact for the preview substitution hint
    const email = contacts.find((e) => (contactsMap[e]) === channel);
    const contact = email ? { email, channel } : {};
    const renderField = (v: string) => substitutePlaceholders(v, contact, tpl as Record<string, any>);

    if (editingCommonChannel === channel) {
      return (
        <div className="space-y-2">
          {Object.entries(editingCommonFields).map(([k, v]) => (
            <div key={k}>
              <label className="text-[11px] text-slate-400 uppercase block mb-0.5">{k}</label>
              <ExpandableTextarea
                value={v}
                onChange={(e) => setEditingCommonFields((p) => ({ ...p, [k]: e.target.value }))}
                className="input-premium text-xs w-full"
                expandedRows={k.toLowerCase().includes("body") || k.toLowerCase().includes("message") ? 5 : 3}
              />
            </div>
          ))}
          <div className="flex gap-2 pt-1">
            <button
              onClick={saveCommon}
              disabled={savingCommon}
              className="btn-brand text-xs px-4 py-1.5 flex items-center gap-1.5"
            >
              {savingCommon ? (
                <><span className="btn-spinner" style={{ width: 12, height: 12 }} /> Saving…</>
              ) : "💾 Save Template"}
            </button>
            <button onClick={cancelEditCommon} className="btn-ghost text-xs px-4 py-1.5">Cancel</button>
          </div>
        </div>
      );
    }

    return (
      <div className="bg-slate-50 rounded-lg p-3 text-xs text-slate-700 space-y-1 border border-slate-100">
        {Object.entries(tpl).map(([k, v]) =>
          typeof v === "string" ? (
            <div key={k}><span className="text-slate-400 mr-1">{k}:</span>{renderField(v)}</div>
          ) : null,
        )}
      </div>
    );
  }

  return (
    <div className="view-enter space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-slate-400 hover:text-blue-600 text-sm transition-colors">
          ← Back
        </button>
        <h2 className="text-xl font-bold text-slate-900 truncate tracking-tight font-display">
          {campaign.name}
        </h2>
        <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${stateColor(campaign.pipeline_state)}`}>
          {campaign.pipeline_state.replace(/_/g, " ")}
        </span>
        {polling && (
          <span className="flex items-center gap-1.5 text-xs text-blue-500">
            <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            live
          </span>
        )}
      </div>

      {/* Pipeline */}
      <div className="card p-5">
        <div className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold mb-4">
          Pipeline Progress
        </div>
        <PipelineProgress state={campaign.pipeline_state} />
        {polling && (
          <div className="mt-3 flex items-center gap-2 text-xs text-blue-500">
            <span className="loader-wave">
              <span /><span /><span /><span /><span />
            </span>
            <span>Processing…</span>
          </div>
        )}
      </div>

      {/* Meta */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: "Company",        val: campaign.company },
          { label: "Target",         val: campaign.target_audience },
          { label: "Approval Req.",  val: campaign.approval_required ? "Yes" : "No" },
          { label: "Approval Status",val: campaign.approval_status },
          { label: "Created",        val: fmt(campaign.created_at) },
          { label: "Created By",     val: campaign.created_by },
          { label: "Approved By",    val: campaign.approved_by ?? "—" },
          { label: "Campaign ID",    val: campaign.id.slice(0, 8) + "…" },
        ].map(({ label, val }) =>
          val ? (
            <div key={label} className="card p-3">
              <div className="text-[11px] text-slate-400 uppercase tracking-wider mb-1">{label}</div>
              <div className="text-sm text-slate-700 truncate font-medium">{val}</div>
            </div>
          ) : null,
        )}
      </div>

      {/* Purpose / Prompt */}
      {(campaign.campaign_purpose || campaign.prompt) && (
        <div className="card p-5">
          <div className="text-[11px] text-slate-400 uppercase tracking-wider mb-2">
            {campaign.campaign_purpose ? "Purpose" : "Original Prompt"}
          </div>
          <p className="text-sm text-slate-700 leading-relaxed">
            {campaign.campaign_purpose || campaign.prompt}
          </p>
        </div>
      )}

      {/* Generated content preview */}
      {Object.keys(common).length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">
            <h3 className="font-semibold text-slate-800 text-sm">Generated Content Templates</h3>
            <div className="flex gap-2">
              {Object.keys(common).map((ch) => (
                <button
                  key={ch}
                  onClick={() => setPreviewChannel(previewChannel === ch ? null : ch)}
                  className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
                    previewChannel === ch
                      ? "bg-blue-500 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-blue-50 hover:text-blue-700"
                  }`}
                >
                  {ch}
                </button>
              ))}
            </div>
          </div>

          {previewChannel && (
            <div className="p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-slate-800">{previewChannel} Template</h4>
                {["CONTENT_GENERATED","AWAITING_APPROVAL"].includes(campaign.pipeline_state) && (
                  <button
                    onClick={() =>
                      editingCommonChannel === previewChannel
                        ? cancelEditCommon()
                        : startEditCommon(previewChannel)
                    }
                    className="btn-ghost text-xs px-3 py-1"
                  >
                    {editingCommonChannel === previewChannel ? "Cancel" : "✎ Edit"}
                  </button>
                )}
              </div>

              {renderCommonPreview(previewChannel)}

              {/* Call audio */}
              {previewChannel === "Call" && editingCommonChannel !== "Call" && (
                <div className="mt-2 space-y-2">
                  {voicesLoading && (
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                      <span className="btn-spinner-blue" />
                      Loading voices…
                    </div>
                  )}
                  {callVoices.length > 0 && (
                    <select
                      value={callVoiceId}
                      onChange={(e) => setCallVoiceId(e.target.value)}
                      className="input-premium text-xs"
                    >
                      {callVoices.map((v) => (
                        <option key={v.id} value={v.id}>{v.name}</option>
                      ))}
                    </select>
                  )}
                  <div className="flex items-center gap-3">
                    <label className="text-xs text-slate-500">Rate: {callAudioRate} WPM</label>
                    <input
                      type="range"
                      min={100}
                      max={300}
                      value={callAudioRate}
                      onChange={(e) => setCallAudioRate(Number(e.target.value))}
                      className="flex-1"
                    />
                  </div>
                  <button
                    onClick={() => loadCallTemplateAudio(false)}
                    disabled={callAudioLoading}
                    className="btn-ghost text-xs px-3 py-1.5 flex items-center gap-2"
                  >
                    {callAudioLoading ? <><span className="btn-spinner-blue" /> Generating…</> : "▶ Preview Audio"}
                  </button>
                  {callAudioError && <p className="text-xs text-red-500">{callAudioError}</p>}
                  {callAudioUrl && <audio controls src={callAudioUrl} className="w-full mt-1" />}
                </div>
              )}

              {/* Approve channel template */}
              {campaign.pipeline_state === "AWAITING_APPROVAL" && (
                approvedChannels.has(previewChannel) ? (
                  <div className="mt-4 flex items-center gap-2 text-xs text-emerald-600">
                    <span>✓</span>
                    <span>{previewChannel} template approved</span>
                  </div>
                ) : (
                  <button
                    onClick={() => approveTemplateChannel(previewChannel)}
                    disabled={approving}
                    className="btn-success mt-4 text-xs px-4 py-2 flex items-center gap-2"
                  >
                    {approving ? (
                      <><span className="btn-spinner" style={{ width: 12, height: 12 }} /> Approving…</>
                    ) : (
                      <>✓ Approve {previewChannel} Template</>
                    )}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      )}

      {/* Contact list — channel assignment */}
      {contacts.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
            <h3 className="font-semibold text-slate-800 text-sm">
              Contacts &amp; Channels ({contacts.length} total)
            </h3>
            <span className="text-xs text-slate-400">Common templates will be personalised at send time</span>
          </div>
          <div className="divide-y divide-slate-50">
            {contacts.slice(0, 20).map((email) => {
              const ch = contactsMap[email] ?? "Email";
              const tpl = common[ch] ?? {};
              // Show substituted preview of first content field
              const previewKey = ch === "Email" ? "subject" : ch === "LinkedIn" ? "message" : "greeting";
              const previewText = typeof tpl[previewKey] === "string"
                ? substitutePlaceholders(tpl[previewKey], { email }, tpl as Record<string, any>)
                : "";
              return (
                <div key={email} className="px-5 py-3 flex items-center gap-3 flex-wrap">
                  <span className="text-sm font-medium text-slate-800 min-w-[200px]">{email}</span>
                  <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${
                    ch === "Email"    ? "bg-blue-50 text-blue-700 border-blue-100" :
                    ch === "Call"     ? "bg-green-50 text-green-700 border-green-100" :
                                        "bg-purple-50 text-purple-700 border-purple-100"
                  }`}>
                    {ch === "Call" ? "📞 Call" : ch === "LinkedIn" ? "💼 LinkedIn" : "✉️ Email"}
                  </span>
                  {previewText && (
                    <span className="text-xs text-slate-400 truncate max-w-xs">{previewText}</span>
                  )}
                </div>
              );
            })}
            {contacts.length > 20 && (
              <div className="px-5 py-3 text-xs text-slate-400">+{contacts.length - 20} more contacts</div>
            )}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3 flex-wrap">
        {["CONTENT_GENERATED","AWAITING_APPROVAL","FAILED"].includes(campaign.pipeline_state) && (
          <button
            onClick={handleRegenerate}
            disabled={regenerating}
            className="btn-warning text-sm px-5 py-2.5 flex items-center gap-2"
          >
            {regenerating ? (
              <><span className="btn-spinner" /> Regenerating…</>
            ) : "↺ Regenerate Content"}
          </button>
        )}
        {campaign.pipeline_state === "AWAITING_APPROVAL" && (
          <>
            <button onClick={handleApprove} className="btn-success text-sm px-5 py-2.5">
              ✓ Approve &amp; Send Campaign
            </button>

          </>
        )}
        {(() => {
          const analyticsEnabled = stepDone(campaign.pipeline_state, "CONTENT_GENERATED");
          return (
            <button
              onClick={() => analyticsEnabled && onAnalytics(campaign)}
              disabled={!analyticsEnabled}
              className={`btn-brand text-sm px-5 py-2.5 ${!analyticsEnabled ? "opacity-40 cursor-not-allowed" : ""}`}
            >
              ◎ Analytics
            </button>
          );
        })()}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Analytics
// ─────────────────────────────────────────────────────────────────────────────
function Bar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const w = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-slate-500">
        <span>{label}</span>
        <span className="font-medium text-slate-700">{value}</span>
      </div>
      <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full bar-fill progress-bar-animated ${color}`}
          style={{ width: `${w}%` }}
        />
      </div>
    </div>
  );
}

function AnalyticsView({
  campaign,
  onBack,
  toast,
}: {
  campaign: Campaign;
  onBack: () => void;
  toast: (msg: string, kind?: Toast["kind"]) => void;
}) {
  const [data, setData] = useState<CampaignAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchAnalytics = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const { data: d, error } = await getCampaignAnalytics(campaign.id);
    if (!silent) setLoading(false);
    if (error) { if (!silent) toast(error, "error"); return; }
    setData(d);
    setLastRefresh(new Date());
  }, [campaign.id]);

  // Initial fetch + auto-poll every 10s
  useEffect(() => {
    fetchAnalytics();
    const iv = setInterval(() => fetchAnalytics(true), 10_000);
    return () => clearInterval(iv);
  }, [fetchAnalytics]);

  const ago = lastRefresh
    ? `Updated ${Math.round((Date.now() - lastRefresh.getTime()) / 1000)}s ago`
    : "";

  return (
    <div className="view-enter space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-slate-400 hover:text-blue-600 text-sm transition-colors">
            ← Back
          </button>
          <div>
            <h2 className="text-xl font-bold text-slate-900 tracking-tight font-display">Analytics</h2>
            <p className="text-slate-500 text-sm truncate">{campaign.name}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {lastRefresh && (
            <span className="text-[11px] text-slate-400">{ago}</span>
          )}
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
          </span>
          <span className="text-[11px] font-medium text-emerald-600 uppercase tracking-wider">Live</span>
        </div>
      </div>

      {loading ? (
        <div className="py-20 flex flex-col items-center justify-center gap-4">
          <div className="loader-page-ring" />
          <span className="text-slate-400 text-sm">Loading analytics…</span>
        </div>
      ) : !data ? (
        <div className="py-20 flex flex-col items-center gap-3">
          <span className="text-3xl">📊</span>
          <span className="text-slate-500 text-sm">No data available</span>
        </div>
      ) : (
        <>
          {/* ── Volume metrics strip ────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 stagger-children">
            <Metric label="Total" value={data.total_contacts} />
            <Metric label="Sent" value={data.sent} accent="text-blue-600" />
            <Metric label="Delivered" value={data.delivered} accent="text-cyan-600" />
            <Metric label="Opened" value={data.opened} accent="text-violet-600" />
            <Metric label="Clicked" value={data.clicked} accent="text-pink-600" />
            <Metric label="Answered" value={data.answered} accent="text-emerald-600" />
            <Metric label="Bounced" value={data.bounced} accent="text-red-500" />
            <Metric label="Busy / No Ans" value={`${data.busy} / ${data.no_answer}`} accent="text-amber-600" />
          </div>

          {/* ── Performance Scorecard ───────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {([
              {
                label: "Reach Rate",
                value: `${data.reach_rate}%`,
                sub: "contacts successfully reached",
                icon: "◎",
                color: "from-blue-50 to-cyan-50 border-blue-100",
                vcolor: "text-blue-600",
              },
              {
                label: "Answer Rate",
                value: `${data.answer_rate}%`,
                sub: "of calls that connected",
                icon: "📞",
                color: "from-emerald-50 to-green-50 border-emerald-100",
                vcolor: "text-emerald-600",
              },
              {
                label: "Click-to-Open",
                value: `${data.click_to_open_rate}%`,
                sub: "of openers who clicked",
                icon: "✦",
                color: "from-violet-50 to-purple-50 border-violet-100",
                vcolor: "text-violet-600",
              },
              {
                label: "Avg Talk Time",
                value: fmtDuration(data.avg_call_duration_seconds),
                sub: "per answered call",
                icon: "⏱",
                color: "from-indigo-50 to-blue-50 border-indigo-100",
                vcolor: "text-indigo-600",
              },
            ] as const).map((kpi) => (
              <div key={kpi.label} className={`card bg-gradient-to-br ${kpi.color} p-5 flex flex-col gap-2`}>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{kpi.label}</span>
                  <span className="text-lg">{kpi.icon}</span>
                </div>
                <div className={`text-3xl font-bold tabular-nums ${kpi.vcolor}`}>{kpi.value}</div>
                <div className="text-[11px] text-slate-400">{kpi.sub}</div>
              </div>
            ))}
          </div>

          {/* ── Conversion + delivery rates ─────────────────────── */}
          <div className="grid grid-cols-3 gap-4">
            <div className="card p-4 text-center">
              <div className="text-2xl font-bold text-cyan-600 tabular-nums">{data.delivery_rate}%</div>
              <div className="text-xs text-slate-500 mt-1">Delivery Rate</div>
              <div className="text-[10px] text-slate-400">delivered / sent</div>
            </div>
            <div className="card p-4 text-center">
              <div className="text-2xl font-bold text-violet-600 tabular-nums">{data.open_rate}%</div>
              <div className="text-xs text-slate-500 mt-1">Open Rate</div>
              <div className="text-[10px] text-slate-400">opened / sent</div>
            </div>
            <div className="card p-4 text-center">
              <div className="text-2xl font-bold text-pink-600 tabular-nums">{data.click_rate}%</div>
              <div className="text-xs text-slate-500 mt-1">Click Rate</div>
              <div className="text-[10px] text-slate-400">clicked / sent</div>
            </div>
          </div>

          {/* ── Dual Funnels: Email + Call ────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="card p-6 space-y-4">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-500" />
                <h3 className="font-semibold text-slate-800 text-sm">Email Funnel</h3>
              </div>
              {(() => {
                const b = data.breakdown_by_channel?.find((c) => c.channel === "Email");
                if (!b) return <p className="text-slate-400 text-xs py-4">No email data</p>;
                return (
                  <>
                    <Bar label="Sent" value={b.sent} max={data.total_contacts} color="bg-blue-500" />
                    <Bar label="Delivered" value={b.delivered} max={b.sent || 1} color="bg-cyan-500" />
                    <Bar label="Opened" value={b.opened} max={b.delivered || 1} color="bg-violet-500" />
                    <Bar label="Clicked" value={b.clicked} max={b.opened || 1} color="bg-pink-500" />
                    <Bar label="Bounced" value={b.bounced} max={b.sent || 1} color="bg-red-400" />
                  </>
                );
              })()}
            </div>
            <div className="card p-6 space-y-4">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-indigo-500" />
                <h3 className="font-semibold text-slate-800 text-sm">Call Funnel</h3>
              </div>
              {(() => {
                const b = data.breakdown_by_channel?.find((c) => c.channel === "Call");
                if (!b) return <p className="text-slate-400 text-xs py-4">No call data</p>;
                return (
                  <>
                    <Bar label="Dialed" value={b.sent} max={data.total_contacts} color="bg-blue-500" />
                    <Bar label="Answered" value={b.answered} max={b.sent || 1} color="bg-emerald-500" />
                    <Bar label="Busy" value={b.busy} max={b.sent || 1} color="bg-amber-500" />
                    <Bar label="No Answer" value={b.no_answer} max={b.sent || 1} color="bg-orange-400" />
                    <Bar label="Failed" value={b.bounced} max={b.sent || 1} color="bg-red-400" />
                  </>
                );
              })()}
            </div>
          </div>

          {/* ── Activity Timeline (hourly sparkline) ─────────────── */}
          {data.hourly_activity?.length > 0 && (() => {
            const max = Math.max(...data.hourly_activity.map((h) => h.count), 1);
            const BAR_W = 28;
            const GAP = 5;
            const CHART_H = 72;
            return (
              <div className="card p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-slate-800 text-sm">Activity Timeline</h3>
                  <span className="text-[11px] text-slate-400">
                    {data.hourly_activity.reduce((s, h) => s + h.count, 0)} engagement events · local time
                  </span>
                </div>
                <div className="overflow-x-auto pb-1">
                  <svg
                    width={data.hourly_activity.length * (BAR_W + GAP)}
                    height={CHART_H + 30}
                    className="overflow-visible"
                  >
                    {data.hourly_activity.map((h, i) => {
                      const barH = Math.max(6, Math.round((h.count / max) * CHART_H));
                      const x = i * (BAR_W + GAP);
                      const y = CHART_H - barH;
                      const localHr = new Date(asUTC(h.hour)).getHours();
                      const ampm = localHr >= 12 ? "pm" : "am";
                      const hr12 = localHr % 12 || 12;
                      return (
                        <g key={h.hour}>
                          <rect
                            x={x} y={y} width={BAR_W} height={barH} rx={4}
                            fill={h.count === max ? "#3b82f6" : "#bfdbfe"}
                            className="transition-colors hover:opacity-80"
                          />
                          <text x={x + BAR_W / 2} y={CHART_H + 14} textAnchor="middle" fontSize={9} fill="#94a3b8">
                            {`${hr12}${ampm}`}
                          </text>
                          {h.count > 0 && (
                            <text x={x + BAR_W / 2} y={y - 4} textAnchor="middle" fontSize={9} fill="#475569" fontWeight="600">
                              {h.count}
                            </text>
                          )}
                        </g>
                      );
                    })}
                  </svg>
                </div>
                <p className="text-[11px] text-slate-400 mt-1">Peak engagement: {fmtDuration(0) === "—" ? "—" : new Date(asUTC(data.hourly_activity.reduce((best, h) => h.count > best.count ? h : best, data.hourly_activity[0]).hour)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
              </div>
            );
          })()}

          {/* ── Top Engaged Contacts (follow-up priority list) ───── */}
          {data.top_engaged_contacts?.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-slate-800 text-sm">Top Engaged Contacts</h3>
                  <p className="text-[11px] text-slate-400 mt-0.5">Priority list for follow-up · ranked by engagement events</p>
                </div>
                <span className="text-[11px] bg-blue-50 text-blue-600 border border-blue-100 px-2 py-1 rounded-full font-medium">
                  {data.top_engaged_contacts.length} contacts
                </span>
              </div>
              <div className="divide-y divide-slate-50">
                {data.top_engaged_contacts.map((c, idx) => {
                  const EVT_COLORS: Record<string, string> = {
                    ANSWERED:  "bg-emerald-50 text-emerald-700 border-emerald-200",
                    DELIVERED: "bg-cyan-50 text-cyan-700 border-cyan-200",
                    OPENED:    "bg-violet-50 text-violet-700 border-violet-200",
                    CLICKED:   "bg-pink-50 text-pink-700 border-pink-200",
                    BUSY:      "bg-amber-50 text-amber-700 border-amber-200",
                    NO_ANSWER: "bg-orange-50 text-orange-700 border-orange-200",
                    BOUNCED:   "bg-red-50 text-red-700 border-red-200",
                    FAILED:    "bg-red-50 text-red-700 border-red-200",
                  };
                  const evtStyle = c.latest_event_type ? (EVT_COLORS[c.latest_event_type] ?? "bg-slate-100 text-slate-500 border-slate-200") : "";
                  return (
                    <div key={c.email} className="px-5 py-3.5 flex items-center gap-4 hover:bg-slate-50/60 transition-colors">
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                        idx === 0 ? "bg-yellow-100 text-yellow-700" :
                        idx === 1 ? "bg-slate-100 text-slate-600" :
                        idx === 2 ? "bg-orange-100 text-orange-700" : "bg-blue-50 text-blue-500"
                      }`}>{idx + 1}</div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-slate-800 truncate">{c.email}</div>
                        <div className="text-xs text-slate-400">{c.events} engagement {c.events === 1 ? "event" : "events"}</div>
                      </div>
                      {c.latest_event_type && (
                        <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium border ${evtStyle}`}>
                          {c.latest_event_type.replace(/_/g, " ")}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Channel Breakdown table ───────────────────────────── */}
          {data.breakdown_by_channel?.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100">
                <h3 className="font-semibold text-slate-800 text-sm">Channel Breakdown</h3>
              </div>
              <div className="divide-y divide-slate-50 overflow-x-auto">
                <div className="grid grid-cols-10 px-5 py-2 text-[11px] text-slate-400 uppercase tracking-wider min-w-[700px]">
                  {["Channel","Sent","Delivered","Opened","Clicked","Answered","Busy","No Answer","Bounced","Conv."].map((h) => (
                    <div key={h}>{h}</div>
                  ))}
                </div>
                {data.breakdown_by_channel.map((ch) => (
                  <div key={ch.channel} className="grid grid-cols-10 px-5 py-3 text-sm text-slate-700 hover:bg-blue-50/30 transition-colors min-w-[700px]">
                    <div className="font-semibold text-slate-800 flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${ch.channel === "Email" ? "bg-blue-500" : ch.channel === "Call" ? "bg-indigo-500" : "bg-emerald-500"}`} />
                      {ch.channel}
                    </div>
                    <div>{ch.sent}</div>
                    <div className={ch.delivered > 0 ? "text-cyan-600 font-medium" : ""}>{ch.delivered}</div>
                    <div>{ch.opened}</div>
                    <div>{ch.clicked}</div>
                    <div className={ch.answered > 0 ? "text-emerald-600 font-medium" : ""}>{ch.answered}</div>
                    <div className={ch.busy > 0 ? "text-amber-600 font-medium" : ""}>{ch.busy}</div>
                    <div className={ch.no_answer > 0 ? "text-orange-500 font-medium" : ""}>{ch.no_answer}</div>
                    <div className={ch.bounced > 0 ? "text-red-500 font-medium" : ""}>{ch.bounced}</div>
                    <div>{ch.conversion_count}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Approval View  — auto-connects, clean UX, no WS logs
// ─────────────────────────────────────────────────────────────────────────────
function ApprovalView({
  campaign,
  onBack,
  onDone,
  toast,
}: {
  campaign: Campaign;
  onBack: () => void;
  onDone: () => void;
  toast: (msg: string, kind?: Toast["kind"]) => void;
}) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [done, setDone] = useState(false);

  // Channel-based state
  const [channels, setChannels] = useState<string[]>([]);
  const [channelCounts, setChannelCounts] = useState<Record<string, number>>({});
  const [totalContacts, setTotalContacts] = useState(0);
  const [currentChannel, setCurrentChannel] = useState<string>("");
  const [currentContent, setCurrentContent] = useState<Record<string, string>>({});
  const [currentContacts, setCurrentContacts] = useState<string[]>([]);
  const [approvedChannels, setApprovedChannels] = useState<Set<string>>(new Set());
  const [regeneratingChannel, setRegeneratingChannel] = useState<string>("");

  // Cache all received channel content so user can switch between tabs
  const [channelCache, setChannelCache] = useState<Record<string, { content: Record<string, string>; contacts: string[] }>>({});
  const [viewingChannel, setViewingChannel] = useState<string>("");

  const [editFields, setEditFields] = useState<Record<string, string>>({});
  const [isEditing, setIsEditing] = useState(false);
  const [approvingAll, setApprovingAll] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  function contentToFields(content: unknown): Record<string, string> {
    if (!content) return {};
    if (typeof content === "string") return { body: content };
    if (typeof content === "object") {
      return Object.fromEntries(
        Object.entries(content as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]),
      );
    }
    return {};
  }

  const connectWs = useCallback(() => {
    setConnecting(true);
    const token = getAccessToken();
    if (!token) {
      toast("Not authenticated — please sign in", "error");
      setConnecting(false);
      return;
    }
    const ws = openApprovalWs(
      campaign.id,
      token,
      (msg) => {
        if (msg.type === "APPROVAL_START") {
          setConnected(true);
          setConnecting(false);
          setTotalContacts(msg.total_contacts ?? 0);
          setChannelCounts(msg.channel_counts ?? {});
          setChannels(msg.channels ?? []);
        }
        if (msg.type === "CHANNEL_GROUP_START") {
          setCurrentChannel(msg.channel ?? "");
          setRegeneratingChannel("");
        }
        if (msg.type === "CHANNEL_CONTENT") {
          const fields = contentToFields(msg.content);
          const ch = msg.channel ?? "";
          const contacts = msg.contacts ?? [];
          // Cache this channel's content
          setChannelCache((prev) => ({ ...prev, [ch]: { content: fields, contacts } }));
          setCurrentContent(fields);
          setEditFields(fields);
          setCurrentContacts(contacts);
          setCurrentChannel(ch);
          setViewingChannel(ch);  // auto-focus the newly-arrived channel
          setIsEditing(false);
          setRegeneratingChannel("");
        }
        if (msg.type === "CONTENT_UPDATED") {
          // Refresh cache for the updated channel on next CHANNEL_CONTENT
        }
        if (msg.type === "CHANNEL_APPROVED") {
          setApprovedChannels((prev) => new Set([...prev, msg.channel ?? ""]));
          setApprovingAll(false);
        }
        if (msg.type === "ALL_APPROVED") {
          setApprovedChannels((prev) => {
            const next = new Set(prev);
            channels.forEach((ch) => next.add(ch));
            return next;
          });
          setApprovingAll(false);
        }
        if (msg.type === "CAMPAIGN_APPROVED") {
          setDone(true);
          toast("Campaign approved — messages are sending now!", "success");
          setTimeout(onDone, 2000);
        }
        if (msg.type === "REGENERATING") {
          setRegeneratingChannel(msg.channel ?? "");
        }
        if (msg.type === "REGENERATE_FAILED") {
          setRegeneratingChannel("");
          toast(`Regeneration failed for ${msg.channel}: ${msg.error ?? "unknown error"}`, "error");
        }
        if (msg.error && !msg.type) {
          toast(msg.error, "error");
          setConnecting(false);
        }
      },
      () => {
        setConnected(false);
        setConnecting(false);
      },
    );
    wsRef.current = ws;
    ws.onopen = () => {
      setConnecting(false);
      setConnected(true);
    };
    ws.onerror = () => {
      setConnecting(false);
      setConnected(false);
    };
  }, [campaign.id, channels]);

  // Auto-connect on mount
  useEffect(() => {
    connectWs();
    return () => wsRef.current?.close();
  }, []);

  function send(action: WsAction, allowFallback = false) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      if (allowFallback) {
        restApprove();
      } else {
        toast("WebSocket disconnected — please reconnect", "error");
      }
      return;
    }
    wsRef.current.send(JSON.stringify(action));
  }

  function sendApprove()    { send({ action: "approve" }, true); }
  function sendApproveAll() { setApprovingAll(true); send({ action: "approve_all" }, true); }
  function sendRegenerate() { send({ action: "regenerate" }); }
  function sendEdit()       {
    send({ action: "edit", edited_content: editFields as Record<string, unknown> });
    setIsEditing(false);
  }

  async function restApprove() {
    const { error } = await approveCampaign(campaign.id);
    if (error) { toast(error, "error"); return; }
    toast("Campaign approved — messages are sending now!", "success");
    onDone();
  }

  const CHANNEL_ICONS: Record<string, string> = { Email: "✉", LinkedIn: "🔗", Call: "☎" };

  const progressPct = channels.length > 0 ? Math.round((approvedChannels.size / channels.length) * 100) : 0;
  const hasContent = Object.keys(currentContent).length > 0;

  return (
    <div className="view-enter space-y-6 w-full">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-slate-400 hover:text-blue-600 text-sm transition-colors">
          ← Back
        </button>
        <div className="flex-1">
          <h2 className="text-xl font-bold text-slate-900 font-display">Review Content</h2>
          <p className="text-slate-500 text-sm truncate">{campaign.name}</p>
        </div>
        {connecting && !connected && (
          <span className="flex items-center gap-2 text-xs text-blue-500">
            <span className="btn-spinner-blue" /> Loading…
          </span>
        )}
        {connected && !done && (
          <span className="flex items-center gap-2 text-xs text-emerald-600 font-medium">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            {totalContacts} contacts · {channels.length} channels
          </span>
        )}
      </div>

      {/* Done state */}
      {done ? (
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-12 text-center">
          <div className="text-5xl mb-4">🎉</div>
          <div className="text-emerald-700 font-bold text-2xl font-display mb-2">Campaign Approved!</div>
          <div className="text-slate-500 text-sm">Your campaign is being sent to all {totalContacts} contacts now.</div>
          <button onClick={onDone} className="mt-6 btn-brand px-8 py-3">
            Back to Dashboard
          </button>
        </div>
      ) : (
        <>
          {/* Channel tab pills */}
          {channels.length > 0 && (
            <div className="flex gap-2 flex-wrap">
              {channels.map((ch) => {
                const isApproved  = approvedChannels.has(ch);
                const isActive    = ch === currentChannel;   // server is waiting on this one
                const isViewing   = ch === viewingChannel;
                const isCached    = !!channelCache[ch];
                const isRegen     = regeneratingChannel === ch;

                return (
                  <button
                    key={ch}
                    onClick={() => { if (isCached) setViewingChannel(ch); }}
                    disabled={!isCached}
                    className={`flex items-center gap-2 px-4 py-2 rounded-xl border transition-all text-sm font-medium ${
                      isViewing
                        ? isApproved
                          ? "bg-emerald-50 border-emerald-300 text-emerald-700 ring-1 ring-emerald-200"
                          : "bg-blue-50 border-blue-300 text-blue-700 ring-1 ring-blue-200"
                        : isApproved
                        ? "bg-emerald-50 border-emerald-200 text-emerald-600 hover:border-emerald-300"
                        : isCached
                        ? "bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-blue-200"
                        : "bg-slate-50 border-slate-100 text-slate-300 cursor-not-allowed"
                    }`}
                  >
                    <span>{CHANNEL_ICONS[ch] ?? "📨"}</span>
                    <span>{ch}</span>
                    <span className={`text-xs ${
                      isViewing ? (isApproved ? "text-emerald-500" : "text-blue-500") : "text-slate-400"
                    }`}>
                      {channelCounts[ch] ?? 0} contacts
                    </span>
                    {isApproved && <span className="text-emerald-500 font-bold">✓</span>}
                    {isRegen && <span className="btn-spinner-blue" style={{ width: 10, height: 10 }} />}
                    {isActive && !isApproved && !isRegen && (
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                    )}
                    {!isCached && !isActive && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-slate-300">
                        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* ★ Primary action: Approve All */}
          {connected && (
            <div className="card p-6 border-2 border-emerald-100 bg-gradient-to-br from-emerald-50/60 to-white">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <div className="text-base font-semibold text-slate-800">
                    Looks good? Approve all {channels.length} channel templates
                  </div>
                  <div className="text-sm text-slate-500 mt-1 max-w-sm">
                    AI has crafted one template per channel. Each template is sent to all contacts assigned to that channel, with placeholders filled in at send time.
                  </div>
                </div>
                <button
                  onClick={sendApproveAll}
                  disabled={approvingAll}
                  className="btn-success px-8 py-3.5 text-base font-semibold shrink-0 flex items-center gap-2"
                >
                  {approvingAll ? (
                    <><span className="btn-spinner" /> Approving…</>
                  ) : `✓ Approve All & Send (${totalContacts} contacts)`}
                </button>
              </div>

              {channels.length > 0 && (
                <div className="mt-5">
                  <div className="flex justify-between text-xs text-slate-400 mb-1.5">
                    <span>Channel approval progress</span>
                    <span>{approvedChannels.size} / {channels.length} channels</span>
                  </div>
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-emerald-400 to-emerald-500 rounded-full transition-all duration-500"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Channel template review card */}
          {(() => {
            const displayCh      = viewingChannel || currentChannel;
            const cached         = channelCache[displayCh];
            const displayContent = displayCh === currentChannel ? currentContent : (cached?.content ?? {});
            const displayContacts = displayCh === currentChannel ? currentContacts : (cached?.contacts ?? []);
            const isServerChannel = displayCh === currentChannel;   // server waiting on this
            const isApproved     = approvedChannels.has(displayCh);
            const canAct         = isServerChannel && !isApproved;  // show edit/approve buttons
            const hasDisplay     = Object.keys(displayContent).length > 0;

            if (!displayCh || !hasDisplay) return null;

            return (
            <div className="card p-6 border border-blue-100">
              <div className="flex items-center gap-3 mb-5">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white text-lg shrink-0 ${
                  isApproved ? "bg-gradient-to-br from-emerald-400 to-emerald-600" : "bg-gradient-to-br from-blue-400 to-blue-600"
                }`}>
                  {CHANNEL_ICONS[displayCh] ?? "📨"}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-slate-800">{displayCh} Template</div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {isApproved
                      ? <span className="text-emerald-600 font-medium">✓ Approved — sent to {channelCounts[displayCh] ?? 0} contacts</span>
                      : `Will be sent to ${channelCounts[displayCh] ?? 0} contacts`}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {canAct && !isEditing && (
                    <button onClick={() => { setEditFields(displayContent); setIsEditing(true); }} className="btn-ghost text-xs px-3 py-1.5">
                      ✎ Edit
                    </button>
                  )}
                  {canAct && (
                    <button
                      onClick={sendRegenerate}
                      disabled={!!regeneratingChannel}
                      className="btn-ghost text-xs px-3 py-1.5"
                    >
                      {regeneratingChannel === displayCh ? (
                        <><span className="btn-spinner-blue" style={{ width: 12, height: 12 }} /> Regenerating…</>
                      ) : "↺ Regenerate"}
                    </button>
                  )}
                  {!canAct && !isApproved && (
                    <span className="text-xs text-slate-400 italic">Waiting for earlier channels…</span>
                  )}
                </div>
              </div>

              {/* Template preview or editor */}
              {!isEditing || !canAct ? (
                <div className="bg-slate-50 border border-slate-100 rounded-xl p-4 space-y-3 mb-5">
                  {Object.entries(displayContent).map(([k, v]) => (
                    <div key={k}>
                      <div className="text-[11px] text-slate-400 uppercase tracking-wider mb-0.5 font-medium">
                        {k.replace(/_/g, " ")}
                      </div>
                      <div className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{v}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-3 mb-5">
                  {Object.entries(editFields).map(([field, val]) => (
                    <div key={field}>
                      <label className="block text-[11px] text-slate-400 uppercase tracking-wider mb-1 font-medium">
                        {field.replace(/_/g, " ")}
                      </label>
                      <ExpandableTextarea
                        value={val}
                        onChange={(e) => setEditFields((prev) => ({ ...prev, [field]: e.target.value }))}
                        className="input-premium text-sm w-full"
                        expandedRows={field === "body" || field === "message" || field === "value_proposition" ? 6 : 3}
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* Recipients */}
              {displayContacts.length > 0 && (
                <div className="mb-5">
                  <div className="text-[11px] text-slate-400 uppercase tracking-wider mb-2 font-medium">
                    Recipients ({channelCounts[displayCh] ?? displayContacts.length} contacts)
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {displayContacts.map((email) => (
                      <span key={email} className="text-xs bg-slate-100 text-slate-600 px-2.5 py-1 rounded-full">
                        {email}
                      </span>
                    ))}
                    {(channelCounts[displayCh] ?? 0) > displayContacts.length && (
                      <span className="text-xs text-slate-400 px-2 py-1">
                        +{(channelCounts[displayCh] ?? 0) - displayContacts.length} more
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Action row — only for the server-active channel */}
              {canAct && (
                <div className="flex items-center gap-3">
                  {isEditing ? (
                    <>
                      <button onClick={sendEdit} className="btn-brand text-sm px-5 py-2.5 flex items-center gap-1.5">
                        💾 Save Changes
                      </button>
                      <button onClick={() => { setIsEditing(false); setEditFields(currentContent); }} className="btn-ghost text-sm px-4 py-2.5">
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button onClick={sendApprove} className="btn-success text-sm px-6 py-2.5 flex items-center gap-2">
                      ✓ Approve {displayCh} Template
                    </button>
                  )}
                </div>
              )}
            </div>
            );
          })()}

          {/* Loading / connecting states */}
          {!connected && connecting && (
            <div className="card p-10 text-center">
              <div className="loader-orbit mx-auto mb-4" />
              <div className="text-slate-500 text-sm">Loading your campaign content…</div>
            </div>
          )}

          {!connected && !connecting && (
            <div className="card p-8 text-center space-y-4">
              <div className="text-3xl">⚠️</div>
              <div className="text-slate-600 font-medium">Connection issue</div>
              <div className="text-slate-400 text-sm">Unable to load campaign content.</div>
              <div className="flex gap-3 justify-center">
                <button onClick={connectWs} className="btn-brand px-6 py-2.5 text-sm">
                  Try Again
                </button>
                <button onClick={restApprove} className="btn-success px-6 py-2.5 text-sm">
                  ✓ Approve & Send Anyway
                </button>
              </div>
            </div>
          )}

          {connected && !hasContent && !approvingAll && (
            <div className="card p-8 text-center">
              <div className="loader-wave mx-auto mb-4">
                <span /><span /><span /><span /><span />
              </div>
              <div className="text-slate-500 text-sm">Preparing channel templates for review…</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Kanban Campaign Card
// ─────────────────────────────────────────────────────────────────────────────
const PLATFORM_ICON: Record<string, string> = {
  email: "✉", linkedin: "🔗", call: "☎", sms: "💬",
};

function CampaignKanbanCard({
  campaign,
  selected,
  onSelect,
  badge,
}: {
  campaign: Campaign;
  selected: boolean;
  onSelect: () => void;
  badge?: React.ReactNode;
}) {
  const icon = PLATFORM_ICON[(campaign.platform ?? "email").toLowerCase().split(/[,+/ ]/)[0]] ?? "✉";
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left rounded-2xl border p-4 transition-all space-y-2 ${
        selected
          ? "border-blue-400 bg-blue-50 ring-1 ring-blue-200 shadow-glow-sm"
          : "border-slate-200 bg-white hover:border-blue-200 hover:bg-blue-50/40 shadow-sm"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full font-medium leading-none ${stateColor(campaign.pipeline_state)}`}>
          {campaign.pipeline_state.replace(/_/g, " ")}
        </span>
        <span className="text-lg leading-none">{icon}</span>
      </div>
      <div className="text-sm font-semibold text-slate-800 leading-snug line-clamp-2">
        {campaign.name}
      </div>
      <div className="text-xs text-slate-400 truncate">{campaign.company ?? "—"}</div>
      <div className="flex items-center justify-between text-[11px] text-slate-400">
        <span>{campaign.platform ?? "email"}</span>
        <span>{new Date(campaign.created_at).toLocaleDateString()}</span>
      </div>
      {badge}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tracking View — Game-Changing Live Event Feed
// ─────────────────────────────────────────────────────────────────────────────

/* SVG icon paths for event types — crisp at any size */
const EVT_SVG: Record<string, { d: string; color: string; bg: string; ring: string; label: string }> = {
  SENT:           { d: "M3.478 2.404a.75.75 0 0 0-.926.941l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.404Z", color: "text-blue-500",    bg: "bg-blue-50",      ring: "ring-blue-200",    label: "Sent" },
  PROCESSED:      { d: "M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",                                                                                                                                                 color: "text-slate-500",  bg: "bg-slate-50",     ring: "ring-slate-200",   label: "Processed" },
  DELIVERED:      { d: "M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",                                                                                                                                    color: "text-emerald-500",bg: "bg-emerald-50",   ring: "ring-emerald-200", label: "Delivered" },
  OPENED:         { d: "M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z", color: "text-violet-500", bg: "bg-violet-50",    ring: "ring-violet-200",  label: "Opened" },
  CLICKED:        { d: "M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244",                        color: "text-pink-500",   bg: "bg-pink-50",      ring: "ring-pink-200",    label: "Clicked" },
  BOUNCED:        { d: "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z",                    color: "text-red-500",    bg: "bg-red-50",       ring: "ring-red-200",     label: "Bounced" },
  DROPPED:        { d: "m9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",                                                                                                                             color: "text-red-400",    bg: "bg-red-50",       ring: "ring-red-200",     label: "Dropped" },
  SPAM_REPORT:    { d: "M3 3v1.5M3 21v-6m0 0 2.77-.693a9 9 0 0 1 6.208.682l.108.054a9 9 0 0 0 6.086.71l3.114-.732a48.524 48.524 0 0 1-.005-10.499l-3.11.732a9 9 0 0 1-6.085-.711l-.108-.054a9 9 0 0 0-6.208-.682L3 4.5M3 15V4.5", color: "text-orange-500", bg: "bg-orange-50",    ring: "ring-orange-200",  label: "Spam" },
  UNSUBSCRIBED:   { d: "M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636",                                                                                                 color: "text-slate-400",  bg: "bg-slate-100",    ring: "ring-slate-200",   label: "Unsub" },
  ANSWERED:       { d: "M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z", color: "text-indigo-500", bg: "bg-indigo-50",    ring: "ring-indigo-200",  label: "Answered" },
  BUSY:           { d: "M14.25 9.75v-4.5m0 4.5h4.5m-4.5 0 3.526-3.526A9 9 0 1 0 21 12h-4.5",                                                                                                                                  color: "text-amber-500",  bg: "bg-amber-50",     ring: "ring-amber-200",   label: "Busy" },
  NO_ANSWER:      { d: "M15.75 3.75 18 6m0 0 2.25 2.25M18 6l2.25-2.25M18 6l-2.25 2.25m1.5 13.5c-8.284 0-15-6.716-15-15V4.5A2.25 2.25 0 0 1 6.75 2.25h1.372c.516 0 .966.351 1.091.852l1.106 4.423c.11.44-.055.902-.417 1.173l-1.293.97a1.062 1.062 0 0 0-.38 1.21 12.035 12.035 0 0 0 7.143 7.143c.441.162.928-.004 1.21-.38l.97-1.293a1.125 1.125 0 0 1 1.173-.417l4.423 1.106c.5.125.852.575.852 1.091V19.5a2.25 2.25 0 0 1-2.25 2.25h-2.25Z", color: "text-slate-400",  bg: "bg-slate-100",    ring: "ring-slate-200",   label: "No Answer" },
  VOICEMAIL:      { d: "M21.75 9v.906a2.25 2.25 0 0 1-1.183 1.981l-6.478 3.488M2.25 9v.906a2.25 2.25 0 0 0 1.183 1.981l6.478 3.488m8.839 2.51-4.66-2.51m0 0-1.023-.55a2.25 2.25 0 0 0-2.134 0l-1.022.55m0 0-4.661 2.51",    color: "text-slate-500",  bg: "bg-slate-50",     ring: "ring-slate-200",   label: "Voicemail" },
  FAILED:         { d: "m9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",                                                                                                                             color: "text-red-500",    bg: "bg-red-50",       ring: "ring-red-200",     label: "Failed" },
  ACCEPTED:       { d: "M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z", color: "text-blue-500",   bg: "bg-blue-50",      ring: "ring-blue-200",    label: "Accepted" },
  MESSAGE_SENT:   { d: "M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z", color: "text-blue-600",   bg: "bg-blue-50",      ring: "ring-blue-200",    label: "Message" },
  REPLIED:        { d: "M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3",                                                                                                                                                          color: "text-emerald-500",bg: "bg-emerald-50",   ring: "ring-emerald-200", label: "Replied" },
  VIEWED_PROFILE: { d: "M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.963 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z", color: "text-violet-500", bg: "bg-violet-50",    ring: "ring-violet-200",  label: "Profile" },
  IGNORED:        { d: "M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88", color: "text-slate-400",  bg: "bg-slate-50",     ring: "ring-slate-200",   label: "Ignored" },
};

function EvtIcon({ type, size = 20 }: { type: string; size?: number }) {
  const meta = EVT_SVG[type] ?? EVT_SVG.SENT;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" width={size} height={size} className={meta.color}>
      <path strokeLinecap="round" strokeLinejoin="round" d={meta.d} />
    </svg>
  );
}

function relativeTime(iso: string) {
  const d = new Date(asUTC(iso));
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatTimestamp(iso: string) {
  if (!iso || typeof iso !== "string") return "—";
  const d = new Date(asUTC(iso));
  if (isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function TrackingView({
  campaigns,
  toast,
}: {
  campaigns: Campaign[];
  toast: (msg: string, kind?: Toast["kind"]) => void;
}) {
  const eligible = campaigns.filter(
    (c) => ["COMPLETED","SENDING","DISPATCHED","APPROVED"].includes(c.pipeline_state),
  );

  const [selectedId, setSelectedId] = useState<string>(eligible[0]?.id ?? "");
  const [events, setEvents] = useState<TrackingEvent[]>([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const [channelFilter, setChannelFilter] = useState<string>("All");
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [showSimulator, setShowSimulator] = useState(false);
  const [secondsElapsed, setSecondsElapsed] = useState(0);
  const [expandedContact, setExpandedContact] = useState<string | null>(null);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  // Simulator state
  const [simTab, setSimTab] = useState<"sendgrid" | "call" | "linkedin">("sendgrid");
  const [sgEmail, setSgEmail] = useState("");
  const [sgMsgId, setSgMsgId] = useState("");
  const [sgEvent, setSgEvent] = useState("open");
  const [sgUrl, setSgUrl] = useState("https://infynd.com");
  const [sgLoading, setSgLoading] = useState(false);
  const [callEmail, setCallEmail] = useState("");
  const [callOutcome, setCallOutcome] = useState("ANSWERED");
  const [callDuration, setCallDuration] = useState(120);
  const [callLoading, setCallLoading] = useState(false);
  const [liEmail, setLiEmail] = useState("");
  const [liEvent, setLiEvent] = useState("ACCEPTED");
  const [liLoading, setLiLoading] = useState(false);

  const fetchEvents = useCallback(async (silent = false) => {
    if (!silent) setFeedLoading(true);
    if (selectedId) {
      const { data, error } = await getTrackingEvents(selectedId, { channel: channelFilter === "All" ? undefined : channelFilter, limit: 200 });
      if (!silent) setFeedLoading(false);
      if (error) { if (!silent) toast(error, "error"); return; }
      setEvents(data?.events ?? []);
    } else {
      const { data, error } = await getAllTrackingEvents(200);
      if (!silent) setFeedLoading(false);
      if (error) { if (!silent) toast(error, "error"); return; }
      setEvents(data ?? []);
    }
    setLastRefresh(new Date());
    setSecondsElapsed(0);
  }, [selectedId, channelFilter]);

  useEffect(() => {
    fetchEvents();
    const iv = setInterval(() => fetchEvents(true), 8_000);
    return () => clearInterval(iv);
  }, [fetchEvents]);

  // Tick "Updated X s ago" every second
  useEffect(() => {
    const t = setInterval(() => setSecondsElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const filteredEvents = channelFilter === "All"
    ? events
    : events.filter((e) => e.channel === channelFilter);

  // Stats computed from events
  const stats = {
    total:     events.length,
    email:     events.filter((e) => e.channel === "Email").length,
    call:      events.filter((e) => e.channel === "Call").length,
    linkedin:  events.filter((e) => e.channel === "LinkedIn").length,
    delivered: events.filter((e) => e.event_type === "DELIVERED").length,
    opened:    events.filter((e) => e.event_type === "OPENED").length,
    clicked:   events.filter((e) => e.event_type === "CLICKED").length,
    bounced:   events.filter((e) => ["BOUNCED","DROPPED","FAILED"].includes(e.event_type)).length,
  };

  const channels = [
    { key: "All",      icon: "M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25a2.25 2.25 0 0 1-2.25-2.25v-2.25Z", count: stats.total },
    { key: "Email",    icon: "M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75", count: stats.email },
    { key: "Call",     icon: "M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z", count: stats.call },
    { key: "LinkedIn", icon: "M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z", count: stats.linkedin },
  ];

  const inputCls = "input-premium";

  async function sendSgEvent() {
    if (!selectedId) { toast("Select a campaign first", "error"); return; }
    setSgLoading(true);
    const evts = [{ email: sgEmail, event: sgEvent, sg_message_id: sgMsgId, campaign_id: selectedId, timestamp: Math.floor(Date.now() / 1000), ...(sgEvent === "click" ? { url: sgUrl } : {}) }];
    const { error } = await sendgridWebhook(evts);
    setSgLoading(false);
    if (error) { toast(error, "error"); return; }
    toast("SendGrid event sent!", "success");
    fetchEvents(true);
  }

  async function sendCall() {
    if (!selectedId) { toast("Select a campaign first", "error"); return; }
    setCallLoading(true);
    const { error } = await callTracking({ contact_email: callEmail, campaign_id: selectedId, outcome: callOutcome, duration_seconds: callDuration });
    setCallLoading(false);
    if (error) { toast(error, "error"); return; }
    toast("Call event recorded!", "success");
    fetchEvents(true);
  }

  async function sendLinkedIn() {
    if (!selectedId) { toast("Select a campaign first", "error"); return; }
    setLiLoading(true);
    const { error } = await linkedinTracking({ contact_email: liEmail, campaign_id: selectedId, event_type: liEvent });
    setLiLoading(false);
    if (error) { toast(error, "error"); return; }
    toast("LinkedIn event recorded!", "success");
    fetchEvents(true);
  }

  const selectedCamp = eligible.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="view-enter space-y-5">

      {/* ── HERO HEADER ── */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-blue-900 p-6 pb-5">
        {/* Decorative mesh */}
        <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: "radial-gradient(circle at 20% 50%, #3b82f6 0%, transparent 50%), radial-gradient(circle at 80% 20%, #8b5cf6 0%, transparent 50%), radial-gradient(circle at 60% 80%, #06b6d4 0%, transparent 50%)" }} />
        <div className="relative flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h2 className="text-2xl font-extrabold text-white tracking-tight font-display">Event Tracking</h2>
              <div className="flex items-center gap-1.5 bg-emerald-500/20 backdrop-blur-sm border border-emerald-400/30 rounded-full px-3 py-1">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
                </span>
                <span className="text-[10px] font-bold text-emerald-300 uppercase tracking-widest">Live</span>
              </div>
            </div>
            <p className="text-blue-200/70 text-sm">Real-time stream of email, call &amp; LinkedIn engagement events</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="text-[10px] text-blue-300/50 uppercase tracking-wider">Last sync</div>
              <div className="text-sm text-blue-100 font-mono tabular-nums">{secondsElapsed}s ago</div>
            </div>
            <button
              onClick={() => setShowSimulator(!showSimulator)}
              className={`text-xs px-4 py-2 rounded-xl font-medium transition-all backdrop-blur-sm border ${
                showSimulator
                  ? "bg-blue-500/30 border-blue-400/40 text-blue-200"
                  : "bg-white/10 border-white/10 text-blue-200 hover:bg-white/20"
              }`}
            >
              <span className="mr-1.5">{showSimulator ? "▾" : "▸"}</span>
              Simulator
            </button>
          </div>
        </div>

        {/* ── STATS RIBBON ── */}
        <div className="relative grid grid-cols-4 lg:grid-cols-8 gap-3 mt-5">
          {[
            { label: "Total",     value: stats.total,     c: "text-white" },
            { label: "Delivered", value: stats.delivered,  c: "text-emerald-300" },
            { label: "Opened",    value: stats.opened,     c: "text-violet-300" },
            { label: "Clicked",   value: stats.clicked,    c: "text-pink-300" },
            { label: "Bounced",   value: stats.bounced,    c: "text-red-300" },
            { label: "Email",     value: stats.email,      c: "text-blue-300" },
            { label: "Calls",     value: stats.call,       c: "text-indigo-300" },
            { label: "LinkedIn",  value: stats.linkedin,   c: "text-cyan-300" },
          ].map((s) => (
            <div key={s.label} className="bg-white/[0.06] backdrop-blur-sm rounded-xl px-3 py-2.5 border border-white/[0.06]">
              <div className="text-[10px] text-blue-200/40 uppercase tracking-wider mb-0.5">{s.label}</div>
              <div className={`text-lg font-bold font-display tabular-nums ${s.c}`}>{s.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── CONTROLS ROW ── */}
      <div className="flex flex-wrap items-center gap-4">
        {/* Campaign selector */}
        <div className="relative">
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="appearance-none bg-white border border-slate-200 rounded-xl pl-4 pr-10 py-2.5 text-sm font-medium text-slate-700 shadow-sm hover:border-blue-300 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all min-w-[220px] cursor-pointer"
          >
            <option value="">All campaigns</option>
            {eligible.map((c) => (
              <option key={c.id} value={c.id}>{c.name.slice(0, 50)}</option>
            ))}
          </select>
          <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </div>
        </div>
        {selectedCamp && (
          <span className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full bg-blue-50 text-blue-600 border border-blue-200 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
            {selectedCamp.pipeline_state}
          </span>
        )}

        {/* Channel filter — segmented control */}
        <div className="flex bg-slate-100/80 p-1 rounded-xl border border-slate-200/60 ml-auto">
          {channels.map((ch) => {
            const active = channelFilter === ch.key;
            return (
              <button
                key={ch.key}
                onClick={() => setChannelFilter(ch.key)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
                  active
                    ? "bg-white text-blue-700 shadow-sm border border-slate-200 ring-1 ring-blue-100"
                    : "text-slate-500 hover:text-slate-700 hover:bg-white/50"
                }`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" width={14} height={14} className={active ? "text-blue-500" : "text-slate-400"}>
                  <path strokeLinecap="round" strokeLinejoin="round" d={ch.icon} />
                </svg>
                {ch.key}
                <span className={`min-w-[20px] text-center text-[10px] px-1.5 py-0.5 rounded-full font-bold tabular-nums ${
                  active ? "bg-blue-100 text-blue-600" : "bg-slate-200/70 text-slate-400"
                }`}>
                  {ch.count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── MAIN CONTENT ── */}
      <div className="flex gap-5 items-start">
        {/* Event Feed */}
        <div className="flex-1 min-w-0">
          {feedLoading ? (
            <div className="py-20 flex flex-col items-center justify-center gap-4">
              <div className="loader-page-ring" />
              <span className="text-slate-400 text-sm">Loading events…</span>
            </div>
          ) : filteredEvents.length === 0 ? (
            <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-gradient-to-b from-white to-slate-50 py-20 text-center">
              <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-4">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor" width={32} height={32} className="text-slate-300">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 0 0 6 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0 1 18 16.5h-2.25m-7.5 0h7.5m-7.5 0-1 3m8.5-3 1 3m0 0 .5 1.5m-.5-1.5h-9.5m0 0-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6" />
                </svg>
              </div>
              <div className="text-slate-500 font-semibold text-sm mb-1">No events yet</div>
              <div className="text-slate-400 text-xs max-w-xs mx-auto">Events stream in automatically as SendGrid webhooks, Twilio call callbacks, and LinkedIn tracking fire</div>
            </div>
          ) : (
            <div className="relative max-h-[calc(100vh-22rem)] overflow-y-auto pr-1 -mr-1 scrollbar-thin">
              {/* Timeline spine */}
              <div className="absolute left-[23px] top-0 bottom-0 w-px bg-gradient-to-b from-blue-200 via-slate-200 to-transparent pointer-events-none" />

              {((): React.ReactNode => {
                // Group events by contact_email — latest event per person is first
                const groups = new Map<string, TrackingEvent[]>();
                filteredEvents.forEach((ev) => {
                  const key = ev.contact_email;
                  if (!groups.has(key)) groups.set(key, []);
                  groups.get(key)!.push(ev);
                });
                const contactList = Array.from(groups.entries());

                return contactList.map(([email, evts], groupIdx) => {
                  const latest = evts[0]; // sorted DESC, so index 0 = most recent
                  const meta = EVT_SVG[latest.event_type] ?? EVT_SVG.SENT;
                  const isContactExpanded = expandedContact === email;
                  const isError = ["BOUNCED","DROPPED","FAILED","SPAM_REPORT"].includes(latest.event_type);
                  const isSuccess = ["DELIVERED","OPENED","CLICKED","ANSWERED","REPLIED","ACCEPTED"].includes(latest.event_type);

                  // Compute the overall "best" status label for the pill ribbon
                  const STATUS_RANK: Record<string, number> = {
                    CLICKED: 9, REPLIED: 9, ACCEPTED: 9,
                    OPENED: 8,
                    ANSWERED: 7,
                    DELIVERED: 6,
                    PROCESSED: 5,
                    SENT: 4,
                    VOICEMAIL: 3,
                    BUSY: 2, NO_ANSWER: 2,
                    BOUNCED: 1, DROPPED: 1, FAILED: 1, SPAM_REPORT: 1, UNSUBSCRIBED: 1,
                  };
                  const allTypes = evts.map((e) => e.event_type);

                  return (
                    <div key={email} className="relative pl-12 mb-1.5 group">
                      {/* Timeline node */}
                      <div className={`absolute left-[15px] top-4 w-[17px] h-[17px] rounded-full border-2 flex items-center justify-center z-10 transition-all ${
                        isError ? "bg-red-50 border-red-300"
                          : isSuccess ? "bg-emerald-50 border-emerald-300"
                          : "bg-white border-slate-300"
                      } ${groupIdx === 0 ? "ring-4 ring-blue-100/60" : ""}`}>
                        <div className={`w-2 h-2 rounded-full ${
                          isError ? "bg-red-400" : isSuccess ? "bg-emerald-400" : "bg-slate-400"
                        }`} />
                      </div>

                      {/* ── CONTACT CARD ── */}
                      <div className={`rounded-xl border transition-all ${
                        isContactExpanded
                          ? `bg-white shadow-lg border-slate-200 ring-2 ${meta.ring}`
                          : "bg-white/80 border-slate-100 hover:bg-white hover:shadow-md hover:border-slate-200"
                      }`}>

                        {/* Main row — latest status */}
                        <div
                          className="flex items-center gap-3 px-4 py-3 cursor-pointer"
                          onClick={() => {
                            setExpandedContact(isContactExpanded ? null : email);
                            setExpandedEventId(null);
                          }}
                        >
                          {/* Icon */}
                          <div className={`w-9 h-9 rounded-xl ${meta.bg} flex items-center justify-center shrink-0 transition-transform group-hover:scale-110`}>
                            <EvtIcon type={latest.event_type} size={18} />
                          </div>

                          {/* Content */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={`text-sm font-bold ${meta.color}`}>
                                {(EVT_SVG[latest.event_type]?.label ?? latest.event_type).toUpperCase()}
                              </span>
                              <span className={`text-[10px] px-2 py-0.5 rounded-md font-semibold uppercase tracking-wider ${
                                latest.channel === "Email" ? "bg-blue-50 text-blue-500 border border-blue-100" :
                                latest.channel === "Call" ? "bg-indigo-50 text-indigo-500 border border-indigo-100" :
                                "bg-cyan-50 text-cyan-600 border border-cyan-100"
                              }`}>
                                {latest.channel}
                              </span>
                              {/* All-status pills (compact) */}
                              <div className="flex items-center gap-1 flex-wrap">
                                {allTypes.slice(0, 5).map((t, ti) => {
                                  const m = EVT_SVG[t] ?? EVT_SVG.SENT;
                                  return (
                                    <span key={ti} className={`text-[9px] px-1.5 py-0.5 rounded font-semibold ${m.bg} ${m.color}`}>
                                      {m.label}
                                    </span>
                                  );
                                })}
                                {allTypes.length > 5 && (
                                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-400 font-semibold">+{allTypes.length - 5}</span>
                                )}
                              </div>
                            </div>
                            <div className="text-xs text-slate-400 truncate mt-0.5">{email}</div>
                          </div>

                          {/* Right — timestamp + event count */}
                          <div className="text-right shrink-0">
                            <div className="text-[11px] text-slate-400 font-mono tabular-nums">{formatTimestamp(latest.occurred_at)}</div>
                            <div className="text-[10px] text-slate-300">{evts.length} event{evts.length !== 1 ? "s" : ""}</div>
                          </div>

                          {/* Expand chevron */}
                          <svg xmlns="http://www.w3.org/2000/svg" width={14} height={14} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
                            className={`text-slate-300 transition-transform shrink-0 ${isContactExpanded ? "rotate-180" : ""}`}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                          </svg>
                        </div>

                        {/* ── EXPANDED: all events for this contact ── */}
                        {isContactExpanded && (
                          <div className="border-t border-slate-100 px-4 pb-3 pt-2 space-y-1 animate-in fade-in slide-in-from-top-1">
                            <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-2 font-semibold">All Events ({evts.length})</div>
                            {evts.map((ev) => {
                              const em = EVT_SVG[ev.event_type] ?? EVT_SVG.SENT;
                              const isEvtExpanded = expandedEventId === ev.id;
                              return (
                                <div
                                  key={ev.id}
                                  className={`rounded-lg border cursor-pointer transition-all ${
                                    isEvtExpanded
                                      ? `bg-slate-50 border-slate-200 ring-1 ${em.ring}`
                                      : "bg-slate-50/60 border-slate-100 hover:bg-slate-100 hover:border-slate-200"
                                  }`}
                                  onClick={(e) => { e.stopPropagation(); setExpandedEventId(isEvtExpanded ? null : ev.id); }}
                                >
                                  <div className="flex items-center gap-2.5 px-3 py-2">
                                    <div className={`w-7 h-7 rounded-lg ${em.bg} flex items-center justify-center shrink-0`}>
                                      <EvtIcon type={ev.event_type} size={14} />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <span className={`text-xs font-bold ${em.color}`}>{em.label.toUpperCase()}</span>
                                      <span className={`ml-2 text-[9px] px-1.5 py-0.5 rounded font-semibold ${
                                        ev.channel === "Email" ? "bg-blue-50 text-blue-500" :
                                        ev.channel === "Call" ? "bg-indigo-50 text-indigo-500" :
                                        "bg-cyan-50 text-cyan-600"
                                      }`}>{ev.channel}</span>
                                    </div>
                                    <div className="text-right shrink-0">
                                      <div className="text-[10px] text-slate-400 font-mono">{formatTimestamp(ev.occurred_at)}</div>
                                      <div className="text-[9px] text-slate-300">{relativeTime(ev.occurred_at)}</div>
                                    </div>
                                    <svg xmlns="http://www.w3.org/2000/svg" width={12} height={12} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
                                      className={`text-slate-300 transition-transform shrink-0 ${isEvtExpanded ? "rotate-180" : ""}`}>
                                      <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                                    </svg>
                                  </div>
                                  {/* Event payload detail */}
                                  {isEvtExpanded && (
                                    <div className="px-3 pb-2.5 pt-1 border-t border-slate-100 space-y-1.5">
                                      <div className="grid grid-cols-2 gap-2">
                                        <div className="bg-white rounded-md p-2">
                                          <div className="text-[9px] text-slate-400 uppercase tracking-wider mb-0.5">Event ID</div>
                                          <div className="text-[10px] text-slate-600 font-mono">{ev.id.slice(0, 12)}…</div>
                                        </div>
                                        <div className="bg-white rounded-md p-2">
                                          <div className="text-[9px] text-slate-400 uppercase tracking-wider mb-0.5">Campaign</div>
                                          <div className="text-[10px] text-slate-600 font-mono">{ev.campaign_id.slice(0, 8)}…</div>
                                        </div>
                                      </div>
                                      {ev.payload && Object.keys(ev.payload).length > 0 && (
                                        <div className="bg-white rounded-md p-2">
                                          <div className="text-[9px] text-slate-400 uppercase tracking-wider mb-1">Payload</div>
                                          <div className="grid grid-cols-2 gap-1">
                                            {Object.entries(ev.payload).map(([k, v]) => (
                                              <div key={k} className="flex items-baseline gap-1">
                                                <span className="text-[9px] text-slate-400 font-mono">{k}:</span>
                                                <span className="text-[10px] text-slate-700 font-medium truncate">{String(v)}</span>
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          )}
        </div>

        {/* ── SIMULATOR DRAWER ── */}
        {showSimulator && (
          <div className="w-[340px] shrink-0 space-y-4 animate-in fade-in slide-in-from-right-4">
            <div className="rounded-2xl border border-slate-200 bg-white shadow-lg overflow-hidden">
              {/* Simulator header */}
              <div className="bg-gradient-to-r from-slate-50 to-blue-50/50 border-b border-slate-100 px-5 py-4">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-blue-100 flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" width={14} height={14} className="text-blue-600">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23-.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0 1 12 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
                    </svg>
                  </div>
                  <div>
                    <div className="text-sm font-bold text-slate-800">Event Simulator</div>
                    <div className="text-[10px] text-slate-400">Fire test events manually</div>
                  </div>
                </div>
              </div>

              {/* Target campaign */}
              <div className="px-5 py-3 border-b border-slate-100">
                <div className={`rounded-xl px-3 py-2.5 text-xs ${
                  selectedCamp
                    ? "bg-blue-50 text-blue-700 border border-blue-200"
                    : "bg-slate-50 text-slate-400 border border-slate-200"
                }`}>
                  {selectedCamp ? (
                    <div className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                      <span className="font-semibold truncate">{selectedCamp.name.slice(0, 32)}</span>
                    </div>
                  ) : "Select a campaign above"}
                </div>
              </div>

              {/* Channel tabs */}
              <div className="px-5 pt-3">
                <div className="flex gap-1 bg-slate-100 p-1 rounded-xl">
                  {(["sendgrid","call","linkedin"] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setSimTab(t)}
                      className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5 ${
                        simTab === t
                          ? "bg-white text-blue-700 shadow-sm border border-slate-200"
                          : "text-slate-500 hover:text-slate-700"
                      }`}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" width={12} height={12}>
                        <path strokeLinecap="round" strokeLinejoin="round" d={
                          t === "sendgrid" ? "M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75"
                          : t === "call" ? "M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z"
                          : "M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z"
                        } />
                      </svg>
                      {t === "sendgrid" ? "Email" : t === "call" ? "Call" : "LinkedIn"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Form body */}
              <div className="p-5 space-y-3.5">
                {simTab === "sendgrid" && (
                  <>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1 font-semibold uppercase tracking-wider">Email</label>
                      <input value={sgEmail} onChange={(e) => setSgEmail(e.target.value)} type="email" placeholder="contact@example.com" className={inputCls} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1 font-semibold uppercase tracking-wider">Event</label>
                        <select value={sgEvent} onChange={(e) => setSgEvent(e.target.value)} className={inputCls}>
                          {["open","click","delivered","bounce","unsubscribe"].map((e) => (
                            <option key={e} value={e}>{e}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1 font-semibold uppercase tracking-wider">Msg ID</label>
                        <input value={sgMsgId} onChange={(e) => setSgMsgId(e.target.value)} placeholder="optional" className={inputCls} />
                      </div>
                    </div>
                    {sgEvent === "click" && (
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1 font-semibold uppercase tracking-wider">Click URL</label>
                        <input value={sgUrl} onChange={(e) => setSgUrl(e.target.value)} className={inputCls} />
                      </div>
                    )}
                    <button onClick={sendSgEvent} disabled={sgLoading || !selectedId} className="w-full btn-brand py-2.5 text-sm rounded-xl">
                      {sgLoading ? <span className="flex items-center justify-center gap-2"><span className="btn-spinner" />Sending…</span> : "Fire Email Event"}
                    </button>
                  </>
                )}

                {simTab === "call" && (
                  <>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1 font-semibold uppercase tracking-wider">Email</label>
                      <input value={callEmail} onChange={(e) => setCallEmail(e.target.value)} type="email" placeholder="contact@example.com" className={inputCls} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1 font-semibold uppercase tracking-wider">Outcome</label>
                        <select value={callOutcome} onChange={(e) => setCallOutcome(e.target.value)} className={inputCls}>
                          {["ANSWERED","VOICEMAIL","NO_ANSWER","BUSY","FAILED"].map((o) => (
                            <option key={o} value={o}>{o}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1 font-semibold uppercase tracking-wider">Duration</label>
                        <input type="number" value={callDuration} onChange={(e) => setCallDuration(Number(e.target.value))} className={inputCls} />
                      </div>
                    </div>
                    <button onClick={sendCall} disabled={callLoading || !selectedId} className="w-full btn-brand py-2.5 text-sm rounded-xl">
                      {callLoading ? <span className="flex items-center justify-center gap-2"><span className="btn-spinner" />Sending…</span> : "Record Call Event"}
                    </button>
                  </>
                )}

                {simTab === "linkedin" && (
                  <>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1 font-semibold uppercase tracking-wider">Email</label>
                      <input value={liEmail} onChange={(e) => setLiEmail(e.target.value)} type="email" placeholder="contact@example.com" className={inputCls} />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1 font-semibold uppercase tracking-wider">LinkedIn Event</label>
                      <select value={liEvent} onChange={(e) => setLiEvent(e.target.value)} className={inputCls}>
                        {["ACCEPTED","MESSAGE_SENT","REPLIED","VIEWED_PROFILE","IGNORED"].map((e) => (
                          <option key={e} value={e}>{e}</option>
                        ))}
                      </select>
                    </div>
                    <button onClick={sendLinkedIn} disabled={liLoading || !selectedId} className="w-full btn-brand py-2.5 text-sm rounded-xl">
                      {liLoading ? <span className="flex items-center justify-center gap-2"><span className="btn-spinner" />Sending…</span> : "Record LinkedIn Event"}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  History View
// ─────────────────────────────────────────────────────────────────────────────
function HistoryView({
  campaigns,
  toast,
  onSelect,
  onApproval,
}: {
  campaigns: Campaign[];
  toast: (msg: string, kind?: Toast["kind"]) => void;
  onSelect: (c: Campaign) => void;
  onApproval: (c: Campaign) => void;
}) {
  const [selectedId, setSelectedId] = useState<string>(campaigns[0]?.id ?? "");
  const [tab, setTab] = useState<"logs" | "messages">("logs");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [messages, setMessages] = useState<MessageEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedId) return;
    setLoading(true);
    (async () => {
      if (tab === "logs") {
        const { data, error } = await getCampaignLogs(selectedId);
        setLoading(false);
        if (error) { toast(error, "error"); return; }
        setLogs(data ?? []);
      } else {
        const { data, error } = await getCampaignMessages(selectedId);
        setLoading(false);
        if (error) { toast(error, "error"); return; }
        setMessages(data ?? []);
      }
    })();
  }, [selectedId, tab]);

  const STATUS_COLORS: Record<string, string> = {
    SUCCESS:      "bg-emerald-50 text-emerald-700 border border-emerald-200",
    RUNNING:      "bg-blue-50 text-blue-700 border border-blue-200",
    FAILED:       "bg-red-50 text-red-700 border border-red-200",
    SENT:         "bg-emerald-50 text-emerald-700 border border-emerald-200",
    PENDING:      "bg-slate-100 text-slate-500 border border-slate-200",
    FAILED_SEND:  "bg-red-50 text-red-700 border border-red-200",
  };

  const selectedCamp = campaigns.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="view-enter space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-900 font-display">History</h2>
        <p className="text-slate-500 text-sm">Select a campaign to view execution logs and sent messages</p>
      </div>

      <div className="flex gap-6 items-start">
        <div className="w-64 xl:w-80 shrink-0">
          <div className="text-xs text-slate-400 uppercase tracking-wider mb-3">
            Campaigns ({campaigns.length})
          </div>
          {campaigns.length === 0 ? (
            <div className="card p-8 text-center">
              <div className="text-3xl mb-2">▤</div>
              <div className="text-slate-400 text-sm">No campaigns yet</div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 max-h-[calc(100vh-14rem)] overflow-y-auto pr-1">
              {campaigns.map((c) => {
                const logCount = c.id === selectedId && tab === "logs" ? logs.length : null;
                const msgCount = c.id === selectedId && tab === "messages" ? messages.length : null;
                return (
                  <CampaignKanbanCard
                    key={c.id}
                    campaign={c}
                    selected={c.id === selectedId}
                    onSelect={() => setSelectedId(c.id)}
                    badge={
                      (logCount !== null || msgCount !== null) && (
                        <div className="text-[11px] text-slate-400 mt-1">
                          {logCount !== null ? `${logCount} logs` : `${msgCount} messages`}
                        </div>
                      )
                    }
                  />
                );
              })}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          {!selectedId ? (
            <div className="card p-12 text-center">
              <div className="text-slate-300 text-sm">Select a campaign</div>
            </div>
          ) : (
            <>
              {selectedCamp && (
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-slate-800">{selectedCamp.name}</h3>
                    <p className="text-xs text-slate-400 mt-0.5">{selectedCamp.company} · {fmt(selectedCamp.created_at)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => onSelect(selectedCamp)}
                      className="btn-ghost text-xs px-3 py-1.5"
                    >
                      View
                    </button>
                    {selectedCamp.pipeline_state === "AWAITING_APPROVAL" && (
                      <button
                        onClick={() => onApproval(selectedCamp)}
                        className="btn-warning text-xs px-3 py-1.5"
                      >
                        Review Approval
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div className="flex gap-1 bg-slate-100 p-1 rounded-xl mb-4 w-fit">
                {(["logs","messages"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`px-4 py-2 rounded-lg text-xs font-medium transition-all capitalize ${
                      tab === t
                        ? "bg-white text-blue-700 shadow-sm border border-slate-200"
                        : "text-slate-500 hover:text-slate-700"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>

              {loading ? (
                <div className="flex flex-col items-center py-12 gap-3">
                  <div className="loader-orbit" />
                  <span className="text-slate-400 text-sm">Loading {tab}…</span>
                </div>
              ) : tab === "logs" ? (
                <div className="card overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                    <h3 className="font-semibold text-slate-800 text-sm">Execution Logs</h3>
                    <span className="text-xs text-slate-400">{logs.length} entries</span>
                  </div>
                  {logs.length === 0 ? (
                    <div className="py-12 text-center text-slate-400 text-sm">No logs found</div>
                  ) : (
                    <div className="divide-y divide-slate-50 max-h-[420px] overflow-y-auto">
                      {logs.map((log) => (
                        <div key={log.id} className="px-5 py-3 flex items-start gap-3">
                          <span className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[log.status] ?? "bg-slate-100 text-slate-500"}`}>
                            {log.status}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="text-xs text-slate-500 mb-0.5">{fmt((log as any).started_at || (log as any).timestamp)}</div>
                            <div className="text-sm text-slate-700">{(log as any).agent_name || "—"}</div>
                            {(log as any).duration_ms && <div className="text-xs text-slate-400 mt-0.5">{(log as any).duration_ms}ms</div>}
                            {log.error_message && <div className="text-xs text-red-500 mt-0.5">{log.error_message}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="card overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                    <h3 className="font-semibold text-slate-800 text-sm">Sent Messages</h3>
                    <span className="text-xs text-slate-400">{messages.length} total</span>
                  </div>
                  {messages.length === 0 ? (
                    <div className="py-12 text-center text-slate-400 text-sm">No messages sent yet</div>
                  ) : (
                    <div className="divide-y divide-slate-50 max-h-[420px] overflow-y-auto">
                      {messages.map((msg) => {
                        const isCall = msg.channel === "Call";
                        const isLinkedIn = msg.channel === "LinkedIn";
                        const callOutcome = msg.latest_event;
                        const callDuration = msg.event_payload?.duration_seconds;
                        const callPhone = msg.event_payload?.contact_phone;

                        const OUTCOME_STYLES: Record<string, string> = {
                          ANSWERED:  "bg-emerald-50 text-emerald-700 border border-emerald-200",
                          BUSY:      "bg-amber-50 text-amber-700 border border-amber-200",
                          NO_ANSWER: "bg-orange-50 text-orange-700 border border-orange-200",
                          FAILED:    "bg-red-50 text-red-700 border border-red-200",
                          CANCELED:  "bg-slate-100 text-slate-500 border border-slate-200",
                          RINGING:   "bg-blue-50 text-blue-600 border border-blue-200",
                          IN_PROGRESS: "bg-blue-50 text-blue-600 border border-blue-200",
                          DELIVERED: "bg-cyan-50 text-cyan-700 border border-cyan-200",
                          OPENED:    "bg-violet-50 text-violet-700 border border-violet-200",
                          CLICKED:   "bg-pink-50 text-pink-700 border border-pink-200",
                          BOUNCED:   "bg-red-50 text-red-600 border border-red-200",
                        };

                        const CHANNEL_ICONS: Record<string, string> = {
                          Email: "✉",
                          Call: "📞",
                          LinkedIn: "🔗",
                        };

                        return (
                          <div key={msg.id} className="px-5 py-4 flex items-start gap-4">
                            {/* Channel icon */}
                            <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-base shrink-0 ${
                              isCall ? "bg-indigo-50" : isLinkedIn ? "bg-blue-50" : "bg-sky-50"
                            }`}>
                              {CHANNEL_ICONS[msg.channel] ?? "📨"}
                            </div>

                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-medium text-slate-800">{msg.contact_email}</span>
                                <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                                  isCall ? "bg-indigo-50 text-indigo-600 border border-indigo-100" :
                                  isLinkedIn ? "bg-blue-50 text-blue-600 border border-blue-100" :
                                  "bg-sky-50 text-sky-600 border border-sky-100"
                                }`}>
                                  {msg.channel}
                                </span>
                                <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[msg.send_status] ?? "bg-slate-100 text-slate-500"}`}>
                                  {msg.send_status}
                                </span>
                                {/* Latest event badge */}
                                {callOutcome && (
                                  <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${OUTCOME_STYLES[callOutcome] ?? "bg-slate-100 text-slate-500 border border-slate-200"}`}>
                                    {callOutcome.replace(/_/g, " ")}
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center gap-3 mt-1 text-xs text-slate-400 flex-wrap">
                                {msg.sent_at && <span>{fmt(msg.sent_at)}</span>}
                                {msg.provider_message_id && (
                                  <span className="font-mono text-slate-300">{msg.provider_message_id.slice(0, 20)}…</span>
                                )}
                              </div>

                              {/* Call-specific details */}
                              {isCall && msg.event_payload && (
                                <div className="mt-2 flex items-center gap-4 text-xs">
                                  {callPhone ? (
                                    <span className="text-slate-500">
                                      <span className="text-slate-400">Phone:</span> {String(callPhone)}
                                    </span>
                                  ) : null}
                                  {callDuration != null && Number(callDuration) > 0 && (
                                    <span className="text-slate-500">
                                      <span className="text-slate-400">Duration:</span> {String(callDuration)}s
                                    </span>
                                  )}
                                  {msg.event_payload?.contact_name ? (
                                    <span className="text-slate-500">
                                      <span className="text-slate-400">Name:</span> {String(msg.event_payload.contact_name)}
                                    </span>
                                  ) : null}
                                </div>
                              )}

                              {/* Email-specific latest event detail */}
                              {!isCall && callOutcome && callOutcome !== "SENT" && (
                                <div className="mt-1.5 text-xs text-slate-400">
                                  Latest event: <span className="font-medium text-slate-600">{callOutcome}</span>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Settings
// ─────────────────────────────────────────────────────────────────────────────
function SettingsView({
  userEmail,
  role,
  onLogout,
  toast,
  onProfileUpdate,
}: {
  userEmail: string;
  role: string;
  onLogout: () => void;
  toast: (msg: string, kind?: Toast["kind"]) => void;
  onProfileUpdate: (email: string, role: string, fullName: string) => void;
}) {
  const [tab, setTab] = useState<"profile" | "security">("profile");

  // Profile fields
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState(userEmail);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileFetched, setProfileFetched] = useState(false);

  // Password fields
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwLoading, setPwLoading]   = useState(false);

  // Fetch profile on mount
  useEffect(() => {
    if (profileFetched) return;
    setProfileFetched(true);
    getProfile().then(({ data }) => {
      if (data) {
        setFullName(data.full_name ?? "");
        setEmail(data.email);
      }
    });
  }, [profileFetched]);

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setProfileLoading(true);
    const { data, error } = await updateProfile({
      full_name: fullName || undefined,
      email: email !== userEmail ? email : undefined,
    });
    setProfileLoading(false);
    if (error || !data) { toast(error ?? "Failed to save profile", "error"); return; }
    toast("Profile updated", "success");
    onProfileUpdate(data.email, data.role, data.full_name ?? "");
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPw !== confirmPw) { toast("New passwords do not match", "error"); return; }
    if (newPw.length < 6)    { toast("Password must be at least 6 characters", "error"); return; }
    setPwLoading(true);
    const { error } = await changePassword(currentPw, newPw);
    setPwLoading(false);
    if (error) { toast(error, "error"); return; }
    toast("Password changed successfully", "success");
    setCurrentPw(""); setNewPw(""); setConfirmPw("");
  }

  return (
    <div className="view-enter w-full">
      <div className="mb-6">
        <h2 className="text-xl font-bold text-slate-900 font-display">Settings</h2>
        <p className="text-slate-500 text-sm">Manage your profile and security</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Left column — avatar + session + about */}
        <div className="space-y-4">
          {/* Avatar banner */}
          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-white text-lg font-bold uppercase">
                {(fullName || email).charAt(0)}
              </div>
              <div>
                <div className="text-base font-semibold text-slate-800">{fullName || email}</div>
                <div className="text-xs text-slate-400 mt-0.5">{email}</div>
                <div className={`inline-flex mt-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                  role === "ADMIN"
                    ? "bg-blue-100 text-blue-700 border border-blue-200"
                    : "bg-slate-100 text-slate-600 border border-slate-200"
                }`}>
                  {role === "ADMIN" ? "Admin — full access" : "Viewer"}
                </div>
              </div>
            </div>
          </div>

          {/* Sign out */}
          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <h3 className="text-sm font-semibold text-slate-800 mb-1">Session</h3>
            <p className="text-xs text-slate-500 mb-4">Sign out of InFynd on this device.</p>
            <button
              onClick={onLogout}
              className="btn-danger text-sm px-5 py-2.5 flex items-center gap-2"
            >
              <span>←</span> Sign Out
            </button>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <h3 className="text-sm font-semibold text-slate-800 mb-1">About InFynd Campaign Engine</h3>
            <p className="text-xs text-slate-500 leading-relaxed">
              InFynd uses a multi-agent AI pipeline to find the right contacts, craft personalized outreach messages, and send them across email, LinkedIn, and phone — all from a single prompt.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {["AI-Powered", "Multi-channel", "Auto-personalized", "Real-time analytics"].map((tag) => (
                <span key={tag} className="text-[11px] px-2.5 py-1 rounded-full bg-blue-50 text-blue-600 border border-blue-100 font-medium">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Right column — tabs + forms */}
        <div className="xl:col-span-2 space-y-4">
          {/* Tabs */}
          <div className="flex rounded-xl bg-slate-100 p-1 w-fit">
            {(["profile", "security"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`px-6 py-2.5 text-sm font-semibold rounded-lg capitalize transition-all ${
                  tab === t ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {t === "profile" ? "Profile" : "Security"}
              </button>
            ))}
          </div>

          {tab === "profile" && (
            <form className="bg-white border border-slate-200 rounded-lg p-5 space-y-4" onSubmit={handleSaveProfile}>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-2">Full Name</label>
                <input
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="input-premium"
                  placeholder="John Doe"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-2">Email Address</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input-premium"
                  required
                />
                <p className="text-xs text-slate-400 mt-1.5">
                  Changing to an <span className="text-blue-500 font-medium">@infynd.com</span> address upgrades your role to Admin.
                </p>
              </div>
              <button
                type="submit"
                disabled={profileLoading}
                className="btn-brand text-sm px-6 py-2.5 flex items-center gap-2"
              >
                {profileLoading ? <><span className="btn-spinner" /> Saving…</> : "💾 Save Profile"}
              </button>
            </form>
          )}

          {tab === "security" && (
            <form className="bg-white border border-slate-200 rounded-lg p-5 space-y-4" onSubmit={handleChangePassword}>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-2">Current Password</label>
                <input
                  type="password"
                  value={currentPw}
                  onChange={(e) => setCurrentPw(e.target.value)}
                  className="input-premium"
                  placeholder="••••••••"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-2">New Password</label>
                <input
                  type="password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  className="input-premium"
                  placeholder="••••••••"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-2">Confirm New Password</label>
                <input
                  type="password"
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  className="input-premium"
                  placeholder="••••••••"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={pwLoading}
                className="btn-brand text-sm px-6 py-2.5 flex items-center gap-2"
              >
                {pwLoading ? <><span className="btn-spinner" /> Updating…</> : "🔑 Change Password"}
              </button>
            </form>
          )}

        </div>{/* end right column */}
      </div>{/* end grid */}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Root App
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState<View>("login");
  const [userEmail, setUserEmail] = useState("");
  const [role, setRole] = useState("VIEWER");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campLoading, setCampLoading] = useState(false);
  const [selectedCamp, setSelectedCamp] = useState<Campaign | null>(null);
  const [analyticsCamp, setAnalyticsCamp] = useState<Campaign | null>(null);
  const [approvalCamp, setApprovalCamp] = useState<Campaign | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const lastKnownCount = useRef<number>(-1);

  useEffect(() => {
    loadTokens();
    if (isLoggedIn()) fetchUserFromToken();
  }, []);

  // Force logout when any API call gets an unrecoverable 401
  // (e.g. refresh token expired / revoked)
  useEffect(() => {
    const handleUnauthorized = () => {
      handleLogout();
      // Override the generic "Signed out" toast from handleLogout with a more informative one
      const id = ++_toastId;
      setToasts((p) => [...p.filter((t) => t.msg !== "Signed out"), { id, msg: "Session expired — please sign in again.", kind: "error" }]);
      setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 6000);
    };
    window.addEventListener("infynd:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("infynd:unauthorized", handleUnauthorized);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function fetchUserFromToken() {
    try {
      const tok = getAccessToken();
      const payload = JSON.parse(atob(tok.split(".")[1]));
      setUserEmail(payload.email ?? "");
      setRole(payload.role ?? "VIEWER");
      setView("create"); // ← land on create page after login
      refreshCampaigns();
    } catch { /* ignore */ }
  }

  const toast = useCallback((msg: string, kind: Toast["kind"] = "info") => {
    const id = ++_toastId;
    setToasts((p) => [...p, { id, msg, kind }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 5000);
  }, []);

  function removeToast(id: number) {
    setToasts((p) => p.filter((t) => t.id !== id));
  }

  function handleLoginSuccess(email: string, r: string) {
    setUserEmail(email);
    setRole(r);
    setView("create"); // ← redirect to create campaign after login
    refreshCampaigns();
    toast(`Welcome, ${email}!`, "success");
  }

  function handleProfileUpdate(email: string, r: string, _fullName: string) {
    setUserEmail(email);
    setRole(r);
  }

  function handleLogout() {
    clearTokens();
    setCampaigns([]);
    setSelectedCamp(null);
    lastKnownCount.current = -1;
    setView("login");
    toast("Signed out", "info");
  }

  async function refreshCampaigns() {
    setCampLoading(true);
    const { data: countData } = await getCampaignCount();
    const serverCount = countData?.count ?? 0;
    if (serverCount === 0) {
      lastKnownCount.current = 0;
      setCampaigns([]);
      setCampLoading(false);
      return;
    }
    const { data, error } = await listCampaigns();
    setCampLoading(false);
    if (error) { toast(error, "error"); return; }
    lastKnownCount.current = serverCount;
    setCampaigns(data ?? []);
  }

  // Helper to open detail view with fresh campaign data
  async function openDetail(c: Campaign) {
    const { data, error } = await getCampaign(c.id);
    if (error) {
      toast(error, "error");
      setSelectedCamp(c);
    } else {
      setSelectedCamp(data ?? c);
    }
    setView("detail");
  }

  // Helper to open approval view with fresh campaign data
  async function openApproval(c: Campaign) {
    const { data, error } = await getCampaign(c.id);
    if (error) {
      toast(error, "error");
      setApprovalCamp(c);
    } else {
      setApprovalCamp(data ?? c);
    }
    setView("approval");
  }

  const refreshRef = useRef(refreshCampaigns);
  useEffect(() => { refreshRef.current = refreshCampaigns; });

  useEffect(() => {
    if (view !== "dashboard" && view !== "detail") return;
    const poll = async () => {
      const { data: countData } = await getCampaignCount();
      if (countData === null) return;
      const serverCount = countData.count;
      if (serverCount === lastKnownCount.current) return;
      await refreshRef.current();
    };
    const t = setInterval(poll, 10_000);
    return () => clearInterval(t);
  }, [view]);

  if (view === "login") {
    return (
      <>
        <Toasts toasts={toasts} remove={removeToast} />
        <LoginView onSuccess={handleLoginSuccess} />
      </>
    );
  }

  function renderMain() {
    switch (view) {
      case "create":
        return (
          <CreateView
            onCreated={(c) => {
              toast(`"${c.name}" created — pipeline running!`, "success");
              refreshCampaigns();
              setSelectedCamp(c);
              setView("detail");
            }}
            toast={toast}
          />
        );
      case "dashboard":
        return (
          <DashboardView
            campaigns={campaigns}
            loading={campLoading}
            refreshCampaigns={refreshCampaigns}
            onSelect={(c) => { openDetail(c); }}
            onAnalytics={(c) => { setAnalyticsCamp(c); setView("analytics"); }}
            onApproval={(c) => { openApproval(c); }}
            toast={toast}
          />
        );
      case "detail":
        return selectedCamp ? (
          <DetailView
            campaign={selectedCamp}
            onBack={() => setView("dashboard")}
            onAnalytics={(c) => { setAnalyticsCamp(c); setView("analytics"); }}
            onApproval={(c) => { setApprovalCamp(c); setView("approval"); }}
            toast={toast}
          />
        ) : null;
      case "analytics":
        return analyticsCamp ? (
          <AnalyticsView
            campaign={analyticsCamp}
            onBack={() => setView(selectedCamp ? "detail" : "dashboard")}
            toast={toast}
          />
        ) : null;
      case "approval":
        return approvalCamp ? (
          <ApprovalView
            campaign={approvalCamp}
            onBack={() => setView(selectedCamp ? "detail" : "dashboard")}
            onDone={() => { refreshCampaigns(); setView("dashboard"); }}
            toast={toast}
          />
        ) : null;
      case "tracking":
        return <TrackingView campaigns={campaigns} toast={toast} />;
      case "history":
        return (
          <HistoryView
            campaigns={campaigns}
            toast={toast}
            onSelect={(c) => { openDetail(c); }}
            onApproval={(c) => { openApproval(c); }}
          />
        );
      case "settings":
        return (
          <SettingsView
            userEmail={userEmail}
            role={role}
            onLogout={handleLogout}
            toast={toast}
            onProfileUpdate={handleProfileUpdate}
          />
        );
      default:
        return null;
    }
  }

  return (
    <>
      <Toasts toasts={toasts} remove={removeToast} />
      <div className="flex h-screen overflow-hidden bg-[#f8fafc]">
        <Sidebar
          view={view}
          setView={setView}
          userEmail={userEmail}
          role={role}
          onLogout={handleLogout}
        />
        <main className="flex-1 p-6 overflow-y-auto min-h-0">
          {renderMain()}
        </main>
      </div>
    </>
  );
}
