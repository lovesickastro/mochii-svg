// sw.js puts this at the top of every proxied page while an extension is on, right after the proxy's own scripts.
// it tells the app a frame is starting, so content scripts can run at document_start
(function () {
  try { const s = document.currentScript; if (s) s.remove(); } catch {}
  try { for (let w = window.parent; w; w = w.parent) { if (w.__mochiiExt) { w.__mochiiExt.frameStart(window); return; } if (w === w.parent) return; } } catch {}
})();
