// ─────────────────────────────────────────────────────────────────────────────
//  InFynd API client  –  wraps all 44 API endpoints + WebSocket
// ─────────────────────────────────────────────────────────────────────────────

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api/v1";
export const WS_BASE  = process.env.NEXT_PUBLIC_WS_URL  ?? "ws://localhost:8000/api/v1";

// ── token cache (client-side only) ──────────────────────────────────────────
let _accessToken  = "";
let _refreshToken = "";

export function setTokens(access: string, refresh: string) {
  _accessToken  = access;
  _refreshToken = refresh;
  if (typeof window !== "undefined") {
    localStorage.setItem("infynd_access",  access);
    localStorage.setItem("infynd_refresh", refresh);
  }
}
export function loadTokens() {
  if (typeof window !== "undefined") {
    _accessToken  = localStorage.getItem("infynd_access")  ?? "";
    _refreshToken = localStorage.getItem("infynd_refresh") ?? "";
  }
}
export function clearTokens() {
  _accessToken = _refreshToken = "";
  if (typeof window !== "undefined") {
    localStorage.removeItem("infynd_access");
    localStorage.removeItem("infynd_refresh");
  }
}
export function getAccessToken() { return _accessToken; }
export function isLoggedIn()     { return !!_accessToken; }

// ── Token refresh mutex ───────────────────────────────────────────────────────
// At most one refresh call in-flight at a time; all concurrent 401s wait on the
// same promise and then retry with the new token instead of racing to refresh.
let _refreshPromise: Promise<boolean> | null = null;

async function doRefresh(): Promise<boolean> {
  if (!_refreshToken) return false;

  // Reuse an in-flight refresh so concurrent 401s don't race
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = (async (): Promise<boolean> => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: _refreshToken }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
      };
      if (!data.access_token) return false;
      // Store both tokens — the backend rotates the refresh token too
      setTokens(data.access_token, data.refresh_token ?? _refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      _refreshPromise = null;
    }
  })();

  return _refreshPromise;
}

/** Dispatch a browser event so the UI can react (e.g. force logout). */
function signalUnauthorized() {
  clearTokens();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("infynd:unauthorized"));
  }
}

// ── core fetch wrapper ────────────────────────────────────────────────────────
interface ApiOpts {
  method?: string;
  body?:   unknown;
  auth?:   boolean;
  token?:  string;
}

function toErrorMessage(detail: unknown, status: number): string {
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object") {
    const obj = detail as Record<string, unknown>;
    if (typeof obj.detail === "string") return obj.detail;
    if (obj.detail && typeof obj.detail === "object") {
      const nested = obj.detail as Record<string, unknown>;
      const nestedMsg = typeof nested.detail === "string" ? nested.detail : null;
      const nestedCode = typeof nested.code === "string" ? nested.code : null;
      if (nestedMsg && nestedCode) return `${nestedMsg} (${nestedCode})`;
      if (nestedMsg) return nestedMsg;
      if (nestedCode) return nestedCode;
      return JSON.stringify(obj.detail);
    }
    if (typeof obj.code === "string") return obj.code;
    return JSON.stringify(obj);
  }
  return `HTTP ${status}`;
}

export async function apiFetch<T = unknown>(
  path: string,
  opts: ApiOpts = {},
): Promise<{ data: T | null; error: string | null; status: number }> {
  const { method = "GET", body, auth = true, token } = opts;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const tok = token ?? _accessToken;
  if (auth && tok) headers["Authorization"] = `Bearer ${tok}`;

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    // ── 401 → try token refresh, then retry once ─────────────────────
    if (res.status === 401 && _refreshToken && path !== "/auth/refresh") {
      const refreshed = await doRefresh();
      if (refreshed) {
        // Retry the original request with the new access token
        return apiFetch<T>(path, opts);
      }
      // Refresh token itself is invalid/expired — force sign-out
      signalUnauthorized();
      return { data: null, error: "Session expired. Please sign in again.", status: 401 };
    }

    let data: T | null = null;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      data = await res.json();
    }

    if (!res.ok) {
      const detail = (data as Record<string, unknown> | null);
      const msg = toErrorMessage(detail, res.status);
      return { data: null, error: msg, status: res.status };
    }

    return { data, error: null, status: res.status };
  } catch (e) {
    return { data: null, error: (e as Error).message, status: 0 };
  }
}

