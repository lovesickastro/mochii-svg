// what gets blocked, split so the stats can count ads and trackers separately.
// a pattern with a path only matches that path on that host
const ADBLOCK_PATTERNS = [
    "googlesyndication.com",
    "googleadservices.com",
    "doubleclick.net",
    "adnxs.com",
    "amazon-adsystem.com",
    "rubiconproject.com",
    "pubmatic.com",
    "criteo.com",
    "openx.net",
    "taboola.com",
    "outbrain.com",
    "moatads.com",
    "casalemedia.com",
    "adsafeprotected.com",
    "advertising.com",
    "adtechus.com",
    "unityads.unity3d.com",
    "facebook.com/ads",
    "ads-api.twitter.com",
    "youtube.com/api/stats/ads",
    "youtube.com/pagead",
    "youtube.com/get_midroll",
];
const TRACKER_PATTERNS = [
    "google-analytics.com",
    "googletagmanager.com",
    "chartbeat.com",
    "scorecardresearch.com",
    "quantserve.com",
    "krxd.net",
    "demdex.net",
    "hotjar.com",
    "mixpanel.com",
    "api.amplitude.com",
    "fullstory.com",
    "clarity.ms",
    "nr-data.net",
    "bat.bing.com",
    "analytics.tiktok.com",
    "ct.pinterest.com",
    "facebook.com/tr",
    "graph.facebook.com/pixel",
    "analytics.twitter.com",
];

// returns "ad", "tracker" or null
function blockKind(urlStr) {
    let h; try { h = new URL(urlStr).hostname; } catch { return null; }
    const hit = p => { const d = p.split('/')[0]; return (h === d || h.endsWith('.' + d)) && (!p.includes('/') || urlStr.includes(p)); };
    return ADBLOCK_PATTERNS.some(hit) ? "ad" : TRACKER_PATTERNS.some(hit) ? "tracker" : null;
}

const swPath = self.location.pathname;
const basePath = swPath.substring(0, swPath.lastIndexOf('/') + 1);
self.basePath = basePath;

// scramjet opens its idb at version 1 without creating the stores here, so this adds them on any open, and off the
// site root (the svg on jsdelivr) uses a db of its own. must match guardScramjetDb in p/js/app/proxy.js
{
    const open = indexedDB.open.bind(indexedDB), name = "$scramjet" + (basePath === "/" ? "" : basePath);
    indexedDB.open = (n, v) => { if (n !== "$scramjet") return open(n, v); const r = open(name, v); r.addEventListener("upgradeneeded", () => { for (const s of ["config", "cookies", "redirectTrackers", "referrerPolicies", "publicSuffixList"]) r.result.objectStoreNames.contains(s) || r.result.createObjectStore(s); }); return r; };
}
 
self.$scramjet = {
    files: {
        wasm: basePath + "p/js/homework/math.wasm.wasm",
        sync: basePath + "p/js/homework/math.sync.js",
    }
};
 
importScripts(basePath + "p/js/homework/math.all.js");
importScripts(basePath + "p/js/lib/bare-mux.js");
importScripts(basePath + "p/js/ext/dnr.js");

// ultraviolet. uv.config.js isn't a real file, the fetch handler below serves it
const UV_FILES = {
    handler: basePath + "p/js/homework/uv.handler.js",
    client: basePath + "p/js/homework/uv.client.js",
    bundle: basePath + "p/js/homework/uv.bundle.js",
    config: basePath + "p/js/homework/uv.config.js",
    sw: basePath + "p/js/homework/uv.sw.js"
};

let uv = null;
let UV_CONFIG_SOURCE = "";
try {
    importScripts(UV_FILES.bundle);
    self.__uv$config = {
        prefix: basePath + "uv/",
        encodeUrl: Ultraviolet.codec.xor.encode,
        decodeUrl: Ultraviolet.codec.xor.decode,
        ...UV_FILES
    };
    importScripts(UV_FILES.sw);
    uv = new UVServiceWorker();
    UV_CONFIG_SOURCE = "self.__uv$config=" + JSON.stringify({ prefix: self.__uv$config.prefix, ...UV_FILES }) + ";self.__uv$config.encodeUrl=Ultraviolet.codec.xor.encode;self.__uv$config.decodeUrl=Ultraviolet.codec.xor.decode;";
} catch {}
 
