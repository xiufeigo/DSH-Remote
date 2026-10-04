#!/usr/bin/env node
/**
 * 结构化源码提取 —— 单一源，被 scripts/test-device-class.mjs 与
 * scratch/t76/extract-selftest.mjs **共同 import**。
 *
 * 为什么要独立成文件：T76 第一版把这套扫描器**抄了两份**（一份在 test-device-class.mjs 里、
 * 一份在 scratch 的自测里），结果自测那份是对的、真正跑的那份漏了 `const openCh = src[open]`
 * ⇒ `test:device` 跑到第 26 条时 `ReferenceError: openCh is not defined` 直接崩。
 * 副本迟早分叉，分叉就是「自测说 PASS、真跑却崩」。**一个实现，两个 import。**
 *
 * ═════════════ 为什么不能按「字符预算」截函数体（这里是 T76 的 5 条假红的全部来源）═════════════
 *
 * 旧写法形如：
 *     HOOK_SOURCE.match(/function armComposerFocus\([\s\S]{0,1400}?\n\t\}/)
 *
 * 它用「最多 1400 个字符」去**猜**函数体在哪结束。函数体一改长（加注释、加分支、换格式化），
 * 上限先被突破，惰性量 `[\s\S]{0,1400}?` 在预算内**永远找不到**收尾的 `\n\t}`
 * ⇒ `match()` 返回 **null** ⇒ 断言里的 `arm = armFn ? armFn[0] : ""` 退化成**空串**
 * ⇒ 所有 `indexOf(...)` 恒为 −1、所有 `/…/.test("")` 恒 false。
 * 于是「函数体被改了」这件事在断言侧表现为「源码里找不到任何东西」，红得毫无信息量。
 *
 * T76 开工时的实测（node scratch/t76/extract-selftest.mjs 现量）：
 *     isPanelTriggerPoint  真实声明 1341 字符  vs 预算  900 ⇒ match 返回 null
 *     armComposerFocus     真实声明 1939 字符  vs 预算 1400 ⇒ match 返回 null
 *     （T66 那两条只是**侥幸**没中：623/700、707/900，余量 77 / 193 字符）
 *
 * 字符预算还是**双向脆**的：往函数体里多写 2 个字符就假红；往里少写 200 个字符就会
 * **悄悄截短**（惰性量在更早的一个 `\n\t}` 上就收手），于是断言在一个「被腰斩的函数体」
 * 上判断——既能假红，也能**假绿**。T66 那条注释记着的负控制事故
 * （「在 if 之后插 `return 0;`，旧断言照样绿」）就是同一类问题的另一个方向。
 *
 * 规则只有一条：**函数 / 语句一律按结构取** ——
 *   1. 声明锚点（正则）只用来**定位开头**，长度不参与判断；
 *   2. 结束位置由**括号配平**求出（scanJsBlock）；
 *   3. 注释、行内字符串、正则字面量、模板串的 `${}` 一律不参与配平计数；
 *   4. 取完再让 **Node 自己解析一遍**（assertParses）—— 截断的、缺半截的代码**解析必然抛**，
 *      于是「提取失败」永远是一条**响亮的红**，而不是那个悄悄变成空串、把 indexOf 变成 −1 的假红。
 *
 * 提取失败一律返回 ""，由调用方 record(..., false, "提取失败：…") 显式报红。
 * 谁想退回 `[\s\S]{0,N}?` 那种写法，请先重跑负控制①（见 scratch/t77/report.md 的
 * 「负控制①」小节，结论：改回字符预算后 T69 那 4 条立刻重新变红）。
 * 同族的「`slice(锚点, 锚点+N)` 硬窗口」也一并禁止，用 jsBlockAfter 取整块。
 */

const JS_BRACE_PAIRS = { "(": ")", "{": "}", "[": "]" };
/** `/` 前面的 token 若是这些，正则字面量才可能出现在这里（否则 `/` 是除号）。 */
const JS_REGEX_LEADING = /^(return|typeof|case|in|of|new|delete|void|instanceof|do|else|yield|await|throw)$/;

