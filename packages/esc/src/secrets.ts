// ESC secret ciphertexts (`fn::secret: { ciphertext: ... }`).
//
// `POST .../encrypt-secrets` returns ciphertexts the Pulumi CLI writes into a managed stack's
// environment definition; the Go evaluator (esc-eval) decrypts them when the environment is opened.
// Keep this format in sync with esc-eval/cmd/lambda/secrets.go.
//
// Key:      HKDF-SHA256(ikm = master key, salt = "procella-esc-secrets",
//                       info = "procella-esc-secret-v1:" + tenantId, 32 bytes)
// Inner:    0x01 || nonce(12) || AES-256-GCM ciphertext || tag(16)
// Envelope: "escx" || uint32be(1) || inner || uint32be(crc32-IEEE of all preceding bytes),
//           base64-encoded — the envelope github.com/pulumi/esc/eval decodes before Decrypt.
//
// Keys are per tenant, matching Procella's tenant-wide ESC access model: anyone who can open an
// environment in the tenant can already read its values.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";

const HKDF_SALT = "procella-esc-secrets";
const HKDF_INFO_PREFIX = "procella-esc-secret-v1:";
const INNER_VERSION = 0x01;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const ENVELOPE_MAGIC = "escx";
const ENVELOPE_VERSION = 1;

/** Upper bound on one plaintext, so a single request cannot ask for huge allocations. */
export const MAX_ESC_SECRET_PLAINTEXT_BYTES = 64 * 1024;

export function deriveEscSecretKey(masterKeyHex: string, tenantId: string): Buffer {
	return Buffer.from(
		hkdfSync(
			"sha256",
			Buffer.from(masterKeyHex, "hex"),
			HKDF_SALT,
			`${HKDF_INFO_PREFIX}${tenantId}`,
			32,
		),
	);
}

/** Encrypts one secret and returns the base64 envelope to place under `ciphertext:`. */
export function encryptEscSecret(
	masterKeyHex: string,
	tenantId: string,
	plaintext: Uint8Array,
): string {
	const key = deriveEscSecretKey(masterKeyHex, tenantId);
	const nonce = randomBytes(NONCE_LENGTH);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
	const inner = Buffer.concat([Buffer.from([INNER_VERSION]), nonce, sealed]);

	const header = Buffer.alloc(8);
	header.write(ENVELOPE_MAGIC, 0, "ascii");
	header.writeUInt32BE(ENVELOPE_VERSION, 4);
	const body = Buffer.concat([header, inner]);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(body) >>> 0, 0);
	return Buffer.concat([body, checksum]).toString("base64");
}

/** Decrypts an envelope produced by {@link encryptEscSecret}. Used by tests and tooling. */
export function decryptEscSecret(masterKeyHex: string, tenantId: string, envelope: string): Buffer {
	const bin = Buffer.from(envelope, "base64");
	if (bin.length < 8 + 1 + NONCE_LENGTH + TAG_LENGTH + 4) {
		throw new Error("invalid ciphertext: too short");
	}
	if (bin.subarray(0, 4).toString("ascii") !== ENVELOPE_MAGIC) {
		throw new Error("invalid ciphertext: bad header");
	}
	if (crc32(bin.subarray(0, bin.length - 4)) >>> 0 !== bin.readUInt32BE(bin.length - 4)) {
		throw new Error("invalid ciphertext: bad checksum");
	}
	if (bin.readUInt32BE(4) !== ENVELOPE_VERSION) {
		throw new Error("invalid ciphertext: unsupported envelope version");
	}
	const inner = bin.subarray(8, bin.length - 4);
	if (inner[0] !== INNER_VERSION) {
		throw new Error("invalid ciphertext: unsupported version");
	}
	const nonce = inner.subarray(1, 1 + NONCE_LENGTH);
	const sealed = inner.subarray(1 + NONCE_LENGTH);
	const decipher = createDecipheriv(
		"aes-256-gcm",
		deriveEscSecretKey(masterKeyHex, tenantId),
		nonce,
	);
	decipher.setAuthTag(sealed.subarray(sealed.length - TAG_LENGTH));
	return Buffer.concat([
		decipher.update(sealed.subarray(0, sealed.length - TAG_LENGTH)),
		decipher.final(),
	]);
}
