var Service = require('webos-service');
var dgram = require('dgram');
var os = require('os');
var fs = require('fs');
var net = require('net');

var SERVICE_NAME = 'com.woltv.wakepc.service';
var DB_URI = 'luna://com.palm.db';
var KIND = 'com.woltv.wakepc:1';
var CONN_URI = 'luna://com.webos.service.connectionmanager';
var TVPOWER_URI = 'luna://com.webos.service.tvpower/power';
var ACTIVITY_URI = 'luna://com.palm.activitymanager';

var FLAGS = {
    broadcast: true
};

var DEFAULT_CONFIG = {
    mac: 'CC:28:AA:A7:B4:1F',
    ip: '255.255.255.255',
    port: 9,
    enableWake: true
};

// Runtime feature switch (configured through the config doc).
// When the feature is off, none of its code runs (no subscriptions, no timers),
// so consumption is kept to a minimum.
// FEATURE.wake holds the desired on/off state; wakeStarted tracks whether the
// corresponding subscriptions/timers are actually running.
var FEATURE = { wake: true };
var wakeStarted = false;

var service = new Service(SERVICE_NAME);
var lastSend = { at: 0, ok: false, error: '', reason: '' };

var configCache = null;
var startedAt = Date.now();
var resident = { ok: false, at: 0, error: '', activityId: '' };

var POWER_TRIGGERS = [
    { method: 'registerPreparePowerOn', ack: 'responsePreparePowerOn', wake: true },
    { method: 'registerPrepareResume', ack: 'responsePrepareResume', wake: true }
];

var power = {
    eventCount: 0,
    lastEvent: null,
    events: [],
    triggers: {}
};

function nowIso() {
    return new Date().toISOString();
}

function rememberEvent(text) {
    power.events.push(text);
    if (power.events.length > 12) { power.events.shift(); }
}

function lunaCall(uri, method, parameters, cb, timeoutMs) {
    var called = false;
    var timer = setTimeout(function () {
        if (!called) { called = true; cb({ returnValue: false, errorText: 'luna timeout' }); }
    }, timeoutMs || 5000);
    try {
        service.call(uri + '/' + method, parameters, function (message) {
            if (!called) { called = true; clearTimeout(timer); cb(message.payload || { returnValue: false }); }
        });
    } catch (e) {
        if (!called) { called = true; clearTimeout(timer); cb({ returnValue: false, errorText: String(e && e.message || e) }); }
    }
}

function dbCall(method, parameters, cb, timeoutMs) {
    lunaCall(DB_URI, method, parameters, cb, timeoutMs);
}

function ensureKind(cb) {
    dbCall('putKind', {
        id: KIND,
        owner: SERVICE_NAME,
        private: true,
        indexes: [{ name: 'default', props: [{ name: '_kind' }] }]
    }, function () {
        cb();
    });
}

function fullConfig(device) {
    var cfg = {
        broadcast: FLAGS.broadcast
    };
    cfg.mac = (device && device.mac) || DEFAULT_CONFIG.mac;
    cfg.ip = (device && device.ip) || DEFAULT_CONFIG.ip;
    cfg.port = (device && typeof device.port === 'number') ? device.port : DEFAULT_CONFIG.port;
    cfg.enableWake = (device && typeof device.enableWake === 'boolean') ? device.enableWake : DEFAULT_CONFIG.enableWake;
    cfg._id = device && device._id;
    return cfg;
}

function loadConfig(cb) {
    if (configCache) { cb(null, fullConfig(configCache)); return; }
    dbCall('find', { query: { from: KIND } }, function (res) {
        var raw = null;
        if (res && res.returnValue && res.results && res.results.length > 0) {
            raw = res.results[0];
        }
        configCache = raw || {};
        cb(null, fullConfig(configCache));
    });
}

