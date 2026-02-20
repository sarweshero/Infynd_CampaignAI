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
  authRefresh,
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
  type WsMessage,
  type WsAction,
  type LogEntry,
  type MessageEntry,
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

function fmt(iso: string) {
  if (!iso || typeof iso !== "string") return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
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
const NAV = [
  { id: "create",    label: "New Campaign", icon: "✦" },
  { id: "dashboard", label: "Dashboard",    icon: "⊞" },
  { id: "history",   label: "History",      icon: "▤" },
  { id: "tracking",  label: "Tracking",     icon: "◎" },
  { id: "settings",  label: "Settings",     icon: "⚙" },
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
    <aside className="flex flex-col w-64 min-h-screen bg-white border-r border-slate-100 py-6 relative shadow-[2px_0_16px_rgba(15,23,42,0.04)]">
      {/* Subtle top gradient accent */}
      <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-blue-500 via-blue-400 to-indigo-500 rounded-none" />

      {/* Logo */}
      <div className="px-6 mb-8">
        <div className="flex items-center gap-3">
          <div className="relative w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-white font-bold text-sm shadow-glow">
            <span className="font-display tracking-tight">In</span>
            <div className="absolute inset-0 rounded-xl bg-blue-500 opacity-20 blur-xl scale-150 -z-10" />
          </div>
          <div>
            <div className="text-slate-900 font-bold text-base leading-tight font-display tracking-tight">InFynd</div>
            <div className="text-blue-400 text-[10px] font-semibold tracking-widest uppercase">Campaign Engine</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 space-y-1">
        {NAV.map((item) => (
          <button
            key={item.id}
            onClick={() => setView(item.id as View)}
            className={`sidebar-item w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm transition-all duration-200 ${
              view === item.id
                ? "active bg-blue-50 text-blue-700 font-semibold border border-blue-100"
                : "text-slate-500 hover:bg-slate-50 hover:text-slate-700"
            }`}
          >
            <span
              className={`text-base w-5 text-center transition-all duration-200 ${
                view === item.id ? "scale-110 text-blue-600" : ""
              }`}
            >
              {item.icon}
            </span>
            {item.label}
            {item.id === "create" && (
              <span className="ml-auto text-[10px] bg-blue-500 text-white px-1.5 py-0.5 rounded-full font-bold">
                AI
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* User */}
      <div className="px-4 mt-4 pt-4 border-t border-slate-100">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-white text-xs font-bold uppercase shadow-glow-sm">
            {userEmail.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-slate-600 truncate font-medium">{userEmail}</div>
            <div
              className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold mt-0.5 ${
                role === "ADMIN"
                  ? "bg-blue-100 text-blue-700 border border-blue-200"
                  : "bg-slate-100 text-slate-500 border border-slate-200"
              }`}
            >
              {role}
            </div>
          </div>
        </div>
        <button
          onClick={onLogout}
          className="w-full flex items-center gap-2 text-xs text-slate-400 hover:text-red-500 transition-all duration-200 px-1 py-1 rounded-lg hover:bg-red-50"
        >
          <span className="text-sm">←</span> Sign out
        </button>
      </div>
    </aside>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Login View
// ─────────────────────────────────────────────────────────────────────────────
function LoginView({ onSuccess }: { onSuccess: (email: string, role: string) => void }) {
  const [email, setEmail] = useState("admin@infynd.com");
  const [password, setPassword] = useState("admin123");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

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

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#f0f6ff] via-[#e8f2ff] to-[#f0f0ff] flex items-center justify-center p-4 relative overflow-hidden">
      {/* Animated mesh orbs */}
      <div className="login-mesh">
        <div
          className="login-orb w-[500px] h-[500px] bg-blue-400/25 animate-pulse-soft"
          style={{ top: "-10%", left: "-5%", animationDelay: "0s" }}
        />
        <div
          className="login-orb w-[400px] h-[400px] bg-indigo-400/20 animate-float"
          style={{ bottom: "5%", right: "-5%", animationDelay: "1s" }}
        />
        <div
          className="login-orb w-[300px] h-[300px] bg-blue-300/15 animate-pulse-soft"
          style={{ top: "50%", left: "45%", animationDelay: "2s" }}
        />
      </div>

      {/* Wireframe background grid */}
      <div className="absolute inset-0 wireframe-bg opacity-50" />

      <div className="w-full max-w-md relative z-10">
        {/* Logo & heading */}
        <div className="text-center mb-10 animate-fade-in-up">
          <div className="relative inline-flex w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-500 to-blue-700 items-center justify-center text-white text-2xl font-bold mb-5 shadow-glow-lg">
            <span className="font-display">In</span>
            <div className="absolute inset-0 rounded-2xl bg-blue-500 opacity-25 blur-2xl scale-150 -z-10" />
          </div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight font-display">
            InFynd{" "}
            <span className="text-gradient-brand">Campaign Engine</span>
          </h1>
          <p className="text-slate-500 mt-2 text-sm font-light">
            AI-powered multi-agent outbound campaign platform
          </p>
          <div className="flex items-center justify-center gap-2 mt-3">
            {["Global Reach", "Multi-Agent AI", "Real-time Analytics"].map((tag) => (
              <span
                key={tag}
                className="text-[10px] font-semibold px-2.5 py-1 rounded-full bg-blue-50 text-blue-600 border border-blue-100"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>

        {/* Card */}
        <div
          className="card p-8 space-y-6 animate-fade-in-up"
          style={{ animationDelay: "0.15s" }}
        >
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
          </div>

          {err && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-red-100 flex items-center justify-center text-xs text-red-600 shrink-0">
                ✕
              </span>
              {err}
            </div>
          )}

          <button
            type="button"
            onClick={handleLogin}
            disabled={loading}
            className="btn-brand w-full py-3.5 text-sm rounded-xl font-semibold"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-3">
                <span className="btn-spinner" />
                Signing in…
              </span>
            ) : (
              "Sign in to InFynd →"
            )}
          </button>

          <p className="text-center text-xs text-slate-400">
            Domain{" "}
            <span className="text-blue-500 font-medium">@infynd.com</span> → ADMIN
            &nbsp;|&nbsp; other → VIEWER
          </p>
        </div>
      </div>
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
    <div className="card p-5 hover-lift">
      <div className="text-slate-400 text-[10px] uppercase tracking-widest font-semibold mb-2">
        {label}
      </div>
      <div
        className={`text-3xl font-bold tracking-tight font-display count-enter ${
          accent ?? "text-slate-900"
        }`}
      >
        {value}
      </div>
      {sub && (
        <div className="text-blue-500 text-xs mt-1.5 font-medium">{sub}</div>
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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 tracking-tight font-display">Dashboard</h2>
          <p className="text-slate-500 text-sm mt-1">
            {total > 0 ? `${total} campaign${total !== 1 ? "s" : ""} · live analytics` : "All campaigns and pipeline status"}
          </p>
        </div>
        <button
          onClick={refreshCampaigns}
          className="btn-ghost text-sm flex items-center gap-2"
        >
          {loading ? <span className="btn-spinner-blue" /> : <span className="text-base">↻</span>}
          Refresh
        </button>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 stagger-children">
        <Metric label="Total Campaigns" value={total} />
        <Metric label="Completed" value={completed} sub={total > 0 ? `${pct(completed, total)}% success` : undefined} accent="text-emerald-600" />
        <Metric label="Awaiting Approval" value={awaiting} sub={awaiting > 0 ? "needs action" : undefined} accent={awaiting > 0 ? "text-amber-600" : "text-slate-900"} />
        <Metric label="In Progress" value={inProgress} sub={dispatched > 0 ? `${dispatched} dispatched` : undefined} accent="text-blue-600" />
      </div>

      {/* Analytics section */}
      {total > 0 && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="card p-5">
              <h4 className="text-sm font-semibold text-slate-800 mb-4">Pipeline Distribution</h4>
              {stateItems.length > 0 ? (
                <HBarChart items={stateItems} maxVal={maxState} />
              ) : (
                <p className="text-slate-400 text-xs">No state data yet</p>
              )}
            </div>

            <div className="card p-5 space-y-5">
              <div>
                <h4 className="text-sm font-semibold text-slate-800 mb-4">Channel Breakdown</h4>
                {platformItems.length > 0 ? (
                  <HBarChart items={platformItems} maxVal={maxPlatform} />
                ) : (
                  <p className="text-slate-400 text-xs">No channel data yet</p>
                )}
              </div>
              {approvalItems.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold text-slate-800 mb-3">Approval Mode</h4>
                  <HBarChart items={approvalItems} maxVal={maxApproval} />
                </div>
              )}
            </div>

            <div className="card p-5">
              <h4 className="text-sm font-semibold text-slate-800 mb-4">
                Campaigns Created{" "}
                <span className="text-slate-400 font-normal">(last 7 days)</span>
              </h4>
              <MiniVBar items={dayItems} maxVal={maxDay} />
              <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-3 gap-2 text-center">
                <div>
                  <div className="text-xl font-bold text-emerald-600 font-display">{completed}</div>
                  <div className="text-[11px] text-slate-400">Completed</div>
                </div>
                <div>
                  <div className="text-xl font-bold text-blue-600 font-display">{dispatched}</div>
                  <div className="text-[11px] text-slate-400">Dispatched</div>
                </div>
                <div>
                  <div className="text-xl font-bold text-red-500 font-display">{failed}</div>
                  <div className="text-[11px] text-slate-400">Failed</div>
                </div>
              </div>
            </div>
          </div>

          {/* Performance rings */}
          <div className="card p-5">
            <h4 className="text-sm font-semibold text-slate-800 mb-6">Performance Overview</h4>
            <div className="flex flex-wrap gap-6 justify-around">
              {[
                { pctVal: pct(completed, total), hex: "#10b981", label: `${pct(completed, total)}%`, sub: "completed", title: "Completion Rate" },
                { pctVal: pct(awaiting + inProgress, total), hex: "#f59e0b", label: `${awaiting + inProgress}`, sub: "campaigns", title: "Active" },
                { pctVal: pct(failed, total), hex: "#ef4444", label: `${pct(failed, total)}%`, sub: "failure", title: "Failure Rate" },
                { pctVal: pct(autoApprove, total), hex: "#3b82f6", label: `${pct(autoApprove, total)}%`, sub: "auto", title: "Auto-Approve" },
                { pctVal: pct(dispatched + completed, total), hex: "#0ea5e9", label: `${dispatched + completed}`, sub: "campaigns", title: "Sent / Done" },
              ].map((ring) => (
                <div key={ring.title} className="flex flex-col items-center gap-2">
                  <RingChart pct={ring.pctVal} hex={ring.hex} centerLabel={ring.label} centerSub={ring.sub} />
                  <span className="text-xs text-slate-500">{ring.title}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Campaign list */}
      <div className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="font-semibold text-slate-800 text-sm">Campaign List</h3>
          {awaiting > 0 && (
            <span className="bg-amber-50 text-amber-700 border border-amber-200 text-xs font-medium px-2.5 py-1 rounded-full">
              {awaiting} awaiting approval
            </span>
          )}
        </div>

        {loading ? (
          <div className="py-16 flex flex-col items-center justify-center gap-4">
            <div className="loader-orbit" />
            <span className="text-slate-400 text-sm">Loading campaigns…</span>
          </div>
        ) : campaigns.length === 0 ? (
          <div className="py-16 text-center">
            <div className="text-4xl mb-3">🚀</div>
            <div className="text-slate-600 text-sm font-medium">No campaigns yet</div>
            <div className="text-slate-400 text-xs mt-1">Create your first campaign to see analytics here</div>
          </div>
        ) : (
          <div className="divide-y divide-slate-50">
            {campaigns.map((c, idx) => (
              <div
                key={c.id}
                className="flex items-center gap-4 px-5 py-4 hover:bg-blue-50/40 transition-all duration-200 card-enter"
                style={{ animationDelay: `${idx * 0.04}s` }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <button
                      onClick={() => onSelect(c)}
                      className="font-medium text-slate-800 text-sm hover:text-blue-600 transition-colors truncate"
                    >
                      {c.name}
                    </button>
                    <span className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full font-medium ${stateColor(c.pipeline_state)}`}>
                      {c.pipeline_state.replace(/_/g, " ")}
                    </span>
                    {c.approval_required && (
                      <span className="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">
                        approval req
                      </span>
                    )}
                  </div>
                  <div className="text-slate-400 text-xs">
                    {c.company} · {c.platform ?? "email"} · {fmt(c.created_at)}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {c.pipeline_state === "AWAITING_APPROVAL" && (
                    <>
                      <button onClick={() => onApproval(c)} className="btn-warning text-xs px-3 py-1.5">
                        Review &amp; Approve
                      </button>
                    </>
                  )}
                  <button onClick={() => onAnalytics(c)} className="btn-ghost text-xs px-3 py-1.5">
                    Analytics
                  </button>
                  <button onClick={() => onSelect(c)} className="btn-ghost text-xs px-3 py-1.5">
                    View
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Create Campaign — Main landing page after login
// ─────────────────────────────────────────────────────────────────────────────
const PROMPT_EXAMPLES = [
  "Reach out to HR Directors in Chennai about InFynd AI's time-to-hire reduction tool. Use cold email style, short and punchy, with a CTA to book a 15-min demo.",
  "Promote our SaaS analytics platform to CTOs at mid-size fintech companies in Bangalore. Use LinkedIn, focus on ROI and ease of integration.",
  "Call startup founders in Mumbai to introduce our funding advisory services from VentureEdge. Target founders who recently raised a Seed round.",
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
  const [exampleIdx, setExampleIdx] = useState(0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
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

  const AI_FEATURES = [
    { icon: "🏢", label: "Company", desc: "auto-detected" },
    { icon: "🎯", label: "Platform", desc: "auto-detected" },
    { icon: "📋", label: "Purpose", desc: "auto-extracted" },
    { icon: "👥", label: "Audience", desc: "auto-segmented" },
    { icon: "✉", label: "Style", desc: "auto-crafted" },
  ];

  return (
    <div className="view-enter max-w-3xl space-y-8">
      {/* Hero header */}
      <div className="card-brand p-8 rounded-2xl relative overflow-hidden">
        <div className="absolute inset-0 dot-grid-bg opacity-20" />
        <div className="relative z-10">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-white/70 text-xs font-semibold tracking-widest uppercase">AI-Powered</span>
            <span className="w-1 h-1 rounded-full bg-white/50" />
            <span className="text-white/70 text-xs font-semibold tracking-widest uppercase">Global Outreach</span>
          </div>
          <h2 className="text-3xl font-bold text-white tracking-tight font-display leading-tight">
            Start Your Campaign
          </h2>
          <p className="text-blue-100 mt-2 text-sm leading-relaxed max-w-lg">
            Describe what you want to promote and who you want to reach. Our AI handles everything else — finding contacts, writing personalized messages, and sending them.
          </p>
          <div className="flex flex-wrap gap-2 mt-5">
            {AI_FEATURES.map(({ icon, label, desc }) => (
              <div
                key={label}
                className="inline-flex items-center gap-1.5 bg-white/10 backdrop-blur border border-white/20 text-white/90 text-xs px-3 py-1.5 rounded-full hover:bg-white/15 transition-colors"
              >
                <span>{icon}</span>
                <span className="font-medium">{label}</span>
                <span className="text-white/50">·</span>
                <span className="text-white/60">{desc}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Main prompt */}
        <div className="card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-semibold text-slate-800">
              Campaign Prompt
              <span className="ml-2 text-xs font-normal text-slate-400">
                The more you tell us, the better the results
              </span>
            </label>
            <button
              type="button"
              onClick={() => {
                const next = (exampleIdx + 1) % PROMPT_EXAMPLES.length;
                setExampleIdx(next);
                setPrompt(PROMPT_EXAMPLES[next]);
              }}
              className="text-xs text-blue-500 hover:text-blue-700 transition-colors font-medium whitespace-nowrap"
            >
              Try example →
            </button>
          </div>

          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={PROMPT_EXAMPLES[exampleIdx]}
            rows={6}
            required
            className="input-premium resize-none leading-relaxed text-sm"
            style={{ minHeight: "140px" }}
          />

          {/* Character count indicator */}
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-400 italic">
              Tip: mention your product, who you want to reach, and what action you want them to take
            </p>
            <span className={`text-xs font-mono ${prompt.length > 20 ? "text-blue-500" : "text-slate-300"}`}>
              {prompt.length} chars
            </span>
          </div>
        </div>

        {/* Product link */}
        <div className="card p-5">
          <label className="block text-sm font-semibold text-slate-800 mb-1.5">
            Product / Landing Page Link
            <span className="ml-2 text-xs font-normal text-slate-400">(optional)</span>
          </label>
          <input
            type="url"
            value={productLink}
            onChange={(e) => setProductLink(e.target.value)}
            placeholder="https://yourproduct.com"
            className="input-premium"
          />
          <p className="text-xs text-slate-400 mt-1.5">
            Used as the CTA link in generated email / LinkedIn messages.
          </p>
        </div>

        {/* Auto-send toggle */}
        <div className="card p-5 flex items-center gap-4">
          <button
            type="button"
            onClick={() => setAutoApprove((v) => !v)}
            className={`w-12 h-6 rounded-full transition-all duration-300 relative shrink-0 border-2 ${
              autoApprove
                ? "bg-gradient-to-r from-blue-500 to-blue-700 border-blue-400 shadow-glow-sm"
                : "bg-slate-200 border-slate-200"
            }`}
          >
            <span
              className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-300 ${
                autoApprove ? "translate-x-6" : "translate-x-0.5"
              }`}
            />
          </button>
          <div className="flex-1">
            <div className="text-sm font-semibold text-slate-800">
              {autoApprove ? "🚀 Auto-send when ready" : "✋ I want to review before sending"}
            </div>
            <div className="text-xs text-slate-400 mt-0.5">
              {autoApprove
                ? "AI will craft and send messages automatically — sit back and watch results roll in"
                : "You\'ll get a chance to review and tweak each message before anything goes out"}
            </div>
          </div>
        </div>

        {/* Submit */}
        <button
          type="submit"
          disabled={loading || !prompt.trim()}
          className="btn-brand w-full py-4 text-sm rounded-xl font-semibold text-base"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-3">
              <span className="loader-ai">
                <span className="loader-ai-dot" />
                <span className="loader-ai-dot" />
                <span className="loader-ai-dot" />
              </span>
              AI Pipeline launching…
            </span>
          ) : (
            <span className="flex items-center justify-center gap-2">
              <span>🚀</span>
              Start Campaign
            </span>
          )}
        </button>
      </form>
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
  const personalized: Record<string, any> = genContent.personalized ?? {};
  const contacts = Object.keys(personalized);

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
    const co = (personalized[email] as Record<string, any>)?.content ?? {};
    setEditingContactFields(Object.fromEntries(Object.entries(co).map(([k, v]) => [k, String(v)])));
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
    const email = Object.keys(personalized).find((e) => (personalized[e] as any)?.channel === channel);
    const contact = email ? { email, ...(personalized[email] as any) } : {};
    const renderField = (v: string) => substitutePlaceholders(v, contact, tpl as Record<string, any>);

    if (editingCommonChannel === channel) {
      return (
        <div className="space-y-2">
          {Object.entries(editingCommonFields).map(([k, v]) => (
            <div key={k}>
              <label className="text-[11px] text-slate-400 uppercase block mb-0.5">{k}</label>
              <textarea
                rows={k.toLowerCase().includes("body") || k.toLowerCase().includes("message") ? 5 : 2}
                value={v}
                onChange={(e) => setEditingCommonFields((p) => ({ ...p, [k]: e.target.value }))}
                className="input-premium text-xs resize-y"
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
        <h2 className="text-2xl font-bold text-slate-900 truncate tracking-tight font-display">
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
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
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

      {/* Personalized contact content */}
      {contacts.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
            <h3 className="font-semibold text-slate-800 text-sm">
              Personalized Content ({contacts.length} contacts)
            </h3>
          </div>
          <div className="divide-y divide-slate-50">
            {contacts.slice(0, 10).map((email) => {
              const ct = personalized[email] as Record<string, any> | undefined;
              const ch = (ct?.channel as string) ?? "Email";
              const co = ct?.content as Record<string, string> | undefined;
              const isEditing = editingContactEmail === email;
              return (
                <div key={email} className="px-5 py-4">
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className="text-sm font-medium text-slate-800">{email}</span>
                    <span className="text-[11px] bg-blue-50 text-blue-700 border border-blue-100 px-2 py-0.5 rounded-full">
                      {ch}
                    </span>
                    {!isEditing && ["CONTENT_GENERATED","AWAITING_APPROVAL"].includes(campaign.pipeline_state) && (
                      <button onClick={() => startEditContact(email)} className="ml-auto btn-ghost text-xs px-3 py-1">
                        ✎ Edit
                      </button>
                    )}
                  </div>
                  {isEditing ? (
                    <div className="space-y-2">
                      {Object.entries(editingContactFields).map(([k, v]) => (
                        <div key={k}>
                          <label className="text-[11px] text-slate-400 uppercase block mb-0.5">{k}</label>
                          <textarea
                            rows={k.toLowerCase().includes("body") || k.toLowerCase().includes("message") || k.toLowerCase().includes("script") ? 4 : 2}
                            value={v}
                            onChange={(e) => setEditingContactFields((p) => ({ ...p, [k]: e.target.value }))}
                            className="input-premium text-xs resize-y"
                          />
                        </div>
                      ))}
                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={saveContact}
                          disabled={savingContact}
                          className="btn-brand text-xs px-4 py-1.5 flex items-center gap-1.5"
                        >
                          {savingContact ? <><span className="btn-spinner" style={{ width: 12, height: 12 }} /> Saving…</> : "💾 Save"}
                        </button>
                        <button onClick={cancelEditContact} className="btn-ghost text-xs px-4 py-1.5">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    co && (
                      <div className="bg-slate-50 rounded-lg p-3 text-xs text-slate-600 space-y-1 border border-slate-100">
                        {Object.entries(co).map(([k, v]) =>
                          typeof v === "string" ? (
                            <div key={k}><span className="text-slate-400 mr-1">{k}:</span>{substitutePlaceholders(v, { email, ...(personalized[email] as any) }, co as Record<string, any>)}</div>
                          ) : null,
                        )}
                      </div>
                    )
                  )}
                </div>
              );
            })}
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

  useEffect(() => {
    (async () => {
      const { data: d, error } = await getCampaignAnalytics(campaign.id);
      setLoading(false);
      if (error) { toast(error, "error"); return; }
      setData(d);
    })();
  }, [campaign.id]);

  return (
    <div className="view-enter space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-slate-400 hover:text-blue-600 text-sm transition-colors">
          ← Back
        </button>
        <div>
          <h2 className="text-2xl font-bold text-slate-900 tracking-tight font-display">Analytics</h2>
          <p className="text-slate-500 text-sm truncate">{campaign.name}</p>
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
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 stagger-children">
            <Metric label="Total Contacts" value={data.total_contacts} />
            <Metric label="Sent" value={data.sent} accent="text-blue-600" />
            <Metric label="Opened" value={data.opened} sub={`${data.open_rate}%`} accent="text-violet-600" />
            <Metric label="Clicked" value={data.clicked} sub={`${data.click_rate}%`} accent="text-pink-600" />
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <Metric label="Answered Calls" value={data.answered} />
            <Metric label="Conversions" value={`${data.conversion_rate}%`} accent="text-emerald-600" />
            <Metric label="Delivery Rate" value={`${pct(data.sent, data.total_contacts)}%`} accent="text-blue-600" />
          </div>

          <div className="card p-6 space-y-5">
            <h3 className="font-semibold text-slate-800 text-sm">Engagement Funnel</h3>
            <Bar label="Sent" value={data.sent} max={data.total_contacts} color="bg-blue-500" />
            <Bar label="Opened" value={data.opened} max={data.sent || 1} color="bg-violet-500" />
            <Bar label="Clicked" value={data.clicked} max={data.opened || 1} color="bg-pink-500" />
          </div>

          {data.breakdown_by_channel?.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100">
                <h3 className="font-semibold text-slate-800 text-sm">Channel Breakdown</h3>
              </div>
              <div className="divide-y divide-slate-50">
                <div className="grid grid-cols-6 px-5 py-2 text-[11px] text-slate-400 uppercase tracking-wider">
                  {["Channel","Sent","Opened","Clicked","Answered","Conversions"].map((h) => (
                    <div key={h}>{h}</div>
                  ))}
                </div>
                {data.breakdown_by_channel.map((ch) => (
                  <div key={ch.channel} className="grid grid-cols-6 px-5 py-3 text-sm text-slate-700 hover:bg-blue-50/30 transition-colors">
                    <div className="font-semibold text-slate-800">{ch.channel}</div>
                    <div>{ch.sent}</div>
                    <div>{ch.opened}</div>
                    <div>{ch.clicked}</div>
                    <div>{ch.answered}</div>
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
  const [currentContact, setCurrent] = useState<WsMessage | null>(null);
  const [currentChannel, setCurrentChannel] = useState<string>("");
  const [editFields, setEditFields] = useState<Record<string, string>>({});
  const [isEditing, setIsEditing] = useState(false);
  const [totalContacts, setTotal] = useState(0);
  const [approved, setApproved] = useState(0);
  const [channelCounts, setChannelCounts] = useState<Record<string, number>>({});
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
          setTotal(msg.total_contacts ?? 0);
          setChannelCounts(msg.channel_counts ?? {});
        }
        if (msg.type === "CHANNEL_GROUP_START") {
          setCurrentChannel(msg.channel ?? "");
        }
        if (msg.type === "CONTACT_CONTENT") {
          setCurrent(msg);
          setEditFields(contentToFields(msg.content));
          setIsEditing(false);
        }
        if (msg.type === "APPROVED" || msg.type === "ALL_APPROVED") {
          setApproved((p) => msg.type === "ALL_APPROVED" ? (msg.approved_count ?? p) : p + 1);
          setApprovingAll(false);
          setCurrent(null);
          setEditFields({});
        }
        if (msg.type === "CAMPAIGN_APPROVED") {
          setDone(true);
          toast("Campaign approved — messages are sending now!", "success");
          setTimeout(onDone, 2000);
        }
        if (msg.error) {
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
      // onopen may happen before we receive approval start
      setConnecting(false);
      setConnected(true);
    };
    ws.onerror = () => {
      setConnecting(false);
      setConnected(false);
    };
  }, [campaign.id]);

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
        toast("WebSocket disconnected — please reconnect before editing or regenerating", "error");
      }
      return;
    }
    wsRef.current.send(JSON.stringify(action));
  }

  function sendApprove()    { send({ action: "approve" }, true); }
  function sendApproveAll() { setApprovingAll(true); send({ action: "approve_all" }, true); }
  function sendRegenerate() { send({ action: "regenerate" }); }   // no fallback — WS required
  function sendEdit()       {
    send({ action: "edit", edited_content: editFields as Record<string, unknown> }); // no fallback
    setIsEditing(false);
  }

  async function restApprove() {
    const { error } = await approveCampaign(campaign.id);
    if (error) { toast(error, "error"); return; }
    toast("Campaign approved — messages are sending now!", "success");
    onDone();
  }

  const CHANNEL_ICONS: Record<string, string> = { Email: "✉", LinkedIn: "🔗", Call: "☎" };
  const EMAIL_FIELDS    = ["subject","body","cta"];
  const LINKEDIN_FIELDS = ["message","cta"];
  const CALL_FIELDS     = ["greeting","value_prop","objection_handler","closing","cta"];
  function fieldsForChannel(ch: string) {
    return ch === "Email" ? EMAIL_FIELDS : ch === "LinkedIn" ? LINKEDIN_FIELDS : CALL_FIELDS;
  }

  const progressPct = totalContacts > 0 ? pct(approved, totalContacts) : 0;

  return (
    <div className="view-enter space-y-6 max-w-3xl">
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
            {totalContacts} contacts ready
          </span>
        )}
      </div>

      {/* Done state */}
      {done ? (
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-12 text-center">
          <div className="text-5xl mb-4">🎉</div>
          <div className="text-emerald-700 font-bold text-2xl font-display mb-2">Campaign Approved!</div>
          <div className="text-slate-500 text-sm">Your campaign is being sent to all contacts now.</div>
          <button onClick={onDone} className="mt-6 btn-brand px-8 py-3">
            Back to Dashboard
          </button>
        </div>
      ) : (
        <>
          {/* Channel summary pills */}
          {Object.keys(channelCounts).length > 0 && (
            <div className="flex gap-3 flex-wrap">
              {Object.entries(channelCounts).map(([ch, count]) => (
                <div
                  key={ch}
                  className={`px-4 py-2 rounded-xl flex items-center gap-2 border transition-all ${
                    currentChannel === ch ? "bg-blue-50 border-blue-200" : "bg-white border-slate-100"
                  }`}
                >
                  <span className="text-base">{CHANNEL_ICONS[ch] ?? "📨"}</span>
                  <span className="text-sm text-slate-700 font-medium">{ch}</span>
                  <span className="text-xs text-slate-400">{count} contacts</span>
                </div>
              ))}
            </div>
          )}

          {/* ★ Primary action: Approve All */}
          {connected && (
            <div className="card p-6 border-2 border-emerald-100 bg-gradient-to-br from-emerald-50/60 to-white">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <div className="text-base font-semibold text-slate-800">
                    Looks good? Send to all {totalContacts > 0 ? totalContacts : ""} contacts
                  </div>
                  <div className="text-sm text-slate-500 mt-1 max-w-sm">
                    AI has crafted personalized messages for each contact. Approve all at once, or scroll down to review one by one.
                  </div>
                </div>
                <button
                  onClick={sendApproveAll}
                  disabled={approvingAll}
                  className="btn-success px-8 py-3.5 text-base font-semibold shrink-0 flex items-center gap-2"
                >
                  {approvingAll ? (
                    <><span className="btn-spinner" /> Approving…</>
                  ) : "✓ Approve All & Send"}
                </button>
              </div>

              {totalContacts > 0 && (
                <div className="mt-5">
                  <div className="flex justify-between text-xs text-slate-400 mb-1.5">
                    <span>Review progress</span>
                    <span>{approved} / {totalContacts}</span>
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

          {/* Individual contact review card */}
          {currentContact && (
            <div className="card p-6 border border-blue-100">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-white text-sm font-bold shrink-0">
                  {(currentContact.contact_email ?? "?").charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-slate-800 truncate">{currentContact.contact_email}</div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {CHANNEL_ICONS[currentContact.channel ?? ""] ?? ""} {currentContact.channel}
                    {totalContacts > 0 && (
                      <span className="ml-2 text-blue-400"># {approved + 1} of {totalContacts}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {!isEditing && (
                    <button
                      onClick={() => setIsEditing(true)}
                      className="btn-ghost text-xs px-3 py-1.5"
                    >
                      ✎ Edit
                    </button>
                  )}
                  <button
                    onClick={sendRegenerate}
                    className="btn-ghost text-xs px-3 py-1.5"
                  >
                    ↺ Regenerate
                  </button>
                </div>
              </div>

              {/* Message preview or editor */}
              {!isEditing ? (
                <div className="bg-slate-50 border border-slate-100 rounded-xl p-4 space-y-3 mb-5">
                  {Object.entries(editFields).map(([k, v]) => (
                    <div key={k}>
                      <div className="text-[11px] text-slate-400 uppercase tracking-wider mb-0.5 capitalize font-medium">
                        {k.replace(/_/g, " ")}
                      </div>
                      <div className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{v}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-3 mb-5">
                  {fieldsForChannel(currentContact.channel ?? "Email").map((field) => (
                    <div key={field}>
                      <label className="block text-[11px] text-slate-400 uppercase tracking-wider mb-1 capitalize font-medium">
                        {field.replace(/_/g, " ")}
                      </label>
                      <textarea
                        value={editFields[field] ?? ""}
                        onChange={(e) => setEditFields((prev) => ({ ...prev, [field]: e.target.value }))}
                        rows={field === "body" || field === "message" || field === "value_prop" ? 5 : 2}
                        className="input-premium text-sm resize-y"
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* Contact action row */}
              <div className="flex items-center gap-3">
                {isEditing ? (
                  <>
                    <button onClick={sendEdit} className="btn-brand text-sm px-5 py-2.5 flex items-center gap-1.5">
                      💾 Save &amp; Approve
                    </button>
                    <button onClick={() => setIsEditing(false)} className="btn-ghost text-sm px-4 py-2.5">
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={sendApprove}
                    className="btn-success text-sm px-6 py-2.5 flex items-center gap-2"
                  >
                    ✓ Approve &amp; Next
                  </button>
                )}
              </div>
            </div>
          )}

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

          {connected && !currentContact && !approvingAll && (
            <div className="card p-8 text-center">
              <div className="loader-wave mx-auto mb-4">
                <span /><span /><span /><span /><span />
              </div>
              <div className="text-slate-500 text-sm">Preparing content for review…</div>
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
//  Tracking View
// ─────────────────────────────────────────────────────────────────────────────
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
  const [tab, setTab] = useState<"sendgrid" | "call" | "linkedin">("sendgrid");

  const [sgEmail, setSgEmail] = useState("sarweshero@gmail.com");
  const [sgMsgId, setSgMsgId] = useState("4BWDnvuMTr22C2CzTF-GmA");
  const [sgEvent, setSgEvent] = useState("open");
  const [sgUrl, setSgUrl] = useState("https://infynd.com");
  const [sgLoading, setSgLoading] = useState(false);
  const [sgResult, setSgResult] = useState("");

  async function sendSgEvent() {
    if (!selectedId) { toast("Select a campaign first", "error"); return; }
    setSgLoading(true);
    const events = [{ email: sgEmail, event: sgEvent, sg_message_id: sgMsgId, campaign_id: selectedId, timestamp: Math.floor(Date.now() / 1000), ...(sgEvent === "click" ? { url: sgUrl } : {}) }];
    const { data, error } = await sendgridWebhook(events);
    setSgLoading(false);
    if (error) { toast(error, "error"); setSgResult(`Error: ${error}`); return; }
    toast("SendGrid event sent!", "success");
    setSgResult(JSON.stringify(data, null, 2));
  }

  const [callEmail, setCallEmail] = useState("sarweshero@gmail.com");
  const [callOutcome, setCallOutcome] = useState("ANSWERED");
  const [callDuration, setCallDuration] = useState(120);
  const [callLoading, setCallLoading] = useState(false);
  const [callResult, setCallResult] = useState("");

  async function sendCall() {
    if (!selectedId) { toast("Select a campaign first", "error"); return; }
    setCallLoading(true);
    const { data, error } = await callTracking({ contact_email: callEmail, campaign_id: selectedId, outcome: callOutcome, duration_seconds: callDuration });
    setCallLoading(false);
    if (error) { toast(error, "error"); setCallResult(`Error: ${error}`); return; }
    toast("Call event recorded!", "success");
    setCallResult(JSON.stringify(data, null, 2));
  }

  const [liEmail, setLiEmail] = useState("sarweshero@gmail.com");
  const [liEvent, setLiEvent] = useState("ACCEPTED");
  const [liLoading, setLiLoading] = useState(false);
  const [liResult, setLiResult] = useState("");

  async function sendLinkedIn() {
    if (!selectedId) { toast("Select a campaign first", "error"); return; }
    setLiLoading(true);
    const { data, error } = await linkedinTracking({ contact_email: liEmail, campaign_id: selectedId, event_type: liEvent });
    setLiLoading(false);
    if (error) { toast(error, "error"); setLiResult(`Error: ${error}`); return; }
    toast("LinkedIn event recorded!", "success");
    setLiResult(JSON.stringify(data, null, 2));
  }

  const TABS = ["sendgrid","call","linkedin"] as const;
  const inputCls = "input-premium";

  const resultBox = (res: string) =>
    res ? (
      <pre className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs text-emerald-700 overflow-x-auto max-h-40">
        {res}
      </pre>
    ) : null;

  const selectedCamp = eligible.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="view-enter space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-900 font-display">Tracking Simulator</h2>
        <p className="text-slate-500 text-sm">Pick a campaign, then fire a tracking event</p>
      </div>

      <div className="flex gap-6 items-start">
        <div className="flex-1 min-w-0">
          <div className="text-xs text-slate-400 uppercase tracking-wider mb-3">
            Eligible campaigns ({eligible.length})
          </div>
          {eligible.length === 0 ? (
            <div className="card p-8 text-center">
              <div className="text-3xl mb-2">◎</div>
              <div className="text-slate-400 text-sm">No dispatched or completed campaigns yet</div>
            </div>
          ) : (
            <div className="grid grid-cols-2 xl:grid-cols-3 gap-3 max-h-[500px] overflow-y-auto pr-1">
              {eligible.map((c) => (
                <CampaignKanbanCard
                  key={c.id}
                  campaign={c}
                  selected={c.id === selectedId}
                  onSelect={() => setSelectedId(c.id)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="w-80 shrink-0 space-y-4">
          <div
            className={`rounded-xl border px-4 py-3 text-xs ${
              selectedCamp
                ? "border-blue-200 bg-blue-50 text-blue-700"
                : "border-slate-200 bg-slate-50 text-slate-400"
            }`}
          >
            {selectedCamp ? (
              <>Selected: <span className="font-semibold">{selectedCamp.name.slice(0, 40)}</span></>
            ) : "No campaign selected"}
          </div>

          <div className="flex gap-1 bg-slate-100 p-1 rounded-xl">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
                  tab === t
                    ? "bg-white text-blue-700 shadow-sm border border-slate-200"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {t === "sendgrid" ? "✉" : t === "call" ? "☎" : "🔗"}
                <span className="ml-1 capitalize">{t === "sendgrid" ? "Email" : t}</span>
              </button>
            ))}
          </div>

          <div className="card p-5 space-y-4">
            {tab === "sendgrid" && (
              <>
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5 font-medium">Contact Email</label>
                  <input value={sgEmail} onChange={(e) => setSgEmail(e.target.value)} type="email" className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5 font-medium">Event Type</label>
                  <select value={sgEvent} onChange={(e) => setSgEvent(e.target.value)} className={inputCls}>
                    {["open","click","delivered","bounce","unsubscribe"].map((e) => (
                      <option key={e} value={e}>{e}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5 font-medium">Message ID</label>
                  <input value={sgMsgId} onChange={(e) => setSgMsgId(e.target.value)} className={inputCls} />
                </div>
                {sgEvent === "click" && (
                  <div>
                    <label className="block text-xs text-slate-500 mb-1.5 font-medium">Click URL</label>
                    <input value={sgUrl} onChange={(e) => setSgUrl(e.target.value)} className={inputCls} />
                  </div>
                )}
                <button
                  onClick={sendSgEvent}
                  disabled={sgLoading || !selectedId}
                  className="w-full btn-brand py-2.5 text-sm"
                >
                  {sgLoading ? <span className="flex items-center justify-center gap-2"><span className="btn-spinner" />Sending…</span> : "Fire SendGrid Event"}
                </button>
                {resultBox(sgResult)}
              </>
            )}

            {tab === "call" && (
              <>
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5 font-medium">Contact Email</label>
                  <input value={callEmail} onChange={(e) => setCallEmail(e.target.value)} type="email" className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5 font-medium">Outcome</label>
                  <select value={callOutcome} onChange={(e) => setCallOutcome(e.target.value)} className={inputCls}>
                    {["ANSWERED","VOICEMAIL","NO_ANSWER","BUSY","FAILED"].map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5 font-medium">Duration (seconds)</label>
                  <input type="number" value={callDuration} onChange={(e) => setCallDuration(Number(e.target.value))} className={inputCls} />
                </div>
                <button
                  onClick={sendCall}
                  disabled={callLoading || !selectedId}
                  className="w-full btn-brand py-2.5 text-sm"
                >
                  {callLoading ? <span className="flex items-center justify-center gap-2"><span className="btn-spinner" />Sending…</span> : "Record Call Event"}
                </button>
                {resultBox(callResult)}
              </>
            )}

            {tab === "linkedin" && (
              <>
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5 font-medium">Contact Email</label>
                  <input value={liEmail} onChange={(e) => setLiEmail(e.target.value)} type="email" className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5 font-medium">LinkedIn Event</label>
                  <select value={liEvent} onChange={(e) => setLiEvent(e.target.value)} className={inputCls}>
                    {["ACCEPTED","MESSAGE_SENT","REPLIED","VIEWED_PROFILE","IGNORED"].map((e) => (
                      <option key={e} value={e}>{e}</option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={sendLinkedIn}
                  disabled={liLoading || !selectedId}
                  className="w-full btn-brand py-2.5 text-sm"
                >
                  {liLoading ? <span className="flex items-center justify-center gap-2"><span className="btn-spinner" />Sending…</span> : "Record LinkedIn Event"}
                </button>
                {resultBox(liResult)}
              </>
            )}
          </div>
        </div>
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
        <div className="w-72 shrink-0">
          <div className="text-xs text-slate-400 uppercase tracking-wider mb-3">
            Campaigns ({campaigns.length})
          </div>
          {campaigns.length === 0 ? (
            <div className="card p-8 text-center">
              <div className="text-3xl mb-2">▤</div>
              <div className="text-slate-400 text-sm">No campaigns yet</div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 max-h-[600px] overflow-y-auto pr-1">
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
                      {messages.map((msg) => (
                        <div key={msg.id} className="px-5 py-4 flex items-start gap-4">
                          <span className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[msg.send_status] ?? "bg-slate-100 text-slate-500"}`}>
                            {msg.send_status}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-slate-800">{msg.contact_email}</span>
                              <span className="text-[11px] bg-blue-50 text-blue-600 border border-blue-100 px-2 py-0.5 rounded-full">{msg.channel}</span>
                            </div>
                            <div className="text-xs text-slate-400 mt-0.5">
                              {msg.sent_at ? fmt(msg.sent_at) : "Not yet sent"}
                              {msg.provider_message_id && (
                                <span className="ml-2 text-slate-300 font-mono">{msg.provider_message_id.slice(0, 20)}…</span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
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
}: {
  userEmail: string;
  role: string;
  onLogout: () => void;
  toast: (msg: string, kind?: Toast["kind"]) => void;
}) {
  return (
    <div className="view-enter space-y-6 max-w-lg">
      <div>
        <h2 className="text-xl font-bold text-slate-900 font-display">Account</h2>
        <p className="text-slate-500 text-sm">Your profile and preferences</p>
      </div>

      <div className="card p-6 space-y-5">
        {/* Avatar + name */}
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-white text-xl font-bold uppercase shadow-glow">
            {userEmail.charAt(0)}
          </div>
          <div>
            <div className="text-base font-semibold text-slate-800">{userEmail}</div>
            <div className={`inline-flex mt-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
              role === "ADMIN"
                ? "bg-blue-100 text-blue-700 border border-blue-200"
                : "bg-slate-100 text-slate-600 border border-slate-200"
            }`}>
              {role === "ADMIN" ? "Admin — full access" : "Viewer"}
            </div>
          </div>
        </div>

        <div className="border-t border-slate-100 pt-4 space-y-3">
          <div className="flex items-center justify-between py-2 px-3 bg-slate-50 rounded-xl">
            <span className="text-sm text-slate-600">Auto-approve future campaigns</span>
            <span className="text-xs text-slate-400">Set per campaign</span>
          </div>
          <div className="flex items-center justify-between py-2 px-3 bg-slate-50 rounded-xl">
            <span className="text-sm text-slate-600">Campaign notifications</span>
            <span className="text-xs text-emerald-600 font-medium">On</span>
          </div>
        </div>

        <button
          onClick={onLogout}
          className="btn-danger text-sm px-5 py-2.5 flex items-center gap-2"
        >
          <span>←</span> Sign Out
        </button>
      </div>

      <div className="card p-6">
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
          />
        );
      default:
        return null;
    }
  }

  return (
    <>
      <Toasts toasts={toasts} remove={removeToast} />
      <div className="flex min-h-screen bg-[#f0f4ff]">
        <Sidebar
          view={view}
          setView={setView}
          userEmail={userEmail}
          role={role}
          onLogout={handleLogout}
        />
        <main className="flex-1 p-8 overflow-y-auto">
          {renderMain()}
        </main>
      </div>
    </>
  );
}
