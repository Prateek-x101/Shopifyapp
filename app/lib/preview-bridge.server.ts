/**
 * Runs inside the live preview (the real product page, served by the app). Talks to the editor with postMessage:
 *   editor → page  { vw: "select", key }            outline + scroll to a widget
 *                  { vw: "draft", key, data }       show unsaved changes right away (offer bar, badges, WhatsApp lines)
 *                  { vw: "device", mobile }          (layout hint only)
 *   page → editor  { vw: "ready", present: [...] }   which widgets are on this page
 *                  { vw: "select", key }             the shopper-view element that was clicked
 * Links and forms don't navigate/submit in the preview.
 */
export const BRIDGE_JS = String.raw`(function () {
  if (window.__vwBridge) return; window.__vwBridge = true;
  /* every theme section on the page can be picked: id "shopify-section-<group>__<key>" → "header:<key>" / "template:<key>" */
  var labels = {};
  function idOf(sec) {
    var m = /^shopify-section-(.+?)__(.+)$/.exec(sec.id || "");
    if (!m) return null;
    return (/^template--/.test(m[1]) ? "template:" : "header:") + m[2];
  }
  function el(id) {
    if (!id) return null;
    var key = id.slice(id.indexOf(":") + 1), tpl = id.indexOf("template:") === 0;
    var list = document.querySelectorAll('[id$="__' + key + '"].shopify-section, .shopify-section[id$="__' + key + '"]');
    for (var i = 0; i < list.length; i++) {
      if (/^shopify-section-template--/.test(list[i].id) === tpl) return target(list[i]);
    }
    return null;
  }
  /* the visible part of a section (fixed widgets like the floating video live inside a zero-height section) */
  function target(sec) {
    if (visible(sec)) return sec;
    var kids = sec.querySelectorAll("*");
    for (var i = 0; i < kids.length; i++) { var r = kids[i].getBoundingClientRect(); if (r.width > 20 && r.height > 20) return kids[i]; }
    return null;
  }
  function label(id) { return labels[id] || (id || "").replace(/^.*?:/, "").replace(/[-_]/g, " "); }
  function visible(n) { if (!n) return false; var r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function keyOf(t) {
    var sec = t && t.closest ? t.closest(".shopify-section") : null;
    return sec ? idOf(sec) : null;
  }
  var post = function (m) { try { window.parent.postMessage(m, "*"); } catch (e) {} };

  /* outlines (don't take clicks) */
  var css = document.createElement("style");
  css.textContent = ".vwx-box{position:fixed;z-index:2147483600;pointer-events:none;border:2px solid #005bd3;border-radius:4px;transition:all .12s ease;display:none}"
    + ".vwx-box.hover{border-style:dashed;border-color:rgba(0,91,211,.6)}"
    + ".vwx-box span{position:absolute;left:-2px;top:-22px;background:#005bd3;color:#fff;font:600 11px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:5px 7px;border-radius:4px 4px 0 0;white-space:nowrap}"
    + ".vwx-box.low span{top:auto;bottom:-22px;border-radius:0 0 4px 4px}"
    + ".vwx-box.hover span{background:rgba(0,91,211,.85)}"
    + "html{scroll-behavior:smooth}";
  document.head.appendChild(css);
  function box(cls) { var b = document.createElement("div"); b.className = "vwx-box " + cls; b.appendChild(document.createElement("span")); document.documentElement.appendChild(b); return b; }
  var hoverBox = box("hover"), selBox = box("sel");
  var sel = null, hov = null;
  function place(b, key) {
    var n = key && el(key);
    if (!n) { b.style.display = "none"; return; }
    var r = n.getBoundingClientRect();
    b.style.display = "block";
    b.style.left = Math.max(1, r.left) + "px"; b.style.top = Math.max(1, r.top) + "px";
    b.style.width = Math.min(r.width, innerWidth - Math.max(1, r.left) - 1) + "px"; b.style.height = r.height + "px";
    b.firstChild.textContent = label(key);
    b.classList.toggle("low", r.top < 26);
  }
  function tick() { place(selBox, sel); place(hoverBox, hov && hov !== sel ? hov : null); requestAnimationFrame(tick); }
  requestAnimationFrame(tick);

  document.addEventListener("mouseover", function (e) { hov = keyOf(e.target); }, true);
  document.addEventListener("mouseleave", function () { hov = null; });
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (a && !/^#/.test(a.getAttribute("href") || "")) e.preventDefault();
    var k = keyOf(e.target);
    if (k) { sel = k; post({ vw: "select", key: k }); }
  }, true);
  document.addEventListener("submit", function (e) { e.preventDefault(); }, true);

  /* unsaved changes, shown right away */
  var waTimer = null;
  function applyDraft(key, d) {
    if (!d) return;
    if (key === "offer") {
      var bar = document.getElementById("vwo");
      if (!bar) return;
      bar.style.display = d.enabled === false ? "none" : "";
      var t = bar.querySelector(".vwo-slide--timer .vwo-title"); if (t && d.title != null) t.textContent = d.title;
      var sub = document.getElementById("vwo-sub");
      if (sub) sub.textContent = d.timerMode === "No timer" ? "" : d.timerMode === "Fixed end date" ? (d.endLabel || "") : "Today only · ends at midnight";
      var tm = bar.querySelector(".vwo-timer"); if (tm) tm.style.display = d.timerMode === "No timer" ? "none" : "";
      if (d.background) { bar.classList.remove("vwo--classic"); bar.style.setProperty("--vwo-bg", d.background); bar.style.background = ""; }
      else if (d.hasImage === false) { bar.classList.add("vwo--classic"); }
    }
    if (key === "badges") {
      var node = document.getElementById("swb-data");
      if (!node) return;
      try {
        var data = JSON.parse(node.textContent);
        data.badges = d.lines;
        node.textContent = JSON.stringify(data);
        document.dispatchEvent(new CustomEvent("variant:changed"));
      } catch (e) {}
    }
    if (key === "whatsapp") {
      var btn = document.getElementById("sp-whatsapp-btn");
      var rot = btn && btn.querySelector(".sp-wa-rot");
      if (!rot) return;
      var first = rot.querySelector(".sp-wa-q");
      var head = first ? first.textContent : "Chat with us on WhatsApp";
      var lines = [head].concat(d.lines || []);
      rot.innerHTML = "";
      lines.forEach(function (l, i) { var s = document.createElement("span"); s.className = "sp-wa-q" + (i === 0 ? " is-on" : ""); s.textContent = l; rot.appendChild(s); });
      clearInterval(waTimer);
      var qs = rot.querySelectorAll(".sp-wa-q"), i = 0;
      if (qs.length > 1) waTimer = setInterval(function () {
        var cur = qs[i]; i = (i + 1) % qs.length; var nx = qs[i];
        cur.classList.remove("is-on"); cur.classList.add("is-out"); nx.classList.remove("is-out"); nx.classList.add("is-on");
        setTimeout(function () { cur.classList.remove("is-out"); }, 460);
      }, 2400);
    }
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var m = e.data || {};
    if (m.vw === "select") {
      sel = m.key;
      var n = el(m.key);
      if (n && m.scroll !== false) {
        var r = n.getBoundingClientRect();
        if (r.top < 60 || r.bottom > innerHeight - 20) window.scrollTo({ top: Math.max(0, scrollY + r.top - 90), behavior: "smooth" });
      }
    }
    if (m.vw === "draft") applyDraft(m.key, m.data);
    if (m.vw === "labels") labels = m.map || {};
    if (m.vw === "scrollTo") window.scrollTo(0, m.y || 0);
  });

  function ready() {
    var present = [];
    document.querySelectorAll(".shopify-section").forEach(function (sec) { var id = idOf(sec); if (id) present.push(id); });
    post({ vw: "ready", present: present, height: document.documentElement.scrollHeight });
  }
  if (document.readyState === "complete") setTimeout(ready, 50); else window.addEventListener("load", function () { setTimeout(ready, 50); });
  window.addEventListener("scroll", function () { post({ vw: "scroll", y: scrollY }); }, { passive: true });
})();`;