function saveConfig(cfg, cb) {
    loadConfig(function (err, existing) {
        var obj = {};
        if (existing && existing._id) { obj._id = existing._id; }
        obj._kind = KIND;
        obj.mac = (cfg.mac || DEFAULT_CONFIG.mac).toString();
        obj.ip = (cfg.ip || DEFAULT_CONFIG.ip).toString();
        obj.port = typeof cfg.port === 'number' ? cfg.port : DEFAULT_CONFIG.port;
        obj.enableWake = typeof cfg.enableWake === 'boolean' ? cfg.enableWake : DEFAULT_CONFIG.enableWake;

        configCache = obj;

        function doPut() {
            dbCall('put', { objects: [obj] }, function (res) {
                if (res && res.returnValue) {
                    cb(null, fullConfig(configCache));
                } else {
                    ensureKind(function () {
                        dbCall('put', { objects: [obj] }, function (res2) {
                            cb(null, fullConfig(configCache));
                        });
                    });
                }
            });
        }
        doPut();
    });
}

function getLocalIpv4() {
    try {
        var ifaces = os.networkInterfaces();
        for (var name in ifaces) {
            var arr = ifaces[name];
            if (!arr) { continue; }
            for (var i = 0; i < arr.length; i++) {
                var a = arr[i];
                var fam = a.family;
                var isIpv4 = (fam === 'IPv4' || fam === 4);
                if (isIpv4 && !a.internal) {
                    var p = String(a.address).split('.').map(Number);
                    if (p.length === 4 && p[0] === 169 && p[1] === 254) { continue; }
                    return a.address;
                }
            }
        }
    } catch (e) { }
    return null;
}

function parseArpTableText(text) {
    var out = [];
    var lines = String(text || '').split('\n');
    for (var i = 1; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) { continue; }
        var f = line.split(/\s+/);
        var ip = f[0] || '';
        var mac = f[3] || '';
        var dev = f[5] || '';
        if (ip && /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(mac) &&
            mac !== '00:00:00:00:00:00') {
            out.push({ ip: ip, mac: mac, device: dev });
        }
    }
    return out;
}

function readArpTable() {
    var devices = [];
    try {
        var text = fs.readFileSync('/proc/net/arp', 'utf8');
        devices = parseArpTableText(text);
    } catch (e) {
        devices = [];
    }
    return devices;
}

function tcpProbe(host, port, timeoutMs, cb) {
    var sock;
    try {
        sock = new net.Socket();
    } catch (e) {
        cb();
        return;
    }
    var done = false;
    function finish() {
        if (done) { return; }
        done = true;
        try { sock.destroy(); } catch (e) { }
        cb();
    }
    sock.setTimeout(timeoutMs);
    sock.once('connect', finish);
    sock.once('timeout', finish);
    sock.once('error', finish);
    sock.once('close', finish);
    try {
        sock.connect(port, host);
    } catch (e) {
        finish();
    }
}

function tcpSweep(cb) {
    var ip = getLocalIpv4();
    if (!ip) { cb(); return; }
    var parts = ip.split('.').map(Number);
    var subnet = parts[0] + '.' + parts[1] + '.' + parts[2] + '.';
    var own = parts[3];
    var targets = [];
    for (var i = 1; i < 255; i++) {
        if (i !== own) { targets.push(subnet + i); }
    }
    var PORTS = [445];
    var total = targets.length * PORTS.length;
    var index = 0;
    var inflight = 0;
    var MAX = 50;
    function next() {
        while (inflight < MAX && index < total) {
            var ti = Math.floor(index / PORTS.length);
            var pi = index % PORTS.length;
            index++;
            inflight++;
            (function (host, port) {
                tcpProbe(host, port, 700, function () { inflight--; next(); });
            })(targets[ti], PORTS[pi]);
        }
        if (inflight === 0 && index >= total) { cb(); }
    }
    next();
}

function dedupe(list) {
    var seen = {};
    var out = [];
    for (var i = 0; i < list.length; i++) {
        var d = list[i];
        var key = d.mac + '|' + d.ip;
        if (!seen[key]) { seen[key] = true; out.push(d); }
    }
    return out;
}

function scanDevices(cb) {
    var localIp = getLocalIpv4();
    var initial = readArpTable();
    var broadcast = null;
    if (localIp) {
        var parts = localIp.split('.').map(Number);
        broadcast = parts[0] + '.' + parts[1] + '.' + parts[2] + '.255';
    }
    tcpSweep(function () {
        var after = readArpTable();
        var merged = dedupe(initial.concat(after));
        merged.sort(function (a, b) { return a.ip.localeCompare(b.ip); });
        cb(null, { devices: merged, broadcast: broadcast, localIp: localIp });
    });
}

