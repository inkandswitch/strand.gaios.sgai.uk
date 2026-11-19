// Bytes the way git sees them: a file's content as a blob, and the blob's
// SHA-1, so strand's files can be compared with a git tree without
// downloading it.

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export type FileContent = string | Uint8Array;

export function toBytes(content: FileContent): Uint8Array {
  return typeof content === "string" ? encoder.encode(content) : content;
}

// The text in `bytes`, or null when they aren't UTF-8 (or hold a NUL, which
// is how git itself guesses a file is binary).
export function asText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return null;
  }
}

// The id git gives a blob with this content.
export async function blobSha(content: FileContent): Promise<string> {
  const body = toBytes(content);
  const header = encoder.encode(`blob ${body.length}\0`);
  const all = new Uint8Array(header.length + body.length);
  all.set(header);
  all.set(body, header.length);
  const digest = await crypto.subtle.digest("SHA-1", all);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
