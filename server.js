const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Try to load robotjs - if it fails, we'll work without it
let robot = null;
try {
    robot = require('robotjs');
    console.log('✅ RobotJS loaded successfully');
} catch (error) {
    console.log('⚠️  RobotJS not available - remote control will be simulated');
}

// Determine base directory (works with pkg)
const BASE_DIR = path.dirname(require.main?.filename || process.argv[1]);
// Under pkg, BASE_DIR points inside the read-only snapshot: fine for bundled
// assets (index.html), but anything the server must CREATE (user config.ini,
// generated TLS certs) goes to DATA_DIR — next to the .exe, always writable.
const IS_PKG = typeof process.pkg !== 'undefined';
const DATA_DIR = IS_PKG ? path.dirname(process.execPath) : BASE_DIR;

// Minimal INI parser (sections, key=value, ;/# comments). No dependencies.
function parseIni(text) {
    const out = {};
    let section = null;
    text.split(/\r?\n/).forEach((raw) => {
        const line = raw.trim();
        if (!line || line.startsWith(';') || line.startsWith('#')) return;
        const sm = line.match(/^\[(.+)\]$/);
        if (sm) {
            section = sm[1].trim().toLowerCase();
            out[section] = out[section] || {};
            return;
        }
        const eq = line.indexOf('=');
        if (eq === -1 || !section) return;
        let val = line.slice(eq + 1).trim();
        if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'")))) {
            val = val.slice(1, -1);
        }
        out[section][line.slice(0, eq).trim().toLowerCase()] = val;
    });
    return out;
}

// Server settings live in config.ini (CONFIG path, or next to the server/exe).
// Precedence: environment variables > config.ini > built-in defaults.
// On first boot the template below is written next to the server/exe so the
// user always has an editable config.ini (inside a pkg snapshot it would be
// read-only and invisible).
const DEFAULT_CONFIG_TEXT = `; Remote Desktop Server configuration
; Lines starting with ; or # are comments.
; Precedence: environment variables > this file > built-in defaults.
; Env overrides: PORT, HOST, ALLOW_CONTROL, AUTOSHARE, VERBOSE,
;   SSL_KEY, SSL_CERT, SSL_NO_AUTO,
;   VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_FPS,
;   FALLBACK_FPS, FALLBACK_WIDTH, FALLBACK_QUALITY, FALLBACK_WATCHDOG_MS,
;   CONFIG (custom path).

[server]
; TCP port to listen on
port = 9000
; Interface to bind: 0.0.0.0 = all interfaces, or pin one IP (e.g. 192.168.1.2).
; A pinned IP is the ONLY advertised address, the ONLY listened interface,
; and the ONLY name on the auto-generated certificate.
host = 0.0.0.0
; Master switch for remote control (1 = allow, 0 = view-only server:
; control packets are dropped and clients hide all control UI).
allow_control = 1
; Kiosk mode for the host page (1 = clicking Host starts screen capture
; at once, sidebar hidden, stop button + join link move to the header).
autoshare = 0
; Verbose logging (1 = full chatter: WS messages, ICE, HTTP hits, keys).
; Warnings and errors always print.
verbose = 0

[video]
; Capture request for getDisplayMedia on the host (ideal values —
; the browser may settle lower if the screen/source cannot provide them).
width = 1920
height = 1080
fps = 30

[fallback]
; WS-relay (MJPEG) used when a viewer's WebRTC ICE is blocked.
; Lower fps/width/quality = less host CPU and traffic.
fps = 5
width = 1280
quality = 0.6
; ICE silence before the viewer asks for relay, milliseconds.
watchdog_ms = 8000

[ssl]
; Paths to TLS key/cert (absolute or relative to the server directory).
; Missing files are auto-generated self-signed on first boot.
key = ssl/key.pem
cert = ssl/cert.pem
; Set to 1 to disable auto-generation and stay on plain HTTP
; (screen sharing will then work only via localhost)
no_auto = 0
`;

function resolveConfigPath() {
    if (process.env.CONFIG) return process.env.CONFIG;
    const userPath = path.join(DATA_DIR, 'config.ini');
    try {
        if (!fs.existsSync(userPath)) {
            // Prefer the bundled template (pkg snapshot) when available.
            let template = null;
            try {
                const snapPath = path.join(BASE_DIR, 'config.ini');
                if (snapPath !== userPath && fs.existsSync(snapPath)) {
                    template = fs.readFileSync(snapPath, 'utf-8');
                }
            } catch (e) { /* ignore - fall back to embedded template */ }
            fs.mkdirSync(path.dirname(userPath), { recursive: true });
            fs.writeFileSync(userPath, template || DEFAULT_CONFIG_TEXT);
            console.log(`📝 Created default config.ini at ${userPath}`);
        }
    } catch (error) {
        console.log(`⚠️  Could not create default config.ini: ${error.message}`);
    }
    return userPath;
}

