// declarativeNetRequest for sw.js: the static rulesets, dynamic and session rules of every enabled extension,
// matched against the real url of each proxied request. rules are indexed by host and by a literal token of their
// url filter, so a request only checks the few rules that could match it

const MOCHII_DNR = (() => {
    const RANK = { allow: 5, allowAllRequests: 5, block: 4, upgradeScheme: 3, redirect: 2, modifyHeaders: 1 };
    const SLD = /^(?:co|com|org|net|gov|edu|ac|or|ne|go|gob|nic|mil)$/;
    const site = h => { const p = String(h || "").split("."); if (p.length <= 2) return h; return (p[p.length - 1].length === 2 && SLD.test(p[p.length - 2]) ? p.slice(-3) : p.slice(-2)).join("."); };
    const onDomain = (h, list) => { for (const d of list) if (h === d || h.endsWith("." + d)) return true; return false; };
    let byHost = new Map(), byToken = new Map(), generic = [], allowAll = [], count = 0;

    function filterRegex(f, cs) {
        let s = String(f), pre = "", post = "";
        if (s.startsWith("||")) { pre = "^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#]*\\.)?"; s = s.slice(2); }
        else if (s.startsWith("|")) { pre = "^"; s = s.slice(1); }
        if (s.endsWith("|")) { post = "$"; s = s.slice(0, -1); }
        const body = s.replace(/[.+?${}()[\]\\\/|]/g, "\\$&").replace(/\*/g, ".*").replace(/\^/g, "(?:[^a-zA-Z0-9_.%-]|$)");
        return new RegExp(pre + body + post, cs ? "" : "i");
    }
    // the longest run of letters and digits that must appear whole in any url the filter matches
    function filterToken(f) {
        let s = String(f).toLowerCase(), best = "";
        const anchoredStart = s.startsWith("|"), anchoredEnd = s.endsWith("|") && !s.endsWith("||");
        s = s.replace(/^\|\|?/, "").replace(/\|$/, "");
        const re = /[a-z0-9]+/g; let m;
        while ((m = re.exec(s))) {
            const a = m.index, b = a + m[0].length, before = s[a - 1], after = s[b];
            const okA = a === 0 ? anchoredStart : before !== "*";
            const okB = b === s.length ? anchoredEnd : after !== "*";
            if (okA && okB && m[0].length > best.length && m[0].length >= 2) best = m[0];
        }
        return best;
    }
    function filterHost(f) {
        if (!String(f).startsWith("||")) return "";
        const m = String(f).slice(2).match(/^[a-z0-9.-]+/i);
        if (!m) return "";
        const rest = String(f).slice(2 + m[0].length);
        return rest === "" || /^[\^/:|?]/.test(rest) ? m[0].toLowerCase().replace(/\.$/, "") : "";
    }

    function compile(rule, ext, set) {
        const c = rule.condition || {}, a = rule.action || {};
        if (!RANK[a.type] || c.responseHeaders || c.excludedResponseHeaders) return null;
        const r = { id: rule.id, ext, set, prio: rule.priority || 1, a, c, re: null };
        if (c.regexFilter) { try { r.re = new RegExp(c.regexFilter, c.isUrlFilterCaseSensitive ? "" : "i"); } catch { return null; } }
        else if (c.urlFilter) { try { r.re = filterRegex(c.urlFilter, c.isUrlFilterCaseSensitive); } catch { return null; } }
        return r;
    }
    function add(r) {
        count++;
        if (r.a.type === "allowAllRequests") allowAll.push(r);
        const c = r.c, push = (map, k) => { let l = map.get(k); if (!l) map.set(k, l = []); l.push(r); };
        if (c.requestDomains && c.requestDomains.length) { for (const d of c.requestDomains) push(byHost, String(d).toLowerCase()); return; }
        if (c.urlFilter) { const h = filterHost(c.urlFilter); if (h) return push(byHost, h); const t = filterToken(c.urlFilter); if (t) return push(byToken, t); }
        generic.push(r);
    }

    function test(r, q) {
        const c = r.c;
        const types = c.resourceTypes || null;
        if (types ? !types.includes(q.type) : q.type === "main_frame" && r.a.type !== "allowAllRequests") return false;
        if (c.excludedResourceTypes && c.excludedResourceTypes.includes(q.type)) return false;
        if (c.requestMethods && !c.requestMethods.includes(q.method)) return false;
        if (c.excludedRequestMethods && c.excludedRequestMethods.includes(q.method)) return false;
        if (c.tabIds && !c.tabIds.includes(q.tabId)) return false;
        if (c.excludedTabIds && c.excludedTabIds.includes(q.tabId)) return false;
        if (c.requestDomains && !onDomain(q.host, c.requestDomains)) return false;
        if (c.excludedRequestDomains && onDomain(q.host, c.excludedRequestDomains)) return false;
        const inits = c.initiatorDomains || c.domains, notInits = c.excludedInitiatorDomains || c.excludedDomains;
        if (inits && (!q.initHost || !onDomain(q.initHost, inits))) return false;
        if (notInits && q.initHost && onDomain(q.initHost, notInits)) return false;
        if (c.domainType) { const third = !!q.initHost && site(q.initHost) !== site(q.host); if ((c.domainType === "thirdParty") !== third) return false; }
        if (r.re && !r.re.test(q.url)) return false;
        return true;
    }
    function candidates(q) {
        const out = new Set();
        const p = q.host.split(".");
        for (let i = 0; i < p.length; i++) { const l = byHost.get(p.slice(i).join(".")); if (l) for (const r of l) out.add(r); }
        for (const t of new Set(q.url.toLowerCase().match(/[a-z0-9]+/g) || [])) { const l = byToken.get(t); if (l) for (const r of l) out.add(r); }
        for (const r of generic) out.add(r);
        return out;
    }
    const better = (a, b) => !b || a.prio > b.prio || (a.prio === b.prio && RANK[a.a.type] > RANK[b.a.type]);

    function redirectUrl(r, q, extBase) {
        const a = r.a.redirect || {};
        if (r.a.type === "upgradeScheme") return q.url.replace(/^http:/i, "https:").replace(/^ws:/i, "wss:");
        if (a.url) return a.url;
        if (a.extensionPath) return extBase + r.ext + "/" + String(a.extensionPath).replace(/^\//, "");
        if (a.regexSubstitution && r.re) { const m = q.url.match(r.re); if (m) return a.regexSubstitution.replace(/\\(\d)/g, (x, n) => m[n] || ""); }
        if (a.transform) {
            try {
                const t = a.transform, u = new URL(q.url);
                if (t.scheme) u.protocol = t.scheme + ":"; if (t.host) u.hostname = t.host; if (t.port != null) u.port = t.port;
                if (t.path != null) u.pathname = t.path; if (t.query != null) u.search = t.query; if (t.fragment != null) u.hash = t.fragment;
                if (t.username != null) u.username = t.username; if (t.password != null) u.password = t.password;
                if (t.queryTransform) {
                    for (const k of t.queryTransform.removeParams || []) u.searchParams.delete(k);
                    for (const kv of t.queryTransform.addOrReplaceParams || []) { if (kv.replaceOnly && !u.searchParams.has(kv.key)) continue; u.searchParams.set(kv.key, kv.value); }
                }
                return u.href;
            } catch {}
        }
        return "";
    }

    return {
        get count() { return count; },
        // sets: [{ ext, set, rules }]
        build(sets) {
            byHost = new Map(); byToken = new Map(); generic = []; allowAll = []; count = 0;
            for (const s of sets) for (const rule of s.rules || []) { const r = compile(rule, s.ext, s.set); if (r) add(r); }
        },
        // q: { url, type, method, initiator, doc } -> null | { type: 'block' | 'redirect', url?, set, ext }
        match(q, extBase) {
            if (!count) return null;
            try { q.host = new URL(q.url).hostname.toLowerCase(); } catch { return null; }
            try { q.initHost = q.initiator ? new URL(q.initiator).hostname.toLowerCase() : ""; } catch { q.initHost = ""; }
            q.method = (q.method || "get").toLowerCase(); q.tabId = q.tabId == null ? 1 : q.tabId;
            const best = new Map();
            for (const r of candidates(q)) if (test(r, q) && better(r, best.get(r.ext))) best.set(r.ext, r);
            // a frame that matched allowAllRequests lets everything it loads through, for that extension
            if (q.doc && q.type !== "main_frame" && allowAll.length) {
                let dq = null;
                try { dq = { url: q.doc, host: new URL(q.doc).hostname.toLowerCase(), initHost: "", method: "get", tabId: q.tabId }; } catch {}
                if (dq) for (const r of allowAll) {
                    const cur = best.get(r.ext);
                    if (cur && cur.prio > r.prio) continue;
                    if (test(r, Object.assign({}, dq, { type: "main_frame" })) || test(r, Object.assign({}, dq, { type: "sub_frame" }))) best.set(r.ext, r);
                }
            }
            let block = null, redirect = null;
            for (const r of best.values()) {
                if (r.a.type === "block") block = block || r;
                else if (r.a.type === "redirect" || r.a.type === "upgradeScheme") redirect = redirect || r;
            }
            if (block) return { type: "block", set: block.set, ext: block.ext };
            if (redirect) { const url = redirectUrl(redirect, q, extBase); if (url && url !== q.url) return { type: "redirect", url, set: redirect.set, ext: redirect.ext }; }
            return null;
        }
    };
})();