function buildMagicPacket(mac) {
    var hex = String(mac || '').replace(/[^0-9a-fA-F]/g, '');
    if (hex.length !== 12) {
        throw new Error('Invalid MAC address: ' + mac);
    }
    var macBuf = Buffer.from(hex, 'hex');
    var packet = Buffer.alloc(6 + 16 * 6);
    for (var i = 0; i < 6; i++) {
        packet[i] = 0xFF;
    }
    for (var j = 0; j < 16; j++) {
        macBuf.copy(packet, 6 + j * 6);
    }
    return packet;
}

var NET_CHECK_INTERVAL_MS = 3000;
var NET_CHECK_TIMEOUT_MS = 5 * 60 * 1000;

function isConnectedPayload(res) {
    if (!res) { return false; }
    var state = String(res.state || '').toLowerCase();
    var inetState = String(res.internetConnectionState || '').toLowerCase();
    return res.connected === true || res.connected === 'connected' ||
        (res.wired && (res.wired.connected === true ||
            String(res.wired.state || '').toLowerCase() === 'connected')) ||
        (res.wifi && (res.wifi.connected === true ||
            String(res.wifi.state || '').toLowerCase() === 'connected')) ||
        state === 'connected' || state === 'ipv4' || state === 'ipv6' ||
        inetState === 'connected';
}

function networkReady(cb) {
    lunaCall(CONN_URI, 'getStatus', {}, function (res) {
        cb(isConnectedPayload(res));
    }, 3000);
}

function sendWOLWhenNetworkReady(cfg, cb) {
    var deadline = Date.now() + NET_CHECK_TIMEOUT_MS;
    var done = false;

    function finish(err) {
        if (done) { return; }
        done = true;
        if (cb) { cb(err); }
    }

    function checkAndSend() {
        if (Date.now() > deadline) {
            finish(new Error('network not ready within 5 minutes'));
            return;
        }
        networkReady(function (ok) {
            if (done) { return; }
            if (ok) {
                sendWOL(cfg, function (err) { finish(err); });
            } else {
                setTimeout(checkAndSend, NET_CHECK_INTERVAL_MS);
            }
        });
    }
    checkAndSend();
}

function sendWOL(cfg, cb) {
    var packet;
    try {
        packet = buildMagicPacket(cfg.mac);
    } catch (e) {
        cb(e);
        return;
    }

    var host = (cfg.ip || DEFAULT_CONFIG.ip).toString();
    var port = cfg.port || DEFAULT_CONFIG.port;
    var socket = dgram.createSocket('udp4');
    var done = false;

    function finish(err) {
        if (done) { return; }
        done = true;
        try { socket.close(); } catch (e) { }
        cb(err);
    }

    socket.on('error', function (err) {
        finish(err);
    });

    socket.bind(function () {
        try {
            if (cfg.broadcast !== false) {
                socket.setBroadcast(true);
            }
            socket.send(packet, 0, packet.length, port, host, function (err) {
                if (err) {
                    finish(err);
                } else {
                    finish(null);
                }
            });
        } catch (e) {
            finish(e);
        }
    });
}

function recordSend(ok, error, reason) {
    lastSend = { at: Date.now(), ok: ok, error: error || '', reason: reason || '' };
}

function sendMagicPacket(cfg, reason, cb) {
    if (!cfg) { cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }
    sendWOLWhenNetworkReady(cfg, function (err) {
        recordSend(!err, err && err.message, reason);
        console.log('magic packet sent reason=' + reason + ' ok=' + !err + (err ? ' error=' + err.message : ''));
        rememberEvent('发送魔术包 ' + (err ? '失败' : '成功'));
        if (cb) { cb(err); }
    });
}

function ackPowerPrepare(ackMethod, triggerMethod, timestamp) {
    lunaCall(TVPOWER_URI, ackMethod, {
        clientName: SERVICE_NAME,
        ack: true,
        timestamp: String(timestamp || Date.now())
    }, function (res) {
        console.log('ack ' + ackMethod + ' for ' + triggerMethod + ': ' + JSON.stringify(res));
    }, 3000);
}

var lastTriggerAt = 0;