function loadConfig() {
    const cfgPath = resolveConfigPath();
    let ini = {};
    try {
        if (fs.existsSync(cfgPath)) {
            ini = parseIni(fs.readFileSync(cfgPath, 'utf-8'));
        } else {
            console.log(`ℹ️  config.ini not found at ${cfgPath} - using defaults`);
        }
    } catch (error) {
        console.log(`⚠️  Could not read config.ini: ${error.message} - using defaults`);
    }
    const srv = ini.server || {};
    const ssl = ini.ssl || {};
    const vid = ini.video || {};
    const fb = ini.fallback || {};
    // Writable-relative paths resolve against DATA_DIR (exe-adjacent under pkg).
    const resolvePath = (p) => (path.isAbsolute(p) ? p : path.join(DATA_DIR, p));
    // Clamped number: garbage/empty config values fall back to defaults
    // instead of breaking capture or flooding the host.
    const num = (v, def, min, max) => {
        const n = parseFloat(v);
        if (!Number.isFinite(n)) return def;
        return Math.min(max, Math.max(min, n));
    };
    const round = (v, def, min, max) => Math.round(num(v, def, min, max));
    return {
        path: cfgPath,
        port: parseInt(process.env.PORT || srv.port || '9000', 10) || 9000,
        host: process.env.HOST || srv.host || '0.0.0.0',
        sslKey: resolvePath(process.env.SSL_KEY || ssl.key || 'ssl/key.pem'),
        sslCert: resolvePath(process.env.SSL_CERT || ssl.cert || 'ssl/cert.pem'),
        sslNoAuto: ['1', 'true', 'yes', 'on'].includes(
            String(process.env.SSL_NO_AUTO || ssl.no_auto || '0').toLowerCase()),
        verbose: ['1', 'true', 'yes', 'on'].includes(
            String(process.env.VERBOSE || srv.verbose || '0').toLowerCase()),
        // Master kill-switch for remote control (view-only server when off).
        allowControl: !['0', 'false', 'no', 'off'].includes(
            String(process.env.ALLOW_CONTROL || srv.allow_control || '1').toLowerCase()),
        // Kiosk mode: Host role starts capture immediately, no sidebar.
        autoshare: ['1', 'true', 'yes', 'on'].includes(
            String(process.env.AUTOSHARE || srv.autoshare || '0').toLowerCase()),
        // Capture request pushed to all hosts (getDisplayMedia ideals).
        video: {
            width: round(process.env.VIDEO_WIDTH || vid.width || '1920', 1920, 320, 7680),
            height: round(process.env.VIDEO_HEIGHT || vid.height || '1080', 1080, 240, 4320),
            fps: round(process.env.VIDEO_FPS || vid.fps || '30', 30, 5, 60)
        },
        // WS-relay (MJPEG) parameters pushed to hosts/viewers.
        fallback: {
            fps: round(process.env.FALLBACK_FPS || fb.fps || '5', 5, 1, 15),
            width: round(process.env.FALLBACK_WIDTH || fb.width || '1280', 1280, 320, 3840),
            quality: num(process.env.FALLBACK_QUALITY || fb.quality || '0.6', 0.6, 0.1, 1),
            watchdogMs: round(process.env.FALLBACK_WATCHDOG_MS || fb.watchdog_ms || '8000', 8000, 1000, 60000)
        }
    };
}
const CONFIG = loadConfig();
console.log(`⚙️  Config: ${CONFIG.path} (port=${CONFIG.port}, host=${CONFIG.host})`);
console.log(`🎥 Capture ${CONFIG.video.width}x${CONFIG.video.height}@${CONFIG.video.fps}fps, relay ${CONFIG.fallback.width}px@${CONFIG.fallback.fps}fps q=${CONFIG.fallback.quality} (watchdog ${CONFIG.fallback.watchdogMs}ms)`);
console.log(CONFIG.allowControl
    ? '🎮 Remote control ENABLED'
    : '👁  Remote control DISABLED by config - view-only server');

// Verbose-only logging for high-frequency/routine chatter (candidates,
// HTTP hits, per-key events). Warnings and errors always print.
function vlog(...args) {
    if (CONFIG.verbose) console.log(...args);
}

// Use environment variable or default port
const PORT = CONFIG.port;
const HOST = CONFIG.host;

// Optional TLS: browsers expose screen capture (getDisplayMedia) only in
// secure contexts (https://, localhost). Plain http://<lan-ip> hides
// navigator.mediaDevices entirely. Certs are auto-generated on first boot
// ([ssl] key/cert in config.ini) so LAN sharing works out of the box;
// set [ssl] no_auto=1 (or SSL_NO_AUTO=1) to keep plain HTTP.
// True for IPv4/IPv6 literals (go to SAN as type 7), false for DNS names (type 2).
function isIpLiteral(v) {
    return /^[0-9a-fA-F:.]+$/.test(v || '') && /[0-9]/.test(v || '');
}

// Specific bind address from config.ini ([server] host), or null when the
// server listens on all interfaces (0.0.0.0 / ::).
function boundHostName() {
    const h = (CONFIG.host || '').trim();
    if (!h || h === '0.0.0.0' || h === '::') return null;
    return h;
}

function ensureTLSCerts() {
    const keyPath = CONFIG.sslKey;
    const certPath = CONFIG.sslCert;
    try {
        if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
            return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), auto: false };
        }
    } catch (error) {
        console.log(`⚠️  Could not load TLS certs: ${error.message}`);
    }
    if (CONFIG.sslNoAuto) return null;
    let selfsigned = null;
    try {
        selfsigned = require('selfsigned');
    } catch (error) {
        console.log('⚠️  "selfsigned" module missing - run `npm install` for auto HTTPS');
        return null;
    }
    try {
        fs.mkdirSync(path.dirname(keyPath), { recursive: true });
        // If config pins a specific bind address, the cert is issued for it
        // (and only it) instead of every local interface.
        const bound = boundHostName();
        const ips = bound ? [bound] : getLocalIPs();
        const cn = bound || ips[0] || 'localhost';
        const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }];
        ips.forEach((ip) => {
            if (isIpLiteral(ip)) {
                if (!altNames.some((a) => a.ip === ip)) altNames.push({ type: 7, ip });
            } else if (!altNames.some((a) => a.value === ip)) {
                altNames.push({ type: 2, value: ip });
            }
        });
        const pems = selfsigned.generate([{ name: 'commonName', value: cn }], {
            keySize: 2048,
            days: 825,
            algorithm: 'sha256',
            extensions: [{ name: 'subjectAltName', altNames }]
        });
        fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
        fs.writeFileSync(certPath, pems.cert);
        console.log(`🔒 Auto-generated self-signed cert (CN=${cn}) at ${path.dirname(keyPath)}`);
        console.log('   Browsers will show a warning on first open - accept it once.');
        return { key: pems.private, cert: pems.cert, auto: true };
    } catch (error) {
        console.log(`⚠️  Auto cert generation failed: ${error.message}`);
        return null;
    }
}
const TLS_OPTIONS = ensureTLSCerts();
const USE_HTTPS = !!TLS_OPTIONS;
if (USE_HTTPS) {
    console.log('🔒 TLS certificates found - serving HTTPS (LAN screen sharing enabled)');
}

// Primary join URL for viewer deep links (?host=N): pinned host IP,
// else the first LAN address (localhost is useless to other machines).
const JOIN_BASE = (() => {
    const ip = (HOST && HOST !== '0.0.0.0') ? HOST : (getLocalIPs()[0] || 'localhost');
    return `${USE_HTTPS ? 'https' : 'http'}://${ip}:${PORT}`;
})();
console.log(`🔗 Viewer join base: ${JOIN_BASE}/?host=<id>`);

