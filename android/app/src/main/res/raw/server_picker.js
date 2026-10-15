/* Android 平板的服务器入口。只插入自有节点，不改官方品牌/新会话组件。 */
(function (snapshot, switchServer, editServer) {
	'use strict';
	var existing = window.__dshRemoteServerPicker;
	if (existing) {
		existing.update(snapshot, switchServer, editServer);
		return;
	}

	var ROOT_ID = 'dshr-server-picker';
	var MENU_ID = 'dshr-server-menu';
	var style = document.createElement('style');
	style.id = 'dshr-server-picker-style';
	style.textContent = `
#dshr-server-picker{flex:none!important;align-self:flex-start!important;flex-shrink:0;margin-bottom:8px;height:auto!important;max-height:none!important;overflow:visible!important}
#dshr-server-picker[hidden],#dshr-server-menu[hidden]{display:none!important}
#dshr-server-picker>button{box-sizing:border-box;width:100%;height:var(--dshr-picker-height,38px);border-radius:var(--dshr-picker-radius,12px);border:1px solid var(--dsw-alias-border-l3,#e5e5e5);background:var(--dsw-alias-button-elevated-fill,#fff);color:var(--dsw-alias-label-primary,#222);display:flex;align-items:center;gap:8px;padding:8px 16px;font:inherit;font-size:14px;cursor:pointer}
#dshr-server-picker>button:hover,#dshr-server-menu button:hover{background:var(--dsw-alias-button-floating-hover,#f3f3f5)}
#dshr-server-picker button:focus-visible,#dshr-server-menu button:focus-visible{outline:2px solid var(--dsw-alias-label-link,#7198ef);outline-offset:2px}
#dshr-server-picker svg{flex-shrink:0;width:16px;height:16px}
#dshr-server-picker .dshr-server-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
#dshr-server-picker .dshr-server-dot{width:6px;height:6px;border-radius:50%;background:#c7c7cc;flex-shrink:0}
#dshr-server-picker .dshr-server-dot[data-status="up"]{background:#38a677}
#dshr-server-picker .dshr-server-dot[data-status="down"]{background:#e11d48}
#dshr-server-menu .dshr-server-status{width:8px;height:8px;border-radius:50%;background:#c7c7cc;flex:none}
#dshr-server-menu .dshr-server-status[data-status="up"]{background:#38a677}
#dshr-server-menu .dshr-server-status[data-status="down"]{background:#e11d48}
#dshr-server-menu{position:fixed;z-index:10000;box-sizing:border-box;padding:6px;border-radius:16px;border:1px solid rgba(0,0,0,.06);background:var(--dsw-alias-button-elevated-fill,#fff);color:var(--dsw-alias-label-primary,#1c1c1e);box-shadow:0 16px 40px rgba(0,0,0,.12);overflow:auto;font:inherit;font-size:14px}
#dshr-server-menu .dshr-server-title{padding:8px 12px 6px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary,#8e8e93)}
#dshr-server-menu .dshr-server-line{display:flex;align-items:center;min-height:56px;border-radius:12px;padding-right:4px}
#dshr-server-menu .dshr-server-line:hover,#dshr-server-menu .dshr-server-line:has([aria-checked=true]){background:var(--dsw-alias-button-floating-hover,#f3f3f5)}
#dshr-server-menu button{display:flex;align-items:center;gap:10px;width:100%;padding:10px;border:0;border-radius:9px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}
#dshr-server-menu .dshr-server-line>button{flex:1;min-width:0;width:auto;min-height:56px;padding:8px 0 8px 12px;border-radius:12px;background:transparent}
#dshr-server-menu .dshr-server-line>button:hover,#dshr-server-menu .dshr-server-line>button[aria-checked=true]{background:transparent}
#dshr-server-menu .dshr-server-trail{display:flex;align-items:center;flex:none;margin-left:auto}
#dshr-server-menu .dshr-server-edit{flex:none;width:32px;height:32px;margin:0;padding:0;justify-content:center;border-radius:8px;color:#8e8e93}
#dshr-server-menu .dshr-server-edit:hover{background:#e7e7eb;color:var(--dsw-alias-label-primary,#1c1c1e)}
#dshr-server-menu button:disabled{opacity:.45;cursor:default}
#dshr-server-menu .dshr-server-copy{flex:1;min-width:0}
#dshr-server-menu .dshr-server-copy>span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dshr-server-menu .dshr-server-copy>span:first-child{font-weight:600;font-size:14px;line-height:1.25}
#dshr-server-menu .dshr-server-detail{margin-top:3px;font-size:12px;line-height:1.25;font-weight:400;color:var(--dsw-alias-label-tertiary,#8e8e93)}
#dshr-server-menu .dshr-server-check{width:22px;text-align:center;font-size:15px;line-height:1;color:#2f9e6b}
#dshr-server-menu .dshr-server-rule{height:1px;margin:6px 10px;background:#ececef}
#dshr-server-menu .dshr-server-add,#dshr-server-menu .dshr-server-stop{height:40px;min-height:40px;padding:0 12px;border-radius:12px;gap:8px;color:var(--dsw-alias-label-primary,#1c1c1e);font-size:14px;font-weight:400}
#dshr-server-menu .dshr-server-mark{width:18px;height:18px;border-radius:6px;display:grid;place-items:center;background:var(--dsw-alias-button-floating-hover,#f2f2f4);color:var(--dsw-alias-label-primary,#1c1c1e);flex:none}
html[data-dshr-dark="1"] #dshr-server-menu .dshr-server-mark,body[data-ds-dark-theme] #dshr-server-menu .dshr-server-mark{background:rgba(255,255,255,.14);color:var(--dsw-alias-label-primary,#f5f5f7)}
#dshr-server-menu .dshr-server-mark svg{width:12px;height:12px;display:block;stroke:currentColor}
#dshr-server-menu .dshr-server-back{width:auto;padding:6px 8px}
#dshr-server-menu label{display:block;margin:0 8px 8px;font-size:12px;color:var(--dsw-alias-label-tertiary,#888)}
#dshr-server-menu input{box-sizing:border-box;width:100%;height:34px;margin-top:4px;border:1px solid var(--dsw-alias-border-l3,#e5e5e5);border-radius:9px;padding:0 10px;font:inherit;font-size:14px;color:inherit;background:#fff}
#dshr-server-menu .dshr-server-pair{display:grid;grid-template-columns:88px 1fr;gap:8px;margin:0 8px}
#dshr-server-menu .dshr-server-pair label{margin:0 0 8px}
#dshr-server-menu .dshr-server-secret{position:relative}
#dshr-server-menu .dshr-server-secret input{padding-right:48px}
#dshr-server-menu .dshr-server-reveal{position:absolute;right:8px;bottom:7px;width:auto;padding:0 4px;font-size:12px;color:var(--dsw-alias-label-tertiary,#888)}
#dshr-server-menu .dshr-server-seg{display:flex;gap:4px;margin:0 8px 8px;padding:2px;border-radius:10px;background:var(--dsw-alias-button-floating-hover,#eee)}
#dshr-server-menu .dshr-server-seg button{flex:1;width:auto;justify-content:center;padding:6px 8px}
#dshr-server-menu .dshr-server-seg button[aria-pressed=true]{background:#fff}
#dshr-server-menu .dshr-server-choice{align-items:flex-start}
#dshr-server-menu .dshr-server-choice[aria-pressed=true]{background:#fff;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l3,#e5e5e5)}
#dshr-server-menu .dshr-server-choice small{display:block;margin-top:2px;color:var(--dsw-alias-label-tertiary,#888);font-size:12px}
#dshr-server-menu .dshr-server-error{margin:0 10px 8px;color:#c2413a;font-size:12px}
#dshr-server-menu .dshr-server-actions{display:flex;justify-content:flex-end;gap:8px;padding:4px 8px 8px}
#dshr-server-menu .dshr-server-actions button{width:auto;padding:8px 14px}
#dshr-server-menu .dshr-server-save{background:#1c1c1e;color:#fff}
#dshr-server-menu .dshr-server-delete{width:auto;margin:0 8px 4px;padding:4px 2px;color:#c2413a}
`;
	var root = document.createElement('div');
	root.id = ROOT_ID;
	var trigger = document.createElement('button');
	trigger.type = 'button';
	trigger.setAttribute('aria-haspopup', 'menu');
	trigger.setAttribute('aria-controls', MENU_ID);
	trigger.setAttribute('aria-expanded', 'false');
	trigger.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg><span class="dshr-server-dot" aria-hidden="true"></span><span class="dshr-server-name"></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';
	root.appendChild(trigger);
	var menu = document.createElement('div');
	menu.id = MENU_ID;
	menu.setAttribute('role', 'menu');
	menu.setAttribute('aria-label', '切换服务器');
	menu.hidden = true;
	var anchor = null;
	var frame = 0;
	var pending = false;
	var destroyed = false;
	var lastLayout = '';
	var data;
	var select;
	var editor = null;
	var view = 'list';
	var placed = '';

	function rememberScroll(node) {
		var saved = [];
		var current = node && node.parentElement;
		while (current) {
			saved.push([current, current.scrollTop, current.scrollLeft]);
			current = current.parentElement;
		}
		var scroller = document.scrollingElement || document.documentElement;
		if (scroller) saved.push([scroller, scroller.scrollTop, scroller.scrollLeft]);
		return saved;
	}

	function restoreScroll(saved) {
		for (var i = 0; i < saved.length; i++) {
			saved[i][0].scrollTop = saved[i][1];
			saved[i][0].scrollLeft = saved[i][2];
		}
	}

	function closeIfOpen() {
		if (menu.hidden) return false;
		menu.hidden = true;
		placed = '';
		trigger.setAttribute('aria-expanded', 'false');
		trigger.focus({ preventScroll: true });
		return true;
	}

	function writeMenuBox(left, width, top, maxHeight) {
		menu.style.setProperty('left', left + 'px', 'important');
		menu.style.setProperty('width', width + 'px', 'important');
		menu.style.setProperty('right', 'auto', 'important');
		menu.style.setProperty('top', top + 'px', 'important');
		menu.style.setProperty('bottom', 'auto', 'important');
		menu.style.setProperty('max-height', maxHeight + 'px', 'important');
		menu.style.setProperty('transform', 'none', 'important');
		menu.style.setProperty('margin', '0', 'important');
	}

	function positionMenu() {
		var rect = trigger.getBoundingClientRect();
		if (rect.width < 2 || rect.height < 2) return;
		var gap = 6;
		var edge = 8;
		var left = Math.round(rect.left);
		var width = Math.round(rect.width);
		var top = Math.round(rect.bottom) + gap;
		if (left < edge) {
			width -= edge - left;
			left = edge;
		}
		if (left + width > innerWidth - edge) width = Math.max(120, innerWidth - edge - left);
		var maxHeight = Math.max(80, Math.round(innerHeight - top - edge));
		var signature = left + '|' + width + '|' + top + '|' + maxHeight;
		var painted = menu.hidden ? null : menu.getBoundingClientRect();
		var overlaps = !!(painted && painted.height > 2 && painted.top < rect.bottom - 1);
		if (signature === placed && !overlaps) return;
		placed = signature;
		writeMenuBox(left, width, top, maxHeight);
		if (menu.hidden) return;
		painted = menu.getBoundingClientRect();
		var drift = Math.round(rect.bottom + gap - painted.top);
		if (drift > 1) writeMenuBox(left, width, top + drift, Math.max(80, maxHeight - drift));
	}

	function openMenu() {
		if (root.hidden || pending) return;
		var saved = rememberScroll(trigger);
		menu.hidden = false;
		trigger.setAttribute('aria-expanded', 'true');
		positionMenu();
		var selected = menu.querySelector('button[aria-checked="true"]:enabled') || menu.querySelector('button:enabled');
		if (selected) selected.focus({ preventScroll: true });
		restoreScroll(saved);
		requestAnimationFrame(function () { restoreScroll(saved); positionMenu(); });
		// 手机抽屉的浮层钳位在打开后约 50ms 才改 top。这里再钉两次，
		// 避免那一帧把菜单拉上去盖住触发按钮。
		setTimeout(function () { if (!destroyed && !menu.hidden) positionMenu(); }, 80);
		setTimeout(function () { if (!destroyed && !menu.hidden) positionMenu(); }, 240);
	}

	function update(next, callback, editorFn) {
		if (!next || !Array.isArray(next.entries) || typeof callback !== 'function') {
			throw new TypeError('服务器选择器缺少原生元数据或连接入口');
		}
		data = next;
		select = callback;
		if (typeof editorFn === 'function') editor = editorFn;
		pending = !!next.switching;
		trigger.disabled = pending;
		var label = pending ? '正在切换…' : (data.currentName || '当前服务器');
		trigger.querySelector('.dshr-server-name').textContent = label;
		var currentStatus = 'idle';
		if (!pending) {
			for (var i = 0; i < data.entries.length; i++) {
				if (data.entries[i].current) currentStatus = entryStatus(data.entries[i]);
			}
		}
		trigger.querySelector('.dshr-server-dot').setAttribute('data-status', currentStatus);
		trigger.setAttribute('aria-label', pending
			? '正在切换服务器'
			: '当前服务器：' + (data.currentName || '当前服务器') + '，' + statusText(currentStatus) + '，切换服务器');
		if (pending) view = 'list';
		if (view === 'form' && !pending) return;
		renderList();
		scheduleSync();
	}

	function renderList() {
		view = 'list';
		menu.replaceChildren();
		var title = document.createElement('div');
		title.className = 'dshr-server-title';
		title.textContent = data.entries.length ? '切换服务器' : '尚未保存服务器';
		menu.appendChild(title);
		data.entries.forEach(function (entry) {
			var line = document.createElement('div');
			line.className = 'dshr-server-line';
			var item = document.createElement('button');
			item.type = 'button';
			item.setAttribute('role', 'menuitemradio');
			item.setAttribute('aria-checked', String(entry.current));
			item.disabled = !entry.enabled;
			var status = entryStatus(entry);
			item.setAttribute('aria-label', entry.name + '，' + statusText(status));
			var mark = document.createElement('span');
			mark.className = 'dshr-server-status';
			mark.setAttribute('data-status', status);
			mark.setAttribute('aria-hidden', 'true');
			item.appendChild(mark);
			var copy = document.createElement('span');
			copy.className = 'dshr-server-copy';
			var name = document.createElement('span');
			name.textContent = entry.name;
			var detail = document.createElement('span');
			detail.className = 'dshr-server-detail';
			detail.textContent = entry.enabled ? entry.detail : entry.detail + ' · 配置不可用';
			copy.append(name, detail);
			item.appendChild(copy);
			item.addEventListener('click', function () {
				closeIfOpen();
				if (entry.current || pending) return;
				pending = true;
				trigger.disabled = true;
				trigger.querySelector('.dshr-server-name').textContent = '正在切换…';
				select(entry.kind, entry.id);
			});
			var trail = document.createElement('span');
			trail.className = 'dshr-server-trail';
			var check = document.createElement('span');
			check.className = 'dshr-server-check';
			check.textContent = entry.current ? '✓' : '';
			check.setAttribute('aria-hidden', 'true');
			trail.appendChild(check);
			line.appendChild(item);
			if (editor) {
				var edit = document.createElement('button');
				edit.type = 'button';
				edit.className = 'dshr-server-edit';
				edit.setAttribute('aria-label', '编辑' + entry.name);
				edit.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16v4Z"/><path d="m12 6 4 4"/></svg>';
				edit.addEventListener('click', function (event) {
					event.stopPropagation();
					openEdit(entry);
				});
				trail.appendChild(edit);
			}
			line.appendChild(trail);
			menu.appendChild(line);
		});
		if (!editor) return;
		var rule = document.createElement('div');
		rule.className = 'dshr-server-rule';
		menu.appendChild(rule);
		var add = document.createElement('button');
		add.type = 'button';
		add.className = 'dshr-server-add';
		add.innerHTML = '<span class="dshr-server-mark" aria-hidden="true"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 1.5v9M1.5 6h9"/></svg></span>添加服务器';
		add.addEventListener('click', openAdd);
		menu.appendChild(add);
		var stop = document.createElement('button');
		stop.type = 'button';
		stop.className = 'dshr-server-stop';
		stop.innerHTML = '<span class="dshr-server-mark" aria-hidden="true"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.4" y="2.4" width="7.2" height="7.2" rx="1.2"/></svg></span>停止隧道';
		stop.addEventListener('click', function () {
			closeIfOpen();
			try { editor('stop', {}); } catch (ignored) { /* 原生会自己提示 */ }
		});
		menu.appendChild(stop);
		if (!menu.hidden) positionMenu();
	}

	function entryStatus(entry) {
		if (entry.status === 'up' || entry.status === 'down' || entry.status === 'idle') return entry.status;
		if (!entry.enabled) return 'down';
		return entry.current ? 'up' : 'idle';
	}

	function statusText(status) {
		if (status === 'up') return '可连接';
		if (status === 'down') return '不可用';
		return '未连接';
	}

	function field(label, value, placeholder) {
		var wrap = document.createElement('label');
		wrap.append(document.createTextNode(label));
		var input = document.createElement('input');
		input.value = value || '';
		input.placeholder = placeholder || '';
		wrap.appendChild(input);
		return { wrap: wrap, input: input };
	}

	function showError(message) {
		var node = menu.querySelector('.dshr-server-error');
		if (!node) return;
		node.hidden = !message;
		node.textContent = message || '';
	}

	function ask(op, payload) {
		var raw;
		try {
			raw = editor(op, payload);
		} catch (error) {
			return { ok: false, error: '无法保存，请稍后再试' };
		}
		try {
			var parsed = JSON.parse(raw);
			if (!parsed || parsed.ok !== true) return { ok: false, error: (parsed && parsed.error) || '无法保存' };
			return parsed;
		} catch (error) {
			return { ok: false, error: '无法保存，请稍后再试' };
		}
	}

	function renderForm(form) {
		view = 'form';
		var kind = form.kind === 'direct' ? 'direct' : 'tunnel';
		var strategy = form.strategy === 'relay' ? 'relay' : 'p2p';
		menu.replaceChildren();
		var head = document.createElement('div');
		head.className = 'dshr-server-line';
		var back = document.createElement('button');
		back.type = 'button';
		back.className = 'dshr-server-back';
		back.setAttribute('aria-label', '返回服务器列表');
		back.textContent = '←';
		back.addEventListener('click', renderList);
		var title = document.createElement('div');
		title.className = 'dshr-server-title';
		title.textContent = form.id ? '编辑服务器' : '添加服务器';
		head.append(back, title);
		menu.appendChild(head);
		var seg = document.createElement('div');
		seg.className = 'dshr-server-seg';
		function segButton(value, text) {
			var button = document.createElement('button');
			button.type = 'button';
			button.textContent = text;
			button.setAttribute('aria-pressed', String(kind === value));
			button.addEventListener('click', function () {
				if (kind === value) return;
				kind = value;
				renderForm({
					kind: kind, id: '', name: '', host: '', port: '7000', tunnel: 'dsh-remote',
					token: '', sk: '', url: '', strategy: 'p2p', p2pEnabled: true, relayEnabled: true, note: ''
				});
			});
			return button;
		}
		if (!form.id) {
			seg.append(segButton('tunnel', '隧道'), segButton('direct', '直连'));
			menu.appendChild(seg);
		}
		var name = field('名称', form.name, kind === 'direct' ? '例如 公司局域网' : '例如 家里的电脑');
		var host = field('VPS 地址', form.host, '与电脑端一致');
		var port = field('控制端口', form.port || '7000', '7000');
		var tunnel = field('隧道名', form.tunnel || 'dsh-remote', 'dsh-remote');
		var editing = !!form.id;
		var token = field('登录密钥', form.token, editing ? '留空表示不修改' : 'frps 的 auth.token');
		var sk = field('访客密钥', form.sk, editing ? '留空表示不修改' : '与电脑插件一致');
		var url = field('网关地址', form.url, 'https://192.168.1.8:18443');
		token.input.type = 'password';
		sk.input.type = 'password';
		token.wrap.classList.add('dshr-server-secret');
		sk.wrap.classList.add('dshr-server-secret');
		[token, sk].forEach(function (secret) {
			var reveal = document.createElement('button');
			reveal.type = 'button';
			reveal.className = 'dshr-server-reveal';
			reveal.textContent = '显示';
			reveal.addEventListener('click', function () {
				var shown = secret.input.type === 'text';
				secret.input.type = shown ? 'password' : 'text';
				reveal.textContent = shown ? '显示' : '隐藏';
			});
			secret.wrap.appendChild(reveal);
		});
		menu.appendChild(name.wrap);
		if (kind === 'tunnel') {
			menu.appendChild(host.wrap);
			var pair = document.createElement('div');
			pair.className = 'dshr-server-pair';
			pair.append(port.wrap, tunnel.wrap);
			menu.appendChild(pair);
			menu.append(token.wrap, sk.wrap);
			function choice(value, heading, hint, enabled) {
				var button = document.createElement('button');
				button.type = 'button';
				button.className = 'dshr-server-choice';
				button.disabled = !enabled;
				button.setAttribute('aria-pressed', String(strategy === value));
				button.innerHTML = '<span><b></b><small></small></span>';
				button.querySelector('b').textContent = heading;
				button.querySelector('small').textContent = hint;
				button.addEventListener('click', function () {
					strategy = value;
					menu.querySelectorAll('.dshr-server-choice').forEach(function (node) {
						node.setAttribute('aria-pressed', String(node === button));
					});
				});
				return button;
			}
			menu.append(
				choice('p2p', '打洞优先', '先试直连，打不通再经 VPS 中转。', form.p2pEnabled !== false),
				choice('relay', '只用中转', '不打洞，建连更稳，流量经过 VPS。', form.relayEnabled !== false)
			);
		} else {
			menu.appendChild(url.wrap);
		}
		if (form.note) {
			var note = document.createElement('div');
			note.className = 'dshr-server-detail';
			note.style.padding = '0 10px 8px';
			note.textContent = form.note;
			menu.appendChild(note);
		}
		var error = document.createElement('div');
		error.className = 'dshr-server-error';
		error.hidden = true;
		menu.appendChild(error);
		if (form.id) {
			var remove = document.createElement('button');
			remove.type = 'button';
			remove.className = 'dshr-server-delete';
			remove.textContent = '删除这台服务器';
			remove.addEventListener('click', function () {
				var result = ask('delete', { kind: kind, id: form.id });
				if (!result.ok) { showError(result.error); return; }
				renderList();
			});
			menu.appendChild(remove);
		}
		var actions = document.createElement('div');
		actions.className = 'dshr-server-actions';
		var cancel = document.createElement('button');
		cancel.type = 'button';
		cancel.textContent = '取消';
		cancel.addEventListener('click', renderList);
		var save = document.createElement('button');
		save.type = 'button';
		save.className = 'dshr-server-save';
		save.textContent = form.id ? '保存' : '保存并连接';
		save.addEventListener('click', function () {
			var payload = { kind: kind, id: form.id || '', name: name.input.value };
			if (kind === 'tunnel') {
				payload.host = host.input.value;
				payload.port = port.input.value;
				payload.tunnel = tunnel.input.value;
				payload.token = token.input.value;
				payload.sk = sk.input.value;
				payload.strategy = strategy;
			} else {
				payload.url = url.input.value;
			}
			var result = ask('save', payload);
			if (!result.ok) { showError(result.error); return; }
			if (!result.connect) renderList();
			else closeIfOpen();
		});
		actions.append(cancel, save);
		menu.appendChild(actions);
		if (!menu.hidden) positionMenu();
	}

	function openAdd() {
		renderForm({
			kind: 'tunnel', id: '', name: '', host: '', port: '7000', tunnel: 'dsh-remote',
			token: '', sk: '', url: '', strategy: 'p2p', p2pEnabled: true, relayEnabled: true, note: ''
		});
	}

	function openEdit(entry) {
		var result = ask('load', { kind: entry.kind, id: entry.id });
		if (!result.ok) {
			var title = menu.querySelector('.dshr-server-title');
			if (title) title.textContent = result.error;
			return;
		}
		renderForm(result);
	}

	// 官方品牌按钮与新会话有相同 aria-label，只按品牌行之后的直接兄弟定位。
	function findAnchor() {
		var rows = document.querySelectorAll('[data-slot="sidebar"] [data-window-drag="true"]');
		for (var i = 0; i < rows.length; i++) {
			var next = rows[i].nextElementSibling;
			if (next === root) next = next.nextElementSibling;
			if (next && next.tagName === 'BUTTON') return next;
		}
		return null;
	}

	function sync() {
		frame = 0;
		if (destroyed) return;
		var next = findAnchor();
		if (next !== anchor) {
			closeIfOpen();
			resize.disconnect();
			anchor = next;
			if (anchor) resize.observe(anchor);
		}
		if (!anchor) {
			root.remove();
			return;
		}
		if (root.nextElementSibling !== anchor) anchor.before(root);
		var rect = anchor.getBoundingClientRect();
		var collapsed = !!anchor.closest('[data-sidebar-collapsed]') || rect.width < 80;
		if (root.hidden !== collapsed) root.hidden = collapsed;
		if (collapsed) {
			closeIfOpen();
			return;
		}
		var css = getComputedStyle(anchor);
		var layout = 'width:' + rect.width + 'px;margin-left:' + css.marginLeft + ';margin-right:' + css.marginRight + ';--dshr-picker-height:' + rect.height + 'px;--dshr-picker-radius:' + css.borderRadius;
		if (lastLayout !== layout) { root.style.cssText = layout; lastLayout = layout; }
		if (!menu.hidden) positionMenu();
	}

	function scheduleSync() {
		if (!frame && !destroyed) frame = requestAnimationFrame(sync);
	}
	function outside(event) {
		if (!menu.contains(event.target) && !root.contains(event.target)) closeIfOpen();
	}
	function keydown(event) {
		if (menu.hidden) {
			if (event.target === trigger && event.key === 'ArrowDown') {
				event.preventDefault();
				openMenu();
			}
			return;
		}
		if (view === 'form') {
			if (event.key === 'Escape') {
				event.preventDefault();
				renderList();
			}
			return;
		}
		if (event.key === 'Escape' || event.key === 'Tab') {
			if (event.key === 'Escape') event.preventDefault();
			closeIfOpen();
			return;
		}
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
		event.preventDefault();
		var items = Array.from(menu.querySelectorAll('[role=menuitemradio]:enabled'));
		if (!items.length) return;
		var index = items.indexOf(document.activeElement);
		if (event.key === 'Home') index = 0;
		else if (event.key === 'End') index = items.length - 1;
		else index = (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
		items[index].focus({ preventScroll: true });
	}
	function destroy() {
		destroyed = true;
		observer.disconnect();
		resize.disconnect();
		cancelAnimationFrame(frame);
		document.removeEventListener('pointerdown', outside, true);
		document.removeEventListener('keydown', keydown);
		window.removeEventListener('resize', scheduleSync);
		window.removeEventListener('scroll', scheduleSync, true);
		root.remove();
		menu.remove();
		style.remove();
		delete window.__dshRemoteServerPicker;
	}
	var observer = new MutationObserver(scheduleSync);
	var resize = new ResizeObserver(scheduleSync);
	trigger.addEventListener('click', function () { if (!closeIfOpen()) openMenu(); });
	document.addEventListener('pointerdown', outside, true);
	document.addEventListener('keydown', keydown);
	window.addEventListener('resize', scheduleSync);
	window.addEventListener('scroll', function (event) {
		if (menu.contains(event.target)) return;
		scheduleSync();
	}, true);
	(document.head || document.documentElement).appendChild(style);
	document.body.appendChild(menu);
	observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-sidebar-collapsed'] });
	window.__dshRemoteServerPicker = { update: update, destroy: destroy, closeIfOpen: closeIfOpen };
	update(snapshot, switchServer, editServer);
})