const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker({
    prefix: basePath + "scramjet/"
});
 
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
 
let wispConfig = { wispurl: null, servers: [], autoswitch: true };
 
async function pingServer(url) {
    return new Promise(resolve => {
        const start = Date.now();
        try {
            const ws = new WebSocket(url);
            const t = setTimeout(() => { try { ws.close(); } catch {} resolve({ url, success: false, latency: null }); }, 3000);
            ws.onopen = () => { clearTimeout(t); try { ws.close(); } catch {} resolve({ url, success: true, latency: Date.now() - start }); };
            ws.onerror = () => { clearTimeout(t); resolve({ url, success: false, latency: null }); };
        } catch { resolve({ url, success: false, latency: null }); }
    });
}
 
// proxied requests come in as /scramjet/<url> or /uv/<url>, so decode them to see where they really go
function realUrl(req) {
    try {
        const u = new URL(req.url);
        if (u.origin !== self.location.origin) return req.url;
        const sj = basePath + "scramjet/", up = basePath + "uv/";
        if (u.pathname.startsWith(sj)) return decodeURIComponent(u.pathname.slice(sj.length)) + u.search;
        if (uv && u.pathname.startsWith(up)) return self.__uv$config.decodeUrl(u.pathname.slice(up.length)) + u.search;
    } catch {}
    return req.url;
}

// block counts are batched and sent to one mochii window, which keeps the totals in localStorage
let pendingBlocks = null, blockFlush = 0;
function countBlock(kind, url) {
    let host = ""; try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}
    pendingBlocks = pendingBlocks || { ads: 0, trackers: 0, hosts: {} };
    pendingBlocks[kind === "ad" ? "ads" : "trackers"]++;
    if (host) pendingBlocks.hosts[host] = (pendingBlocks.hosts[host] || 0) + 1;
    if (!blockFlush) blockFlush = setTimeout(flushBlocks, 1500);
}
async function flushBlocks() {
    blockFlush = 0;
    if (!pendingBlocks) return;
    const tops = (await self.clients.matchAll({ type: "window" })).filter(c => c.frameType === "top-level" && /\/(index\.html)?$/.test(new URL(c.url).pathname));
    const target = tops.find(c => c.focused) || tops[0];
    if (!target) return; // kept for the next flush
    target.postMessage({ type: "blocked", ...pendingBlocks });
    pendingBlocks = null;
}


// extensions. their files live in indexeddb (written by p/js/app/extensions.js) and are served from /ext/<id>/<path>,
// so pages, modules and fetch(chrome.runtime.getURL(...)) all work. the rule engine is p/js/ext/dnr.js
const EXT_PREFIX = basePath + "ext/";
const EXT_BASE = self.location.origin + EXT_PREFIX;
let extState = null, extLoading = null, extDbConn = null, extBare = null;
function extDb() {
    if (extDbConn) return Promise.resolve(extDbConn);
    return new Promise(resolve => {
        let r; try { r = indexedDB.open("mochiiExtensions"); } catch { return resolve(null); }
        // the app makes the stores, so a db that doesn't exist yet stays that way
        r.onupgradeneeded = () => { try { r.transaction.abort(); } catch {} };
        r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains("files")) { db.close(); return resolve(null); } db.onversionchange = () => { db.close(); extDbConn = null; }; extDbConn = db; resolve(db); };
        r.onerror = () => resolve(null);
    });
}
async function extGet(store, key) {
    const db = await extDb(); if (!db) return null;
    return new Promise(resolve => { try { const q = db.transaction(store, "readonly").objectStore(store)[key === undefined ? "getAll" : "get"](key); q.onsuccess = () => resolve(q.result ?? null); q.onerror = () => resolve(null); } catch { resolve(null); } });
}
const extFile = (id, path) => extGet("files", id + "/" + String(path).replace(/^\/+/, ""));
function extLoad() {
    return extLoading = (async () => {
        const all = (await extGet("extensions")) || [], on = all.filter(e => e.enabled), sets = [];
        for (const e of on) {
            const d = e.dnr || {}, res = e.manifest?.declarative_net_request?.rule_resources || [];
            const enabled = Array.isArray(d.rulesets) ? d.rulesets : res.filter(r => r.enabled).map(r => r.id);
            for (const r of res) {
                if (!enabled.includes(r.id)) continue;
                const blob = await extFile(e.id, r.path); if (!blob) continue;
                try { const off = new Set((d.disabledRules || {})[r.id] || []); sets.push({ ext: e.id, set: r.id, rules: JSON.parse(await blob.text()).filter(x => !off.has(x.id)) }); } catch {}
            }
            if (d.dynamic?.length) sets.push({ ext: e.id, set: "_dynamic", rules: d.dynamic });
            if (d.session?.length) sets.push({ ext: e.id, set: "_session", rules: d.session });
        }
        MOCHII_DNR.build(sets);
        extState = { on: new Set(on.map(e => e.id)), hook: on.length > 0, rec: new Map(all.map(e => [e.id, e])) };
    })().catch(() => { extState = { on: new Set(), hook: false, rec: new Map() }; });
}
const extReady = () => extState ? null : (extLoading || extLoad());

