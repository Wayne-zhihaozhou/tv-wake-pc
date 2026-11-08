(function () {
    'use strict';

    var SERVICE = 'luna://com.woltv.wakepc.service';

    var els = {
        device: document.getElementById('device'),
        deviceList: document.getElementById('deviceList'),
        scan: document.getElementById('btnScan'),
        mac: document.getElementById('mac'),
        ip: document.getElementById('ip'),
        port: document.getElementById('port'),
        save: document.getElementById('btnSave'),
        exit: document.getElementById('btnExit'),
        wake: document.getElementById('btnWake'),
        status: document.getElementById('status'),
        powerDiag: document.getElementById('powerDiag'),
        enableWake: document.getElementById('enableWake')
    };

    var devicesCache = [];

    var CALL_TIMEOUT = 12000;

    function callService(method, params, timeoutMs) {
        return new Promise(function (resolve, reject) {
            var bridge = new PalmServiceBridge();
            var settled = false;

            function settle(fn, val) {
                if (settled) { return; }
                settled = true;
                fn(val);
            }

            bridge.onservicecallback = function (response) {
                var msg;
                try {
                    msg = JSON.parse(response);
                } catch (e) {
                    settle(reject, { errorText: '服务返回格式错误' });
                    return true;
                }
                if (msg && msg.returnValue) {
                    settle(resolve, msg);
                } else {
                    settle(reject, msg || { errorText: '服务返回未知错误' });
                }
                return true;
            };

            setTimeout(function () {
                settle(reject, { errorText: '服务无响应（超时）' });
            }, timeoutMs || CALL_TIMEOUT);

            try {
                bridge.call(SERVICE + '/' + method, JSON.stringify(params || {}));
            } catch (e) {
                settle(reject, { errorText: '调用服务失败: ' + (e && e.message || e) });
            }
        });
    }

    function setStatus(text, kind) {
        els.status.textContent = text;
        els.status.className = 'status' + (kind ? ' ' + kind : '');
    }

    function showError(err) {
        setStatus('错误: ' + (err && (err.errorText || err.message) || '未知错误'), 'err');
    }

    function macLabel(mac) {
        return String(mac || '').toUpperCase();
    }

    var deviceOptions = [];
    var deviceSelected = 0;
    var deviceOpen = false;
    var deviceActive = 0;

    function rebuildDeviceList(devices, broadcast) {
        devicesCache = devices || [];
        deviceOptions = [];

        var curMac = macLabel(els.mac.value.trim());
        var curIp = els.ip.value.trim();
        if (curMac && curMac.length >= 12) {
            deviceOptions.push({
                value: curMac,
                label: '当前设置 (' + curMac + (curIp ? ' / ' + curIp : '') + ')'
            });
        } else {
            deviceOptions.push({ value: '', label: '—— 请选择设备 ——' });
        }

        if (broadcast) {
            deviceOptions.push({
                value: 'broadcast:' + broadcast,
                label: '广播唤醒所有设备 (' + broadcast + ')'
            });
        }
        for (var i = 0; i < devicesCache.length; i++) {
            var d = devicesCache[i];
            var label = (d.ip || '?') + (d.mac ? '  (' + macLabel(d.mac) + ')' : '');
            deviceOptions.push({ value: d.mac + '|' + (d.ip || ''), label: label });
        }

        deviceSelected = matchCurrentIndex();
        renderDeviceList();
        setTriggerLabel();
    }

    function renderDeviceList() {
        var frag = document.createDocumentFragment();
        for (var i = 0; i < deviceOptions.length; i++) {
            (function (idx) {
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'dd-item';
                btn.setAttribute('role', 'option');
                btn.textContent = deviceOptions[idx].label;
                btn.addEventListener('click', function () {
                    selectDevice(idx);
                    closeDropdown();
                });
                frag.appendChild(btn);
            })(i);
        }
        els.deviceList.innerHTML = '';
        els.deviceList.appendChild(frag);
    }

    function matchCurrentIndex() {
        var curMac = macLabel(els.mac.value.trim());
        for (var i = 0; i < deviceOptions.length; i++) {
            if (curMac && deviceOptions[i].value.indexOf(curMac) === 0) { return i; }
        }
        return 0;
    }

    function selectDevice(idx) {
        if (idx < 0 || idx >= deviceOptions.length) { return; }
        deviceSelected = idx;
        applyDeviceValue(deviceOptions[idx].value);
        setTriggerLabel();
    }

    function setTriggerLabel() {
        var opt = deviceOptions[deviceSelected];
        els.device.textContent = opt ? opt.label : '—— 请选择设备 ——';
    }

    function applyDeviceValue(val) {
        if (!val) { return; }
        if (val.indexOf('broadcast:') === 0) {
            els.mac.value = '';
            els.ip.value = val.slice('broadcast:'.length);
            els.mac.placeholder = '广播模式：请在下方手动填 MAC';
            return;
        }
        var parts = val.split('|');
        var mac = parts[0] || '';
        var ip = parts[1] || '';
        if (mac) { els.mac.value = mac; }
        if (ip) { els.ip.value = ip; }
        els.mac.placeholder = 'AA:BB:CC:DD:EE:FF';
        setStatus('已选择设备：' + mac + (ip ? ' @ ' + ip : ''), 'ok');
    }

    function openDropdown() {
        if (deviceOpen) { return; }
        deviceOpen = true;
        els.device.setAttribute('aria-expanded', 'true');
        els.deviceList.hidden = false;
        deviceActive = deviceSelected;
        updateActiveItem();
    }

    function closeDropdown() {
        if (!deviceOpen) { return; }
        deviceOpen = false;
        els.device.setAttribute('aria-expanded', 'false');
        els.deviceList.hidden = true;
        els.device.focus();
    }

    function updateActiveItem() {
        var items = els.deviceList.children;
        for (var i = 0; i < items.length; i++) {
            items[i].classList.toggle('focused', i === deviceActive);
        }
        if (items[deviceActive]) {
            items[deviceActive].scrollIntoView({ block: 'nearest' });
        }
    }

    function moveActive(delta) {
        if (deviceOptions.length === 0) { return; }
        deviceActive = (deviceActive + delta + deviceOptions.length) % deviceOptions.length;
        updateActiveItem();
    }

    function chooseActive() {
        selectDevice(deviceActive);
        closeDropdown();
    }

    function scanDevices() {
        setStatus('正在扫描局域网…');
        els.scan.disabled = true;
        callService('scan', {}, 30000)
            .then(function (res) {
                var devs = res.devices || [];
                rebuildDeviceList(devs, res.broadcast);
                if (devs.length === 0) {
                    setStatus('未发现在线设备。目标电脑若处于关机状态无法被发现，请先开机扫描一次，或直接手动填写 MAC 地址。', '');
                } else {
                    setStatus('扫描完成：发现 ' + devs.length + ' 台设备，请选择', 'ok');
                }
            })
            .catch(function (err) {
                rebuildDeviceList([], null);
                var msg = (err && (err.errorText || err.message)) || '未知错误';
                setStatus('扫描失败：' + msg + '。请手动填写 MAC 地址。', 'err');
            })
            .then(function () {
                els.scan.disabled = false;
            });
    }

    var DEFAULT_MAC = 'CC:28:AA:A7:B4:1F';

    function ensureMacDefault() {
        if (!els.mac.value.trim()) { els.mac.value = DEFAULT_MAC; }
    }

    function setToggle(el, on) {
        if (!el) { return; }
        el.setAttribute('aria-pressed', on ? 'true' : 'false');
        el.textContent = el.getAttribute('data-label') + '：' + (on ? '开' : '关');
    }

    function applyConfig(c) {
        els.mac.value = (c && c.mac) || DEFAULT_MAC;
        els.ip.value = (c && c.ip) || '255.255.255.255';
        els.port.value = (c && typeof c.port === 'number') ? c.port : 9;
        ensureMacDefault();
        setToggle(els.enableWake, !c || c.enableWake !== false);
        updateWakeControls();
    }

    function updateWakeControls() {
        var on = els.enableWake && els.enableWake.getAttribute('aria-pressed') === 'true';
        els.scan.disabled = !on;
        els.wake.disabled = !on;
    }

    function loadConfig() {
        callService('getConfig')
            .then(function (res) {
                applyConfig(res.config);
                rebuildDeviceList([], null);
                setStatus('已加载设置。可点「扫描设备」选择目标。', 'ok');
            })
            .catch(function () {
                applyConfig(null);
                rebuildDeviceList([], null);
                setStatus('已使用默认目标（' + DEFAULT_MAC + '），可直接保存。', '');
            });
    }

    function readForm() {
        return {
            mac: els.mac.value.trim(),
            ip: els.ip.value.trim() || '255.255.255.255',
            port: parseInt(els.port.value, 10) || 9,
            enableWake: els.enableWake ? els.enableWake.getAttribute('aria-pressed') === 'true' : true
        };
    }

    function validMac(mac) {
        return /^[0-9a-fA-F:.\-]{12,17}$/.test(mac) &&
            mac.replace(/[^0-9a-fA-F]/g, '').length === 12;
    }

    function saveConfig() {
        var cfg = readForm();
        if (!validMac(cfg.mac)) {
            setStatus('请先选择设备或填写正确的 MAC 地址（例如 AA:BB:CC:DD:EE:FF）', 'err');
            return;
        }
        setStatus('保存中…');
        callService('setConfig', cfg)
            .then(function (res) {
                applyConfig(res && res.config);
                setStatus('已保存 ✓', 'ok');
            })
            .catch(showError);
    }

    function wakeNow() {
        if (!els.enableWake || els.enableWake.getAttribute('aria-pressed') !== 'true') {
            setStatus('魔术包唤醒功能已关闭，无法发送', 'err');
            return;
        }
        var cfg = readForm();
        if (!validMac(cfg.mac)) {
            setStatus('请先选择设备或填写正确的 MAC 地址', 'err');
            return;
        }
        setStatus('正在发送魔术包…');
        callService('wake', cfg)
            .then(function () {
                setStatus('魔术包已发送 ✓（若电脑未开机，请检查网络/WOL 设置）', 'ok');
            })
            .catch(showError);
    }

    function exitApp() {
        try {
            if (window.PalmSystem && typeof window.PalmSystem.close === 'function') {
                window.PalmSystem.close();
                return;
            }
        } catch (e) { }
        try {
            window.close();
        } catch (e) { }
    }

    function fmtClock(ms) {
        if (!ms) { return '从未'; }
        var d = new Date(ms);
        function pad(n) { return (n < 10 ? '0' : '') + n; }
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    function loadPowerDiag() {
        if (!els.powerDiag) { return; }
        callService('getStatus', {}, 6000)
            .then(function (res) {
                var p = res.power || {};
                var triggers = p.triggers || {};
                var names = [];
                for (var k in triggers) {
                    if (Object.prototype.hasOwnProperty.call(triggers, k)) {
                        names.push(k.replace('registerPrepare', '') + (triggers[k].subscribed ? '✓' : '✗'));
                    }
                }
                var lines = [];
                lines.push('后台服务常驻：' + ((res.resident && res.resident.ok) ? '是' : '否'));
                lines.push('开机触发注册：' + (names.length ? names.join(' / ') : '无'));
                lines.push('电源事件：' + (p.eventCount || 0) + ' 次' +
                    (p.lastEvent ? '，最近 ' + p.lastEvent.reason + ' ' + fmtClock(p.lastEvent.at) : ''));
                var ls = res.lastSend || {};
                lines.push('最近发送：' + fmtClock(ls.at) +
                    (ls.at ? (ls.ok ? ' 成功' : ' 失败') + (ls.reason ? ' (' + ls.reason + ')' : '') : ''));
                if (p.events && p.events.length) {
                    lines.push('记录：' + p.events.slice(-3).join('；'));
                }
                els.powerDiag.textContent = lines.join('　·　');
            })
            .catch(function () {
                els.powerDiag.textContent = '后台服务无响应';
            });
    }

    function loadBuildInfo() {
        var el = document.getElementById('build');
        if (!el) { return; }
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', 'appinfo.json', true);
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) { return; }
                var info;
                try { info = JSON.parse(xhr.responseText); } catch (e) { return; }
                if (!info) { return; }
                var parts = [];
                if (info.version) { parts.push('v' + info.version); }
                if (info.buildHash) { parts.push(info.buildHash); }
                if (parts.length) { el.textContent = ' | ' + parts.join(' · '); }
            };
            xhr.send();
        } catch (e) { }
    }

    function getFocusOrder() {
        var sel = [
            els.device, els.scan, els.mac, els.ip, els.port,
            els.save, els.exit, els.wake,
            els.enableWake
        ];
        return sel.filter(function (el) { return el && el.offsetParent !== null && !el.disabled; });
    }

    function focusAt(index) {
        var order = getFocusOrder();
        if (order.length === 0) { return; }
        var i = (index + order.length) % order.length;
        order[i].focus();
        order[i].scrollIntoView({ block: 'nearest' });
    }

    function currentIndex() {
        var order = getFocusOrder();
        return order.indexOf(document.activeElement);
    }

    function activateFocused() {
        var el = document.activeElement;
        if (!el) { return; }
        if (el.tagName === 'BUTTON') { el.click(); }
    }

    function isEditableInput(el) {
        return el && (el === els.mac || el === els.ip || el === els.port);
    }

    ['mac', 'ip', 'port'].forEach(function (key) {
        els[key].addEventListener('blur', function () {
            this.readOnly = true;
        });
    });

    document.addEventListener('keydown', function (e) {
        var key = e.keyCode;

        if (deviceOpen) {
            if (key === 40 || key === 38) {
                e.preventDefault();
                moveActive(key === 40 ? 1 : -1);
                return;
            }
            if (key === 13) {
                e.preventDefault();
                chooseActive();
                return;
            }
            if (key === 461 || key === 8 || key === 27) {
                e.preventDefault();
                closeDropdown();
                return;
            }
            if (key === 37 || key === 39) {
                closeDropdown();
            } else {
                return;
            }
        }

        var active = document.activeElement;

        if (key === 38 || key === 40 || key === 37 || key === 39) {
            e.preventDefault();
            var idx = currentIndex();
            if (key === 38 || key === 37) { focusAt(idx - 1); }
            else { focusAt(idx + 1); }
            return;
        }

        if (key === 13) {
            e.preventDefault();
            var act = document.activeElement;
            if (isEditableInput(act) && act.readOnly) {
                act.readOnly = false;
                act.focus();
            } else {
                activateFocused();
            }
            return;
        }

        if (key === 461 || key === 8) {
            return;
        }
    });

    els.scan.addEventListener('click', scanDevices);
    els.device.addEventListener('click', function () {
        if (deviceOpen) { closeDropdown(); }
        else { openDropdown(); }
    });
    els.save.addEventListener('click', saveConfig);
    els.exit.addEventListener('click', exitApp);
    els.wake.addEventListener('click', wakeNow);

    function wireToggle(el, label) {
        if (!el) { return; }
        el.setAttribute('data-label', label);
        el.addEventListener('click', function () {
            var on = el.getAttribute('aria-pressed') === 'true';
            setToggle(el, !on);
            updateWakeControls();
            setStatus('功能开关已修改，请点击「保存」生效', '');
        });
    }
    wireToggle(els.enableWake, '魔术包唤醒功能');

    loadConfig();
    loadBuildInfo();
    loadPowerDiag();
    window.setInterval(loadPowerDiag, 5000);
    window.setTimeout(function () { focusAt(0); }, 300);

    callService('getStatus', {}, 6000)
        .then(function (res) {
            setStatus('后台服务正常。', 'ok');
        })
        .catch(function () {
            setStatus('警告：后台服务无响应。请重新部署或重启电视后重试。', 'err');
        });

})();
