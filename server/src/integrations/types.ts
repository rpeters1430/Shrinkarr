export interface MediaServerClient {
  notifyLibraryChanged(): Promise<void>;
  testConnection?(): Promise<{ ok: boolean; message: string }>;
  getActiveStreamCount?(): Promise<number>;
}

export function normalizeIntegrationUrl(rawUrl: string): string {
  let url = (rawUrl || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  return url.replace(/\/+$/, "");
}

