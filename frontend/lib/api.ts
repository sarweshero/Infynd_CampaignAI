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

    // Auto-refresh on 401
    if (res.status === 401 && _refreshToken && path !== "/auth/refresh") {
      const refreshed = await apiFetch<{ access_token: string }>("/auth/refresh", {
        method: "POST",
        body:   { refresh_token: _refreshToken },
        auth:   false,
      });
      if (refreshed.data?.access_token) {
        _accessToken = refreshed.data.access_token;
        setTokens(_accessToken, _refreshToken);
        return apiFetch<T>(path, opts); // retry once
      }
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
      const refreshed = await apiFetch<{ access_token: string }>("/auth/refresh", {
        method: "POST",
        body: { refresh_token: _refreshToken },
        auth: false,
      });
      if (refreshed.data?.access_token) {
        _accessToken = refreshed.data.access_token;
        setTokens(_accessToken, _refreshToken);
        res = await execute(_accessToken);
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
      const refreshed = await apiFetch<{ access_token: string }>("/auth/refresh", {
        method: "POST",
        body: { refresh_token: _refreshToken },
        auth: false,
      });
      if (refreshed.data?.access_token) {
        _accessToken = refreshed.data.access_token;
        setTokens(_accessToken, _refreshToken);
        res = await execute(_accessToken);
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
//  ❶  AUTH  (endpoints 1–2)
// ─────────────────────────────────────────────────────────────────────────────
export interface TokenResponse {
  access_token:  string;
  refresh_token: string;
  token_type:    string;
  role:          string;
  email:         string;
}

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
  opened:           number;
  clicked:          number;
  answered:         number;
  conversion_count: number;
}
export interface CampaignAnalytics {
  campaign_id:          string;
  total_contacts:       number;
  sent:                 number;
  opened:               number;
  clicked:              number;
  answered:             number;
  open_rate:            number;
  click_rate:           number;
  conversion_rate:      number;
  breakdown_by_channel: ChannelBreakdown[];
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
//  ❺  WEBSOCKET  (WS /ws/campaigns/{id}?token=...)
// ─────────────────────────────────────────────────────────────────────────────
export type WsMessage = {
  type?:           string;
  error?:          string;
  code?:           string;
  campaign_id?:    string;
  total_contacts?: number;
  channel_counts?: Record<string, number>;
  contact_email?:  string;
  channel?:        string;
  content?:        unknown;
  count?:          number;   // from CHANNEL_GROUP_START
  index?:          number;
  approved_count?: number;
  approved_by?:    string;
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
