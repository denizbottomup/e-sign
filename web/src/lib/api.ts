const BASE_URL = "/api";

async function getHeaders(): Promise<HeadersInit> {
  return { "Content-Type": "application/json" };
}

export async function apiFetch<T = unknown>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const headers = await getHeaders();
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers: { ...headers, ...(options?.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error: ${res.status}`);
  }
  return res.json();
}

export function apiGet<T = unknown>(endpoint: string): Promise<T> {
  return apiFetch<T>(endpoint);
}

export function apiPost<T = unknown>(endpoint: string, body?: unknown): Promise<T> {
  return apiFetch<T>(endpoint, {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
  });
}

export function apiDelete<T = unknown>(endpoint: string): Promise<T> {
  return apiFetch<T>(endpoint, { method: "DELETE" });
}

export { getHeaders };

export const swrFetcher = <T = unknown>(url: string): Promise<T> =>
  apiGet<T>(url);
