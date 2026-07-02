export interface SignedUploadTarget {
  url: string;
  path: string;
  token: string;
}

export async function putSignedUpload(
  upload: SignedUploadTarget,
  file: File,
  fallbackContentType: string
): Promise<void> {
  const res = await fetch(upload.url, {
    method: "PUT",
    headers: { "Content-Type": file.type || fallbackContentType },
    body: file,
  });

  if (!res.ok) {
    throw new Error(`upload_failed:${res.status}:${upload.path}`);
  }
}

export async function sha256File(file: File): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