// Create HTTP(S) server to serve static files
const requestHandler = (req, res) => {
    // Print request info for debugging
    vlog(`Received request for: ${req.url} from ${req.socket.remoteAddress}`);
    
    // Handle static file requests. Strip query/hash: deep links like
    // /?host=3 must serve index.html, not a file literally named "?host=3".
    let urlPath = (req.url || '/').split('?')[0].split('#')[0];
    try { urlPath = decodeURIComponent(urlPath); } catch (e) { /* keep raw */ }
    let filePath = path.join(BASE_DIR, urlPath);
    if (urlPath === '/' || urlPath === '') {
        filePath = path.join(BASE_DIR, 'index.html');
    }
    // Never escape the snapshot dir (e.g. /../config.ini).
    if (path.relative(BASE_DIR, filePath).startsWith('..')) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }
    
    // Get the file extension
    const extname = path.extname(filePath);
    let contentType = 'text/html';
    
    // Set proper content type
    switch (extname) {
        case '.js':
            contentType = 'text/javascript';
            break;
        case '.css':
            contentType = 'text/css';
            break;
        case '.json':
            contentType = 'application/json';
            break;
        case '.png':
            contentType = 'image/png';
            break;
        case '.jpg':
        case '.jpeg':
            contentType = 'image/jpeg';
            break;
    }
    
    // Read the file
    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404);
                res.end(`File not found: ${filePath}`);
            } else {
                res.writeHead(500);
                res.end(`Server error: ${error.code}`);
            }
        } else {
            // Never cache: index.html carries the whole app inline, and a
            // stale cached copy looks exactly like "the fix didn't work".
            res.writeHead(200, {
                'Content-Type': contentType,
                'Cache-Control': 'no-store, no-cache, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            res.end(content, 'utf-8');
        }
    });
};

const server = USE_HTTPS
    ? https.createServer(TLS_OPTIONS, requestHandler)
    : http.createServer(requestHandler);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Increase max listeners to avoid warning (pkg bundles can cause this)
wss.setMaxListeners(20);

// Store connected clients
const clients = new Map();
let clientIdCounter = 0;

// Store hosts and viewers
const hosts = new Map();
const viewers = new Map();

// Performance optimization: Direct peer references
const clientPeers = new Map(); // Maps clientId to their peer's client object

// Performance optimization: Mouse movement batching
const mouseState = new Map(); // Track last mouse position for each client
const MOUSE_THRESHOLD = 2; // Minimum pixel change to process

// Performance optimization: Modifier key state caching
const keyboardState = new Map(); // Track modifier keys state for each client

// Performance optimization: Event priority handling
const EVENT_PRIORITIES = {
    'mousemove': 1, // Highest priority (lowest number)
    'wheel': 2,
    'mousedown': 3,
    'mouseup': 3,
    'click': 4,
    'rightclick': 4,
    'keydown': 5,
    'keyup': 5
};

// Get local IP addresses
function getLocalIPs() {
    const interfaces = os.networkInterfaces();
    const addresses = [];
    
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                addresses.push(iface.address);
            }
        }
    }
    
    return addresses;
}

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
    const clientId = ++clientIdCounter;
    const clientIp = req.socket.remoteAddress;
    
    console.log(`[Client ${clientId}] Connected from ${clientIp}`);
    
    // Performance optimization: Set binary type for WebSocket
    ws.binaryType = 'arraybuffer';
    
    // Store client
    const client = {
        id: clientId,
        ws: ws,
        role: null,
        ip: clientIp,
        ready: false,
        // Performance optimization: Track last event time
        lastEventTime: Date.now(),
        // Performance optimization: Event queue for priority handling
        eventQueue: []
    };
    
    clients.set(clientId, client);
    
    // Initialize tracking states
    mouseState.set(clientId, { x: 0, y: 0, lastUpdate: 0 });
    keyboardState.set(clientId, {
        shift: false,
        control: false,
        alt: false,
        command: false
    });
    
    // Handle messages
    ws.on('message', (message) => {
        try {
            // Performance optimization: Handle binary messages for mouse movement
            if (message instanceof ArrayBuffer) {
                if (client.role === 'client' && message.byteLength === 8) {
                    const view = new Float32Array(message);
                    handleBinaryMouseMove(client, {
                        x: view[0],
                        y: view[1]
                    });
                    return;
                }
            }
            
            const data = JSON.parse(message);
            // Routine chatter only in verbose mode (see config.ini [server] verbose).
            vlog(`[Client ${clientId}] Message: ${data.type}`);
            
            // Performance optimization: Update last event time
            client.lastEventTime = Date.now();
            
            switch(data.type) {
                case 'register':
                    handleRegister(client, data);
                    break;
                    
                case 'host-ready':
                    handleHostReady(client);
                    break;
                    
                case 'host-stopped':
                    handleHostStopped(client);
                    break;
                    
                case 'connect-to-host':
                    handleConnectToHost(client, data);
                    break;
                    
                case 'offer':
                    handleOffer(client, data);
                    break;
                    
                case 'answer':
                    handleAnswer(client, data);
                    break;
                    
                case 'ice-candidate':
                    handleIceCandidate(client, data);
                    break;
                    
                case 'control':
                    // Mousemove is idempotent and high-frequency: handle it
                    // immediately. Queueing it made thousands of moves pile up
                    // (one processed per tick + full sort per message), so the
                    // remote cursor lagged seconds behind and clicks/keys
                    // starved behind the backlog - looking "not transmitted".
                    if (data.action === 'mousemove') {
                        handleControl(client, data);
                    } else if (EVENT_PRIORITIES[data.action]) {
                        client.eventQueue.push(data);
                        // Cap the queue: a flooding client must not grow it
                        // unbounded (each push used to trigger a full sort).
                        if (client.eventQueue.length > 100) {
                            client.eventQueue.splice(0, client.eventQueue.length - 100);
                        }
                        processEventQueue(client);
                    } else {
                        handleControl(client, data);
                    }
                    break;

                case 'request-fallback':
                case 'stop-fallback':
                case 'screen-frame':
                    // WS relay fallback for WebRTC-blocked networks (zero ICE
                    // candidates in browser). Route by targetId, broadcast to
                    // opposite role when target is missing/stale.
                    forwardToPeer(client, data);
                    break;
            }
        } catch (error) {
            console.error(`[Client ${clientId}] Error:`, error);
        }
    });
    
    // Handle disconnect
    ws.on('close', () => {
        console.log(`[Client ${clientId}] Disconnected`);
        
        // Remove from maps
        if (client.role === 'host') {
            hosts.delete(clientId);

            // Refresh remaining viewers' host lists
            broadcastHostList();

            // Notify all viewers
            viewers.forEach((viewer) => {
                sendToClient(viewer, {
                    type: 'host-disconnected',
                    hostId: clientId
                });
            });
        } else if (client.role === 'client') {
            viewers.delete(clientId);
        }
        
        // Performance optimization: Clean up all client-related resources
        clients.delete(clientId);
        mouseState.delete(clientId);
        keyboardState.delete(clientId);
        
        // Clean up peer references
        if (clientPeers.has(clientId)) {
            clientPeers.delete(clientId);
        }
    });
    
    // Handle errors
    ws.on('error', (error) => {
        console.error(`[Client ${clientId}] WebSocket error:`, error);
    });
});