function triggerWake(reason, detail) {
    if (!FEATURE.wake) { return; }
    var now = Date.now();
    if (now - lastTriggerAt < 30000) {
        console.log('power trigger ignored (duplicate): ' + reason);
        return;
    }
    lastTriggerAt = now;
    power.eventCount++;
    power.lastEvent = { reason: reason, at: now, detail: detail || null };
    rememberEvent(reason + ' @ ' + nowIso());
    console.log('power trigger: ' + reason + ' detail=' + JSON.stringify(detail || null));
    loadConfig(function (err, cfg) {
        sendMagicPacket(cfg, reason, function () { });
    });
}

function registerPowerTrigger(trigger) {
    var state = power.triggers[trigger.method];
    if (state && state.subscribed) { return; }
    if (!state) {
        state = { subscribed: false, at: 0, events: 0, error: '', ack: trigger.ack, wake: trigger.wake };
        power.triggers[trigger.method] = state;
    }
    state.at = Date.now();
    var subscription;
    try {
        subscription = service.subscribe(TVPOWER_URI + '/' + trigger.method, {
            clientName: SERVICE_NAME,
            subscribe: true
        });
    } catch (e) {
        state.error = String(e && e.message || e);
        console.log('subscribe ' + trigger.method + ' failed: ' + state.error);
        return;
    }
    subscription.on('response', function (message) {
        var payload = (message && message.payload) || {};
        if (payload.subscribed === true && !state.subscribed) {
            state.subscribed = true;
            state.error = '';
            console.log('registered for ' + trigger.method);
            return;
        }
        state.events++;
        console.log('power event ' + trigger.method + ': ' + JSON.stringify(payload));
        if (!trigger.wake) { return; }
        ackPowerPrepare(trigger.ack, trigger.method, payload.timestamp);
        rememberEvent('收到 ' + trigger.method);
        triggerWake(trigger.method === 'registerPrepareResume' ? 'resume' : 'powerOn', payload);
    });
    subscription.on('cancel', function () {
        state.subscribed = false;
        console.log('subscription cancelled: ' + trigger.method);
        setTimeout(function () { registerPowerTrigger(trigger); }, 5000);
    });
}

function registerPowerTriggers() {
    for (var i = 0; i < POWER_TRIGGERS.length; i++) {
        registerPowerTrigger(POWER_TRIGGERS[i]);
    }
}

// tvpower 开机/恢复订阅由唤醒功能持有：
// 订阅断开后由 watchdog 每 60 秒自动补上。
var powerWatchdog = null;

function ensurePowerTriggers() {
    registerPowerTriggers();
    if (!powerWatchdog) {
        powerWatchdog = setInterval(function () {
            if (wakeStarted) { registerPowerTriggers(); }
        }, 60 * 1000);
    }
}

function maybeStopPowerTriggers() {
    if (!wakeStarted && powerWatchdog) {
        clearInterval(powerWatchdog);
        powerWatchdog = null;
    }
}

function registerIncomingHooks() {
    var hooks = [
        { method: 'registerPreparePowerOn', ack: 'responsePreparePowerOn', wake: true },
        { method: 'preparePowerOn', ack: 'responsePreparePowerOn', wake: true },
        { method: 'registerPrepareResume', ack: 'responsePrepareResume', wake: true },
        { method: 'prepareResume', ack: 'responsePrepareResume', wake: true }
    ];
    hooks.forEach(function (hook) {
        service.register(hook.method, function (message) {
            var payload = (message && message.payload) || {};
            console.log('incoming ' + hook.method + ': ' + JSON.stringify(payload));
            message.respond({ returnValue: true, received: hook.method });
            if (hook.wake) {
                ackPowerPrepare(hook.ack, hook.method, payload.timestamp);
                triggerWake(hook.method.indexOf('Resume') >= 0 ? 'resume' : 'powerOn', payload);
            }
        });
    });
}

var residentActivity = null;

function keepResident() {
    if (residentActivity) { return; }
    try {
        residentActivity = service.activityManager.create('wol-resident', function (activity) {
            resident.ok = true;
            resident.at = Date.now();
            resident.error = '';
            resident.activityId = (activity && activity.activityId) || '';
            console.log('resident activity created: ' + JSON.stringify(activity));
        });
    } catch (e) {
        resident.ok = false;
        resident.error = String(e && e.message || e);
        console.log('resident activity failed: ' + resident.error);
    }
}