/** 跳过一个普通引号字符串（含转义），返回结束引号之后的下标。 */
export function skipJsString(src, i) {
	const quote = src[i];
	i += 1;
	while (i < src.length) {
		if (src[i] === "\\") { i += 2; continue; }
		if (src[i] === quote) return i + 1;
		i += 1;
	}
	return src.length;
}

/** 跳过一个正则字面量（含 `[...]` 字符类与转义），返回末尾 `/` 之后的下标。 */
export function skipJsRegex(src, i) {
	i += 1;
	let inClass = false;
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") { i += 2; continue; }
		if (c === "\n") return i; // 不是正则（保守：按除号处理，交给调用方）
		if (c === "[") inClass = true;
		else if (c === "]") inClass = false;
		else if (c === "/" && !inClass) {
			i += 1;
			while (i < src.length && /[a-z]/.test(src[i])) i += 1; // g / i / m / s / u / y
			return i;
		}
		i += 1;
	}
	return src.length;
}

/**
 * 跳过一个模板串。`${ … }` 内部是**真代码**（可能含花括号、字符串、嵌套模板），
 * 必须递归进去按同一条规则处理，否则 `${ {a:1} }` 这类会把配平数数错。
 * @returns {number} 结束反引号之后的下标
 */
export function skipJsTemplate(src, i) {
	i += 1;
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") { i += 2; continue; }
		if (c === "`") return i + 1;
		if (c === "$" && src[i + 1] === "{") {
			const close = scanJsBlock(src, i + 1); // 配平 ${ … }
			if (close < 0) return src.length;
			i = close + 1;
			continue;
		}
		i += 1;
	}
	return src.length;
}

/**
 * 从 `open`（必须是 `(` / `{` / `[` 之一）起按**括号配平**求配对闭合符下标。
 * 注释 / 字符串 / 正则 / 模板串全部跳过；其它种类的括号整体跳过（它们内部的花括号自配平）。
 * @returns {number} 闭合符下标；未配平返回 -1
 */
