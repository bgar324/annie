import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { canonicalJson } from "../core/json.js";

export interface SealedValue {
  keyVersion: number;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

export class CredentialVault {
  readonly #key: Buffer;
  readonly #linkSigningKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) {
      throw new Error("The credential vault master key must contain exactly 32 bytes");
    }
    this.#key = Buffer.from(masterKey);
    this.#linkSigningKey = Buffer.from(
      hkdfSync("sha256", masterKey, "imessage-assistant", "connect-link-signing-v1", 32),
    );
  }

  seal(purpose: string, identity: string, generation: number, value: unknown): SealedValue {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(aad(purpose, identity, generation));
    const ciphertext = Buffer.concat([cipher.update(canonicalJson(value), "utf8"), cipher.final()]);
    return {
      keyVersion: 1,
      nonce,
      ciphertext,
      authTag: cipher.getAuthTag(),
    };
  }

  open<T>(
    purpose: string,
    identity: string,
    generation: number,
    sealed: SealedValue,
  ): T {
    if (sealed.keyVersion !== 1 || sealed.nonce.length !== 12 || sealed.authTag.length !== 16) {
      throw new Error("Unsupported or malformed credential envelope");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.#key, sealed.nonce);
    decipher.setAAD(aad(purpose, identity, generation));
    decipher.setAuthTag(sealed.authTag);
    const plaintext = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString(
      "utf8",
    );
    return JSON.parse(plaintext) as T;
  }

  linkSigningKey(): Buffer {
    return Buffer.from(this.#linkSigningKey);
  }

}

function aad(purpose: string, identity: string, generation: number): Buffer {
  if (purpose.length === 0 || identity.length === 0 || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Invalid credential envelope context");
  }
  return Buffer.from(`imessage-assistant:${purpose}:v1:${identity}:${generation}`, "utf8");
}
