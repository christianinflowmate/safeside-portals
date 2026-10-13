import type {
  ApiError,
  CreatedInvite,
  InviteSummary,
  ApiUser,
  ExtractionProgress,
  GeneratedDocument,
  LoginRequest,
  ProposalDetail,
  ProposalListItem,
  SelectRecommendationsRequest,
  SelectDisclaimersRequest,
  UpdateCustomerRequest,
  UpdateLineDetailRequest,
  UpdateLineRequest,
  UpdateProposalRequest,
} from '@safeside/shared';

/**
 * The one place that talks to the API.
 *
 * The session cookie is httpOnly, so nothing here can read it. Whether we are
 * logged in is a question only `GET /api/auth/me` can answer, and any 401 from
 * any call means the answer changed underneath us.
 */

export const UNAUTHORIZED_EVENT = 'safeside:unauthorized';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly details: string[];
  readonly leakFindings: NonNullable<ApiError['leak_findings']>;

  constructor(
    status: number,
    message: string,
    details: string[] = [],
    leakFindings: NonNullable<ApiError['leak_findings']> = [],
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.details = details;
    this.leakFindings = leakFindings;
  }
}

interface RequestOptions {
  method?: string;
  /** JSON body. Mutually exclusive with `form`. */
  body?: unknown;
  /** Multipart body, used for uploads. */
  form?: FormData;
  /**
   * Login is the one call where a 401 is an answer rather than an expired
   * session, so it must not kick the whole app back to the login screen.
   */
  silentOn401?: boolean;
  signal?: AbortSignal;
}

function defaultMessage(status: number): string {
  if (status === 401) return 'Your session has expired. Sign in again.';
  if (status === 403) return 'You do not have access to this.';
  if (status === 404) return 'Not found. This part of the API may not exist yet.';
  if (status === 413) return 'That file is too large.';
  if (status >= 500) return `The server failed (${status}).`;
  return `Request failed (${status}).`;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, form, silentOn401 = false, signal } = options;

  const init: RequestInit = { method, credentials: 'same-origin', signal };
  if (form) {
    init.body = form;
  } else if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiRequestError(0, `Could not reach the API at ${path}.`);
  }

  if (response.status === 401 && !silentOn401) {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }

  if (!response.ok) {
    let payload: Partial<ApiError> = {};
    try {
      payload = (await response.json()) as Partial<ApiError>;
    } catch {
      /* A non-JSON error body (a proxy 502, an HTML 404) is still an error. */
    }
    throw new ApiRequestError(
      response.status,
      payload.error ?? defaultMessage(response.status),
      payload.details ?? [],
      payload.leak_findings ?? [],
    );
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiRequestError(
      response.status,
      `The API returned something that is not JSON (${path}).`,
    );
  }
}

/** POST /api/proposals returns at least an id; the rest is not relied upon. */
export interface CreatedProposal {
  id: string;
}