export function scanJsBlock(src, open) {
	const openCh = src[open];
	const closeCh = JS_BRACE_PAIRS[openCh];
	if (!closeCh) return -1;
	let depth = 0;
	let prev = ""; // 上一个有意义的 token（判 `/` 是正则还是除号）
	let i = open;
	while (i < src.length) {
		const c = src[i];
		if (c === "/" && src[i + 1] === "/") {
			const e = src.indexOf("\n", i + 2);
			i = e < 0 ? src.length : e + 1;
			continue; // 注释不进 prev
		}
		if (c === "/" && src[i + 1] === "*") {
			const e = src.indexOf("*/", i + 2);
			i = e < 0 ? src.length : e + 2;
			continue; // 注释不进 prev
		}
		if (c === "'" || c === '"') { i = skipJsString(src, i); prev = "str"; continue; }
		if (c === "`") { i = skipJsTemplate(src, i); prev = "str"; continue; }
		if (c === "/") {
			const regexAllowed = prev === "" || /[({[=,:;!?&|+\-*%<>~^]/.test(prev) || JS_REGEX_LEADING.test(prev);
			if (regexAllowed) { i = skipJsRegex(src, i); prev = "str"; continue; }
			i += 1; prev = "/";
			continue;
		}
		if (/[A-Za-z_$]/.test(c)) {
			let j = i + 1;
			while (j < src.length && /[\w$]/.test(src[j])) j += 1;
			prev = src.slice(i, j);
			i = j;
			continue;
		}
		if (/[0-9]/.test(c)) {
			let j = i + 1;
			while (j < src.length && /[\w.]/.test(src[j])) j += 1;
			prev = "num";
			i = j;
			continue;
		}
		if (c === openCh) depth += 1;
		else if (c === closeCh) {
			depth -= 1;
			if (depth === 0) return i;
		} else if (JS_BRACE_PAIRS[c]) {
			// 另一种括号：整体跳过（它内部的花括号自配平，对当前目标无贡献）
			const close = scanJsBlock(src, i);
			if (close < 0) return -1;
			i = close + 1; prev = c;
			continue;
		}
		prev = c;
		i += 1;
	}
	return -1;
}

/**
 * 从 `from` 起找**顶层**（不在任何 `(` / `[` 内）的第一个 `want` 字符下标。
 * 用途：跳过签名里的解构参数 `{a, b}`，找到真正的**函数体**开括号。
 */
export function findTopLevelChar(src, from, want) {
	let depth = 0;
	let prev = "";
	let i = from;
	while (i < src.length) {
		const c = src[i];
		if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i + 2); i = e < 0 ? src.length : e + 1; continue; }
		if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; continue; }
		if (c === "'" || c === '"') { i = skipJsString(src, i); prev = "str"; continue; }
		if (c === "`") { i = skipJsTemplate(src, i); prev = "str"; continue; }
		if (c === "/") {
			const regexAllowed = prev === "" || /[({[=,:;!?&|+\-*%<>~^]/.test(prev) || JS_REGEX_LEADING.test(prev);
			if (regexAllowed) { i = skipJsRegex(src, i); prev = "str"; continue; }
			i += 1; prev = "/";
			continue;
		}
		if (c === "(" || c === "[") { depth += 1; prev = c; i += 1; continue; }
		// depth 不许变负：锚点**可能**已经把签名左半截吃掉了（例如 /function foo\(/），
		// 这时先遇到的是参数表末尾的 `)`，必须夹在 0 上，后面才是函数体那层 `{`。
		if (c === ")" || c === "]") { depth = Math.max(0, depth - 1); prev = c; i += 1; continue; }
		if (depth === 0 && c === want) return i;
		prev = c;
		i += 1;
	}
	return -1;
}

/** 提取结果的「完整性」硬闸：交给 Node 自己解析一遍，截断的代码必然抛。 */
export function assertParses(label, code) {
	if (!code.trim()) throw new Error(`${label}：提取结果为空`);
	try {
		// 包一层函数体，让 `return` / `await` 这些「只能在函数里」的语法合法。
		new Function(`"use strict";return (async function(){${code}\n});`);
	} catch (err) {
		throw new Error(`${label}：提取结果不是完整可解析的代码（${String(err.message || err)}）`);
	}
}

/**
 * 按「声明锚点 + 括号配平」取一个 JS 函数声明/表达式的**完整**源码（含签名与函数体）。
 *
 * @param {string} src    源码
 * @param {RegExp} anchor 只用于**定位**开头，必须能匹配到 `function foo` / `= function (` /
 *                        `= (…) =>` 之类的声明起点；**长度不许参与**（见本文件顶部告警）
 * @param {string} label  报错用的名字
 * @returns {string} 完整声明文本；定位/配平/解析任一失败都返回 ""（调用方必须显式报红）
 */
export function extractDecl(src, anchor, label) {
	const m = anchor.exec(src);
	if (!m) return "";
	const open = findTopLevelChar(src, m.index + m[0].length, "{");
	if (open < 0) return "";
	const close = scanJsBlock(src, open);
	if (close < 0) return "";
	const text = src.slice(m.index, close + 1);
	assertParses(label, text);
	return text;
}

/**
 * 从 `anchorText` 处起，取紧随其后那个 `{ … }` **整块**（花括号配平，含两端）。
 *
 * ═════════════ 为什么不能用「A 之后 N 字内必须有 B」（T77 补的最后一类脆性）═════════════
 *
 * T76 把「正则字符预算」全换成了结构化提取，但**漏了同一族的另一种写法**：硬窗口。
 *     /return false;/.test(armCode.slice(iHeld, iHeld + 200))
 * 它问的是「锚点 A 之后的 200 个字符里有没有 B」。这和 `{0,900}?` 是**同一个病**：
 * 窗口是魔数，中间的注释/格式化一变就跨不过（假红），
 * 或者目标被挪出窗口就悄悄不成立（假绿）。
 *
 * T77 实测当时三处的真实余量（node scratch/t77/measure-windows.mjs）：
 *     L975  isPanelTriggerPoint→return false;   窗口 120 实测距  72 余量 48
 *     L986  armComposerFocus→return false;      窗口 200 实测距 103 余量 97
 *     L989  armComposerFocus→clearFocusSticky   窗口 220 实测距  27 余量 193
 * 第一处余量只有 48 字符 —— 在那个 `if` 里补一句注释就假红，
 * 与 T66 那两条「侥幸没炸」的（77/193）是同一量级的定时炸弹。
 *
 * 本函数把这个问题彻底消灭：**取整块，在整块里逐字找**。块变长变短都不影响判定。
 * 调用方不要再写 `slice(i, i + N)`。
 *
 * @param {string} src       源码（一般传已掩掉注释的副本）
 * @param {string} anchorText 定位锚点，取它**之后**第一个顶层 `{`
 * @param {string} label     报错用的名字
 * @returns {string} 整块文本（含 `{}`）；定位/配平/解析任一失败都返回 ""
 */
export function jsBlockAfter(src, anchorText, label) {
	const at = src.indexOf(anchorText);
	if (at < 0) return "";
	const open = findTopLevelChar(src, at + anchorText.length, "{");
	if (open < 0) return "";
	const close = scanJsBlock(src, open);
	if (close < 0) return "";
	const text = src.slice(open, close + 1);
	assertParses(label, text);
	return text;
}

/**
 * 取一个 `var|let|const X = …;` 语句的**完整**初始化表达式（从声明到配平的 `;`）。
 * 用于 `COMPOSER_TRIGGER_SELECTOR = [ … ].join(',')` 这类**数组**常量 ——
 * 旧写法 `/\[[\s\S]{0,600}?\]\.join\(/` 同样是字符预算，同样会「匹配不到 → 空串」。
 */
export function extractInitializer(src, name, label) {
	const anchor = new RegExp(`(?:var|let|const)\\s+${name}\\s*=`);
	const m = anchor.exec(src);
	if (!m) return "";
	let depth = 0;
	let prev = "";
	let i = m.index + m[0].length;
	while (i < src.length) {
		const c = src[i];
		if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i + 2); i = e < 0 ? src.length : e + 1; continue; }
		if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; continue; }
		if (c === "'" || c === '"') { i = skipJsString(src, i); prev = "str"; continue; }
		if (c === "`") { i = skipJsTemplate(src, i); prev = "str"; continue; }
		if (c === "/") {
			const regexAllowed = prev === "" || /[({[=,:;!?&|+\-*%<>~^]/.test(prev) || JS_REGEX_LEADING.test(prev);
			if (regexAllowed) { i = skipJsRegex(src, i); prev = "str"; continue; }
			i += 1; prev = "/";
			continue;
		}
		if (c === "(" || c === "[" || c === "{") { depth += 1; prev = c; i += 1; continue; }
		if (c === ")" || c === "]" || c === "}") {
			if (depth === 0) return ""; // 没到 `;` 就出括号了 ⇒ 锚点打歪了
			depth -= 1; prev = c; i += 1;
			continue;
		}
		if (c === ";" && depth === 0) {
			const text = src.slice(m.index, i + 1);
			assertParses(label, text);
			return text;
		}
		prev = c;
		i += 1;
	}
	return "";
}

/** Java 里剥掉块注释与行注释，只留代码（供「逐字比对」用，避免注释噪声造成假红）。 */
export function stripJavaComments(t) {
	return t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * Java 的**注释 + 字符串/字符字面量** → 等长空格，**偏移量 1:1 保持不变**。
 *
 * 与 `stripJavaComments` 的区别：那个把注释换成**一个空格**（长度会变），只能用于
 * 「文本里有没有某个记号」；这个保持长度，所以能拿来做**按下标定位**的结构扫描
 * （`javaMethodSpans` / `javaEnclosingMethod`）。等长掩码还有两个附带好处：
 *   ① 字面量里的 `{` `}` `;` 不再参与配平（Javadoc 的 `{@code}`、注入串里的
 *      `"uiState=" + uiState` 都不会再骗到扫描器）；
 *   ② 之后所有 `indexOf` 结果都能直接拿去原文里取片段。
 *
 * 引号本身**保留**（只掩内容）：这样 `""`、`'x'` 的空壳还在，便于识别「这里原来是个字面量」。
 */
export function maskJavaNoise(src) {
	const n = src.length;
	const buf = src.split("");
	const blank = (a, b) => {
		for (let k = Math.max(0, a); k < b && k < n; k++) {
			if (buf[k] !== "\n" && buf[k] !== "\r") buf[k] = " ";
		}
	};
	let i = 0;
	while (i < n) {
		const c = src[i];
		if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); const to = e < 0 ? n : e; blank(i, to); i = to; continue; }
		if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); const to = e < 0 ? n : e + 2; blank(i, to); i = to; continue; }
		if (c === '"' || c === "'") {
			const q = c;
			let j = i + 1;
			while (j < n) {
				if (src[j] === "\\") { j += 2; continue; }
				if (src[j] === q) break;
				if (src[j] === "\n") break; // 未闭合：按行尾收手，别把后面整份源码当字符串吃掉
				j += 1;
			}
			const to = Math.min(j + 1, n);
			blank(i + 1, to - 1);
			i = to;
			continue;
		}
		i += 1;
	}
	return buf.join("");
}

