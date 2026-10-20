// Minimal JSON calls for first-party views, through the backend seam
// (lib/backend) like everything else.

import { backend } from "@/lib/backend";

export async function getJson<T>(path: string): Promise<T> {
  return backend.request<T>(path);
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  return backend.request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
