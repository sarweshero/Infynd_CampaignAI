// ─────────────────────────────────────────────────────────────────────────────
//  InFynd API client  –  Axios + SWR
// ─────────────────────────────────────────────────────────────────────────────

import axios, {
  type AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from "axios";

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api/v1";
export const WS_BASE  = process.env.NEXT_PUBLIC_WS_URL  ?? "ws://localhost:8000/api/v1";

// ── Allow custom flags on axios request config ────────────────────────────────
declare module "axios" {
  interface InternalAxiosRequestConfig {
    _retry?: boolean;  // prevents infinite refresh loop
    noAuth?: boolean;  // skip Authorization header for public routes
  }
}

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
      // Use plain axios (NOT axiosInstance) to avoid hitting the response
      // interceptor and causing an infinite refresh → 401 loop.
      const { data } = await axios.post<{ access_token?: string; refresh_token?: string }>(
        `${API_BASE}/auth/refresh`,
        { refresh_token: _refreshToken },
        { headers: { "Content-Type": "application/json" } },
      );
      if (!data.access_token) return false;
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

// ─────────────────────────────────────────────────────────────────────────────
//  Axios instance  +  request / response interceptors
// ─────────────────────────────────────────────────────────────────────────────
export const axiosInstance: AxiosInstance = axios.create({
  baseURL: API_BASE,
  headers: { "Content-Type": "application/json" },
});

// ── Request interceptor: attach Bearer token ──────────────────────────────────
axiosInstance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (!config.noAuth && _accessToken) {
    config.headers["Authorization"] = `Bearer ${_accessToken}`;
  }
  return config;
});

// ── Response interceptor: 401 → refresh → retry once ─────────────────────────
axiosInstance.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const original      = error.config as InternalAxiosRequestConfig;
    const is401         = error.response?.status === 401;
    const isRefreshPath = original?.url === "/auth/refresh";
    const alreadyRetried = original?._retry;

    if (is401 && !isRefreshPath && !alreadyRetried && _refreshToken) {
      original._retry = true;
      const refreshed = await doRefresh();
      if (refreshed) {
        original.headers["Authorization"] = `Bearer ${_accessToken}`;
        return axiosInstance(original);
      }
      signalUnauthorized();
    }
    return Promise.reject(error);
  },
);

// ── core Axios wrapper ────────────────────────────────────────────────────────
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

  // Build the request config for axiosInstance
  const config: AxiosRequestConfig & { noAuth?: boolean } = {
    url:    path,
    method,
    data:   body,
    noAuth: !auth,   // interceptor reads this to skip Authorization header
  };
  // Per-request token override (e.g. for audio/voice helpers)
  if (token) {
    config.headers = { Authorization: `Bearer ${token}` };
  }

  try {
    const res = await axiosInstance.request<T>(config);
    return { data: res.data, error: null, status: res.status };
  } catch (err) {
    const axErr = err as AxiosError;
    if (axErr.response) {
      const msg = toErrorMessage(axErr.response.data, axErr.response.status);
      return { data: null, error: msg, status: axErr.response.status };
    }
    return { data: null, error: (err as Error).message, status: 0 };
  }
}

export async function fetchCallTemplateAudio(
  campaignId: string,
  channel = "Call",
  opts?: { rate?: number; voiceId?: string },
): Promise<{ data: string | null; error: string | null; status: number }> {
  if (typeof window !== "undefined") loadTokens();
  const params = new URLSearchParams();
  if (typeof opts?.rate === "number") params.set("rate", String(opts.rate));
  if (opts?.voiceId) params.set("voice_id", opts.voiceId);
  const qs   = params.toString();
  const path = `/campaigns/${campaignId}/common-content/${encodeURIComponent(channel)}/audio${qs ? `?${qs}` : ""}`;

  try {
    const res = await axiosInstance.get<Blob>(path, { responseType: "blob" });
    const objectUrl = URL.createObjectURL(res.data);
    return { data: objectUrl, error: null, status: res.status };
  } catch (err) {
    const axErr = err as AxiosError;
    if (axErr.response) {
      let msg = `HTTP ${axErr.response.status}`;
      try {
        const text = await (axErr.response.data as Blob).text();
        msg = toErrorMessage(JSON.parse(text) as unknown, axErr.response.status);
      } catch { /* ignore */ }
      return { data: null, error: msg, status: axErr.response.status };
    }
    return { data: null, error: (err as Error).message, status: 0 };
  }
}