/** Java 关键字 + 会被误判成「方法名」的控制流词。 */
const JAVA_NOT_METHOD = new Set([
	"if", "else", "for", "while", "do", "switch", "case", "default", "try", "catch", "finally",
	"synchronized", "return", "throw", "new", "assert", "yield", "record", "class", "interface",
	"enum", "static", "public", "private", "protected", "final", "abstract", "native", "strictfp",
	"this", "super", "instanceof", "package", "import", "extends", "implements", "throws", "void",
]);

/**
 * 判断 `{`（下标 open）是不是**方法体**，是则返回 `{name, typeStart}`。
 *
 * 只做「往回看」的局部判定，不需要完整 Java 语法：一个方法体的 `{` 往回一定是
 *   … 标识符 `(` 参数表 `)` [throws …] `{`
 * 且参数表那个标识符前面**还有**一层东西（返回类型 / 修饰符 / 构造器名），
 * 而不是 `=`（lambda）、`new`（匿名类）、`.`（调用）、`;`/`{`/`}`（普通块）。
 *
 * 传入的 `src` 必须是 `maskJavaNoise()` 处理过的等长副本，否则注释里的花括号会骗人。
 */
function javaMethodDeclAt(src, open) {
	let j = open - 1;
	while (j >= 0 && /\s/.test(src[j])) j--;
	if (j < 0 || src[j] !== ")") return null;
	// 往回配对参数表的 `(`
	let depth = 0;
	let k = j;
	for (; k >= 0; k--) {
		if (src[k] === ")") depth++;
		else if (src[k] === "(" && --depth === 0) break;
	}
	if (k < 0) return null;
	let e = k - 1;
	while (e >= 0 && /\s/.test(src[e])) e--;
	let b = e;
	while (b >= 0 && /[\w$]/.test(src[b])) b--;
	const name = src.slice(b + 1, e + 1);
	if (!/^[A-Za-z_$][\w$]*$/.test(name) || JAVA_NOT_METHOD.has(name)) return null;
	// 名字前面必须有「返回类型 / 注解 / 修饰符」：往回吃到语句边界，再确认不是 new/. /=
	let m = e;
	while (m >= 0 && /\s/.test(src[m])) m--;
	if (m < 0) return null;
	const ch = src[m];
	if (ch === "." || ch === "=") return null;
	if (!/[\w$>\]@]/.test(ch)) return null;
	// 往回吃「返回类型」时必须把 `[` 也吃进去：`private int[] foo()` 的返回值是**数组**，
	// 只吃 `]` 会在 `[` 上停住 ⇒ typeStart 落在 `]` 上 ⇒ 抽出来的声明是 `] foo() {…}`
	// （javac：非法的类型开始）。T79 第一版就是这么被咬的，夹具的报错行看着像「替身写错了」，
	// 其实是被测源码的**返回类型**被截掉了——又一个「提取器出错伪装成实现出错」。
	let t = m;
	while (t >= 0 && /[\w$>\]\[\s.@<,]/.test(src[t])) t--;
	const head = src.slice(t + 1, m + 1).trim();
	if (/\bnew\s+[\w.$<>\[\]]*$/.test(head)) return null; // 匿名类 `new X() {`
	if (/\b(else|return|case|do|try)\b/.test(head)) return null;
	return { name, typeStart: t + 1 };
}

