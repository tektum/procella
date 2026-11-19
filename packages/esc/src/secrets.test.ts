import { describe, expect, test } from "bun:test";
import { crc32 } from "node:zlib";
import { decryptEscSecret, deriveEscSecretKey, encryptEscSecret } from "./secrets.js";

const KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
// Same vector as esc-eval/cmd/lambda/secrets_test.go, which decrypts it in Go.
const GO_VECTOR = "ZXNjeAAAAAEBDkSFQcFpJC0KX6bjgxjuUgxirqDwt6Gpg8TYE81gtMjHbdaBpdzI";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("ESC secret ciphertexts", () => {
	test("round-trips and decrypts the vector shared with the Go evaluator", () => {
		expect(
			decryptEscSecret(KEY, "tenant-a", encryptEscSecret(KEY, "tenant-a", utf8("x"))).toString(),
		).toBe("x");
		expect(decryptEscSecret(KEY, "tenant-a", GO_VECTOR).toString()).toBe("hunter2");
	});

	test("uses the pulumi/esc envelope: escx, version 1, crc32 of the preceding bytes", () => {
		const bin = Buffer.from(encryptEscSecret(KEY, "tenant-a", utf8("value")), "base64");
		expect(bin.subarray(0, 4).toString("ascii")).toBe("escx");
		expect(bin.readUInt32BE(4)).toBe(1);
		expect(bin.readUInt32BE(bin.length - 4)).toBe(crc32(bin.subarray(0, bin.length - 4)) >>> 0);
		// inner: version byte + 12-byte nonce + ciphertext (5) + 16-byte tag
		expect(bin.length - 12).toBe(1 + 12 + 5 + 16);
	});

	test("uses a fresh nonce for every encryption", () => {
		expect(encryptEscSecret(KEY, "t", utf8("same"))).not.toBe(
			encryptEscSecret(KEY, "t", utf8("same")),
		);
	});

	test("keys are separated by tenant", () => {
		expect(deriveEscSecretKey(KEY, "tenant-a").equals(deriveEscSecretKey(KEY, "tenant-b"))).toBe(
			false,
		);
		expect(() => decryptEscSecret(KEY, "tenant-b", GO_VECTOR)).toThrow();
	});

	test("rejects tampered or truncated envelopes", () => {
		const bin = Buffer.from(GO_VECTOR, "base64");
		const flipped = Buffer.from(bin);
		flipped[20] ^= 1;
		expect(() => decryptEscSecret(KEY, "tenant-a", flipped.toString("base64"))).toThrow("checksum");
		expect(() => decryptEscSecret(KEY, "tenant-a", bin.subarray(0, 10).toString("base64"))).toThrow(
			"too short",
		);
		const badMagic = Buffer.from(bin);
		badMagic.write("nope", 0, "ascii");
		expect(() => decryptEscSecret(KEY, "tenant-a", badMagic.toString("base64"))).toThrow("header");
	});
});