// Process queued discrete input events (clicks/keys/wheel) in priority order.
// Bounded synchronous drain: no setImmediate chain per event, no parallel
// pumps from concurrent messages, leftover work rescheduled once.
function processEventQueue(client) {
    if (client._pumping) return;
    client._pumping = true;
    try {
        let n = 0;
        while (client.eventQueue.length > 0 && n < 50) {
            // Sort queue by priority
            client.eventQueue.sort((a, b) =>
                (EVENT_PRIORITIES[a.action] || 99) - (EVENT_PRIORITIES[b.action] || 99)
            );

            // Process highest priority event
            const event = client.eventQueue.shift();
            handleControl(client, event);
            n++;
        }
    } finally {
        client._pumping = false;
    }

    // If there are more events, continue in the next tick
    if (client.eventQueue.length > 0) {
        setImmediate(() => processEventQueue(client));
    }
}

// Handle binary mouse move data
function handleBinaryMouseMove(client, data) {
    // Only process if client role is correct
    if (client.role !== 'client') return;
    // View-only server: drop all remote input at the gate.
    if (!CONFIG.allowControl) return;
    
    // Performance optimization: UDP-style delivery (drop if too frequent)
    const now = Date.now();
    const lastState = mouseState.get(client.id);
    
    // Drop events that come too quickly (5ms threshold)
    if (now - lastState.lastUpdate < 5) return;
    
    // Performance optimization: Skip if movement is below threshold
    const screenSize = robot ? robot.getScreenSize() : { width: 1920, height: 1080 };
    const newX = Math.round(data.x * screenSize.width);
    const newY = Math.round(data.y * screenSize.height);
    
    const deltaX = Math.abs(newX - lastState.x);
    const deltaY = Math.abs(newY - lastState.y);
    
    if (deltaX < MOUSE_THRESHOLD && deltaY < MOUSE_THRESHOLD) return;
    
    // Update state
    mouseState.set(client.id, {
        x: newX,
        y: newY,
        lastUpdate: now
    });
    
    // Create minimal control data for forwarding
    const minimalData = {
        action: 'mousemove',
        x: data.x,
        y: data.y
    };
    
    // Forward to all hosts with minimal data
    hosts.forEach((host) => {
        sendToClient(host, {
            type: 'control',
            ...minimalData,
            fromId: client.id
        });
    });
    
    // If robotjs is available, perform the action
    if (robot) {
        try {
            robot.moveMouse(newX, newY);
        } catch (error) {
            console.error(`RobotJS error: ${error.message}`, error);
        }
    }
}

// Send message to specific client
function sendToClient(client, data) {
    if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(data));
    }
}

// Forward a message to one peer by targetId, or to all opposite-role
// peers when targetId is missing/stale. Adds fromId so receiver knows
// who to answer (fallback frames, fallback requests).
function forwardToPeer(client, data) {
    const payload = { ...data, fromId: client.id };
    if (data.targetId) {
        const target = clients.get(parseInt(data.targetId));
        if (target && target.ws.readyState === WebSocket.OPEN) {
            sendToClient(target, payload);
            return;
        }
        console.log(`[Client ${client.id}] ${data.type} target ${data.targetId} missing, broadcasting`);
    }
    clients.forEach((other) => {
        if (other.id !== client.id && other.role !== client.role && other.ws.readyState === WebSocket.OPEN) {
            sendToClient(other, payload);
        }
    });
}

// True when the address belongs to this machine (loopback or a local NIC).
function isLocalAddress(ip) {
    const n = normIp(ip);
    if (n === '127.0.0.1' || n === '::1' || n === 'localhost') return true;
    try {
        return getLocalIPs().includes(n);
    } catch (e) {
        return false;
    }
}

// Normalize socket address for display: ::ffff:192.168.1.5 -> 192.168.1.5
function normIp(ip) {
    if (!ip) return 'unknown';
    if (ip.startsWith('::ffff:')) return ip.slice(7);
    return ip;
}

// Snapshot of sharing hosts for the viewer host list.
// `local` tells the viewer whether remote control can work (RobotJS runs
// on THIS server machine, so only a host on the same machine is steerable).
function getHostList() {
    const list = [];
    hosts.forEach((host) => {
        if (host.ready) {
            list.push({ hostId: host.id, ip: normIp(host.ip), local: !!host.isLocal });
        }
    });
    return list;
}

// Push current host list to all viewers (called on ready/stop/disconnect).
function broadcastHostList() {
    const hosts_list = getHostList();
    viewers.forEach((viewer) => {
        sendToClient(viewer, {
            type: 'host-list',
            hosts: hosts_list
        });
    });
}

// Handle registration
function handleRegister(client, data) {
    client.role = data.role;
    // Whether this peer runs on the server machine: RobotJS can only move
    // the cursor HERE, so remote control of this peer is possible.
    client.isLocal = isLocalAddress(client.ip);

    if (data.role === 'host') {
        hosts.set(client.id, client);
        console.log(`[Client ${client.id}] Registered as HOST from ${normIp(client.ip)} (hosts online: ${hosts.size})`);
        broadcastHostList();
    } else if (data.role === 'client') {
        viewers.set(client.id, client);
        console.log(`[Client ${client.id}] Registered as CLIENT (viewers online: ${viewers.size})`);

        // Send current host list (IP addresses) to the new viewer
        sendToClient(client, {
            type: 'host-list',
            hosts: getHostList()
        });

        // Check if any host is ready
        hosts.forEach((host) => {
            if (host.ready) {
                sendToClient(client, {
                    type: 'host-available',
                    hostId: host.id,
                    hostLocal: !!host.isLocal
                });

                // Tell host about the viewer
                sendToClient(host, {
                    type: 'client-joined',
                    clientId: client.id
                });
            }
        });
    }

    // Send confirmation (host panel shows IP instead of numeric session id)
    sendToClient(client, {
        type: 'registered',
        clientId: client.id,
        role: client.role,
        ip: normIp(client.ip),
        // Global control kill-switch: clients hide all control UI when false.
        allowControl: CONFIG.allowControl,
        // Kiosk mode for the host page (autostart capture, no sidebar).
        autoshare: CONFIG.autoshare,
        // Base URL for viewer deep links (?host=N) shown in the header.
        joinBase: JOIN_BASE,
        // Tunable streaming settings from config.ini ([video]/[fallback]).
        settings: { video: CONFIG.video, fallback: CONFIG.fallback }
    });
}

