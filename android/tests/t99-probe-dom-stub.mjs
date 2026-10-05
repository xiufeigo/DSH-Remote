/**
 * 行为臂（文件与臂号沿用 T99 的名字）：把 MainActivity.TABLET_BACK_OVERLAY_PROBE_JS
 * 的**真实字面量**抠出来，在一个极简 DOM 桩上真跑，验证「除左抽屉外还有没有要收的东西」
 * 这个判据的**行为**（T102 起：'none' ⇒ 原生不调桥、会话根退到后台；'overlay' ⇒ 只关它）。
 *
 * 为什么要这一臂：JVM 臂只能验"探针里的字符串长什么样"（T40 §8 M1/M2 的教训：
 * 只断言源码里有某个字符串的钉子不承重）。这里真跑一遍 IIFE，覆盖：
 *   · 右栏 / 模态弹框 / sheet / Explorer 详情 四个分支各自命中与不命中；
 *   · **左抽屉展开但无弹层 ⇒ 'none'**（T99/T102 的核心：平板档返回键不看左抽屉）；
 *   · 异常路径 ⇒ 'error'（原生按非 none 处理 ⇒ 退回既有桥）；
 *   · 只读性：跑完全程，DOM 桩上的写 API 计数必须为 0（不是"字面量里没有 setAttribute"，
 *     而是"真跑一遍一次都没调"）。
 *
 * ⚠️ DOM 桩是**模型**不是浏览器：它证明的是探针的判据逻辑与只读性，
 * 不证明"真页面上这四个标记长这样"——后者由设备侧真机证据（scratch/t102/report.md §3）终审。
 *
 * 用法：node android/tests/t99-probe-dom-stub.mjs <MainActivity.java>
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const mainJavaPath = process.argv[2] || "android/app/src/main/java/top/d1studio/dshremote/MainActivity.java";
const src = readFileSync(mainJavaPath, "utf8");

/** 与 android/tests/T99BackKeyTest.java#stringConcat 同一算法（语句外第一个分号定边界）。 */
function stringConcat(source, name) {
	const at = source.indexOf(name);
	if (at < 0) return "";
	let i = source.indexOf('"', at);
	if (i < 0) return "";
	let out = "";
	let inString = false;
	for (; i < source.length; i++) {
		const c = source[i];
		if (!inString) {
			if (c === '"') inString = true;
			else if (c === ";") break;
			continue;
		}
		if (c === "\\") {
			out += source[i + 1];
			i++;
			continue;
		}
		if (c === '"') {
			inString = false;
			continue;
		}
		out += c;
	}
	return out;
}

const PROBE = stringConcat(src, "TABLET_BACK_OVERLAY_PROBE_JS = ");

let passed = 0;
const failures = [];
function check(cond, what, detail) {
	if (cond) {
		passed++;
		console.log("ok " + what);
	} else {
		failures.push(what + (detail ? " — " + detail : ""));
		console.log("FAIL " + what + (detail ? " — " + detail : ""));
	}
}

// ── 极简 DOM 桩 ─────────────────────────────────────────────────────────
const writeCalls = { setAttribute: 0, removeAttribute: 0, appendChild: 0, dispatchEvent: 0, click: 0, styleSet: 0 };

function node({ rects = 1, attrs = {} } = {}) {
	const n = {
		getClientRects: () => new Array(rects),
		getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
		hasAttribute: (k) => Object.prototype.hasOwnProperty.call(attrs, k),
		setAttribute: () => { writeCalls.setAttribute++; },
		removeAttribute: () => { writeCalls.removeAttribute++; },
		appendChild: () => { writeCalls.appendChild++; },
		dispatchEvent: () => { writeCalls.dispatchEvent++; },
		click: () => { writeCalls.click++; },
		set style(v) { writeCalls.styleSet++; },
	};
	return n;
}

/**
 * @param {{sheet?:any, dialogs?:any[], rightPanel?:any, explorerDetails?:boolean, boom?:boolean}} model
 */
function domeModel(model) {
	const documentElement = node({
		rects: 1,
		attrs: model.explorerDetails ? { "data-dshr-explorer-details": "1" } : {},
	});
	return {
		documentElement,
		querySelector: (sel) => {
			if (model.boom) throw new Error("boom");
			if (sel === "[data-dshr-sheet-panel]") return model.sheet ?? null;
			if (sel === "[data-sidebar-right-panel][data-sidebar-right-open]") return model.rightPanel ?? null;
			return null;
		},
		querySelectorAll: (sel) => {
			if (sel === '[role="dialog"][aria-modal="true"]') return model.dialogs ?? [];
			return [];
		},
	};
}

