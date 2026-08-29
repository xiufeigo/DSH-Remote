/**
 * 网关自签 TLS 证书：首次启动生成，持久化到 <home>/certs/。
 *
 * 手机浏览器访问自签证书会有告警（可手动信任）；自研壳 App 走证书锁定，
 * 配对二维码携带 SHA-256 指纹，App 校验后无感信任。
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import selfsigned from "selfsigned";

export interface GatewayCert {
	keyPem: string;
	certPem: string;
	fingerprintSha256: string;
}

/**
 * PEM 证书 → SHA-256 指纹（大写 hex，与 GatewayCert.fingerprintSha256 同一口径）。
 * CLI-06：网关与测试脚本（scripts/test-harness.mjs）共用此单一实现，不再各自复刻正则。
 */
export function fingerprintOf(certPem: string): string {
	const der = Buffer.from(
		certPem
			.split(/-----[^-]+-----/)
			.join("")
			.replace(/\s+/g, ""),
		"base64",
	);
	return createHash("sha256").update(der).digest("hex").toUpperCase();
}

export async function ensureCert(certsDir: string): Promise<GatewayCert> {
	const keyPath = join(certsDir, "gateway.key");
	const certPath = join(certsDir, "gateway.crt");
	try {
		const [keyPem, certPem] = await Promise.all([readFile(keyPath, "utf8"), readFile(certPath, "utf8")]);
		return { keyPem, certPem, fingerprintSha256: fingerprintOf(certPem) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const pems = selfsigned.generate(
		[{ name: "commonName", value: "dsh-remote" }],
		{
			days: 3650,
			keySize: 2048,
			algorithm: "sha256",
			extensions: [
				{
					name: "subjectAltName",
					altNames: [
						{ type: 2, value: "localhost" }, // DNS
						{ type: 7, ip: "127.0.0.1" },
						{ type: 2, value: "dsh.remote" },
					],
				},
				{ name: "keyUsage", keyCertSign: true, digitalSignature: true },
				{
					name: "extKeyUsage",
					serverAuth: true,
				},
			],
		},
	);

	await writeFile(keyPath, pems.private, { encoding: "utf8", mode: 0o600 });
	await writeFile(certPath, pems.cert, "utf8");
	return { keyPem: pems.private, certPem: pems.cert, fingerprintSha256: fingerprintOf(pems.cert) };
}

/** 加载手工提供的 PEM 证书（config.tls.certPath/keyPath），指纹口径与自签一致。 */
export async function loadManualCert(certPath: string, keyPath: string): Promise<GatewayCert> {
	const [certPem, keyPem] = await Promise.all([readFile(certPath, "utf8"), readFile(keyPath, "utf8")]);
	return { certPem, keyPem, fingerprintSha256: fingerprintOf(certPem) };
}