/**
 * 枚举 Java 源码里**所有方法声明**（含构造器），按出现顺序。
 *
 * 为什么要它：T72 的断言原来写 `javaMethod(src, "private void applyDeviceClassInsets()")`
 * —— 锚点是**整条签名文本**。T78 把 insets 取值抽到 `readSystemBarInsetsPx()` 之后，
 * 「掩码在哪个方法里」这条断言就整个失效（`avoidBody` 里再也找不到那三个 type），
 * 而失配的表现是一条**看似合理的红**（`方法段长=1260 systemBars=false`），
 * 真正的原因（取值被搬走了）在报错文本里完全看不出来。
 *
 * 有了 spans 就可以按**名字**甚至按**可达性**取代码：方法改名/换修饰符/挪位置都不影响。
 *
 * @param {string} src Java 源码（内部会 maskJavaNoise，调用方传原文即可）
 * @returns {Array<{name:string, typeStart:number, open:number, close:number, decl:string, body:string}>}
 */
export function javaMethodSpans(src) {
	const code = maskJavaNoise(src);
	const spans = [];
	const stack = [];
	for (let i = 0; i < code.length; i++) {
		const c = code[i];
		if (c === "{") { stack.push(i); continue; }
		if (c !== "}") continue;
		const open = stack.pop();
		if (open === undefined) continue;
		const decl = javaMethodDeclAt(code, open);
		if (!decl) continue;
		spans.push({
			name: decl.name,
			typeStart: decl.typeStart,
			open,
			close: i,
			decl: code.slice(decl.typeStart, i + 1),
			body: code.slice(open, i + 1),
		});
	}
	return spans.sort((a, b) => a.typeStart - b.typeStart);
}