export async function fetchCallTemplateVoices(
  campaignId: string,
  channel = "Call",
): Promise<{ data: Array<{ id: string; name: string }> | null; error: string | null; status: number }> {
  if (typeof window !== "undefined") loadTokens();
  const path = `/campaigns/${campaignId}/common-content/${encodeURIComponent(channel)}/audio/voices`;

  try {
    const res = await axiosInstance.get<{ voices?: Array<{ id: string; name: string }> }>(path);
    return { data: res.data.voices ?? [], error: null, status: res.status };
  } catch (err) {
    const axErr = err as AxiosError;
    if (axErr.response) {
      return { data: null, error: toErrorMessage(axErr.response.data, axErr.response.status), status: axErr.response.status };
    }
    return { data: null, error: (err as Error).message, status: 0 };
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
export const authRegister = (email: string, password: string, company: string, full_name?: string) =>
  apiFetch<RegisterResponse>("/auth/register", {
    method: "POST",
    body: { email, password, company, full_name: full_name || null },
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

// ─────────────────────────────────────────────────────────────────────────────
//  ❻  SWR FETCHER  — use with useSWR(key, swrFetcher)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generic fetcher for SWR.  The `key` is the API path string.
 * Uses axiosInstance.get directly — Axios throws on non-2xx so SWR
 * captures HTTP errors automatically via its `error` field.
 */
export async function swrFetcher<T = unknown>(path: string): Promise<T> {
  if (typeof window !== "undefined") loadTokens();
  const res = await axiosInstance.get<T>(path);
  return res.data;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ❼  INSIGHTS  (endpoints /insights/global | /insights/history | /insights/tracking)
// ─────────────────────────────────────────────────────────────────────────────

export interface GlobalInsights {
  // Campaign pipeline
  total_campaigns:   number;
  completed:         number;
  failed:            number;
  active:            number;
  awaiting_approval: number;
  dispatched:        number;
  // Engagement
  total_sent:      number;
  total_delivered: number;
  total_opened:    number;
  total_clicked:   number;
  total_answered:  number;
  // Rates (%)
  delivery_rate: number;
  open_rate:     number;
  click_rate:    number;
  // Channel split
  channel_counts:  Record<string, number>;
  // Recency
  events_last_24h: number;
}

export interface HistoryInsights {
  // Logs
  total_logs:   number;
  success_logs: number;
  failed_logs:  number;
  running_logs: number;
  // Messages
  total_messages:    number;
  email_messages:    number;
  call_messages:     number;
  linkedin_messages: number;
}

export interface TrackingInsights {
  total_events:    number;
  sent:            number;
  delivered:       number;
  opened:          number;
  clicked:         number;
  answered:        number;
  bounced:         number;
  delivery_rate:   number;
  open_rate:       number;
  click_rate:      number;
  channel_counts:  Record<string, number>;
  event_breakdown: Record<string, number>;
}

/** GET /insights/global */
export const getGlobalInsights = () =>
  apiFetch<GlobalInsights>("/insights/global");

/** GET /insights/history?campaign_id=<optional> */
export const getHistoryInsights = (campaignId?: string) =>
  apiFetch<HistoryInsights>(
    campaignId ? `/insights/history?campaign_id=${campaignId}` : "/insights/history",
  );

/** GET /insights/tracking?campaign_id=<optional> */
export const getTrackingInsights = (campaignId?: string) =>
  apiFetch<TrackingInsights>(
    campaignId ? `/insights/tracking?campaign_id=${campaignId}` : "/insights/tracking",
  );

// ─────────────────────────────────────────────────────────────────────────────
//  ❽  ADMIN — user management  (ADMIN role required)
// ─────────────────────────────────────────────────────────────────────────────

export interface AdminUser {
  id:         string;
  email:      string;
  full_name:  string | null;
  role:       string;
  company:    string | null;
  is_active:  boolean;
  created_at: string;
}

export interface AdminUserListResponse {
  users: AdminUser[];
  total: number;
}

export interface AdminCreateUserPayload {
  email:     string;
  password:  string;
  full_name?: string;
  role:      string;
  company?:  string;
}

export interface AdminUpdateUserPayload {
  role?:      string;
  full_name?: string;
  company?:   string;
  is_active?: boolean;
}

/** GET /admin/users — list all users */
export const adminListUsers = () =>
  apiFetch<AdminUserListResponse>("/admin/users");

/** POST /admin/users — create a user */
export const adminCreateUser = (payload: AdminCreateUserPayload) =>
  apiFetch<AdminUser>("/admin/users", { method: "POST", body: payload });

/** PATCH /admin/users/:id — update role / name / company / active */
export const adminUpdateUser = (userId: string, payload: AdminUpdateUserPayload) =>
  apiFetch<AdminUser>(`/admin/users/${userId}`, { method: "PATCH", body: payload });

/** DELETE /admin/users/:id */
export const adminDeleteUser = (userId: string) =>
  apiFetch<void>(`/admin/users/${userId}`, { method: "DELETE" });