function ensurePersistActivity() {
    lunaCall(ACTIVITY_URI, 'create', {
        activity: {
            name: SERVICE_NAME + '.persist',
            description: 'Persistent watchdog to relaunch WOL service after cold boot',
            type: { persist: true, background: true },
            callback: {
                method: 'luna://' + SERVICE_NAME + '/wake',
                params: { reason: 'boot' }
            }
        },
        start: true,
        replace: true,
        subscribe: true
    }, function (res) {
        var p = res || {};
        if (p.returnValue === false) {
            console.log('persist activity create failed: ' + (p.errorText || ''));
        }
    }, 8000);
}

function startWakeFeature() {
    if (wakeStarted) { return; }
    wakeStarted = true;
    FEATURE.wake = true;
    keepResident();
    ensurePersistActivity();
    ensurePowerTriggers();
    console.log('wake feature enabled');
}

function stopWakeFeature() {
    if (!wakeStarted) { return; }
    wakeStarted = false;
    FEATURE.wake = false;
    // Force re-subscription on next enable so a re-enabled switch starts fresh.
    for (var m in power.triggers) {
        if (Object.prototype.hasOwnProperty.call(power.triggers, m) && power.triggers[m]) {
            power.triggers[m].subscribed = false;
        }
    }
    maybeStopPowerTriggers();
    console.log('wake feature disabled');
}

// Read the feature switch from a config doc and start/stop accordingly.
function syncFeatures(cfg) {
    if (!cfg || cfg.enableWake !== false) { startWakeFeature(); } else { stopWakeFeature(); }
}

registerIncomingHooks();
loadConfig(function (err, cfg) {
    syncFeatures(cfg);
});

service.register('wake', function (message) {
    var p = message.payload || {};
    if (!FEATURE.wake) {
        message.respond({ returnValue: false, errorText: '魔术包唤醒功能已关闭', errorCode: -2 });
        return;
    }
    loadConfig(function (err, cfg) {
        if (p.mac) { cfg.mac = p.mac; }
        if (p.ip) { cfg.ip = p.ip; }
        if (p.port) { cfg.port = p.port; }

        function respond(sendErr) {
            if (sendErr) {
                message.respond({ returnValue: false, errorText: sendErr.message, errorCode: -1 });
            } else {
                message.respond({ returnValue: true, sent: true });
            }
        }

        sendMagicPacket(cfg, p.reason || 'boot', function (sendErr) {
            respond(sendErr);
        });
    });
});

service.register('getConfig', function (message) {
    loadConfig(function (err, cfg) {
        if (err) {
            message.respond({ returnValue: false, errorText: String(err.errorText || err) });
        } else {
            message.respond({ returnValue: true, config: cfg });
        }
    });
});

service.register('setConfig', function (message) {
    var p = message.payload || {};
    try {
        if (!p.mac) {
            message.respond({ returnValue: false, errorText: 'mac is required' });
            return;
        }
        saveConfig(p, function (saveErr, saved) {
            if (saveErr) {
                message.respond({ returnValue: false, errorText: String(saveErr.errorText || saveErr) });
            } else {
                // Apply feature switches immediately so a change takes effect without a restart.
                syncFeatures(saved);
                message.respond({ returnValue: true, config: saved });
            }
        });
    } catch (e) {
        message.respond({ returnValue: false, errorText: String(e && e.message || e) });
    }
});

service.register('getStatus', function (message) {
    message.respond({
        returnValue: true,
        lastSend: lastSend,
        startedAt: startedAt,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        resident: resident,
        power: power,
        features: { wake: FEATURE.wake }
    });
});

service.register('scan', function (message) {
    var responded = false;
    var timer = setTimeout(function () {
        if (!responded) {
            responded = true;
            message.respond({ returnValue: false, errorText: 'scan timed out' });
        }
    }, 45000);

    scanDevices(function (err, res) {
        if (responded) { return; }
        responded = true;
        clearTimeout(timer);
        if (err) {
            message.respond({ returnValue: false, errorText: String(err.errorText || err) });
        } else {
            message.respond({ returnValue: true, devices: res.devices, broadcast: res.broadcast });
        }
    });
});
