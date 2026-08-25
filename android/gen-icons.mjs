/**
 * 生成 Android 启动图标：直接复用网关的 iconPng（同一套品牌视觉），
 * 输出到 android/app/src/main/res/mipmap-<dpi>/ic_launcher.png。
 * 用法：node android/gen-icons.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { iconPng } from "../packages/gateway/src/pwa.ts";

const DPI_SIZES = [
	["mdpi", 48],
	["hdpi", 72],
	["xhdpi", 96],
	["xxhdpi", 144],
	["xxxhdpi", 192],
];

for (const [dpi, size] of DPI_SIZES) {
	const dir = new URL(`./app/src/main/res/mipmap-${dpi}/`, import.meta.url);
	mkdirSync(dir, { recursive: true });
	writeFileSync(new URL("ic_launcher.png", dir), iconPng(size));
	console.log(`mipmap-${dpi}/ic_launcher.png (${size}x${size})`);
}