// Handle host ready
function handleHostReady(host) {
    host.ready = true;
    console.log(`[Host ${host.id}] Ready to share`);

    // Refresh viewer host lists (IP addresses)
    broadcastHostList();

    // Notify all viewers
    viewers.forEach((viewer) => {
        sendToClient(viewer, {
            type: 'host-available',
            hostId: host.id,
            hostLocal: !!host.isLocal
        });

        // Tell host about the viewer
        sendToClient(host, {
            type: 'client-joined',
            clientId: viewer.id
        });
    });
}

// Handle host stopped
function handleHostStopped(host) {
    host.ready = false;
    console.log(`[Host ${host.id}] Stopped sharing`);

    // Refresh viewer host lists (host disappeared)
    broadcastHostList();

    // Notify all viewers
    viewers.forEach((viewer) => {
        sendToClient(viewer, {
            type: 'host-stopped',
            hostId: host.id
        });
    });
}

// Handle connect to host
function handleConnectToHost(client, data) {
    console.log(`[Client ${client.id}] Trying to connect to host: ${data.hostId}`);
    
    const host = clients.get(parseInt(data.hostId));
    if (host && host.role === 'host' && host.ready) {
        console.log(`[Client ${client.id}] Host found and ready`);

        // Tell client about host
        sendToClient(client, {
            type: 'host-available',
            hostId: host.id,
            hostLocal: !!host.isLocal
        });
        
        // Tell host about client
        sendToClient(host, {
            type: 'client-joined',
            clientId: client.id
        });
    } else {
        console.log(`[Client ${client.id}] Host not found or not ready`);
        sendToClient(client, {
            type: 'error',
            message: 'Host not found or not ready'
        });
    }
}

// Handle WebRTC offer
function handleOffer(client, data) {
    const targetId = data.targetId || findPeerForClient(client.id);
    vlog(`[Client ${client.id}] Sending offer to ${targetId} (role: ${client.role})`);
    
    const target = clients.get(parseInt(targetId));
    if (target && target.ws.readyState === WebSocket.OPEN) {
        // Performance optimization: Store direct peer reference
        clientPeers.set(client.id, target);
        clientPeers.set(target.id, client);
        
        vlog(`[Server] Forwarding offer from ${client.id} (${client.role}) to ${target.id} (${target.role})`);
        sendToClient(target, {
            type: 'offer',
            offer: data.offer,
            fromId: client.id
        });
    } else {
        console.log(`[Client ${client.id}] Target ${targetId} not found or not connected`);
    }
}

// Helper to find a peer for a client
function findPeerForClient(clientId) {
    const client = clients.get(clientId);
    if (!client) return null;
    
    if (client.role === 'host') {
        // Find the first viewer
        for (const [id, viewer] of viewers) {
            return id;
        }
    } else {
        // Find the first host
        for (const [id, host] of hosts) {
            if (host.ready) {
                return id;
            }
        }
    }
    
    return null;
}

// Handle WebRTC answer
function handleAnswer(client, data) {
    const targetId = data.targetId || findPeerForClient(client.id);
    vlog(`[Client ${client.id}] Sending answer to ${targetId} (role: ${client.role})`);
    
    const target = clients.get(parseInt(targetId));
    if (target && target.ws.readyState === WebSocket.OPEN) {
        vlog(`[Server] Forwarding answer from ${client.id} (${client.role}) to ${target.id} (${target.role})`);
        sendToClient(target, {
            type: 'answer',
            answer: data.answer,
            fromId: client.id
        });
    } else {
        console.log(`[Client ${client.id}] Target ${targetId} not found or not connected`);
    }
}

// Handle ICE candidate
function handleIceCandidate(client, data) {
    vlog(`[Client ${client.id}] Forwarding ICE candidate (role: ${client.role}) targetId: ${data.targetId || 'auto'}`);
    
    // Forward to specific target if provided
    if (data.targetId) {
        const target = clients.get(parseInt(data.targetId));
        if (target && target.ws.readyState === WebSocket.OPEN) {
            sendToClient(target, {
                type: 'ice-candidate',
                candidate: data.candidate,
                fromId: client.id
            });
        } else {
            // FIX: stale targetId (peer reconnected, id changed) — don't drop,
            // fall back to opposite-role broadcast so ICE can still connect.
            console.log(`[Client ${client.id}] ICE target ${data.targetId} missing, broadcasting to opposite role`);
            clients.forEach((otherClient) => {
                if (otherClient.id !== client.id && otherClient.role !== client.role && otherClient.ws.readyState === WebSocket.OPEN) {
                    sendToClient(otherClient, {
                        type: 'ice-candidate',
                        candidate: data.candidate,
                        fromId: client.id
                    });
                }
            });
        }
    } else {
        // Broadcast to all clients with different role
        clients.forEach((otherClient) => {
            if (otherClient.id !== client.id && otherClient.role !== client.role) {
                sendToClient(otherClient, {
                    type: 'ice-candidate',
                    candidate: data.candidate,
                    fromId: client.id
                });
            }
        });
    }
}

// Handle remote control
// Normalized (0-1) fraction -> screen pixels, clamped to bounds.
// Returns null for garbage (NaN/Infinity/missing) so robotjs never throws
// on coordinates (a throw here used to skip the button toggle below it).
function toScreenPixels(frac, max) {
    const v = Number(frac);
    if (!Number.isFinite(v)) return null;
    return Math.min(max - 1, Math.max(0, Math.round(v * max)));
}