export async function fetchCallTemplateAudio(
  campaignId: string,
  channel = "Call",
  opts?: { rate?: number; voiceId?: string },
): Promise<{ data: string | null; error: string | null; status: number }> {
  if (!_accessToken && typeof window !== "undefined") {
    loadTokens();
  }
  const params = new URLSearchParams();
  if (typeof opts?.rate === "number") params.set("rate", String(opts.rate));
  if (opts?.voiceId) params.set("voice_id", opts.voiceId);
  const query = params.toString();
  const path = `/campaigns/${campaignId}/common-content/${encodeURIComponent(channel)}/audio${query ? `?${query}` : ""}`;

  const execute = async (tokenOverride?: string) => {
    const headers: Record<string, string> = {};
    const tok = tokenOverride ?? _accessToken;
    if (tok) headers["Authorization"] = `Bearer ${tok}`;
    return fetch(`${API_BASE}${path}`, { method: "GET", headers });
  };

  try {
    let res = await execute();

    if (res.status === 401 && _refreshToken) {
      const ok = await doRefresh();
      if (ok) {
        res = await execute(_accessToken);
      } else {
        signalUnauthorized();
        return { data: null, error: "Session expired. Please sign in again.", status: 401 };
      }
    }

    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const detail = (await res.json()) as unknown;
        msg = toErrorMessage(detail, res.status);
      }
      return { data: null, error: msg, status: res.status };
    }

    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    return { data: objectUrl, error: null, status: res.status };
  } catch (e) {
    return { data: null, error: (e as Error).message, status: 0 };
  }
}