export const api = {
  /* --- Auth -------------------------------------------------------------- */

  login: (credentials: LoginRequest) =>
    request<ApiUser | null>('/api/auth/login', {
      method: 'POST',
      body: credentials,
      silentOn401: true,
    }),

  me: (signal?: AbortSignal) => request<ApiUser>('/api/auth/me', { signal, silentOn401: true }),

  logout: () => request<void>('/api/auth/logout', { method: 'POST', silentOn401: true }),

  /**
   * silentOn401 because a wrong current password is an answer to show on the
   * form, not a sign the session expired — without it the app would bounce to
   * the sign-in screen on a typo.
   */
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('/api/auth/password', {
      method: 'POST',
      body: { current_password: currentPassword, new_password: newPassword },
      silentOn401: true,
    }),

  /* --- Invitations ------------------------------------------------------- */

  /* The two a not-yet-signed-in person uses. */
  lookupInvite: (token: string, signal?: AbortSignal) =>
    request<{ email: string; display_name: string }>(`/api/invites/${encodeURIComponent(token)}`, { signal, silentOn401: true }),

  acceptInvite: (token: string, password: string) =>
    request<{ ok: true }>(`/api/invites/${encodeURIComponent(token)}/accept`, {
      method: 'POST',
      body: { password },
      silentOn401: true,
    }),

  /* Admin only. */
  listInvites: (signal?: AbortSignal) => request<InviteSummary[]>('/api/admin/invites', { signal }),

  createInvite: (input: { email: string; display_name: string; is_admin: boolean }) =>
    request<CreatedInvite>('/api/admin/invites', { method: 'POST', body: input }),

  revokeInvite: (id: string) => request<void>(`/api/admin/invites/${id}`, { method: 'DELETE' }),

  /* --- Proposals --------------------------------------------------------- */

  listProposals: (signal?: AbortSignal) =>
    request<ProposalListItem[]>('/api/proposals', { signal }),

  createProposal: (clientName: string) =>
    request<CreatedProposal>('/api/proposals', {
      method: 'POST',
      body: { client_name: clientName },
    }),

  deleteProposal: (id: string) =>
    request<void>(`/api/proposals/${id}`, { method: 'DELETE' }),

  getProposal: (id: string, signal?: AbortSignal) =>
    request<ProposalDetail>(`/api/proposals/${id}`, { signal }),

  /**
   * Build the editable draft if it is not there yet.
   *
   * Idempotent and safe to race: the server locks the proposal row, so a second
   * caller blocks and then bails out rather than inserting the lines twice.
   */
  materialize: (id: string, signal?: AbortSignal) =>
    request<{ created: boolean; lineCount: number; reason?: string }>(
      `/api/proposals/${id}/materialize`,
      { method: 'POST', signal },
    ),

  updateProposal: (id: string, patch: UpdateProposalRequest) =>
    request<unknown>(`/api/proposals/${id}`, { method: 'PATCH', body: patch }),

  /* --- Files and extraction ---------------------------------------------- */

  uploadFiles: (id: string, files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);
    return request<unknown>(`/api/proposals/${id}/files`, { method: 'POST', form });
  },

  getStatus: (id: string, signal?: AbortSignal) =>
    request<ExtractionProgress>(`/api/proposals/${id}/status`, { signal }),

  deleteFile: (id: string, fileId: string) =>
    request<void>(`/api/proposals/${id}/files/${fileId}`, { method: 'DELETE' }),

  retryFile: (id: string, fileId: string) =>
    request<{ id: string }>(`/api/proposals/${id}/files/${fileId}/retry`, { method: 'POST' }),

  /* --- Review ------------------------------------------------------------ */

  updateCustomer: (id: string, patch: UpdateCustomerRequest) =>
    request<unknown>(`/api/proposals/${id}/customer`, { method: 'PATCH', body: patch }),

  updateLine: (lineId: string, patch: UpdateLineRequest) =>
    request<unknown>(`/api/lines/${lineId}`, { method: 'PATCH', body: patch }),

  /**
   * LineDetail carries no id, so a detail is addressed by its position in the
   * line's `details` array.
   */
  updateLineDetail: (lineId: string, index: number, patch: UpdateLineDetailRequest) =>
    request<unknown>(`/api/lines/${lineId}/details/${index}`, {
      method: 'PATCH',
      body: patch,
    }),

  /** Replace one of a line's schedule tables. Whole-array, no row ids. */
  putSchedule: (lineId: string, kind: string, rows: Array<Record<string, string | null>>) =>
    request<unknown>(`/api/lines/${lineId}/schedules/${kind}`, {
      method: 'PUT',
      body: { rows },
    }),

  /** Replace the insured's premise schedule. It belongs to the business, not a line. */
  putPremises: (id: string, rows: Array<Record<string, string | null>>) =>
    request<unknown>(`/api/proposals/${id}/premises`, { method: 'PUT', body: { rows } }),

  selectDisclaimers: (id: string, selection: SelectDisclaimersRequest) =>
    request<unknown>(`/api/proposals/${id}/disclaimers`, {
      method: 'PUT',
      body: selection,
    }),

  selectRecommendations: (id: string, selection: SelectRecommendationsRequest) =>
    request<unknown>(`/api/proposals/${id}/recommendations`, {
      method: 'PUT',
      body: selection,
    }),

  /* --- Documents --------------------------------------------------------- */

  generate: (id: string) =>
    request<GeneratedDocument>(`/api/proposals/${id}/generate`, { method: 'POST' }),

  getDocument: (id: string, signal?: AbortSignal) =>
    request<GeneratedDocument>(`/api/proposals/${id}/document`, { signal }),
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