function run(model) {
	const before = JSON.stringify(writeCalls);
	const value = vm.runInNewContext(PROBE, { document: domeModel(model) }, { timeout: 1000 });
	return { value, wrote: JSON.stringify(writeCalls) !== before };
}

console.log("== T99 probe DOM-stub： " + mainJavaPath);
check(PROBE.length > 200, "探针字面量抠出（len=" + PROBE.length + "）");
check(PROBE.startsWith("(function(){try{") && PROBE.endsWith("}})()"), "探针是自吞异常的 IIFE");

const rightPanelOpen = () => node({ rects: 1, attrs: { "data-sidebar-right-open": "", "aria-hidden": "false" } });
const rightPanelHidden = () => node({ rects: 1, attrs: { "data-sidebar-right-open": "", "aria-hidden": "true" } });

// ── 右栏 ────────────────────────────────────────────────────────────────
{
	const r = run({ rightPanel: rightPanelOpen() });
	check(r.value === "overlay", "右栏展开 ⇒ 'overlay'（返回键仍先收右栏，T43/T47 语义）", String(r.value));
	check(!r.wrote, "右栏展开这一路：探针零写操作");
}
{
	const r = run({ rightPanel: rightPanelHidden() });
	check(r.value === "none", "右栏 aria-hidden=true（未真开）⇒ 'none'（与 hook isRightbarOpen 同口径）", String(r.value));
}
{
	const r = run({ rightPanel: null });
	check(r.value === "none", "右栏节点不存在 ⇒ 'none'", String(r.value));
}

// ── 模态弹框 ────────────────────────────────────────────────────────────
{
	const r = run({ dialogs: [node({ rects: 1 })] });
	check(r.value === "overlay", "可见模态弹框 ⇒ 'overlay'（桥的第 3 分支语义保住）", String(r.value));
}
{
	const r = run({ dialogs: [node({ rects: 0 }), node({ rects: 0 })] });
	check(r.value === "none", "全部弹框不可见 ⇒ 'none'（可见性闸真的在起作用）", String(r.value));
}
{
	const r = run({ dialogs: [node({ rects: 0 }), node({ rects: 2 })] });
	check(r.value === "overlay", "第 2 个弹框可见 ⇒ 'overlay'（不是只看第一个）", String(r.value));
}

// ── sheet / Explorer ────────────────────────────────────────────────────
{
	const r = run({ sheet: node({ rects: 1 }) });
	check(r.value === "overlay", "sheet 面板可见 ⇒ 'overlay'（桥的第 1 分支语义保住）", String(r.value));
}
{
	const r = run({ sheet: node({ rects: 0 }) });
	check(r.value === "none", "sheet 面板不可见 ⇒ 'none'", String(r.value));
}
{
	const r = run({ explorerDetails: true });
	check(r.value === "overlay", "Explorer 详情展开 ⇒ 'overlay'（桥的第 2 分支语义保住）", String(r.value));
}

// ── T99 核心：左抽屉展开但无弹层 ⇒ 'none'（原生据此直接进设置页，不调桥） ──
{
	// 桩里刻意**不提供**任何左抽屉节点/属性：探针连查都不查（JVM 臂已逐字钉住这一点）。
	const r = run({});
	check(r.value === "none", "★ 无任何弹层（哪怕左抽屉是展开的）⇒ 'none' ⇒ 平板档返回键不调桥，会话根退到后台", String(r.value));
	check(!r.wrote, "★ 这一路探针零写操作（左抽屉不可能被这行代码动到）");
}
{
	const r = run({ rightPanel: rightPanelOpen(), dialogs: [node({ rects: 1 })] });
	check(r.value === "overlay", "右栏 + 弹框同时在场 ⇒ 'overlay'（只要有东西要收就走桥）", String(r.value));
}

// ── 异常路径 ────────────────────────────────────────────────────────────
{
	const r = run({ boom: true });
	check(r.value === "error", "探针抛异常 ⇒ 'error'（原生按非 none ⇒ 退回既有桥，fail-safe）", String(r.value));
	check(!r.wrote, "抛异常这一路也没有写操作残留");
}

// ── 全程只读 ────────────────────────────────────────────────────────────
check(
	writeCalls.setAttribute === 0 && writeCalls.removeAttribute === 0 && writeCalls.appendChild === 0 &&
	writeCalls.dispatchEvent === 0 && writeCalls.click === 0 && writeCalls.styleSet === 0,
	"全部 11 个场景跑完：DOM 写/事件/点击计数全为 0（行为级只读证明）",
	JSON.stringify(writeCalls),
);

console.log("\nT99 probe DOM-stub: " + passed + " passed, " + failures.length + " failed");
if (failures.length) {
	for (const f of failures) console.log("  - " + f);
	process.exit(1);
}
