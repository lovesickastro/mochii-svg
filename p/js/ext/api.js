// the chrome.* api that extensions see. sw.js puts this file at the top of every extension page (background, popup,
// options, offscreen), and the app turns mochiiChromeApi into a string and runs it inside each proxied frame that gets
// content scripts. so mochiiChromeApi may only use its own body plus host (the app's __mochiiExt) and ctx.
// every object it hands out is made in the realm it runs in, and everything crossing to the host goes through json

function mochiiChromeApi(host, ctx) {
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const content = ctx.kind === 'content';
  const events = {}, ports = {}, menuClicks = {}, ttsCallbacks = {};
  let lastError = null, portSeq = 0;

  // events
  function makeEvent(name) {
    const list = [];
    return {
      _name: name, _list: list,
      addListener(fn) { if (typeof fn === 'function' && !list.includes(fn)) list.push(fn); },
      removeListener(fn) { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); },
      hasListener(fn) { return list.includes(fn); },
      hasListeners() { return list.length > 0; },
      addRules() {}, removeRules() {}, getRules(cb) { cb && cb([]); }
    };
  }
  const ev = name => events[name] || (events[name] = makeEvent(name));
  const fire = (name, args) => { const e = events[name]; if (!e) return; for (const fn of e._list.slice()) { try { fn(...args); } catch (err) { console.error(err); } } };

  // calls into the host. a trailing function is a callback (with runtime.lastError set while it runs), otherwise a promise
  const toError = e => new Error(e && e.message ? e.message : String(e || 'unknown error'));
  function withLastError(err, fn) { lastError = err ? { message: err.message } : null; try { fn(); } finally { lastError = null; } }
  function callHost(name, args) { return new Promise((res, rej) => { try { Promise.resolve(host.call(ctx.id, name, JSON.stringify(args))).then(v => res(clone(v)), e => rej(toError(e))); } catch (e) { rej(toError(e)); } }); }
  function api(name, prep) {
    return function (...args) {
      let cb = null;
      if (typeof args[args.length - 1] === 'function') cb = args.pop();
      if (prep) args = prep(args);
      const p = callHost(name, args);
      if (!cb) return p;
      p.then(v => withLastError(null, () => cb(v)), e => withLastError(e, () => cb()));
    };
  }
  const sync = (name, ...args) => clone(host.sync(ctx.id, name, JSON.stringify(args)));
  const ns = (prefix, methods, evs, extra) => {
    const o = {};
    for (const m of methods.split(' ').filter(Boolean)) o[m] = api(prefix + '.' + m);
    for (const e of (evs || '').split(' ').filter(Boolean)) o[e] = ev(prefix + '.' + e);
    return Object.assign(o, extra || {});
  };
  // namespaces nobody here implements still answer: every method resolves to undefined and every on* is an event
  function stub(path) {
    const cache = {};
    const f = function () {};
    return new Proxy(f, {
      get(t, k) {
        if (typeof k === 'symbol' || k === 'then' || k === 'prototype') return undefined;
        if (/^on[A-Z]/.test(k)) return ev(path + '.' + k);
        if (/^[A-Z][A-Z0-9_]+$/.test(k)) return k;
        return cache[k] || (cache[k] = stub(path + '.' + k));
      },
      set(t, k, v) { cache[k] = v; return true; },
      apply(t, self, args) { return api(path)(...args); }
    });
  }

  // messages: sendMessage resolves with the first reply, ports relay through the host
  function makePort(id, name, sender) {
    let closed = false;
    const port = {
      name, sender: sender ? clone(sender) : undefined, onMessage: makeEvent('port.onMessage'), onDisconnect: makeEvent('port.onDisconnect'),
      postMessage(msg) { if (closed) throw new Error('Attempting to use a disconnected port object'); host.portPost(ctx.id, id, JSON.stringify(msg === undefined ? null : msg)); },
      disconnect() { if (closed) return; closed = true; delete ports[id]; host.portClose(ctx.id, id); }
    };
    ports[id] = { port, close(err) { if (closed) return; closed = true; delete ports[id]; withLastError(err ? { message: err } : null, () => { for (const fn of port.onDisconnect._list.slice()) { try { fn(port); } catch (e) { console.error(e); } } }); } };
    return port;
  }
  function connect(target, info) {
    const id = ctx.id + ':' + (++portSeq), name = (info && info.name) || '';
    const port = makePort(id, name);
    host.portOpen(ctx.id, id, JSON.stringify({ target, name, frameId: info && info.frameId, documentId: info && info.documentId }));
    return port;
  }
  function sendMessage(target, args) {
    let cb = null;
    if (typeof args[args.length - 1] === 'function') cb = args.pop();
    const p = callHost('message.send', [target, args[0] === undefined ? null : args[0], args[1] || null]);
    if (!cb) return p;
    p.then(v => withLastError(null, () => cb(v)), e => withLastError(e, () => cb()));
  }

  // icons given as ImageData become data urls here, because ImageData doesn't survive json
  function imageDataUrl(data) {
    const one = d => { try { const c = document.createElement('canvas'); c.width = d.width; c.height = d.height; c.getContext('2d').putImageData(d, 0, 0); return c.toDataURL(); } catch { return ''; } };
    if (!data) return '';
    if (typeof data.width === 'number') return one(data);
    const keys = Object.keys(data).sort((a, b) => b - a);
    return keys.length ? one(data[keys[0]]) : '';
  }
  const iconPrep = args => { const d = Object.assign({}, args[0] || {}); if (d.imageData) { d.iconUrl = imageDataUrl(d.imageData); delete d.imageData; } return [d]; };
  const scriptPrep = args => {
    const d = Object.assign({}, args[0] || {});
    if (typeof d.func === 'function') d.func = d.func.toString();
    if (typeof d.function === 'function') { d.func = d.function.toString(); delete d.function; }
    return [d];
  };

  // i18n is synchronous, so the messages come in with ctx
  const MSG = ctx.messages || {};
  function getMessage(name, subs) {
    name = String(name || '');
    const lang = ctx.uiLang || 'en';
    const fixed = { '@@extension_id': ctx.extId, '@@ui_locale': lang.replace('-', '_'), '@@bidi_dir': 'ltr', '@@bidi_reversed_dir': 'rtl', '@@bidi_start_edge': 'left', '@@bidi_end_edge': 'right' };
    if (name in fixed) return fixed[name];
    const m = MSG[name.toLowerCase()];
    if (!m) return '';
    const list = subs == null ? [] : Array.isArray(subs) ? subs.map(String) : [String(subs)];
    const ph = {};
    for (const [k, v] of Object.entries(m.placeholders || {})) ph[k.toLowerCase()] = String(v.content || '').replace(/\$(\d)/g, (x, n) => list[n - 1] ?? '');
    return String(m.message || '').replace(/\$([a-z0-9_@]+)\$/gi, (x, k) => ph[k.toLowerCase()] ?? x).replace(/\$(\d)/g, (x, n) => list[n - 1] ?? '').replace(/\$\$/g, '$');
  }

  // storage areas share one event, and each area also fires its own
  const area = name => Object.assign(ns('storage.' + name, 'get set remove clear getBytesInUse getKeys setAccessLevel', 'onChanged'),
    name === 'sync' ? { QUOTA_BYTES: 102400, QUOTA_BYTES_PER_ITEM: 8192, MAX_ITEMS: 512, MAX_WRITE_OPERATIONS_PER_HOUR: 1800, MAX_WRITE_OPERATIONS_PER_MINUTE: 120 } : name === 'local' ? { QUOTA_BYTES: 10485760 } : name === 'session' ? { QUOTA_BYTES: 10485760 } : {});
  const storage = { local: area('local'), sync: area('sync'), session: area('session'), managed: area('managed'), onChanged: ev('storage.onChanged') };

  const baseUrl = ctx.baseUrl;
  const getURL = p => baseUrl + String(p == null ? '' : p).replace(/^\/+/, '');
  const runtime = {
    get id() { return ctx.extId; },
    get lastError() { return lastError || undefined; },
    getURL, getManifest: () => clone(ctx.manifest),
    sendMessage: (...a) => typeof a[0] === 'string' && /^[a-p]{32}$/.test(a[0]) && a.length > 1 ? sendMessage({ ext: a.shift() }, a) : sendMessage({ ext: ctx.extId }, a),
    connect: (a, b) => connect({ ext: ctx.extId }, typeof a === 'string' ? b : a),
    onMessage: ev('runtime.onMessage'), onConnect: ev('runtime.onConnect'), onMessageExternal: ev('runtime.onMessageExternal'), onConnectExternal: ev('runtime.onConnectExternal'),
    onInstalled: ev('runtime.onInstalled'), onStartup: ev('runtime.onStartup'), onSuspend: ev('runtime.onSuspend'), onSuspendCanceled: ev('runtime.onSuspendCanceled'), onUpdateAvailable: ev('runtime.onUpdateAvailable'), onRestartRequired: ev('runtime.onRestartRequired'), onUserScriptMessage: ev('runtime.onUserScriptMessage'),
    getPlatformInfo: api('runtime.getPlatformInfo'),
    OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
    PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd', FUCHSIA: 'fuchsia' },
    ContextType: { TAB: 'TAB', POPUP: 'POPUP', BACKGROUND: 'BACKGROUND', OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT', SIDE_PANEL: 'SIDE_PANEL', DEVELOPER_TOOLS: 'DEVELOPER_TOOLS' }
  };
  const extension = { getURL, inIncognitoContext: false, get lastError() { return lastError || undefined; }, onRequest: ev('extension.onRequest'), sendRequest: (...a) => runtime.sendMessage(...a) };
  const i18n = { getMessage, getUILanguage: () => ctx.uiLang || 'en', getAcceptLanguages: api('i18n.getAcceptLanguages'), detectLanguage: api('i18n.detectLanguage') };
  const dom = { openOrClosedShadowRoot: el => { try { return el.openOrClosedShadowRoot || el.shadowRoot || null; } catch { return null; } } };
  const chrome = { runtime, storage, i18n, extension, dom };

  if (!content) {
    Object.assign(runtime, ns('runtime', 'openOptionsPage setUninstallURL reload requestUpdateCheck restart restartAfterDelay getContexts getPackageDirectoryEntry sendNativeMessage'), {
      getBackgroundPage(cb) { const p = Promise.resolve(host.raw(ctx.id, 'backgroundPage')); if (!cb) return p; p.then(w => cb(w)); },
      connectNative() { const p = makePort('native:' + (++portSeq), 'native'); setTimeout(() => ports['native:' + portSeq] && ports['native:' + portSeq].close('Native host has exited.'), 0); return p; }
    });
    Object.assign(extension, {
      getBackgroundPage: () => host.raw(ctx.id, 'backgroundPage'),
      getViews: f => host.raw(ctx.id, 'views', f || {}),
      isAllowedIncognitoAccess: api('extension.isAllowedIncognitoAccess'), isAllowedFileSchemeAccess: api('extension.isAllowedFileSchemeAccess'), setUpdateUrlData() {}
    });
    const tabs = ns('tabs', 'get getCurrent query create update remove reload duplicate highlight move discard captureVisibleTab detectLanguage getZoom setZoom getZoomSettings setZoomSettings group ungroup goBack goForward insertCSS removeCSS getSelected getAllInWindow',
      'onCreated onUpdated onActivated onRemoved onReplaced onMoved onAttached onDetached onHighlighted onZoomChange onActiveChanged onSelectionChanged', {
        TAB_ID_NONE: -1, TAB_INDEX_NONE: -1, MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND: 2,
        sendMessage: (tabId, ...a) => { if (a[1] && typeof a[1] === 'object' && a.length >= 2 && typeof a[1] !== 'function') { const opts = a.splice(1, 1)[0]; return sendMessage({ tab: tabId, frameId: opts.frameId, documentId: opts.documentId }, a); } return sendMessage({ tab: tabId }, a); },
        connect: (tabId, info) => connect({ tab: tabId }, info),
        executeScript: api('tabs.executeScript')
      });
    const windows = ns('windows', 'get getCurrent getLastFocused getAll create update remove', 'onCreated onRemoved onFocusChanged onBoundsChanged', { WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2 });
    const action = Object.assign(ns('action', 'setBadgeText getBadgeText setBadgeBackgroundColor getBadgeBackgroundColor setBadgeTextColor getBadgeTextColor setTitle getTitle setPopup getPopup enable disable isEnabled openPopup getUserSettings', 'onClicked onUserSettingsChanged'), { setIcon: api('action.setIcon', iconPrep) });
    const scripting = ns('scripting', 'insertCSS removeCSS registerContentScripts getRegisteredContentScripts unregisterContentScripts updateContentScripts', '', { executeScript: api('scripting.executeScript', scriptPrep), ExecutionWorld: { ISOLATED: 'ISOLATED', MAIN: 'MAIN' }, StyleOrigin: { AUTHOR: 'AUTHOR', USER: 'USER' } });
    const menuCreate = (props, cb) => {
      const p = Object.assign({}, props || {});
      if (p.id == null) p.id = 'mochii-' + Math.random().toString(36).slice(2);
      if (typeof p.onclick === 'function') { menuClicks[p.id] = p.onclick; delete p.onclick; }
      callHost('contextMenus.create', [p]).then(() => cb && withLastError(null, () => cb()), e => cb && withLastError(e, () => cb()));
      return p.id;
    };
    const menuUpdate = (id, props, cb) => { const p = Object.assign({}, props || {}); if (typeof p.onclick === 'function') { menuClicks[id] = p.onclick; delete p.onclick; } const r = callHost('contextMenus.update', [id, p]); if (!cb) return r; r.then(() => withLastError(null, cb), e => withLastError(e, cb)); };
    const contextMenus = ns('contextMenus', 'remove removeAll', 'onClicked onShown onHidden', { create: menuCreate, update: menuUpdate, refresh() {}, ACTION_MENU_TOP_LEVEL_LIMIT: 6, ContextType: { ALL: 'all', PAGE: 'page', FRAME: 'frame', SELECTION: 'selection', LINK: 'link', EDITABLE: 'editable', IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio', LAUNCHER: 'launcher', BROWSER_ACTION: 'browser_action', PAGE_ACTION: 'page_action', ACTION: 'action' }, ItemType: { NORMAL: 'normal', CHECKBOX: 'checkbox', RADIO: 'radio', SEPARATOR: 'separator' } });
    const dnr = ns('declarativeNetRequest', 'updateDynamicRules getDynamicRules updateSessionRules getSessionRules updateEnabledRulesets getEnabledRulesets updateStaticRules getDisabledRuleIds getAvailableStaticRuleCount getMatchedRules isRegexSupported setExtensionActionOptions testMatchOutcome', 'onRuleMatchedDebug', {
      GUARANTEED_MINIMUM_STATIC_RULES: 30000, MAX_NUMBER_OF_STATIC_RULESETS: 100, MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50, MAX_NUMBER_OF_DYNAMIC_RULES: 30000, MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000, MAX_NUMBER_OF_SESSION_RULES: 5000, MAX_NUMBER_OF_UNSAFE_SESSION_RULES: 5000, MAX_NUMBER_OF_REGEX_RULES: 1000, MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL: 20, GETMATCHEDRULES_QUOTA_INTERVAL: 10, DYNAMIC_RULESET_ID: '_dynamic', SESSION_RULESET_ID: '_session',
      ResourceType: { MAIN_FRAME: 'main_frame', SUB_FRAME: 'sub_frame', STYLESHEET: 'stylesheet', SCRIPT: 'script', IMAGE: 'image', FONT: 'font', OBJECT: 'object', XMLHTTPREQUEST: 'xmlhttprequest', PING: 'ping', CSP_REPORT: 'csp_report', MEDIA: 'media', WEBSOCKET: 'websocket', WEBTRANSPORT: 'webtransport', WEBBUNDLE: 'webbundle', OTHER: 'other' },
      RuleActionType: { BLOCK: 'block', REDIRECT: 'redirect', ALLOW: 'allow', UPGRADE_SCHEME: 'upgradeScheme', MODIFY_HEADERS: 'modifyHeaders', ALLOW_ALL_REQUESTS: 'allowAllRequests' },
      DomainType: { FIRST_PARTY: 'firstParty', THIRD_PARTY: 'thirdParty' }, RequestMethod: { CONNECT: 'connect', DELETE: 'delete', GET: 'get', HEAD: 'head', OPTIONS: 'options', PATCH: 'patch', POST: 'post', PUT: 'put', OTHER: 'other' },
      HeaderOperation: { APPEND: 'append', SET: 'set', REMOVE: 'remove' }, UnsupportedRegexReason: { SYNTAX_ERROR: 'syntaxError', MEMORY_LIMIT_EXCEEDED: 'memoryLimitExceeded' }
    });
    // tts runs right here with the page's own speechSynthesis
    const tts = {
      speak(text, opts, cb) {
        if (typeof opts === 'function') { cb = opts; opts = {}; } opts = opts || {};
        try {
          const s = speechSynthesis, u = new SpeechSynthesisUtterance(String(text || ''));
          if (opts.lang) u.lang = opts.lang; if (opts.rate) u.rate = opts.rate; if (opts.pitch) u.pitch = opts.pitch; if (opts.volume != null) u.volume = opts.volume;
          if (opts.voiceName) { const v = s.getVoices().find(x => x.name === opts.voiceName); if (v) u.voice = v; }
          const send = type => e => { try { opts.onEvent && opts.onEvent({ type, charIndex: e && e.charIndex, length: e && e.charLength }); } catch {} };
          u.onstart = send('start'); u.onend = send('end'); u.onerror = send('error'); u.onpause = send('pause'); u.onresume = send('resume'); u.onboundary = e => send(e.name === 'sentence' ? 'sentence' : 'word')(e);
          if (!opts.enqueue) s.cancel();
          s.speak(u);
        } catch (e) { lastError = { message: String(e) }; }
        cb && cb(); return Promise.resolve();
      },
      stop() { try { speechSynthesis.cancel(); } catch {} }, pause() { try { speechSynthesis.pause(); } catch {} }, resume() { try { speechSynthesis.resume(); } catch {} },
      isSpeaking(cb) { const v = (() => { try { return speechSynthesis.speaking; } catch { return false; } })(); cb && cb(v); return Promise.resolve(v); },
      getVoices(cb) { const v = (() => { try { return speechSynthesis.getVoices().map(x => ({ voiceName: x.name, lang: x.lang, remote: !x.localService, eventTypes: ['start', 'end', 'word', 'sentence', 'error'] })); } catch { return []; } })(); cb && cb(v); return Promise.resolve(v); },
      onVoicesChanged: ev('tts.onVoicesChanged')
    };
    const offscreen = ns('offscreen', 'createDocument closeDocument hasDocument', '', { Reason: new Proxy({}, { get: (t, k) => typeof k === 'string' ? k : undefined }) });
    const identity = Object.assign(stub('identity'), {});
    Object.assign(chrome, {
      tabs, windows, action, scripting, contextMenus, declarativeNetRequest: dnr, tts, offscreen,
      menus: contextMenus,
      alarms: ns('alarms', 'create get getAll clear clearAll', 'onAlarm'),
      notifications: ns('notifications', 'create update clear getAll getPermissionLevel', 'onClicked onClosed onButtonClicked onPermissionLevelChanged onShowSettings', { TemplateType: { BASIC: 'basic', IMAGE: 'image', LIST: 'list', PROGRESS: 'progress' } }),
      permissions: ns('permissions', 'contains getAll request remove addHostAccessRequest removeHostAccessRequest', 'onAdded onRemoved'),
      commands: ns('commands', 'getAll', 'onCommand'),
      webNavigation: ns('webNavigation', 'getFrame getAllFrames', 'onBeforeNavigate onCommitted onDOMContentLoaded onCompleted onErrorOccurred onCreatedNavigationTarget onReferenceFragmentUpdated onTabReplaced onHistoryStateUpdated'),
      webRequest: ns('webRequest', 'handlerBehaviorChanged', 'onBeforeRequest onBeforeSendHeaders onSendHeaders onHeadersReceived onAuthRequired onResponseStarted onBeforeRedirect onCompleted onErrorOccurred onActionIgnored', { MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: 20 }),
      sidePanel: ns('sidePanel', 'setOptions getOptions setPanelBehavior getPanelBehavior open close', 'onOpened onClosed'),
      management: ns('management', 'getSelf getAll get setEnabled uninstallSelf uninstall getPermissionWarningsById launchApp createAppShortcut', 'onInstalled onUninstalled onEnabled onDisabled'),
      downloads: ns('downloads', 'download search pause resume cancel open show showDefaultFolder erase removeFile acceptDanger setShelfEnabled setUiOptions getFileIcon', 'onCreated onErased onChanged onDeterminingFilename'),
      search: ns('search', 'query'),
      idle: ns('idle', 'queryState setDetectionInterval getAutoLockDelay', 'onStateChanged'),
      fontSettings: Object.assign(stub('fontSettings'), {}),
      ttsEngine: stub('ttsEngine'), identity, cookies: stub('cookies'), history: stub('history'), bookmarks: stub('bookmarks'), privacy: stub('privacy'), proxy: stub('proxy'),
      tabCapture: stub('tabCapture'), tabGroups: stub('tabGroups'), sessions: stub('sessions'), topSites: stub('topSites'), contentSettings: stub('contentSettings'), browsingData: stub('browsingData'),
      pageCapture: stub('pageCapture'), desktopCapture: stub('desktopCapture'), power: stub('power'), readingList: stub('readingList'), system: stub('system'), gcm: stub('gcm'), instanceID: stub('instanceID'),
      declarativeContent: stub('declarativeContent'), debugger: stub('debugger'), omnibox: stub('omnibox'), devtools: undefined, documentScan: stub('documentScan'), printing: stub('printing'), wallpaper: stub('wallpaper')
    });
    chrome.identity.getRedirectURL = p => 'https://' + ctx.extId + '.chromiumapp.org/' + String(p || '').replace(/^\//, '');
    chrome.browserAction = action; chrome.pageAction = Object.assign({}, action, { show: api('action.enable'), hide: api('action.disable') });
    if (ctx.mv === 3) { delete chrome.browserAction; delete chrome.pageAction; }
    else { tabs.executeScript = api('tabs.executeScript', a => { if (typeof a[0] !== 'number' && a[0] != null) a.unshift(null); return a; }); }
  }

  // the host calls these to deliver things into this realm
  const rt = {
    chrome,
    dispatch(name, json) {
      const args = json ? JSON.parse(json) : [];
      if (name === 'runtime.onMessage' || name === 'runtime.onMessageExternal') {
        const list = ev(name)._list.slice(); if (!list.length) return null;
        return new Promise(res => {
          let done = false, keep = false;
          const reply = v => { if (!done) { done = true; res({ r: v === undefined ? null : JSON.parse(JSON.stringify(v === undefined ? null : v)) }); } };
          for (const fn of list) {
            let out; try { out = fn(args[0], args[1], reply); } catch (e) { console.error(e); }
            if (out === true) keep = true; else if (out && typeof out.then === 'function') { keep = true; out.then(reply, () => reply(undefined)); }
          }
          if (!keep && !done) res({ none: true });
        });
      }
      if (name === 'runtime.onConnect' || name === 'runtime.onConnectExternal') {
        const list = ev(name)._list.slice(); if (!list.length) return false;
        const port = makePort(args[0], args[1], args[2]);
        for (const fn of list) { try { fn(port); } catch (e) { console.error(e); } }
        return true;
      }
      if (name === 'contextMenus.onClicked') { const f = menuClicks[args[0] && args[0].menuItemId]; if (f) { try { f(args[0], args[1]); } catch (e) { console.error(e); } } }
      if (name === 'storage.onChanged') fire('storage.' + args[1] + '.onChanged', [args[0]]);
      fire(name, args);
      return undefined;
    },
    hasListeners: name => !!(events[name] && events[name]._list.length),
    portMessage(id, json) { const p = ports[id]; if (!p) return; const msg = JSON.parse(json); for (const fn of p.port.onMessage._list.slice()) { try { fn(msg, p.port); } catch (e) { console.error(e); } } },
    portClosed(id, err) { const p = ports[id]; if (p) p.close(err); }
  };
  return rt;
}

// content scripts get a self / globalThis that hands out chrome and keeps their own globals apart from the page's,
// which is as close to chrome's isolated world as one realm allows. also turned into a string and run in the frame
function mochiiContentWorld(win, chrome) {
  const own = { chrome }, bound = new WeakMap();
  return new Proxy(win, {
    get(t, k) {
      if (k in own) return own[k];
      let v; try { v = Reflect.get(t, k); } catch { return undefined; }
      if (typeof v === 'function' && !v.prototype) { let b = bound.get(v); if (!b) { b = v.bind(t); bound.set(v, b); } return b; }
      return v;
    },
    set(t, k, v) { if (k in own || !(k in t)) own[k] = v; else { try { t[k] = v; } catch {} } return true; },
    has(t, k) { return k in own || k in t; },
    deleteProperty(t, k) { delete own[k]; return true; }
  });
}

// extension pages: find the app above us, ask it who we are, then set up chrome and the service worker globals
(function () {
  if (typeof window === 'undefined') return;
  let host = null;
  try { for (let w = window.parent; w; w = w.parent) { if (w.__mochiiExt) { host = w.__mochiiExt; break; } if (w === w.parent) break; } } catch {}
  if (!host || window.__mochiiExt) return;
  const ctx = host.attachPage(window);
  if (!ctx) return;
  const rt = mochiiChromeApi(host, ctx);
  window.__mochiiRt = rt;
  try { Object.defineProperty(window, 'chrome', { value: rt.chrome, configurable: true, writable: true }); } catch { window.chrome = rt.chrome; }
  if (ctx.kind === 'popup' || ctx.kind === 'side') window.close = () => host.closeSurface(ctx.id);
  if (ctx.kind !== 'background' || !ctx.worker) return;
  // a manifest v3 service worker runs in this page, so give it the worker globals it expects
  const base = ctx.workerUrl;
  self.importScripts = (...urls) => {
    for (const u of urls) {
      const url = new URL(u, base).href, x = new XMLHttpRequest();
      x.open('GET', url, false); x.send();
      if (x.status >= 400) throw new Error('importScripts failed: ' + url);
      (0, eval)(x.responseText + '\n//# sourceURL=' + url);
    }
  };
  self.skipWaiting = () => Promise.resolve();
  self.clients = { claim: () => Promise.resolve(), matchAll: () => Promise.resolve([]), get: () => Promise.resolve(undefined), openWindow: url => rt.chrome.tabs.create({ url }) };
  const reg = { scope: ctx.baseUrl, active: { state: 'activated', scriptURL: base, postMessage() {} }, installing: null, waiting: null, navigationPreload: { enable: () => Promise.resolve(), disable: () => Promise.resolve(), setHeaderValue: () => Promise.resolve(), getState: () => Promise.resolve({ enabled: false }) },
    showNotification: (title, o) => rt.chrome.notifications.create({ type: 'basic', title, message: (o && o.body) || '', iconUrl: (o && o.icon) || '' }), getNotifications: () => Promise.resolve([]), update: () => Promise.resolve(), unregister: () => Promise.resolve(false), addEventListener() {}, removeEventListener() {} };
  try { Object.defineProperty(self, 'registration', { value: reg, configurable: true }); Object.defineProperty(self, 'serviceWorker', { value: reg.active, configurable: true }); } catch {}
})();