/**
 * 按下标找**最内层**包含它那个方法。用于「这行写入落在哪个方法里」这类结构性判定
 * —— 不再需要先知道方法叫什么。
 */
export function javaEnclosingMethod(spans, idx) {
	let best = null;
	for (const sp of spans) {
		if (idx > sp.open && idx < sp.close) {
			if (!best || sp.open > best.open) best = sp;
		}
	}
	return best;
}

/**
 * 从 `entryName` 这个方法的**声明**出发，把「它 + 它在本文件里直接/间接调用的方法」
 * 的声明拼成一段代码 —— 也就是这段逻辑**实际会执行到的源码**。
 *
 * 这是 T79 修 T72 三条断言的核心：让位的取值本体在哪个方法里、叫什么名字，
 * 断言都不需要知道；它只需要问「**让位这条链上**，掩码里有没有那三个 type」。
 * 于是 T78 那种「把取值抽出来共用」的重构（正确且更好的方向）不会再把断言打红，
 * 而**真的删掉**掩码里某一型（变异反证①）照旧变红 —— 判别力一点没丢。
 *
 * @param {Array} spans              javaMethodSpans 的结果
 * @param {string} entryName         入口方法名
 * @param {{maxDepth?:number, exclude?:Set<string>|string[], original?:string}} [opts]
 *        maxDepth 默认 4；exclude 用来剔除「替身里已经手写了」的方法（避免重复定义）。
 *        original 传**原文**时，拼出来的是原文片段（注释与字面量都还在）——
 *        javac 夹具必须用这个：掩码副本会把 `Log.i("dshr-inset", …)` 的标签字符串抹成空格，
 *        夹具虽然仍能编译，但「行为验证」跑的是被抹过的代码，语义上与真源码不是同一份。
 *        调用扫描始终用掩码副本（避免注释里的 `foo(` 把无关方法拖进链里）。
 * @returns {{code:string, names:string[]}} 拼好的代码 + 收纳到的全部方法名
 */
