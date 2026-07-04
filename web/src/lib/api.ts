// Minimal same-origin JSON fetch for first-party views. Mirrors the local `api`
// helper in App.tsx (which isn't exported) so new screens share one convention.

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string })?.error || `${res.status} ${res.statusText}`);
  return data as T;
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string })?.error || `${res.status} ${res.statusText}`);
  return data as T;
}