function handleControl(client, data) {
    if (client.role !== 'client') return;
    // View-only server: drop all remote input at the gate.
    if (!CONFIG.allowControl) {
        vlog(`[Client ${client.id}] Control dropped (allow_control=0)`);
        return;
    }

    // mousemove/wheel arrive dozens per second - don't spam the log.
    if (data.action !== 'mousemove' && data.action !== 'wheel') {
        console.log(`[Client ${client.id}] Control: ${data.action}`);
    }
    
    // Performance optimization: Create minimal data object for forwarding
    const minimalData = {
        type: 'control',
        action: data.action,
        fromId: client.id
    };
    
    // Only include necessary properties based on action type
    switch(data.action) {
        case 'mousemove':
            minimalData.x = data.x;
            minimalData.y = data.y;
            if (data.relative) {
                minimalData.relative = true;
                minimalData.deltaX = data.deltaX;
                minimalData.deltaY = data.deltaY;
            }
            break;
            
        case 'mousedown':
        case 'mouseup':
        case 'click':
        case 'rightclick':
            minimalData.x = data.x;
            minimalData.y = data.y;
            if (data.button !== undefined) minimalData.button = data.button;
            break;
            
        case 'wheel':
            minimalData.x = data.x;
            minimalData.y = data.y;
            if (data.deltaX) minimalData.deltaX = data.deltaX;
            if (data.deltaY) minimalData.deltaY = data.deltaY;
            if (data.mode !== undefined) minimalData.mode = data.mode;
            break;
            
        case 'keydown':
        case 'keyup':
            minimalData.key = data.key;
            minimalData.code = data.code;
            if (data.shiftKey) minimalData.shiftKey = true;
            if (data.ctrlKey) minimalData.ctrlKey = true;
            if (data.altKey) minimalData.altKey = true;
            if (data.metaKey) minimalData.metaKey = true;
            break;
            
        default:
            // For unknown actions, forward the original data
            Object.assign(minimalData, data);
    }
    
    // Route input to the intended host only (legacy packets without
    // targetId still go to all hosts).
    const targetId = data.targetId !== undefined && data.targetId !== null
        ? parseInt(data.targetId, 10) : NaN;
    const target = Number.isFinite(targetId) ? clients.get(targetId) : null;
    const targetHost = target && target.role === 'host' ? target : null;
    if (targetHost) {
        sendToClient(targetHost, minimalData);
    } else {
        hosts.forEach((host) => {
            sendToClient(host, minimalData);
        });
    }

    // RobotJS moves the cursor OF THIS SERVER MACHINE. Executing input for
    // a host on another machine would yank the wrong cursor (and the real
    // target would ignore it) - so run robot only when the target host IS
    // this machine. Otherwise tell the viewer to move the server.
    const targetIsLocal = targetHost ? !!targetHost.isLocal : true;
    if (targetHost && !targetIsLocal) {
        const nowMs = Date.now();
        if (!client._lastNoControlWarn || nowMs - client._lastNoControlWarn > 15000) {
            client._lastNoControlWarn = nowMs;
            const hostIp = normIp(targetHost.ip);
            console.log(`⚠️  [Client ${client.id}] Control target is host ${targetHost.id} (${hostIp}) - NOT this server machine. RobotJS skipped. Run the server ON the host for remote control.`);
            sendToClient(client, {
                type: 'control-unavailable',
                message: `Host ${hostIp} is not this server machine - remote control unavailable. Run remote-desktop on the host itself.`
            });
        }
        return;
    }

    // If robotjs is available, perform the action
    if (robot) {
        try {
            const screenSize = robot.getScreenSize();
            // Map button values: 0 = left, 1 = middle, 2 = right
            const buttonMap = ['left', 'middle', 'right'];
            
            switch(data.action) {
                case 'mousemove':
                    // Performance optimization: Skip redundant mouse movements
                    if (data.relative && typeof data.deltaX === 'number' && typeof data.deltaY === 'number') {
                        // Get current mouse position
                        const currentPos = robot.getMousePos();
                        // Calculate new position using deltas
                        const moveX = currentPos.x + Math.round(data.deltaX * screenSize.width);
                        const moveY = currentPos.y + Math.round(data.deltaY * screenSize.height);
                        
                        // Only move if delta is significant
                        const deltaX = Math.abs(moveX - currentPos.x);
                        const deltaY = Math.abs(moveY - currentPos.y);
                        
                        if (deltaX >= MOUSE_THRESHOLD || deltaY >= MOUSE_THRESHOLD) {
                            // Ensure within screen bounds
                            const boundedX = Math.max(0, Math.min(screenSize.width - 1, moveX));
                            const boundedY = Math.max(0, Math.min(screenSize.height - 1, moveY));
                            robot.moveMouse(boundedX, boundedY);
                        }
                    } else {
                        // Use absolute positioning
                        const x = toScreenPixels(data.x, screenSize.width);
                        const y = toScreenPixels(data.y, screenSize.height);
                        if (x === null || y === null) break;

                        // 1/sec trace: compare with client's [TRACE] mouse out.
                        const nowMs = Date.now();
                        if (!global._mouseTraceT || nowMs - global._mouseTraceT > 1000) {
                            global._mouseTraceT = nowMs;
                            vlog(`[TRACE] mouse in client=${client.id} frac=${data.x},${data.y} -> px=${x},${y} screen=${screenSize.width}x${screenSize.height}`);
                        }
                        // Competing senders (e.g. a stale viewer tab with cached
                        // JS) fight over the cursor and it "jumps". Detect it.
                        if (global._lastMoveFrom && global._lastMoveFrom.id !== null &&
                            global._lastMoveFrom.id !== client.id &&
                            nowMs - global._lastMoveFrom.t < 1500 &&
                            (!global._dupWarnT || nowMs - global._dupWarnT > 10000)) {
                            global._dupWarnT = nowMs;
                            console.log(`⚠️  Two viewers sending mouse input (clients ${global._lastMoveFrom.id} and ${client.id}). Close duplicate viewer tabs!`);
                        }
                        global._lastMoveFrom = { id: client.id, t: nowMs };

                        // Get current mouse position and check if movement is significant
                        const currentPos = robot.getMousePos();
                        const deltaX = Math.abs(x - currentPos.x);
                        const deltaY = Math.abs(y - currentPos.y);

                        if (deltaX >= MOUSE_THRESHOLD || deltaY >= MOUSE_THRESHOLD) {
                            robot.moveMouse(x, y);
                        }
                    }
                    break;

                case 'mousedown':
                    // Move only when coords are valid; the button toggle below
                    // must ALWAYS run so clicks are never swallowed by bad coords.
                    const downX = toScreenPixels(data.x, screenSize.width);
                    const downY = toScreenPixels(data.y, screenSize.height);
                    if (downX !== null && downY !== null) robot.moveMouse(downX, downY);

                    const button = buttonMap[data.button] || 'left';
                    vlog(`[Control] Mouse down: ${downX},${downY} button: ${button}`);
                    robot.mouseToggle('down', button);
                    break;

                case 'mouseup':
                    const upX = toScreenPixels(data.x, screenSize.width);
                    const upY = toScreenPixels(data.y, screenSize.height);
                    if (upX !== null && upY !== null) robot.moveMouse(upX, upY);

                    const upButton = buttonMap[data.button] || 'left';
                    vlog(`[Control] Mouse up: ${upX},${upY} button: ${upButton}`);
                    robot.mouseToggle('up', upButton);
                    break;

                case 'click':
                    const clickX = toScreenPixels(data.x, screenSize.width);
                    const clickY = toScreenPixels(data.y, screenSize.height);
                    if (clickX !== null && clickY !== null) robot.moveMouse(clickX, clickY);
                    robot.mouseClick(buttonMap[data.button] || 'left');
                    break;

                case 'rightclick':
                    const rclickX = toScreenPixels(data.x, screenSize.width);
                    const rclickY = toScreenPixels(data.y, screenSize.height);
                    if (rclickX !== null && rclickY !== null) robot.moveMouse(rclickX, rclickY);
                    robot.mouseClick('right');
                    break;

                case 'wheel':
                    // Handle both vertical and horizontal scrolling
                    // Ensure mouse is at the right position
                    const scrollX = toScreenPixels(data.x, screenSize.width);
                    const scrollY = toScreenPixels(data.y, screenSize.height);
                    if (scrollX !== null && scrollY !== null) robot.moveMouse(scrollX, scrollY);
                    
                    // Normalize scroll amounts - invert deltaY to match natural scroll direction
                    // Use mode to determine the scale factor (0=pixels, 1=lines, 2=pages)
                    let vScroll = 0, hScroll = 0;
                    const scaleFactor = data.mode === 1 ? 15 : data.mode === 2 ? 50 : 1;
                    
                    if (data.deltaY) {
                        // Note: robotjs expects positive values to scroll down
                        vScroll = Math.sign(data.deltaY) * Math.min(Math.abs(data.deltaY / scaleFactor), 100);
                    }
                    
                    if (data.deltaX) {
                        // Note: robotjs expects positive values to scroll right
                        hScroll = Math.sign(data.deltaX) * Math.min(Math.abs(data.deltaX / scaleFactor), 100);
                    }
                    
                    vlog(`[Control] Scroll: v=${vScroll}, h=${hScroll}`);
                    robot.scrollMouse(hScroll, vScroll);
                    break;
                
                // Performance optimization: Cached modifier state for keyboard events
                case 'keydown':
                    vlog(`[Keyboard] DOWN: ${data.key} (${data.code})`);
                    handleKeyboardEvent(client, data, true);
                    break;
                    
                case 'keyup':
                    vlog(`[Keyboard] UP: ${data.key} (${data.code})`);
                    handleKeyboardEvent(client, data, false);
                    break;
            }
        } catch (error) {
            console.error(`RobotJS error: ${error.message}`, error);
        }
    } else {
        if (data.action === 'keydown' || data.action === 'keyup') {
            vlog(`[NO ROBOTJS] ${data.action} ${data.key} (${data.code}). Install RobotJS for keyboard control.`);
        }
    }
}

