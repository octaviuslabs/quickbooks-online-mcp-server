import crypto from "node:crypto";
import zlib from "node:zlib";

/**
 * Stateless sealed tokens for the HTTP OAuth proxy.
 *
 * Every piece of OAuth state the proxy would normally keep in a database
 * (registered clients, authorization codes, access/refresh tokens) is instead
 * serialized to JSON, deflate-compressed, and sealed with AES-256-GCM. The
 * resulting opaque string is handed to the MCP client, which presents it back
 * on later requests. Any server replica holding the same key can unseal it,
 * so the HTTP server needs no session store at all.
 *
 * Each token is bound to a `purpose` (client / state / code / access /
 * refresh) via GCM additional authenticated data, so a blob issued as one
 * kind of token can never be replayed as another.
 */

const TOKEN_VERSION = "v1";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export type TokenPurpose = "client" | "state" | "code" | "access" | "refresh";

export class TokenSealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenSealError";
  }
}

/**
 * Seal a JSON-serializable payload into an opaque, tamper-proof token.
 */
export function seal(payload: object, key: Buffer, purpose: TokenPurpose): string {
  const plaintext = zlib.deflateRawSync(Buffer.from(JSON.stringify(payload), "utf-8"));
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${TOKEN_VERSION}:${purpose}`, "utf-8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${TOKEN_VERSION}.${Buffer.concat([iv, tag, ciphertext]).toString("base64url")}`;
}

/**
 * Unseal a token produced by {@link seal}. Throws {@link TokenSealError} on
 * any failure (wrong key, wrong purpose, tampering, malformed input).
 */
export function unseal<T>(token: string, key: Buffer, purpose: TokenPurpose): T {
  const dot = token.indexOf(".");
  if (dot === -1 || token.slice(0, dot) !== TOKEN_VERSION) {
    throw new TokenSealError("Unrecognized token format");
  }
  const raw = Buffer.from(token.slice(dot + 1), "base64url");
  if (raw.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new TokenSealError("Token is too short");
  }
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(`${TOKEN_VERSION}:${purpose}`, "utf-8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(zlib.inflateRawSync(plaintext).toString("utf-8")) as T;
  } catch {
    throw new TokenSealError("Token failed authentication or decoding");
  }
}

/**
 * Resolve the 32-byte encryption key for sealed tokens.
 *
 * Prefers an explicit key (MCP_TOKEN_ENCRYPTION_KEY, hex or base64 encoded
 * 32 bytes). When absent, derives a deterministic key from the Intuit client
 * secret so that all replicas configured with the same QuickBooks app share
 * a key without extra configuration.
 */
export function resolveTokenEncryptionKey(explicitKey: string | undefined, clientSecret: string): Buffer {
  if (explicitKey) {
    const key = /^[0-9a-fA-F]{64}$/.test(explicitKey) ? Buffer.from(explicitKey, "hex") : Buffer.from(explicitKey, "base64");
    if (key.length !== 32) {
      throw new TokenSealError("MCP_TOKEN_ENCRYPTION_KEY must be 32 bytes, hex or base64 encoded");
    }
    return key;
  }
  return crypto.scryptSync(clientSecret, "qbo-mcp-token-key-v1", 32);
}
