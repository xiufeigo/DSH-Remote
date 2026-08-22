window.__ModuleLoader__.load({ id: "dsh-remote-plugin", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
//#region src/client/index.tsx
/**
* DSH-Remote —— 浏览器半边：设置 → 插件 里的配置卡片。
*
* 与 dsh-explorer 同一套接入方式：slots.inject("settings.plugin.item") 注册卡片；
* 数据不走 localStorage（那些值必须落在 PC 的 config.json），而是通过插件宿主
* 半边注册在 DSH webServer 上的 /dsh-remote/config 路由读写，保存后宿主会
* 自动重启网关子进程生效。
*/
async function fetchJson(path, init) {
	return await (await fetch(path, {
		...init,
		headers: {
			"content-type": "application/json",
			...init?.headers ?? {}
		}
	})).json();
}
const styles = {
	card: { listStyle: "none" },
	head: {
		display: "flex",
		alignItems: "center",
		gap: 12,
		width: "100%",
		background: "transparent",
		border: "none",
		cursor: "pointer",
		padding: "12px 4px",
		textAlign: "left",
		color: "inherit"
	},
	name: {
		fontWeight: 600,
		fontSize: 14
	},
	desc: {
		fontSize: 12,
		opacity: .65,
		marginTop: 2
	},
	chevron: (open) => ({
		marginLeft: "auto",
		transition: "transform .15s",
		transform: open ? "rotate(90deg)" : "rotate(0deg)",
		fontSize: 12,
		opacity: .6
	}),
	body: {
		padding: "4px 8px 16px",
		borderTop: "1px solid rgba(128,128,128,.25)"
	},
	sectionTitle: {
		fontSize: 12,
		fontWeight: 700,
		opacity: .7,
		margin: "14px 0 6px"
	},
	field: {
		display: "flex",
		alignItems: "center",
		gap: 10,
		margin: "8px 0"
	},
	label: {
		minWidth: 110,
		fontSize: 13
	},
	hint: {
		fontSize: 11,
		opacity: .55
	},
	input: {
		flex: 1,
		maxWidth: 220,
		padding: "5px 8px",
		borderRadius: 6,
		border: "1px solid rgba(128,128,128,.4)",
		background: "rgba(127,127,127,.08)",
		color: "inherit",
		fontSize: 13
	},
	row: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		margin: "10px 0"
	},
	statusDot: (ok) => ({
		display: "inline-block",
		width: 8,
		height: 8,
		borderRadius: 4,
		marginRight: 6,
		background: ok ? "#22c55e" : "#9ca3af"
	}),
	button: (primary) => ({
		padding: "6px 14px",
		borderRadius: 8,
		cursor: "pointer",
		fontSize: 13,
		border: primary ? "none" : "1px solid rgba(128,128,128,.45)",
		background: primary ? "#1b66ff" : "rgba(127,127,127,.15)",
		color: primary ? "#fff" : "inherit"
	}),
	codeBox: {
		marginTop: 8,
		padding: 10,
		borderRadius: 8,
		fontSize: 13,
		background: "rgba(27,102,255,.1)",
		border: "1px solid rgba(27,102,255,.35)"
	},
	error: {
		color: "#ef4444",
		fontSize: 12,
		marginTop: 6
	}
};
function Toggle({ checked, onChange }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
		type: "button",
		role: "switch",
		"aria-checked": checked,
		onClick: () => {
			onChange(!checked);
		},
		style: {
			width: 40,
			height: 22,
			borderRadius: 11,
			position: "relative",
			cursor: "pointer",
			border: "none",
			background: checked ? "#1b66ff" : "rgba(127,127,127,.4)",
			transition: "background .15s"
		},
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
			position: "absolute",
			top: 3,
			left: checked ? 21 : 3,
			width: 16,
			height: 16,
			borderRadius: 8,
			background: "#fff",
			transition: "left .15s"
		} })
	});
}
function NumberField({ label, value, onChange, hint }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: styles.field,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: styles.label,
				children: label
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
				style: styles.input,
				type: "number",
				value: Number.isFinite(value) ? value : "",
				onChange: (event) => {
					onChange(Number(event.target.value));
				}
			}),
			hint !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: styles.hint,
				children: hint
			}) : null
		]
	});
}
/** 设置 → 插件 页的 DSH Remote 卡片。 */
function DshRemoteSettingsCard() {
	const [open, setOpen] = (0, react.useState)(false);
	const [form, setForm] = (0, react.useState)(null);
	const [status, setStatus] = (0, react.useState)(null);
	const [saving, setSaving] = (0, react.useState)(false);
	const [message, setMessage] = (0, react.useState)(null);
	const [pairing, setPairing] = (0, react.useState)(null);
	const refreshStatus = (0, react.useCallback)(() => {
		fetchJson("/dsh-remote/status").then(setStatus).catch(() => setStatus(null));
	}, []);
	(0, react.useEffect)(() => {
		fetchJson("/dsh-remote/config").then((payload) => {
			const merged = {
				autoStart: true,
				listenHost: "127.0.0.1",
				listenPort: 18443,
				upstreamPort: 52392,
				autoFixUpstreamPort: true,
				frp: {
					enabled: false,
					serverAddr: "",
					serverPort: 7e3,
					remotePort: 8443
				},
				...payload.config,
				frp: {
					enabled: false,
					serverAddr: "",
					serverPort: 7e3,
					remotePort: 8443,
					...payload.config?.frp
				}
			};
			setForm(merged);
		}).catch(() => setMessage({
			kind: "err",
			text: "读取配置失败（插件路由不可达）"
		}));
		refreshStatus();
	}, [refreshStatus]);
	(0, react.useEffect)(() => {
		if (!open) return void 0;
		const timer = setInterval(refreshStatus, 5e3);
		return () => {
			clearInterval(timer);
		};
	}, [open, refreshStatus]);
	const patchForm = (patch) => {
		setForm((current) => ({
			...current,
			...patch
		}));
	};
	const save = async () => {
		setSaving(true);
		setMessage(null);
		try {
			const payload = {
				autoStart: form.autoStart,
				listenHost: form.listenHost,
				listenPort: form.listenPort,
				upstreamPort: form.upstreamPort,
				autoFixUpstreamPort: form.autoFixUpstreamPort,
				frp: {
					enabled: form.frp.enabled,
					serverAddr: String(form.frp.serverAddr ?? "").trim(),
					serverPort: form.frp.serverPort,
					remotePort: form.frp.remotePort
				}
			};
			const result = await fetchJson("/dsh-remote/config", {
				method: "POST",
				body: JSON.stringify(payload)
			});
			if (result.ok === true) {
				setMessage({
					kind: "ok",
					text: "已保存并重启网关（几秒后生效）"
				});
				setTimeout(refreshStatus, 2500);
			} else setMessage({
				kind: "err",
				text: Array.isArray(result.errors) ? result.errors.join("；") : "保存失败"
			});
		} catch (error) {
			setMessage({
				kind: "err",
				text: `保存失败：${String(error)}`
			});
		} finally {
			setSaving(false);
		}
	};
	const mintPairCode = async () => {
		setMessage(null);
		try {
			const result = await fetchJson("/dsh-remote/pair-code", { method: "POST" });
			if (result.ok === true) setPairing({
				code: result.code,
				expiresAt: result.expiresAt
			});
			else setMessage({
				kind: "err",
				text: result.error ?? "生成失败"
			});
		} catch (error) {
			setMessage({
				kind: "err",
				text: `生成失败：${String(error)}`
			});
		}
	};
	const restartGateway = async () => {
		setMessage(null);
		try {
			await fetchJson("/dsh-remote/restart", { method: "POST" });
			setMessage({
				kind: "ok",
				text: "重启指令已发出"
			});
			setTimeout(refreshStatus, 3e3);
		} catch (error) {
			setMessage({
				kind: "err",
				text: `重启失败：${String(error)}`
			});
		}
	};
	const gatewayRunning = status?.gatewayRunning === true;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
		style: styles.card,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
			type: "button",
			style: styles.head,
			"aria-expanded": open,
			onClick: () => {
				setOpen((v) => !v);
			},
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: styles.name,
				children: "DSH Remote"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles.desc,
				children: ["手机远程访问本机 DSH：设备配对、frp 隧道、局域网模式。", status !== void 0 && status !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					style: { marginLeft: 8 },
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: styles.statusDot(gatewayRunning) }), gatewayRunning ? `运行中 · ${String(status.deviceCount ?? "?")} 台设备` : "网关未运行"]
				}) : null]
			})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: styles.chevron(open),
				children: "▶"
			})]
		}), open && form !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: styles.body,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: styles.sectionTitle,
					children: "常规"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles.row,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: styles.label,
						children: "DSH 启动时自动拉起网关"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Toggle, {
						checked: form.autoStart,
						onChange: (v) => {
							patchForm({ autoStart: v });
						}
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: styles.sectionTitle,
					children: "frp 远程隧道"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles.row,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: styles.label,
						children: "启用 frp 隧道"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: styles.hint,
						children: "需要 VPS 上已部署 frps（见项目 docs/）"
					})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Toggle, {
						checked: form.frp.enabled,
						onChange: (v) => {
							patchForm({ frp: {
								...form.frp,
								enabled: v
							} });
						}
					})]
				}),
				form.frp.enabled ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: styles.label,
							children: "VPS 地址"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: styles.input,
							placeholder: "例如 1.2.3.4",
							value: form.frp.serverAddr,
							onChange: (event) => {
								patchForm({ frp: {
									...form.frp,
									serverAddr: event.target.value
								} });
							}
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberField, {
						label: "控制端口",
						value: form.frp.serverPort,
						onChange: (v) => {
							patchForm({ frp: {
								...form.frp,
								serverPort: v
							} });
						},
						hint: "frps bindPort"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberField, {
						label: "入口端口",
						value: form.frp.remotePort,
						onChange: (v) => {
							patchForm({ frp: {
								...form.frp,
								remotePort: v
							} });
						},
						hint: "手机访问的端口"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: styles.hint,
						children: "共享密钥在 PC 的 state/secrets.json 与 VPS 的 frps.toml，两端一致即可（安全起见不在面板展示）。"
					})
				] }) : null,
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: styles.sectionTitle,
					children: "网络"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles.field,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: styles.label,
						children: "监听面"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
						style: styles.input,
						value: form.listenHost,
						onChange: (event) => {
							patchForm({ listenHost: event.target.value });
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "127.0.0.1",
							children: "仅本机（推荐，经 frp 出外网）"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "0.0.0.0",
							children: "局域网（家庭可信网络直连）"
						})]
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberField, {
					label: "上游端口",
					value: form.upstreamPort,
					onChange: (v) => {
						patchForm({ upstreamPort: v });
					},
					hint: "DSH Web GUI 端口"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles.row,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: styles.label,
						children: "自动跟随端口漂移"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: styles.hint,
						children: "DSH 重启换端口时自动探测并回写"
					})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Toggle, {
						checked: form.autoFixUpstreamPort,
						onChange: (v) => {
							patchForm({ autoFixUpstreamPort: v });
						}
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						gap: 8,
						marginTop: 14,
						flexWrap: "wrap"
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: styles.button(true),
							disabled: saving,
							onClick: () => {
								save();
							},
							children: saving ? "保存中…" : "保存并重启网关"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: styles.button(false),
							onClick: () => {
								mintPairCode();
							},
							children: "生成配对码"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: styles.button(false),
							onClick: () => {
								restartGateway();
							},
							children: "重启网关"
						})
					]
				}),
				pairing !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles.codeBox,
					children: [
						"配对码：",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: pairing.code }),
						"（10 分钟有效）",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: styles.hint,
							children: "手机打开网关地址后输入此码完成配对"
						})
					]
				}) : null,
				message !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: styles.error,
					children: message.text
				}) : null
			]
		}) : null]
	});
}
/** 必需服务：槽位注册器。 */
const inject = ["slots"];
const name = "dsh-remote-plugin";
function apply(ctx) {
	try {
		ctx.slots.inject("settings.plugin.item", () => {
			try {
				return ctx.slots.register({
					name: "settings.plugin.item",
					id: "dsh-remote-plugin",
					key: "dsh-remote-plugin",
					order: 40
				}, DshRemoteSettingsCard);
			} catch (error) {
				console.error("dsh-remote: settings card register failed", error);
				return () => {};
			}
		});
	} catch (error) {
		console.error("dsh-remote: settings card inject failed", error);
	}
}
//#endregion
exports.DshRemoteSettingsCard = DshRemoteSettingsCard;
exports.apply = apply;
exports.inject = inject;
exports.name = name;

return module.exports; } });
//# sourceMappingURL=client.js.map