// Helper function to handle keyboard events
function handleKeyboardEvent(client, data, isDown) {
    if (!robot) {
        vlog(`[Warning] RobotJS not available - cannot process keyboard events`);
        return;
    }
    
    try {
        const action = isDown ? 'down' : 'up';
        
        // Map common key codes to robotjs-compatible key strings
        const key = mapKeyToRobotJS(data.key, data.code);
        
        if (!key) {
            console.log(`[Control] Unsupported key: ${data.key} (${data.code})`);
            return;
        }
        
        console.log(`[Control] Key ${action}: ${key}`);
        
        // Performance optimization: Use cached state for modifier keys
        const clientKeyState = keyboardState.get(client.id);
        
        // Handle modifier keys with state caching
        if (['shift', 'control', 'alt', 'command'].includes(key)) {
            // Update cached state
            clientKeyState[key] = isDown;
            
            robot.keyToggle(key, action);
            vlog(`[RobotJS] Toggled modifier: ${key} ${action}`);
            return;
        }
        
        // Handle regular keys with modifiers
        const modifiers = [];
        if (data.shiftKey) modifiers.push('shift');
        if (data.ctrlKey) modifiers.push('control');
        if (data.altKey) modifiers.push('alt');
        if (data.metaKey) modifiers.push('command');
        
        // Performance optimization: Only toggle modifiers that changed state
        if (isDown) {
            // Activate modifiers
            modifiers.forEach(mod => {
                if (!clientKeyState[mod]) {
                    clientKeyState[mod] = true;
                    robot.keyToggle(mod, 'down');
                    vlog(`[RobotJS] Modifier down: ${mod}`);
                }
            });
            
            // Press main key
            robot.keyToggle(key, 'down');
            vlog(`[RobotJS] Key down: ${key}`);
        }
        // For key up, release the key then toggle off modifiers
        else {
            // Release main key
            robot.keyToggle(key, 'up');
            vlog(`[RobotJS] Key up: ${key}`);
            
            // Only release modifiers that are no longer needed
            Object.keys(clientKeyState).forEach(mod => {
                if (clientKeyState[mod] && !modifiers.includes(mod)) {
                    clientKeyState[mod] = false;
                    robot.keyToggle(mod, 'up');
                    vlog(`[RobotJS] Modifier up: ${mod}`);
                }
            });
        }
    } catch (error) {
        console.error(`Keyboard control error for ${data.key}: ${error.message}`);
        console.error(error);
    }
}

