const encoder = new TextEncoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function randomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64(bytes)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export async function sha256Hex(value: string | ArrayBuffer): Promise<string> {
  const input = typeof value === 'string' ? encoder.encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hmacSha256Base64(secret: string, value: string | ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const input = typeof value === 'string' ? encoder.encode(value) : value;
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign('HMAC', key, input)));
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export function timingSafeBase64Equal(left: string, right: string): boolean {
  const a = base64ToBytes(left);
  const b = base64ToBytes(right);
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  return (crypto.subtle as SubtleCrypto & {
    timingSafeEqual(first: ArrayBufferView, second: ArrayBufferView): boolean;
  }).timingSafeEqual(a, b);
}

export function timingSafeStringEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.byteLength !== b.byteLength) return false;
  return (crypto.subtle as SubtleCrypto & {
    timingSafeEqual(first: ArrayBufferView, second: ArrayBufferView): boolean;
  }).timingSafeEqual(a, b);
}

export function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(header.split(';').flatMap((part) => {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName) return [];
    try {
      return [[decodeURIComponent(rawName), decodeURIComponent(rawValue.join('='))]];
    } catch {
      return [];
    }
  }));
}