const EXT_TYPES = { html: "text/html", htm: "text/html", js: "text/javascript", mjs: "text/javascript", css: "text/css", json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", wasm: "application/wasm", txt: "text/plain", xml: "application/xml", mp3: "audio/mpeg", mp4: "video/mp4", webm: "video/webm", wav: "audio/wav", ogg: "audio/ogg" };
const extType = p => EXT_TYPES[String(p).split(".").pop().toLowerCase()] || "application/octet-stream";
const extHeaders = type => ({ "Content-Type": type + (/^text\/|json|xml|javascript/.test(type) ? "; charset=utf-8" : ""), "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
// every extension page gets the chrome api first
const extApiTag = () => `<script src="${basePath}p/js/ext/api.js"></script>`;
const withApi = html => /^\s*<!doctype[^>]*>/i.test(html) ? html.replace(/^\s*<!doctype[^>]*>/i, m => m + extApiTag()) : extApiTag() + html;
// "wrap" runs a script through the page's Function, which the proxy rewrites, so it sees the real site's location
async function extServe(urlStr, wrap) {
    await extReady();
    const u = new URL(urlStr), rest = decodeURIComponent(u.pathname.slice(EXT_PREFIX.length)), id = rest.split("/")[0], path = rest.slice(id.length + 1) || "index.html";
    const rec = extState.rec.get(id);
    if (!rec) return new Response("extension not found", { status: 404 });
    // the page a background runs in. a service worker's page sits next to its script, so relative urls resolve the same
    if (path.endsWith("_generated_background_page.html")) {
        const bg = rec.manifest?.background || {}, scripts = bg.service_worker ? [bg.service_worker] : bg.scripts || [];
        const tags = scripts.map(src => `<script src="${EXT_PREFIX}${id}/${String(src).replace(/^\/+/, "").replace(/"/g, "&quot;")}"${bg.type === "module" ? ' type="module"' : ""}></script>`).join("");
        return new Response(withApi(`<!doctype html><html><head><meta charset="utf-8"></head><body>${tags}</body></html>`), { headers: extHeaders("text/html") });
    }
    const blob = await extFile(id, path);
    if (!blob) return new Response("not found", { status: 404, headers: extHeaders("text/plain") });
    const type = extType(path);
    if (type === "text/html") return new Response(withApi(await blob.text()), { headers: extHeaders(type) });
    if (type === "text/css") return new Response((await blob.text()).replace(/__MSG_@@extension_id__/g, id), { headers: extHeaders(type) });
    if (wrap && type === "text/javascript") return new Response(`(new Function(${JSON.stringify(await blob.text())})).call(window);`, { headers: extHeaders(type) });
    return new Response(blob, { headers: extHeaders(type) });
}

// proxied pages get p/js/ext/hook.js right after the proxy's own scripts, so content scripts can start early
async function withHook(res) {
    if (!(res instanceof Response) || res.status < 200 || res.status > 299 || !/text\/html/i.test(res.headers.get("content-type") || "")) return res;
    let html; try { html = await res.text(); } catch { return res; }
    const tag = `<script src="${basePath}p/js/ext/hook.js"></script>`;
    const head = /<head\b[^>]*>(?:\s*(?:<script\b[^>]*>\s*<\/script>|<link\b[^>]*>))*/i;
    if (head.test(html)) html = html.replace(head, m => m + tag);
    else if (/^\s*<!doctype[^>]*>/i.test(html)) html = html.replace(/^\s*<!doctype[^>]*>/i, m => m + tag);
    else html = tag + html;
    const headers = new Headers(res.headers); headers.delete("content-length");
    return new Response(html, { status: res.status, statusText: res.statusText, headers });
}

function proxiedUrl(target, viaUv) {
    return viaUv && uv ? self.__uv$config.prefix + self.__uv$config.encodeUrl(target) : basePath + "scramjet/" + encodeURIComponent(target);
}
function resourceType(req) {
    const d = req.destination;
    if (d === "document") return "main_frame";
    if (d === "iframe" || d === "frame") return req.referrer ? "sub_frame" : "main_frame";
    return ({ script: "script", worker: "script", sharedworker: "script", serviceworker: "script", style: "stylesheet", image: "image", font: "font", object: "object", embed: "object", audio: "media", video: "media", track: "media", manifest: "other", report: "csp_report" })[d] || (req.mode === "websocket" ? "websocket" : d === "" ? "xmlhttprequest" : "other");
}
async function initiatorOf(event) {
    let u = "";
    try { const c = event.clientId && await self.clients.get(event.clientId); u = c ? c.url : event.request.referrer; } catch {}
    if (!u) return "";
    const real = realUrl({ url: u });
    return real === u && u.startsWith(self.location.origin) ? "" : real;
}
function blockedPage(url, ext) {
    const name = extState?.rec.get(ext)?.name || "an extension";
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    return new Response(`<!doctype html><meta charset="utf-8"><title>blocked</title><body style="font:14px system-ui;background:#111;color:#bbb;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:420px"><div style="font-size:16px;color:#fff;margin-bottom:6px">this page was blocked</div><div>${esc(name)} blocked ${esc(url)}</div></div>`, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
// extension pages talk to any host they have permission for, so their cross-origin requests go out through the proxy
async function extOutbound(event) {
    try {
        if (!extBare) extBare = new BareMux.BareClient();
        const req = event.request, body = /^(GET|HEAD)$/i.test(req.method) ? undefined : await req.arrayBuffer();
        const headers = {}; req.headers.forEach((v, k) => { headers[k] = v; });
        const res = await extBare.fetch(req.url, { method: req.method, headers, body, redirect: "follow" });
        const out = new Headers(res.headers); out.set("Access-Control-Allow-Origin", "*"); out.delete("content-encoding"); out.delete("content-length");
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
    } catch { return fetch(event.request); }
}

function notifyClients(msg) {
    self.clients.matchAll().then(clients => clients.forEach(c => c.postMessage(msg)));
}
 
async function proactiveCheck() {
    if (!wispConfig.autoswitch || !wispConfig.servers?.length) return;
    const results = await Promise.all(wispConfig.servers.map(s => pingServer(s.url)));
    const currentOk = results.find(r => r.url === wispConfig.wispurl)?.success;
    if (!currentOk) {
        const best = results.filter(r => r.success).sort((a,b) => a.latency - b.latency)[0];
        if (best) {
            wispConfig.wispurl = best.url;
            notifyClients({ type: 'wispChanged', url: best.url, name: wispConfig.servers.find(s => s.url === best.url)?.name || 'Server', latency: best.latency });
        }
    }
}
 
self.addEventListener("message", ({ data, source }) => {
    if (data?.type === "config") {
        if (data.wispurl) wispConfig.wispurl = data.wispurl;
        if (data.servers?.length) { wispConfig.servers = data.servers; if (wispConfig.autoswitch) setTimeout(proactiveCheck, 500); }
        if (typeof data.autoswitch !== 'undefined') wispConfig.autoswitch = data.autoswitch;
    } else if (data?.type === "ext-sync") {
        extState = null; extLoad().then(() => { try { source?.postMessage({ type: "ext-synced", rules: MOCHII_DNR.count }); } catch {} });
    } else if (data?.type === "ping") {
        pingServer(wispConfig.wispurl).then(result => notifyClients({ type: 'pingResult', ...result }));
    }
});
 
self.addEventListener("fetch", event => {
    const req = event.request, url = new URL(req.url);
    if (url.origin === self.location.origin && url.pathname.startsWith(EXT_PREFIX)) { event.respondWith(extServe(req.url)); return; }
    const real = realUrl(req), proxied = real !== req.url, kind = blockKind(real);
    if (kind) {
        countBlock(kind, real);
        event.respondWith(new Response(null, { status: 204 }));
        return;
    }
    if (uv && url.pathname === UV_FILES.config) {
        event.respondWith(new Response(UV_CONFIG_SOURCE, { headers: { "Content-Type": "text/javascript", "Cache-Control": "no-store" } }));
        return;
    }
    // a proxied request for an extension file (a content script inserting chrome.runtime.getURL(...) into the page)
    if (proxied && real.startsWith(EXT_BASE)) {
        const d = req.destination;
        event.respondWith(d === "document" || d === "iframe" || d === "frame" ? Response.redirect(real, 302) : extServe(real, d === "script"));
        return;
    }
    const viaUv = !!uv && url.pathname.startsWith(basePath + "uv/");
    const proxy = () => {
        if (viaUv && uv.route(event)) return uv.fetch(event);
        return (async () => {
            try {
                await scramjet.loadConfig();
                if (scramjet.route(event)) return scramjet.fetch(event);
            } catch {}
            return fetch(req);
        })();
    };
    if (!proxied) {
        if (uv && uv.route(event)) { event.respondWith(uv.fetch(event)); return; }
        // requests made by extension pages themselves. "/x" means the extension's own root there, like in chrome,
        // and other sites are reached through the proxy, since extensions aren't held to cors
        // worker scripts are skipped: looking up the client that is still loading would wait on itself
        const own = url.origin === self.location.origin, app = own && (url.pathname.startsWith(`${basePath}p/`) || /\/(sw|bareworker)\.js$/.test(url.pathname));
        if (!app && !/worker$/.test(req.destination) && (event.clientId || req.referrer.startsWith(EXT_BASE))) {
            event.respondWith((async () => {
                let from = req.referrer;
                try { const c = event.clientId && await Promise.race([self.clients.get(event.clientId), new Promise(r => setTimeout(r, 300))]); if (c) from = c.url; } catch {}
                if (from && from.startsWith(EXT_BASE)) {
                    if (url.origin === self.location.origin) {
                        if (!url.pathname.startsWith(`${basePath}p/js/ext/`)) {
                            const id = from.slice(EXT_BASE.length).split("/")[0], r = await extServe(EXT_BASE + id + "/" + url.pathname.slice(basePath.length));
                            if (r.status !== 404) return r;
                        }
                    } else if (/^https?:$/.test(url.protocol)) return extOutbound(event);
                }
                return proxy();
            })());
            return;
        }
        event.respondWith(proxy());
        return;
    }
    event.respondWith((async () => {
        await extReady();
        const type = resourceType(req), page = type === "main_frame" || type === "sub_frame";
        if (MOCHII_DNR.count) {
            const initiator = await initiatorOf(event);
            const hit = MOCHII_DNR.match({ url: real, type, method: req.method, initiator, doc: page ? "" : initiator }, EXT_BASE);
            if (hit?.type === "block") {
                countBlock(/privacy|track|spy/i.test(hit.set) ? "tracker" : "ad", real);
                return page ? blockedPage(real, hit.ext) : Response.error();
            }
            if (hit?.type === "redirect") {
                countBlock(/privacy|track|spy/i.test(hit.set) ? "tracker" : "ad", real);
                if (hit.url.startsWith(EXT_BASE)) return extServe(hit.url);
                if (/^https?:/i.test(hit.url)) return Response.redirect(proxiedUrl(hit.url, viaUv), 302);
            }
        }
        const res = await proxy();
        return page && extState?.hook ? withHook(res) : res;
    })());
});