export function javaCallChain(spans, entryName, opts = {}) {
	const maxDepth = opts.maxDepth === undefined ? 4 : opts.maxDepth;
	const exclude = new Set(opts.exclude || []);
	const original = opts.original;
	const byName = new Map();
	for (const sp of spans) if (!byName.has(sp.name)) byName.set(sp.name, sp);
	const seen = new Set();
	const out = [];
	const walk = (sp, depth) => {
		if (!sp || depth > maxDepth || seen.has(sp.name) || exclude.has(sp.name)) return;
		seen.add(sp.name);
		out.push(original ? original.slice(sp.typeStart, sp.close + 1) : sp.decl);
		const called = new Set();
		for (const m of sp.decl.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1]);
		// 声明自身的名字也在 matchAll 里（`foo(` 那一处），跳过即可
		for (const name of called) if (name !== sp.name) walk(byName.get(name), depth + 1);
	};
	walk(byName.get(entryName), 0);
	return { code: out.join("\n"), names: [...seen] };
}

/**
 * 取源码里**每一处** `callee(` 的**完整实参块**（含两端括号）。
 * 用途：`getInsets(<掩码>)` 的掩码只能在这一块里判，不能拿整个方法体去 `test()`
 * —— 否则同一个方法里另一个 `getInsets(ime())` 会把「掩码不含 ime」判成假红。
 *
 * @returns {Array<{at:number, args:string}>}
 */
export function javaCallArgs(src, callee) {
	const out = [];
	const re = new RegExp(`\\b${callee.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`, "g");
	let m;
	while ((m = re.exec(src)) !== null) {
		const open = src.indexOf("(", m.index);
		const args = javaBalanced(src, open, "(", `${callee} 的实参`);
		if (args) out.push({ at: m.index, args });
	}
	return out;
}

/**
 * 把 JS 的**注释与字符串字面量**替换成等长空格，**偏移量因此完全保持不变**。
 *
 * 为什么必须：断言若直接对源码 `indexOf('composer.focus()')`，会先命中**注释里**的那一句。
 * 实测（就在本轮）：`armComposerFocus` 的 T69 说明注释里就写着
 * 「下面的 composer.focus() 会把 DOM 焦点从用户点的目标上搬走」，
 * 于是 `indexOf` 给出 422，而真正的调用在 ~1400、早退在 781 ——
 * 顺序断言 `iFocus > iHeld` 就成了**假红**（真代码顺序完全正确）。
 * 这与 T72 里 `maskComments72` 记的是同一类事故（注释里恰好有被断言的字符串），
 * 当年只在那一个块里打了掩码，这次要**所有顺序断言都过掩码**。
 *
 * 等长替换 ⇒ 后面所有下标与原文一一对应，可以直接拿来比较大小。
 */
