/**
 * Generate an RFC 4122 v4 UUID that also works in non-secure browsing contexts.
 *
 * `crypto.randomUUID()` is only exposed in a *secure context* — HTTPS or
 * `http://localhost`. When the app is served over plain HTTP from a non-localhost
 * origin (e.g. a LAN IP such as `http://10.10.100.29`), `crypto.randomUUID` is
 * `undefined`, and calling it throws
 * `TypeError: crypto.randomUUID is not a function`.
 *
 * `crypto.getRandomValues()` is available in insecure contexts too, so we fall
 * back to deriving the UUID from it — keeping cryptographically strong randomness
 * without requiring HTTPS.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID#secure_context
 */
export function randomUUID(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;

  // Secure context (https / localhost): use the native implementation.
  if (typeof cryptoObj?.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }

  // Insecure context (plain http on a non-localhost host): getRandomValues is
  // still available — derive an RFC 4122 v4 UUID from 16 random bytes.
  if (typeof cryptoObj?.getRandomValues === "function") {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Last resort (no Web Crypto at all — practically never in a browser): a
  // non-cryptographic v4 UUID. These ids are used as chat/stream keys, which do
  // not require crypto-grade randomness, so this is an acceptable degradation
  // over throwing.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