// Map browser key codes/values to robotjs-compatible key strings
function mapKeyToRobotJS(key, code) {
    // Special keys mapping
    const specialKeys = {
        'Backspace': 'backspace',
        'Tab': 'tab',
        'Enter': 'enter',
        'Escape': 'escape',
        'Space': 'space',
        'ArrowLeft': 'left',
        'ArrowUp': 'up',
        'ArrowRight': 'right',
        'ArrowDown': 'down',
        'Delete': 'delete',
        'Home': 'home',
        'End': 'end',
        'PageUp': 'pageup',
        'PageDown': 'pagedown',
        'CapsLock': 'capslock',
        'Control': 'control',
        'Alt': 'alt',
        'Shift': 'shift',
        'Meta': 'command'
    };
    
    // Function keys
    if (code && code.startsWith('F') && code.length > 1) {
        const fNum = code.substring(1);
        if (!isNaN(parseInt(fNum)) && parseInt(fNum) >= 1 && parseInt(fNum) <= 12) {
            return `f${fNum}`;
        }
    }
    
    // Special keys
    if (specialKeys[key]) {
        return specialKeys[key];
    }
    
    // Regular single character keys
    if (key && key.length === 1) {
        return key.toLowerCase();
    }
    
    return null;
}

// Function to test network interfaces
function testNetworkInterfaces() {
    const interfaces = os.networkInterfaces();
    console.log('\nNetwork Interface Details:');
    for (const name of Object.keys(interfaces)) {
        console.log(`Interface: ${name}`);
        for (const iface of interfaces[name]) {
            console.log(`  ${iface.family}: ${iface.address} ${iface.internal ? '(internal)' : '(external)'}`);
        }
    }
}

// Start server (bound interface comes from config.ini [server] host)
server.on('error', (err) => {
    if (err && err.code === 'EADDRNOTAVAIL') {
        console.error(`\n❌ Cannot bind to ${HOST}:${PORT} - address not present on this machine.`);
        console.error('   Fix [server] host in config.ini (0.0.0.0 = all interfaces).');
    } else if (err && err.code === 'EADDRINUSE') {
        console.error(`\n❌ Port ${PORT} already in use - change [server] port in config.ini.`);
    } else {
        console.error('\n❌ Server error:', err && err.message ? err.message : err);
    }
    process.exit(1);
});
server.listen(PORT, HOST, () => {
    console.log('\n==========================================');
    console.log('   Remote Desktop Server');
    console.log('==========================================\n');

    const proto = USE_HTTPS ? 'https' : 'http';
    const bound = boundHostName();
    console.log(`Server running on port ${PORT} (${USE_HTTPS ? 'HTTPS' : 'HTTP'}), interface: ${bound || 'all (0.0.0.0)'}`);
    console.log('Control mapping: ctrl-fix-2 (validated+clamped coords, toggle-always)');

    if (bound) {
        // Pinned interface: advertise only it - nothing else is reachable.
        console.log(`\nAccess: ${proto}://${bound}:${PORT}`);
    } else {
        console.log(`Local access: ${proto}://localhost:${PORT}`);

        const ips = getLocalIPs();
        if (ips.length > 0) {
            console.log('\nNetwork access:');
            ips.forEach(ip => {
                console.log(`  ${proto}://${ip}:${PORT}`);
            });
        } else {
            console.log('\nWARNING: No network interfaces detected! This might prevent access from other devices.');
        }
    }

    if (!USE_HTTPS) {
        console.log('\n⚠️  HTTP mode: browsers allow screen capture only via localhost.');
        console.log('   HOST must open http://localhost:' + PORT + ' on its own machine.');
        if (!bound) console.log('   Viewers may use the LAN addresses above.');
        console.log('   (Auto HTTPS failed or SSL_NO_AUTO=1. Manual cert:');
        console.log('    openssl req -x509 -newkey rsa:2048 -nodes -days 365 \\');
        console.log('      -keyout ssl/key.pem -out ssl/cert.pem -subj "/CN=<host-lan-ip>")');
    } else if (TLS_OPTIONS.auto) {
        console.log(`\n✅ HTTPS auto-enabled (self-signed cert for ${bound || 'all interfaces'}). Open the https:// address above,`);
        console.log('   accept the browser warning once, and LAN screen sharing will work.');
    }

    if (!bound) {
        // Full interface dump is only useful when listening on all of them.
        if (CONFIG.verbose) testNetworkInterfaces();
    }

    console.log('\n📋 Instructions:');
    console.log('1. Open the URL in browser on both computers');
    console.log('2. Host: Click "Host" then "Start Screen Share"');
    console.log('3. Client: Click "Client" and wait for connection');
    console.log('4. Client: Click "Enable Control" to control the host\n');
    console.log('🖱️  Remote control moves THIS server machine: run the server ON the host PC.');

    console.log('ℹ️ Network Tips:');
    console.log('- Make sure your firewall allows incoming connections to port ' + PORT);
    console.log('- Both devices must be on the same network');
    if (!bound) console.log('- Try accessing the specific IP addresses shown above');
    
    if (!robot) {
        console.log('\n⚠️  Note: RobotJS not installed - remote control simulated');
        console.log('   Run: npm install robotjs');
    }
    
    console.log('\nPress Ctrl+C to stop\n');
});

// Graceful shutdown
// NOTE: wss.close(cb) waits for every browser socket to disconnect, and
// server.close(cb) waits for HTTP keep-alive — without force-closing both,
// the process hangs on Ctrl+C forever.
let shuttingDown = false;
function gracefulShutdown(signal) {
    // Second Ctrl+C / signal while shutting down: exit immediately.
    if (shuttingDown) {
        console.log('\nForce exit...');
        process.exit(1);
    }
    shuttingDown = true;
    console.log(`\nShutting down (${signal})...`);

    // Notify all clients, then graceful-close their sockets so the
    // shutdown message has a chance to flush before the TCP teardown.
    clients.forEach((client) => {
        try {
            if (client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(JSON.stringify({ type: 'server-shutdown' }), () => {
                    try { client.ws.close(1001, 'server shutdown'); } catch (e) { /* ignore */ }
                });
            } else {
                try { client.ws.terminate(); } catch (e) { /* ignore */ }
            }
        } catch (e) { /* ignore */ }
    });

    // Stragglers that never answer the close handshake get terminated.
    setTimeout(() => {
        clients.forEach((client) => {
            try { client.ws.terminate(); } catch (e) { /* ignore */ }
        });
    }, 500).unref();

    wss.close(() => {
        // Drop HTTP keep-alive connections so server.close() can finish.
        if (typeof server.closeAllConnections === 'function') {
            try { server.closeAllConnections(); } catch (e) { /* ignore */ }
        }
        server.close(() => {
            console.log('Server stopped');
            process.exit(0);
        });
    });

    // Safety: never hang longer than a few seconds.
    setTimeout(() => {
        console.log('Shutdown timeout, forcing exit');
        process.exit(0);
    }, 3000).unref();
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
// nodemon restart
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2'));