export function maskJsComments(src) {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/'(?:\\.|[^'\\\n])*'/g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/"(?:\\.|[^"\\\n])*"/g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/`(?:\\.|[^`\\])*`/g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * 取一个 Java 方法的**完整**源码（签名 + 花括号配平的方法体）。
 * 注释里的 `{@code}` 不参与配平（这与脚本里原有的 javaMethod 同一套规则）。
 * 放在共享模块是因为 T41 / T64 / T72 三块都要用 —— 曾经各抄一份，抄串了就是假红/假绿。
 */
export function javaMethod(src, sig) {
	const at = src.indexOf(sig);
	if (at < 0) return "";
	const open = src.indexOf("{", at + sig.length);
	if (open < 0) return "";
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 1; continue; }
		if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); i = e < 0 ? src.length : e; continue; }
		if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return src.slice(at, i + 1);
	}
	return "";
}

/**
 * 只把**注释**替换成等长空格，**字符串字面量原样保留**，偏移量完全不变。
 *
 * ═════════════ 为什么顺序断言要用这个，而不是 maskJsComments（T77 实测踩到）═════════════
 *
 * `maskJsComments` 连**字符串**一起掩掉。它解决的是
 * 「armComposerFocus 的说明注释里就写着 `composer.focus()`，直接 indexOf 会命中注释」
 * 这类问题（那是对的）。但它同时把 `closest('button')` 里的 `'button'` 掩成空格，
 * 于是 `indexOf("closest('button")` 恒为 **−1**，
 * 而断言写的是 `iFallback > iSend` ⇒ 这条**永远为假**。
 * 实测：`fallback=-1`（A/T69「发送排除在兜底分支之前」）。
 * 这是一条 T76 引入掩码时带进来的**潜伏红**，之前被更早的崩溃盖住了。
 *
 * 结论：**顺序/位置断言只需要掩注释，不需要掩字符串** ——
 * 因为被断言的记号（`composer.focus()`、`clearFocusSticky(composer)`、
 * `COMPOSER_TRIGGER_SELECTOR`）都是**代码**而不是字符串字面量；
 * 真正需要按字面量找的（`closest('button`）恰恰必须保留字符串。
 */
export function maskJsCommentsOnly(src) {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * 从 `fromIdx` 起找到第一个 `openCh`（'(' 或 '{'）并按**配平**取到它的闭合符（含两端）。
 *
 * T76：用来替掉「A 之后 N 字内必须有 B」这种**字符预算窗口**断言。窗口是魔数：
 * 中间插一行注释就跨不过（假红），把 B 挪出窗口就悄悄不成立（假绿）。
 * 改成「取整个括号块，在块内逐字比对」就没有窗口可言。
 */
export function javaBalanced(src, fromIdx, openCh, label) {
	if (fromIdx < 0) return "";
	const closeCh = openCh === "(" ? ")" : "}";
	let open = -1;
	for (let i = fromIdx; i < src.length; i++) {
		const c = src[i];
		if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 1; continue; }
		if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); i = e < 0 ? src.length : e; continue; }
		if (c === '"') { let j = i + 1; while (j < src.length && src[j] !== '"') { if (src[j] === "\\") j++; j++; } i = j; continue; }
		if (c === "'") { let j = i + 1; while (j < src.length && src[j] !== "'") { if (src[j] === "\\") j++; j++; } i = j; continue; }
		if (c === openCh) { open = i; break; }
	}
	if (open < 0) return "";
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 1; continue; }
		if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); i = e < 0 ? src.length : e; continue; }
		if (c === '"') { let j = i + 1; while (j < src.length && src[j] !== '"') { if (src[j] === "\\") j++; j++; } i = j; continue; }
		if (c === "'") { let j = i + 1; while (j < src.length && src[j] !== "'") { if (src[j] === "\\") j++; j++; } i = j; continue; }
		if (c === openCh) depth++;
		else if (c === closeCh && --depth === 0) return src.slice(open, i + 1);
	}
	// 没配平：报出来，别悄悄交一个空串（空串会让所有断言假红且看不出原因）
	console.log(`  ----  [extract] ${label}：括号没配平，按提取失败处理`);
	return "";
}
