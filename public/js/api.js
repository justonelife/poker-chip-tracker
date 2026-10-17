// Thin fetch wrapper. Throws ApiError for non-2xx and network failures
// (status 0), so callers can branch on err.status.

export class ApiError extends Error {
  constructor(status, body, message) {
    super(message || body?.message || `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

export async function request(method, path, body, headers = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, null, 'No connection. Check your network.');
  }
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON error page (proxy, cold start). Fall through with null body.
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
