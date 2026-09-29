/* VWLOGIN_V2 — installed by the Engine app (Settings → Storefront widget → Repair widget). Edit in the app repo. */
/**
 * "Continue with Google" + profile for the review widget.
 * - Loads before review-widget.js. A Google sign-in from this browser (30 days) presents the shopper to the widget
 *   as a logged-in customer, and its token rides along on every call to the app proxy (/apps/engine).
 * - Signing in does not reload the page: the widget switches to the new customer and the reply that was typed is
 *   sent. If the widget is too old to switch, the page reloads and comes back to the same review / scroll position.
 * - VWLogin.profile() (or any element with data-vw-profile) opens the profile: orders, conversations, sign out.
 */
(function () {
    'use strict';
    var cfg = window.__vwGoogle || {};
    var PROXY = window.__arwProxyBase || '/apps/engine';
    var KEY = 'vw_glogin';
    var RESTORE = 'vw_restore';
    var enabled = !!(cfg.enabled && cfg.clientId);

    function read() {
        try {
            var v = JSON.parse(localStorage.getItem(KEY) || 'null');
            if (v && v.token && v.exp > Date.now()) return v;
            if (v) localStorage.removeItem(KEY);
        } catch (e) { /* storage blocked */ }
        return null;
    }
    var session = read();
    var shopifyCustomer = window.__arwCustomer && window.__arwCustomer.via !== 'google' ? window.__arwCustomer : null;

    function asCustomer(s) {
        return { id: s.id, firstName: s.name, lastName: '', name: s.name, loggedIn: true, via: 'google' };
    }
    if (session && !window.__arwCustomer) window.__arwCustomer = asCustomer(session);

    /* token on every call to the review API (reads the current session, so a fresh sign-in works at once) */
    if (window.fetch) {
        var origFetch = window.fetch.bind(window);
        window.fetch = function (input, init) {
            try {
                var url = typeof input === 'string' ? input : (input && input.url) || '';
                var isProxy = url.indexOf(PROXY) === 0 || url.indexOf(location.origin + PROXY) === 0;
                if (session && isProxy) {
                    init = init || {};
                    var method = String(init.method || 'GET').toUpperCase();
                    if (method === 'POST' && typeof init.body === 'string') {
                        var b = JSON.parse(init.body);
                        if (b && typeof b === 'object' && !b.appToken) {
                            b.appToken = session.token;
                            init = Object.assign({}, init, { body: JSON.stringify(b) });
                        }
                    } else if (method === 'GET' && typeof input === 'string' && input.indexOf('vw_t=') < 0) {
                        input = input + (input.indexOf('?') >= 0 ? '&' : '?') + 'vw_t=' + encodeURIComponent(session.token);
                    }
                }
            } catch (e) { /* leave the call as it was */ }
            return origFetch(input, init);
        };
    }

    /* ── remember where the shopper was (before a reload or the email login page) ── */
    function openReviewId() {
        var sheetEl = document.getElementById('ai-reply-sheet');
        if (!sheetEl || !sheetEl.classList.contains('active')) return '';
        var b = sheetEl.querySelector('.yt-origin [data-review-id]');
        return b ? b.getAttribute('data-review-id') || '' : '';
    }
    function remember() {
        try {
            var input = document.getElementById('ai-sheet-input');
            sessionStorage.setItem(RESTORE, JSON.stringify({
                path: location.pathname, y: window.scrollY, review: openReviewId(),
                text: input ? input.value : '', t: Date.now()
            }));
        } catch (e) { /* storage blocked */ }
    }
    function restore() {
        var st = null;
        try { st = JSON.parse(sessionStorage.getItem(RESTORE) || 'null'); sessionStorage.removeItem(RESTORE); } catch (e) { st = null; }
        if (!st || st.path !== location.pathname || Date.now() - st.t > 15 * 60 * 1000) return;
        try { history.scrollRestoration = 'manual'; } catch (e) { /* old browser */ }
        var tries = 0;
        (function wait() {
            var card = st.review ? document.querySelector('.ai-review-card[data-review-id="' + st.review + '"]') : null;
            var ready = window.ARWidget && (!st.review || card);
            if (!ready && tries++ < 60) { setTimeout(wait, 100); return; }
            if (card) {
                card.scrollIntoView({ block: 'center' });
                if (window.ARWidget && window.ARWidget.openReplies) {
                    window.ARWidget.openReplies(card.querySelector('.ai-action-btn') || card);
                    setTimeout(function () {
                        var input = document.getElementById('ai-sheet-input');
                        if (input && st.text && !input.value) input.value = st.text;
                    }, 350);
                }
            } else {
                window.scrollTo(0, st.y || 0);
                setTimeout(function () { window.scrollTo(0, st.y || 0); }, 400); // again after late content
            }
        })();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', restore); else restore();

    /* ── shared bottom-sheet look ── */
    var cssDone = false;
    function css() {
        if (cssDone) return;
        cssDone = true;
        var el = document.createElement('style');
        el.textContent = [
            '.vwl-back{position:fixed;inset:0;z-index:2147483500;background:rgba(0,0,0,.45);opacity:0;transition:opacity .2s ease}',
            '.vwl-back.is-open{opacity:1}',
            '.vwl{position:fixed;left:0;right:0;bottom:0;z-index:2147483501;max-width:480px;max-height:88vh;overflow:auto;margin:0 auto;padding:10px 20px calc(22px + env(safe-area-inset-bottom));',
            'background:#fff;border-radius:18px 18px 0 0;box-shadow:0 -8px 30px rgba(0,0,0,.12);transform:translateY(100%);transition:transform .32s cubic-bezier(.2,.8,.2,1);',
            'font-family:Roboto,Helvetica,Arial,sans-serif;color:#141414;text-align:center}',
            '.vwl.is-open{transform:none}',
            '.vwl-bar{width:40px;height:4px;border-radius:2px;background:#ddd;margin:0 auto 14px}',
            '.vwl h3{margin:0 0 4px;font-size:18px;font-weight:700}',
            '.vwl p{margin:0 0 16px;color:#606060;font-size:13.5px;line-height:1.4}',
            '.vwl-g{display:flex;justify-content:center;min-height:44px;margin-bottom:10px}',
            '.vwl-or{display:flex;align-items:center;gap:10px;margin:6px 0 10px;color:#9a9a9a;font-size:12px}',
            '.vwl-or:before,.vwl-or:after{content:"";flex:1;height:1px;background:#eee}',
            '.vwl-email{display:block;height:44px;line-height:44px;border:1px solid #dadce0;border-radius:22px;color:#141414;font-size:14px;font-weight:500;text-decoration:none}',
            '.vwl-msg{margin:10px 0 0;font-size:12.5px;color:#606060}.vwl-msg.is-bad{color:#b3261e}',
            '.vwl-note{margin:12px 0 0!important;font-size:11.5px!important;color:#9a9a9a!important}',
            '.vwl-x{position:absolute;right:12px;top:10px;width:32px;height:32px;border:0;border-radius:50%;background:#f2f2f2;font-size:18px;line-height:1;cursor:pointer}',
            /* profile */
            '.vwp{text-align:left}',
            '.vwp-head{display:flex;align-items:center;gap:12px;margin:4px 0 14px}',
            '.vwp-av{width:48px;height:48px;border-radius:50%;background:#141414;color:#fff;display:grid;place-items:center;font-size:19px;font-weight:700;flex-shrink:0}',
            '.vwp-name{font-size:17px;font-weight:700;line-height:1.2}',
            '.vwp-mail{font-size:12.5px;color:#707070;margin-top:2px;word-break:break-all}',
            '.vwp-via{display:inline-block;margin-top:4px;font-size:11px;color:#606060;background:#f2f2f2;border-radius:999px;padding:1px 8px}',
            '.vwp-stats{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px}',
            '.vwp-stat{border:1px solid #eee;border-radius:12px;padding:10px 12px}',
            '.vwp-stat b{display:block;font-size:18px}',
            '.vwp-stat span{font-size:12px;color:#707070}',
            '.vwp-h{font-size:13px;font-weight:700;margin:4px 0 8px}',
            '.vwp-order{border:1px solid #eee;border-radius:12px;padding:10px 12px;margin-bottom:8px}',
            '.vwp-order-top{display:flex;justify-content:space-between;gap:8px;font-size:13px}',
            '.vwp-order-top b{font-weight:700}',
            '.vwp-order-sub{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;font-size:11.5px;color:#707070}',
            '.vwp-chip{border-radius:999px;padding:1px 8px;background:#f2f2f2;color:#303030}',
            '.vwp-chip.ok{background:#e8f5ec;color:#1a7f37}',
            '.vwp-items{display:flex;gap:6px;margin-top:8px;overflow-x:auto}',
            '.vwp-item{display:flex;align-items:center;gap:6px;min-width:0;max-width:220px;font-size:12px;color:#303030;text-decoration:none}',
            '.vwp-item img{width:36px;height:36px;border-radius:8px;object-fit:cover;background:#f2f2f2;flex-shrink:0}',
            '.vwp-item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.vwp-empty{font-size:13px;color:#707070;padding:10px 0}',
            '.vwp-foot{display:flex;gap:8px;margin-top:14px}',
            '.vwp-btn{flex:1;height:42px;border-radius:21px;border:1px solid #dadce0;background:#fff;color:#141414;font:inherit;font-size:14px;font-weight:500;cursor:pointer;text-decoration:none;display:grid;place-items:center}',
            '.vwp-btn.dark{background:#141414;border-color:#141414;color:#fff}',
            '.vwp-skel{height:64px;border-radius:12px;background:linear-gradient(90deg,#f2f2f2,#fafafa,#f2f2f2);background-size:200% 100%;animation:vwp-sh 1.2s infinite;margin-bottom:8px}',
            '@keyframes vwp-sh{to{background-position:-200% 0}}'
        ].join('');
        document.head.appendChild(el);
    }

    function makeSheet(label) {
        css();
        var back = document.createElement('div');
        back.className = 'vwl-back';
        var el = document.createElement('div');
        el.className = 'vwl';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.setAttribute('aria-label', label);
        document.body.appendChild(back);
        document.body.appendChild(el);
        function close() {
            el.classList.remove('is-open');
            back.classList.remove('is-open');
            setTimeout(function () { back.style.display = 'none'; el.style.visibility = 'hidden'; }, 320);
        }
        back.addEventListener('click', close);
        el.__close = close;
        el.__show = function () {
            back.style.display = '';
            el.style.visibility = '';
            requestAnimationFrame(function () { back.classList.add('is-open'); el.classList.add('is-open'); });
        };
        return el;
    }

    /* ── Google sign-in sheet ── */
    var sheet = null, gisLoading = null;

    function loadGis() {
        if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve();
        if (gisLoading) return gisLoading;
        gisLoading = new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = 'https://accounts.google.com/gsi/client';
            s.async = true;
            s.onload = function () { resolve(); };
            s.onerror = function () { reject(new Error('Could not load Google sign-in')); };
            document.head.appendChild(s);
        });
        return gisLoading;
    }

    function msg(text, bad) {
        var m = sheet && sheet.querySelector('.vwl-msg');
        if (!m) return;
        m.textContent = text || '';
        m.hidden = !text;
        m.classList.toggle('is-bad', !!bad);
    }

    function setMe() {
        var c = window.__arwCustomer;
        var n = c && (c.firstName || c.name);
        document.querySelectorAll('.yt-me').forEach(function (me) {
            me.textContent = n ? String(n).charAt(0).toUpperCase() : '?';
        });
    }

    function afterLogin(d) {
        session = { token: d.token, id: d.customerId, name: d.name, exp: Date.now() + (d.days || 30) * 864e5 };
        try { localStorage.setItem(KEY, JSON.stringify(session)); } catch (e) { /* storage blocked */ }
        window.VWLogin.session = session;
        if (typeof window.__arwSetCustomer !== 'function') {
            // widget can't switch customers on the fly: reload, then come back to the same place
            msg('Signed in as ' + d.name + '. One moment…');
            remember();
            setTimeout(function () { location.reload(); }, 300);
            return;
        }
        window.__arwCustomer = asCustomer(session);
        window.__arwSetCustomer(window.__arwCustomer);
        setMe();
        msg('Signed in as ' + d.name);
        setTimeout(function () { if (sheet) sheet.__close(); }, 450);
        try { window.dispatchEvent(new CustomEvent('vw:login', { detail: { name: d.name, id: d.customerId } })); } catch (e) { /* old browser */ }
        // the reply that was waiting for the login goes out now
        var replySheet = document.getElementById('ai-reply-sheet');
        var input = document.getElementById('ai-sheet-input');
        if (replySheet && replySheet.classList.contains('active') && input && input.value.replace(/^@\S[^\n]*?​\s?/, '').trim()
            && window.ARWidget && window.ARWidget.submitComment) {
            setTimeout(function () { window.ARWidget.submitComment(); }, 500);
        }
    }

    function onCredential(resp) {
        msg('Signing you in…');
        fetch(PROXY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actionType: 'google_login', credential: resp && resp.credential })
        }).then(function (r) { return r.json(); }).then(function (d) {
            if (!d || !d.success) throw new Error((d && d.error) || 'Google sign-in failed');
            afterLogin(d);
        }).catch(function (e) { msg(e.message || 'Google sign-in failed', true); });
    }

    function build() {
        if (sheet) return sheet;
        sheet = makeSheet('Log in');
        sheet.innerHTML =
            '<div class="vwl-bar"></div>' +
            '<button type="button" class="vwl-x" aria-label="Close">&times;</button>' +
            '<h3>Log in to continue</h3>' +
            '<p>Post reviews, reply to comments and mark reviews helpful.</p>' +
            '<div class="vwl-g" id="vwl-g"></div>' +
            '<div class="vwl-or">or</div>' +
            '<a class="vwl-email" href="#">Log in with email</a>' +
            '<div class="vwl-msg" hidden></div>' +
            '<p class="vwl-note">We only use your name and email to show your reviews and comments.</p>';
        sheet.querySelector('.vwl-x').addEventListener('click', sheet.__close);
        sheet.querySelector('.vwl-email').addEventListener('click', remember); // come back to the same place
        return sheet;
    }

    function open(returnUrl) {
        var ret = returnUrl || (location.pathname + location.search);
        if (!enabled) { remember(); location.href = '/account/login?return_url=' + encodeURIComponent(ret); return; }
        build();
        sheet.querySelector('.vwl-email').setAttribute('href', '/account/login?return_url=' + encodeURIComponent(ret));
        msg('');
        sheet.__show();
        loadGis().then(function () {
            window.google.accounts.id.initialize({ client_id: cfg.clientId, callback: onCredential, ux_mode: 'popup', auto_select: false, itp_support: true });
            var box = sheet.querySelector('#vwl-g');
            box.innerHTML = '';
            window.google.accounts.id.renderButton(box, { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', logo_alignment: 'left', width: Math.min(360, (sheet.clientWidth || 340) - 40) });
        }).catch(function () { msg('Google sign-in could not load. Please use email.', true); });
    }

    function signOut() {
        try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
        if (session) { remember(); location.reload(); return; }
        location.href = '/account/logout';
    }

    /* ── profile ── */
    var prof = null;
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function money(a, c) {
        var n = Number(a);
        if (!isFinite(n)) return '';
        try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: c || 'INR', maximumFractionDigits: 0 }).format(n); } catch (e) { return (c || '') + ' ' + n; }
    }
    function nice(s) { return String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, function (x) { return x.toUpperCase(); }); }

    function profile() {
        var c = window.__arwCustomer;
        if (!c || !c.id) { open(); return; }
        if (!prof) prof = makeSheet('Your profile');
        var name = c.firstName || c.name || 'You';
        var viaGoogle = c.via === 'google';
        prof.innerHTML =
            '<div class="vwl-bar"></div><button type="button" class="vwl-x" aria-label="Close">&times;</button>' +
            '<div class="vwp">' +
            '<div class="vwp-head"><div class="vwp-av">' + esc(name.charAt(0).toUpperCase()) + '</div><div>' +
            '<div class="vwp-name">' + esc(name) + '</div><div class="vwp-mail"></div>' +
            '<span class="vwp-via">' + (viaGoogle ? 'Signed in with Google' : 'Store account') + '</span></div></div>' +
            '<div class="vwp-stats"><div class="vwp-stat"><b class="vwp-n-orders">–</b><span>Orders</span></div>' +
            '<div class="vwp-stat"><b class="vwp-n-threads">–</b><span>Conversations</span></div></div>' +
            '<div class="vwp-h">Recent orders</div><div class="vwp-orders"><div class="vwp-skel"></div><div class="vwp-skel"></div></div>' +
            '<div class="vwp-foot"><a class="vwp-btn" href="/account">My account</a><button type="button" class="vwp-btn dark vwp-out">Sign out</button></div>' +
            '</div>';
        prof.querySelector('.vwl-x').addEventListener('click', prof.__close);
        prof.querySelector('.vwp-out').addEventListener('click', signOut);
        prof.__show();

        fetch(PROXY + '?action=my_profile&_=' + Date.now(), { headers: { Accept: 'application/json' } })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (!d || !d.success) throw new Error((d && d.error) || 'Could not load your profile');
                prof.querySelector('.vwp-mail').textContent = d.email || '';
                prof.querySelector('.vwp-n-orders').textContent = d.ordersCount;
                prof.querySelector('.vwp-n-threads').textContent = d.threads;
                var box = prof.querySelector('.vwp-orders');
                if (!d.orders || !d.orders.length) {
                    box.innerHTML = '<div class="vwp-empty">No recent orders on this account.</div>';
                    return;
                }
                box.innerHTML = d.orders.map(function (o) {
                    var done = /FULFILLED|DELIVERED/i.test(o.status || '') && !/UN|PARTIAL/i.test(o.status || '');
                    return '<div class="vwp-order"><div class="vwp-order-top"><b>' + esc(o.name) + '</b><span>' + esc(money(o.total, o.currency)) + '</span></div>' +
                        '<div class="vwp-order-sub"><span>' + esc(new Date(o.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })) + '</span>' +
                        '<span class="vwp-chip' + (done ? ' ok' : '') + '">' + esc(nice(o.status)) + '</span>' +
                        (o.payment ? '<span class="vwp-chip">' + esc(nice(o.payment)) + '</span>' : '') + '</div>' +
                        '<div class="vwp-items">' + (o.items || []).map(function (it) {
                            var inner = (it.image ? '<img src="' + esc(it.image) + (it.image.indexOf('?') >= 0 ? '&' : '?') + 'width=96" alt="" loading="lazy">' : '') +
                                '<span>' + esc(it.title) + (it.qty > 1 ? ' ×' + it.qty : '') + '</span>';
                            return it.handle ? '<a class="vwp-item" href="/products/' + esc(it.handle) + '">' + inner + '</a>' : '<div class="vwp-item">' + inner + '</div>';
                        }).join('') + '</div></div>';
                }).join('');
            })
            .catch(function (e) {
                var box = prof.querySelector('.vwp-orders');
                if (box) box.innerHTML = '<div class="vwp-empty">' + esc(e.message || 'Could not load your orders') + '</div>';
            });
    }

    // anything marked data-vw-profile opens the profile (not used inside the review widget)
    document.addEventListener('click', function (e) {
        var t = e.target && e.target.closest ? e.target.closest('[data-vw-profile]') : null;
        if (!t) return;
        e.preventDefault();
        profile();
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setMe); else setMe();

    window.VWLogin = { enabled: enabled, open: open, signOut: signOut, profile: profile, session: session, shopify: shopifyCustomer, version: 2 };
})();