export async function fetchCallTemplateVoices(
  campaignId: string,
  channel = "Call",
): Promise<{ data: Array<{ id: string; name: string }> | null; error: string | null; status: number }> {
  if (!_accessToken && typeof window !== "undefined") {
    loadTokens();
  }
  const path = `/campaigns/${campaignId}/common-content/${encodeURIComponent(channel)}/audio/voices`;

  const execute = async (tokenOverride?: string) => {
    const headers: Record<string, string> = {};
    const tok = tokenOverride ?? _accessToken;
    if (tok) headers["Authorization"] = `Bearer ${tok}`;
    return fetch(`${API_BASE}${path}`, { method: "GET", headers });
  };

  try {
    let res = await execute();

    if (res.status === 401 && _refreshToken) {
      const ok = await doRefresh();
      if (ok) {
        res = await execute(_accessToken);
      } else {
        signalUnauthorized();
        return { data: null, error: "Session expired. Please sign in again.", status: 401 };
      }
    }

    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const detail = (await res.json()) as unknown;
        msg = toErrorMessage(detail, res.status);
      }
      return { data: null, error: msg, status: res.status };
    }

    const payload = (await res.json()) as { voices?: Array<{ id: string; name: string }> };
    return { data: payload.voices ?? [], error: null, status: res.status };
  } catch (e) {
    return { data: null, error: (e as Error).message, status: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ❶  AUTH  (endpoints 1–3)
// ─────────────────────────────────────────────────────────────────────────────
export interface TokenResponse {
  access_token:  string;
  refresh_token: string;
  token_type:    string;
  role:          string;
  email:         string;
}

export interface RegisterResponse {
  id:        string;
  email:     string;
  full_name: string | null;
  role:      string;
  message:   string;
}

/** POST /auth/register */
export const authRegister = (email: string, password: string, full_name?: string) =>
  apiFetch<RegisterResponse>("/auth/register", {
    method: "POST",
    body: { email, password, full_name: full_name || null },
    auth: false,
  });

/** POST /auth/login */
export const authLogin = (email: string, password: string) =>
  apiFetch<TokenResponse>("/auth/login", {
    method: "POST",
    body: { email, password },
    auth: false,
  });

/** POST /auth/refresh */
export const authRefresh = (refresh_token: string) =>
  apiFetch<TokenResponse>("/auth/refresh", {
    method: "POST",
    body: { refresh_token },
    auth: false,
  });

export interface ProfileResponse {
  id:        string;
  email:     string;
  full_name: string | null;
  role:      string;
  is_active: boolean;
}

/** GET /auth/me */
export const getProfile = () =>
  apiFetch<ProfileResponse>("/auth/me");

/** PATCH /auth/profile */
export const updateProfile = (data: { full_name?: string; email?: string }) =>
  apiFetch<ProfileResponse>("/auth/profile", { method: "PATCH", body: data });

/** PATCH /auth/password */
export const changePassword = (current_password: string, new_password: string) =>
  apiFetch<{ message: string }>("/auth/password", {
    method: "PATCH",
    body: { current_password, new_password },
  });

// ─────────────────────────────────────────────────────────────────────────────
//  ❷  CAMPAIGNS  (endpoints 3–7)
// ─────────────────────────────────────────────────────────────────────────────
export interface Campaign {
  id:                  string;
  name:                string;
  company?:            string;
  campaign_purpose?:   string;
  target_audience?:    string;
  product_link?:       string;
  prompt?:             string;
  platform?:           string;
  approval_required:   boolean;
  auto_approve_content: boolean;   // computed: !approval_required
  pipeline_state:      string;
  generated_content?:  Record<string, any>;
  approval_status:     string;
  approved_at?:        string;
  approved_by?:        string;
  created_by?:         string;
  created_at:          string;
}

export interface CreateCampaignPayload {
  prompt:               string;   // Required — AI extracts all other fields
  product_link?:        string;   // Optional
  auto_approve_content: boolean;  // true = no WS review; false = WS approval gate
}

export interface LogEntry {
  id:           string;
  agent_name:   string;
  status:       string;
  started_at:   string;
  completed_at?: string;
  duration_ms?: number;
  error_message?: string;
}

export interface MessageEntry {
  id:                   string;
  contact_email:        string;
  channel:              string;
  send_status:          string;
  provider_message_id?: string;
  sent_at?:             string;
  latest_event?:        string;
  event_payload?:       Record<string, unknown>;
}

/** POST /campaigns/ */
export const createCampaign = (payload: CreateCampaignPayload) =>
  apiFetch<Campaign>("/campaigns/", { method: "POST", body: payload });

/** GET /campaigns/ */
export const listCampaigns = () =>
  apiFetch<Campaign[]>("/campaigns/");

/** GET /campaigns/count */
export const getCampaignCount = () =>
  apiFetch<{ count: number }>("/campaigns/count");

/** GET /campaigns/{id} */
export const getCampaign = (id: string) =>
  apiFetch<Campaign>(`/campaigns/${id}`);

/** PATCH /campaigns/{id}/content/{email} */
export const editContactContent = (
  campaignId: string,
  contactEmail: string,
  content: Record<string, unknown>,
) =>
  apiFetch<{ message: string; contact_email: string }>(
    `/campaigns/${campaignId}/content/${encodeURIComponent(contactEmail)}`,
    { method: "PATCH", body: { content } },
  );

/** PATCH /campaigns/{id}/common-content/{channel} */
export const editCommonContent = (
  campaignId: string,
  channel: string,
  content: Record<string, unknown>,
) =>
  apiFetch<{ message: string; channel: string }>(
    `/campaigns/${campaignId}/common-content/${encodeURIComponent(channel)}`,
    { method: "PATCH", body: { content } },
  );

/** POST /campaigns/{id}/approve */
export const approveCampaign = (id: string) =>
  apiFetch<{ message: string }>(`/campaigns/${id}/approve`, { method: "POST" });

/** POST /campaigns/{id}/regenerate-content */
export const regenerateCampaignContent = (id: string) =>
  apiFetch<{ message: string }>(`/campaigns/${id}/regenerate-content`, { method: "POST" });

/** GET /campaigns/{id}/logs */
export const getCampaignLogs = (id: string) =>
  apiFetch<LogEntry[]>(`/campaigns/${id}/logs`);

/** GET /campaigns/{id}/messages */
export const getCampaignMessages = (id: string) =>
  apiFetch<MessageEntry[]>(`/campaigns/${id}/messages`);

// ─────────────────────────────────────────────────────────────────────────────
//  ❸  ANALYTICS  (endpoint 8)
// ─────────────────────────────────────────────────────────────────────────────
export interface ChannelBreakdown {
  channel:          string;
  sent:             number;
  delivered:        number;
  opened:           number;
  clicked:          number;
  answered:         number;
  bounced:          number;
  busy:             number;
  no_answer:        number;
  conversion_count: number;
}
export interface HourlyActivity {
  hour:  string;   // ISO datetime string (UTC)
  count: number;
}
export interface TopContact {
  email:             string;
  events:            number;
  latest_event_type: string | null;
}
export interface CampaignAnalytics {
  campaign_id:              string;
  total_contacts:           number;
  sent:                     number;
  delivered:                number;
  opened:                   number;
  clicked:                  number;
  answered:                 number;
  bounced:                  number;
  busy:                     number;
  no_answer:                number;
  open_rate:                number;
  click_rate:               number;
  conversion_rate:          number;
  delivery_rate:            number;
  answer_rate:              number;
  reach_rate:               number;
  click_to_open_rate:       number;
  avg_call_duration_seconds: number;
  hourly_activity:          HourlyActivity[];
  top_engaged_contacts:     TopContact[];
  breakdown_by_channel:     ChannelBreakdown[];
}

/** GET /campaigns/{id}/analytics */
export const getCampaignAnalytics = (id: string) =>
  apiFetch<CampaignAnalytics>(`/campaigns/${id}/analytics`);

// ─────────────────────────────────────────────────────────────────────────────
//  ❹  TRACKING  (endpoints 9–11)
// ─────────────────────────────────────────────────────────────────────────────

/** POST /tracking/sendgrid  (array of events) */
export const sendgridWebhook = (events: unknown[]) =>
  apiFetch<{ processed: number }>("/tracking/sendgrid", {
    method: "POST",
    body:   events,
    auth:   false,
  });

/** POST /tracking/call */
export const callTracking = (payload: {
  contact_email:    string;
  campaign_id:      string;
  outcome:          string;
  duration_seconds?: number;
}) =>
  apiFetch<{ message: string }>("/tracking/call", {
    method: "POST",
    body:   payload,
    auth:   false,
  });

/** POST /tracking/linkedin */
export const linkedinTracking = (payload: {
  contact_email: string;
  campaign_id:   string;
  event_type:    string;
}) =>
  apiFetch<{ message: string }>("/tracking/linkedin", {
    method: "POST",
    body:   payload,
    auth:   false,
  });

// ─────────────────────────────────────────────────────────────────────────────
//  ❹b  TRACKING EVENT FEED  (live data)
// ─────────────────────────────────────────────────────────────────────────────
export interface TrackingEvent {
  id:            string;
  campaign_id:   string;
  contact_email: string;
  channel:       string;
  event_type:    string;
  occurred_at:   string;
  payload?:      Record<string, unknown>;
}
export interface TrackingFeed {
  campaign_id: string;
  events:      TrackingEvent[];
  total:       number;
}

/** GET /tracking/events/{campaign_id} */
export const getTrackingEvents = (campaignId: string, opts?: { limit?: number; channel?: string }) => {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.channel) params.set("channel", opts.channel);
  const qs = params.toString();
  return apiFetch<TrackingFeed>(`/tracking/events/${campaignId}${qs ? `?${qs}` : ""}`);
};

/** GET /tracking/events  (all campaigns) */
export const getAllTrackingEvents = (limit = 50) =>
  apiFetch<TrackingEvent[]>(`/tracking/events?limit=${limit}`);

// ─────────────────────────────────────────────────────────────────────────────
//  ❺  WEBSOCKET  (WS /ws/campaigns/{id}?token=...)
// ─────────────────────────────────────────────────────────────────────────────
export type WsMessage = {
  type?:           string;
  error?:          string;
  code?:           string;
  campaign_id?:    string;
  total_contacts?: number;
  channel_counts?: Record<string, number>;
  channels?:       string[];              // APPROVAL_START
  contact_email?:  string;
  channel?:        string;
  content?:        unknown;
  count?:          number;                // CHANNEL_GROUP_START
  contact_count?:  number;                // CHANNEL_CONTENT
  contacts?:       string[];              // CHANNEL_CONTENT — sample emails for this channel
  index?:          number;
  approved_count?: number;
  approved_by?:    string;
  approved_channels?: string[];           // CAMPAIGN_APPROVED
};

export type WsAction =
  | { action: "approve" }
  | { action: "approve_all" }
  | { action: "edit";       edited_content: Record<string, unknown> }
  | { action: "regenerate" };

export function openApprovalWs(
  campaignId: string,
  token: string,
  onMessage: (msg: WsMessage) => void,
  onClose: () => void,
): WebSocket {
  const ws = new WebSocket(`${WS_BASE}/ws/campaigns/${campaignId}?token=${token}`);
  ws.onmessage = (ev) => {
    try { onMessage(JSON.parse(ev.data)); } catch { /* ignore */ }
  };
  ws.onclose  = onClose;
  ws.onerror  = () => onClose();
  return ws;
}
