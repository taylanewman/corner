/*
 * Corner — private storage layer
 * ------------------------------------------------------------------
 * The app itself is the same code as the original. This file gives it a
 * place to keep its data that nobody else can read:
 *
 *   • Everything is locked (AES-256-GCM) on this device with a key made
 *     from the owner's passphrase, BEFORE it is sent anywhere.
 *   • The sync database (Supabase) only ever stores locked text.
 *   • Changes are pushed live to the owner's other signed-in devices.
 *   • The passphrase never leaves the device and is never stored.
 *     (The unlocked key is kept on this device only, in a form the
 *     browser will not hand out, until "Lock this device".)
 *
 * It provides the same small storage interface the app already uses
 * (window.claude.use('db') → db.doc(path).get/set/delete/onSnapshot).
 */
(function () {
  'use strict';

  var TABLE = 'corner_docs';
  var META = '__meta';
  var KDF_ITER = 600000;
  var BACKUP_EVERY_DAYS = 14;

  /* ---------------- small helpers ---------------- */
  var LS = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var te = new TextEncoder(), td = new TextDecoder();
  function b64(buf) { var b = new Uint8Array(buf), s = ''; for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(s) { var bin = atob(s), b = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function deepFreeze(o) { if (o && typeof o === 'object') { Object.freeze(o); Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); } return o; }
  function netErr(e) { var m = String((e && (e.message || e.error_description)) || e || ''); return { code: 'unavailable', message: m }; }

  /* ---------------- settings: where the sync database is ---------------- */
  function config() {
    var baked = window.CORNER_CONFIG || {};
    var saved = LS.get('cp-config') || {};
    return { url: (baked.url || saved.url || '').trim(), key: (baked.anonKey || saved.key || '').trim(), baked: !!(baked.url && baked.anonKey) };
  }

  /* ---------------- the lock ---------------- */
  function deriveKey(pass, saltB64) {
    return crypto.subtle.importKey('raw', te.encode(pass.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']).then(function (base) {
      return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(saltB64), iterations: KDF_ITER, hash: 'SHA-256' }, base,
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    });
  }
  /* "path" is mixed in so a locked piece can't be swapped into another place */
  function lock(key, path, obj) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: te.encode(path) }, key, te.encode(JSON.stringify(obj)))
      .then(function (ct) { return { iv: b64(iv), data: b64(ct) }; });
  }
  function unlock(key, path, row) {
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(row.iv), additionalData: te.encode(path) }, key, unb64(row.data))
      .then(function (pt) { return JSON.parse(td.decode(pt)); });
  }

  /* the unlocked key stays on this device only (the browser won't let it be read out) */
  var IDB = 'corner-keys';
  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(IDB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('k'); };
      r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); };
    });
  }
  function keyGet(id) { return idb().then(function (d) { return new Promise(function (res) { var q = d.transaction('k').objectStore('k').get(id); q.onsuccess = function () { res(q.result || null); }; q.onerror = function () { res(null); }; }); }).catch(function () { return null; }); }
  function keyPut(id, k) { return idb().then(function (d) { return new Promise(function (res) { var tx = d.transaction('k', 'readwrite'); tx.objectStore('k').put(k, id); tx.oncomplete = function () { res(true); }; tx.onerror = function () { res(false); }; }); }).catch(function () { return false; }); }
  function keyDel(id) { return idb().then(function (d) { return new Promise(function (res) { var tx = d.transaction('k', 'readwrite'); tx.objectStore('k').delete(id); tx.oncomplete = function () { res(true); }; tx.onerror = function () { res(false); }; }); }).catch(function () { return false; }); }

  /* ---------------- the sync database ---------------- */
  var sb = null, uid = null, KEY = null;
  function client() {
    if (sb) return sb;
    var c = config();
    var lib = window.supabase;
    if (!lib || !lib.createClient) throw new Error('Sync library did not load.');
    sb = lib.createClient(c.url, c.key, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'cp-auth' } });
    return sb;
  }
  function cacheKey(path) { return 'cp-cache:' + uid + ':' + path; }
  function rowGet(path) {
    return sb.from(TABLE).select('iv,data,updated_at').eq('owner', uid).eq('path', path).maybeSingle().then(function (r) {
      if (r.error) throw r.error; return r.data;
    });
  }
  function rowPut(path, locked) {
    return sb.from(TABLE).upsert({ owner: uid, path: path, iv: locked.iv, data: locked.data, updated_at: new Date().toISOString() }, { onConflict: 'owner,path' })
      .then(function (r) { if (r.error) throw r.error; });
  }

  /* ---------------- the storage interface the app uses ---------------- */
  var listeners = {}, lastSent = {}, channel = null, refetchTimers = {}, online = true;
  function snapOf(obj) {
    var has = obj !== null && obj !== undefined;
    var frozen = has ? deepFreeze(JSON.parse(JSON.stringify(obj))) : undefined;
    return { exists: has, data: function () { return frozen; }, metadata: { hasPendingWrites: false, fromCache: !online } };
  }
  function getDoc(path) {
    return rowGet(path).then(function (row) {
      online = true; setNet(true);
      if (!row) { LS.del(cacheKey(path)); return snapOf(null); }
      LS.set(cacheKey(path), row);
      return unlock(KEY, path, row).then(snapOf);
    }, function (e) {
      online = false; setNet(false);
      var c = LS.get(cacheKey(path));                /* offline: use this device's locked copy */
      if (c) return unlock(KEY, path, c).then(snapOf);
      if (LS.get('cp-seen:' + uid)) return snapOf(null);
      throw netErr(e);
    });
  }
  function setDoc(path, obj) {
    return lock(KEY, path, obj).then(function (l) {
      lastSent[path] = l.data;
      return rowPut(path, l).then(function () {
        LS.set(cacheKey(path), { iv: l.iv, data: l.data }); LS.set('cp-seen:' + uid, 1); online = true; setNet(true);
      }, function (e) { online = false; setNet(false); throw netErr(e); });
    });
  }
  function delDoc(path) {
    return sb.from(TABLE).delete().eq('owner', uid).eq('path', path).then(function (r) {
      if (r.error) throw netErr(r.error); LS.del(cacheKey(path));
    });
  }
  function emit(path) {
    clearTimeout(refetchTimers[path]);
    refetchTimers[path] = setTimeout(function () {
      getDoc(path).then(function (s) { (listeners[path] || []).slice().forEach(function (cb) { try { cb(s); } catch (e) {} }); }).catch(function () {});
    }, 150);
  }
  function ensureChannel() {
    if (channel) return;
    channel = sb.channel('corner-' + uid)
      .on('postgres_changes', { event: '*', schema: 'public', table: TABLE, filter: 'owner=eq.' + uid }, function (p) {
        var row = p.new && p.new.path ? p.new : p.old;
        var path = row && row.path;
        if (!path || !listeners[path]) return;
        if (p.new && p.new.data && p.new.data === lastSent[path]) return;   /* our own change coming back */
        emit(path);                                                          /* fetch the full row, then unlock */
      })
      .subscribe(function (status) { if (status === 'SUBSCRIBED') catchUp(); });
  }
  /* after being offline or asleep, pull anything that changed meanwhile */
  function catchUp() { Object.keys(listeners).forEach(emit); }
  window.addEventListener('online', catchUp);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') catchUp(); });

  function makeDb() {
    return {
      doc: function (path) {
        return {
          get: function () { return getDoc(path); },
          set: function (obj) { return setDoc(path, obj); },
          delete: function () { return delDoc(path); },
          onSnapshot: function (cb, err) {
            (listeners[path] = listeners[path] || []).push(cb); ensureChannel();
            return function () { listeners[path] = (listeners[path] || []).filter(function (x) { return x !== cb; }); };
          }
        };
      }
    };
  }

  /* ---------------- screens: connect, sign in, passphrase ---------------- */
  var ov = null;
  var CSS = '' +
    '.cp-ov{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:20px;background:radial-gradient(1200px 700px at 20% 10%,#fde7f3 0,transparent 60%),radial-gradient(900px 600px at 90% 90%,#e0e7ff 0,transparent 60%),#f6f0fb;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;color:#2a2340}' +
    '@media (prefers-color-scheme:dark){.cp-ov{background:radial-gradient(1200px 700px at 20% 10%,#3a1d35 0,transparent 60%),radial-gradient(900px 600px at 90% 90%,#1e2550 0,transparent 60%),#17131f;color:#eee8f7}.cp-card{background:#221c2e!important;border-color:#3a3150!important}.cp-card input{background:#191422!important;color:#eee8f7!important;border-color:#3a3150!important}.cp-hint,.cp-small{color:#a99cc0!important}}' +
    '.cp-card{width:100%;max-width:420px;background:#fff;border:1px solid #eadff5;border-radius:22px;padding:26px 24px;box-shadow:0 20px 60px rgba(120,70,170,.18)}' +
    '.cp-logo{width:44px;height:44px;border-radius:14px;background:linear-gradient(135deg,#ec4899,#8b5cf6 55%,#3b82f6);display:flex;align-items:center;justify-content:center;color:#fff;font-size:22px;margin-bottom:12px}' +
    '.cp-card h1{font-family:Nunito,Inter,sans-serif;font-size:22px;margin:0 0 6px}' +
    '.cp-card p{margin:0 0 14px;font-size:14px;line-height:1.5}' +
    '.cp-card label{display:block;font-size:12.5px;font-weight:600;margin:12px 0 5px}' +
    '.cp-card input[type=text],.cp-card input[type=email],.cp-card input[type=password],.cp-card input[type=url]{width:100%;box-sizing:border-box;border:1px solid #e3d8f0;border-radius:11px;padding:11px 12px;font-size:15px;outline:none;background:#fff;color:#2a2340}' +
    '.cp-card input:focus{border-color:#a855f7;box-shadow:0 0 0 3px rgba(168,85,247,.18)}' +
    '.cp-btn{width:100%;margin-top:16px;border:0;border-radius:12px;padding:12px;font-size:15px;font-weight:700;color:#fff;background:linear-gradient(90deg,#ec4899,#8b5cf6,#3b82f6);cursor:pointer}' +
    '.cp-btn[disabled]{opacity:.6;cursor:default}' +
    '.cp-link{background:none;border:0;color:#8b5cf6;font-weight:600;cursor:pointer;padding:0;font-size:13px}' +
    '.cp-err{color:#dc2626;font-size:13px;margin-top:10px;min-height:1em}' +
    '.cp-hint{font-size:12.5px;color:#7a6f92;margin-top:6px;line-height:1.45}' +
    '.cp-small{font-size:12px;color:#7a6f92;margin-top:14px;text-align:center}' +
    '.cp-check{display:flex!important;gap:8px;align-items:flex-start;font-weight:500!important;font-size:13px!important;line-height:1.4}' +
    '.cp-check input{margin-top:2px}' +
    '.cp-row{display:flex;justify-content:space-between;align-items:center;margin-top:12px}' +
    '.cp-fab{position:fixed;right:14px;bottom:14px;z-index:9000;width:34px;height:34px;border-radius:50%;border:1px solid rgba(139,92,246,.35);background:rgba(255,255,255,.85);backdrop-filter:blur(6px);cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(120,70,170,.15)}' +
    '.cp-fab.dot::after{content:"";position:absolute;top:2px;right:2px;width:9px;height:9px;border-radius:50%;background:#ec4899}' +
    '.cp-fab.off{border-color:#f59e0b}' +
    '.cp-menu{position:fixed;right:14px;bottom:56px;z-index:9001;min-width:250px;background:#fff;color:#2a2340;border:1px solid #eadff5;border-radius:14px;padding:6px;box-shadow:0 16px 40px rgba(120,70,170,.22);font-family:Inter,system-ui,sans-serif;font-size:14px}' +
    '.cp-menu .cp-mh{padding:8px 10px 6px;font-size:12px;color:#7a6f92}' +
    '.cp-menu button{display:block;width:100%;text-align:left;background:none;border:0;border-radius:9px;padding:9px 10px;font-size:14px;color:inherit;cursor:pointer}' +
    '.cp-menu button:hover{background:#f6effd}' +
    '@media (prefers-color-scheme:dark){.cp-fab{background:rgba(34,28,46,.9)}.cp-menu{background:#221c2e;color:#eee8f7;border-color:#3a3150}.cp-menu button:hover{background:#2d2540}}';
  function ensureCss() { if (document.getElementById('cp-css')) return; var s = document.createElement('style'); s.id = 'cp-css'; s.textContent = CSS; document.head.appendChild(s); }
  function show(html) {
    ensureCss();
    if (!ov) { ov = document.createElement('div'); ov.className = 'cp-ov'; document.body.appendChild(ov); }
    ov.innerHTML = '<div class="cp-card" role="dialog" aria-modal="true"><div class="cp-logo">🔒</div>' + html + '</div>';
    var f = ov.querySelector('input'); if (f) setTimeout(function () { f.focus(); }, 30);
    return ov;
  }
  function hide() { if (ov) { ov.remove(); ov = null; } }
  function q(sel) { return ov && ov.querySelector(sel); }
  function busy(on, label) { var b = q('.cp-btn'); if (b) { b.disabled = on; if (label) b.textContent = label; } }
  function err(msg) { var e = q('.cp-err'); if (e) e.textContent = msg || ''; }
  function onSubmit(fn) { var f = q('form'); f.addEventListener('submit', function (e) { e.preventDefault(); fn(); }); }

  function screenConnect() {
    return new Promise(function (done) {
      var c = config();
      show('<h1>Connect your sync space</h1><p>Paste the two codes from the setup guide. You only do this once on each device.</p>' +
        '<form><label for="cp-url">Project URL</label><input id="cp-url" type="url" placeholder="https://xxxx.supabase.co" value="' + esc(c.url) + '" required>' +
        '<label for="cp-key">Publishable key</label><input id="cp-key" type="text" placeholder="sb_publishable_…" value="' + esc(c.key) + '" required autocomplete="off">' +
        '<div class="cp-hint">These only say <i>where</i> your locked data is kept. They can’t unlock it.</div>' +
        '<div class="cp-err"></div><button class="cp-btn" type="submit">Continue</button></form>');
      onSubmit(function () {
        var url = q('#cp-url').value.trim().replace(/\/+$/, ''), key = q('#cp-key').value.trim();
        if (!/^https:\/\/.+/.test(url)) { err('That URL should start with https://'); return; }
        if (key.length < 20) { err('That key looks too short.'); return; }
        LS.set('cp-config', { url: url, key: key }); sb = null; done();
      });
    });
  }

  function screenAuth(mode) {
    return new Promise(function (done) {
      function draw(m) {
        var signup = m === 'signup';
        show('<h1>' + (signup ? 'Create your account' : 'Sign in') + '</h1>' +
          '<p>' + (signup ? 'Use your email and a password. This only lets you into your space. Your passphrase (next) is what locks your data.' : 'Welcome back. Sign in to reach your locked space.') + '</p>' +
          '<form><label for="cp-em">Email</label><input id="cp-em" type="email" autocomplete="username" required>' +
          '<label for="cp-pw">Password</label><input id="cp-pw" type="password" autocomplete="' + (signup ? 'new-password' : 'current-password') + '" minlength="8" required>' +
          '<div class="cp-err"></div><button class="cp-btn" type="submit">' + (signup ? 'Create account' : 'Sign in') + '</button></form>' +
          '<div class="cp-row"><button class="cp-link" data-sw>' + (signup ? 'I already have an account' : 'First time? Create an account') + '</button>' +
          (config().baked ? '' : '<button class="cp-link" data-cfg>Change sync codes</button>') + '</div>');
        q('[data-sw]').addEventListener('click', function () { draw(signup ? 'signin' : 'signup'); });
        var cf = q('[data-cfg]'); if (cf) cf.addEventListener('click', function () { LS.del('cp-config'); sb = null; done('reconfig'); });
        onSubmit(function () {
          var em = q('#cp-em').value.trim(), pw = q('#cp-pw').value;
          busy(true); err('');
          var signin = function () { return client().auth.signInWithPassword({ email: em, password: pw }); };
          /* on a second device people often press "create" again: if the account exists, just sign in */
          var p = signup ? client().auth.signUp({ email: em, password: pw }).then(function (r) {
            if (r.error && /already registered|already exists/i.test(r.error.message || '')) return signin();
            return r;
          }) : signin();
          p.then(function (r) {
            if (r.error) throw r.error;
            if (!r.data.session) { draw('signin'); var ce = q('.cp-err'); ce.style.color = '#16a34a'; ce.textContent = 'Check your email to confirm your account, then sign in here.'; return; }
            done(r.data.session);
          }).catch(function (e) {
            busy(false);
            var m = String((e && e.message) || e);
            if (/invalid login/i.test(m)) m = 'That email and password don’t match.';
            else if (/already registered/i.test(m)) m = 'That email already has an account. Sign in instead.';
            else if (/fetch|network/i.test(m)) m = 'Can’t reach the sync space. Check your internet, or the sync codes.';
            err(m);
          });
        });
      }
      draw(mode || 'signin');
    });
  }

  function screenNewPassphrase() {
    return new Promise(function (done) {
      show('<h1>Create your passphrase</h1><p>This is the key to your data. Everything is locked with it <b>on this device</b> before it’s saved. Nobody else can unlock it: not the database, not anyone with the codes, not any AI.</p>' +
        '<form><label for="cp-p1">Passphrase</label><input id="cp-p1" type="password" autocomplete="new-password" required>' +
        '<div class="cp-hint">Tip: 4 or more random words, like <i>violet-teapot-river-moon</i>. Easy to remember, hard to guess.</div>' +
        '<label for="cp-p2">Type it again</label><input id="cp-p2" type="password" autocomplete="new-password" required>' +
        '<label class="cp-check"><input type="checkbox" id="cp-ok"> I understand: if I forget it, nobody can recover my data. I’ll keep backups.</label>' +
        '<div class="cp-err"></div><button class="cp-btn" type="submit">Lock my space</button></form>');
      onSubmit(function () {
        var a = q('#cp-p1').value, b = q('#cp-p2').value;
        if (a.length < 12 || a.trim().split(/[\s\-_.]+/).length < 3 && a.length < 16) { err('Please use at least 12 characters, ideally 4 words.'); return; }
        if (a !== b) { err('The two don’t match.'); return; }
        if (!q('#cp-ok').checked) { err('Please tick the box so you know it can’t be recovered.'); return; }
        busy(true, 'Locking…'); err('');
        var salt = b64(crypto.getRandomValues(new Uint8Array(16)));
        deriveKey(a, salt).then(function (k) {
          return lock(k, META, { check: 'corner-ok', created: new Date().toISOString() }).then(function (chk) {
            return sb.from(TABLE).insert({ owner: uid, path: META, iv: chk.iv, data: JSON.stringify({ v: 1, salt: salt, iter: KDF_ITER, check: chk }) }).then(function (r) {
              if (r.error) throw r.error; return k;
            });
          });
        }).then(done).catch(function (e) {
          busy(false, 'Lock my space');
          var m = String((e && e.message) || e);
          if (/duplicate|unique|conflict/i.test(m)) { err('This account already has a passphrase. Reloading…'); setTimeout(function () { location.reload(); }, 1200); return; }
          err('Couldn’t save: ' + m);
        });
      });
    });
  }

  function screenUnlock(meta) {
    return new Promise(function (done) {
      show('<h1>Unlock your space</h1><p>Type your passphrase once on this device. It stays unlocked here until you choose “Lock this device”.</p>' +
        '<form><label for="cp-pp">Passphrase</label><input id="cp-pp" type="password" autocomplete="current-password" required>' +
        '<div class="cp-err"></div><button class="cp-btn" type="submit">Unlock</button></form>' +
        '<div class="cp-row"><span></span><button class="cp-link" data-out>Sign out</button></div>');
      q('[data-out]').addEventListener('click', signOut);
      onSubmit(function () {
        var p = q('#cp-pp').value; busy(true, 'Unlocking…'); err('');
        deriveKey(p, meta.salt).then(function (k) {
          return unlock(k, META, meta.check).then(function (x) { if (!x || x.check !== 'corner-ok') throw 0; return k; });
        }).then(done).catch(function () { busy(false, 'Unlock'); err('That passphrase didn’t work. Check caps and spaces.'); q('#cp-pp').select(); });
      });
    });
  }

  function readMeta() {
    return rowGet(META).then(function (row) {
      if (row) LS.set('cp-meta:' + uid, row);
      return row;
    }, function (e) { var c = LS.get('cp-meta:' + uid); if (c) return c; throw e; })
      .then(function (row) { return row ? JSON.parse(row.data) : null; });
  }

  /* ---------------- the little lock menu (bottom-left) ---------------- */
  var fab = null, menu = null, netOk = true;
  function setNet(ok) { netOk = ok; if (fab) { fab.classList.toggle('off', !ok); fab.title = ok ? 'Private space: locked & synced' : 'Offline: changes will sync when you’re back'; } }
  function backupDue() { var t = LS.get('cp-lastbackup:' + uid); return !t || (Date.now() - t) > BACKUP_EVERY_DAYS * 864e5; }
  function drawFab() {
    ensureCss();
    if (!fab) { fab = document.createElement('button'); fab.className = 'cp-fab'; fab.textContent = '🔒'; fab.setAttribute('aria-label', 'Privacy & backup'); document.body.appendChild(fab); fab.addEventListener('click', toggleMenu); }
    fab.classList.toggle('dot', backupDue()); setNet(netOk);
  }
  function toggleMenu() {
    if (menu) { menu.remove(); menu = null; return; }
    var email = (LS.get('cp-email:' + uid) || '');
    menu = document.createElement('div'); menu.className = 'cp-menu';
    var lb = LS.get('cp-lastbackup:' + uid);
    menu.innerHTML = '<div class="cp-mh">🔒 Locked & private' + (email ? ' · ' + esc(email) : '') + '<br>' + (netOk ? 'Synced live' : 'Offline: will sync when back') + '</div>' +
      '<button data-a="backup">⬇️ Download backup' + (backupDue() ? ' <b style="color:#ec4899">· due</b>' : '') + '</button>' +
      '<div class="cp-mh" style="padding-top:0">' + (lb ? 'Last backup ' + new Date(lb).toLocaleDateString() : 'No backup yet') + '. To restore one: Settings → Restore from a backup.</div>' +
      '<button data-a="lock">🔐 Lock this device</button><button data-a="out">🚪 Sign out</button>';
    document.body.appendChild(menu);
    menu.addEventListener('click', function (e) {
      var a = e.target.closest('[data-a]'); if (!a) return; var w = a.getAttribute('data-a');
      if (w === 'backup') downloadBackup(); else if (w === 'lock') lockDevice(); else if (w === 'out') signOut();
      if (menu) { menu.remove(); menu = null; }
    });
    setTimeout(function () { document.addEventListener('click', function off(ev) { if (menu && !menu.contains(ev.target) && ev.target !== fab) { menu.remove(); menu = null; } document.removeEventListener('click', off); }); }, 0);
  }

  /* backup = the app's own backup format, so Settings → "Restore from a backup" accepts it */
  function downloadBackup() {
    getDoc('pm/core').then(function (cs) {
      if (!cs.exists) throw new Error('Nothing saved yet.');
      var core = JSON.parse(JSON.stringify(cs.data())), n = core.taskChunks || 1, ps = [];
      for (var i = 0; i < n; i++) ps.push(getDoc('pm/tasks-' + i));
      ps.push(getDoc('pm/history')); ps.push(getDoc('pm/extras'));
      return Promise.all(ps).then(function (r) {
        var tasks = []; for (var i = 0; i < n; i++) if (r[i].exists) tasks = tasks.concat(r[i].data().tasks || []);
        var h = r[n].exists ? r[n].data() : {}, x = r[n + 1].exists ? r[n + 1].data() : {};
        var st = { version: core.version || 1, title: core.title, projects: core.projects || [], links: core.links || [], thoughts: core.thoughts || [], settings: core.settings,
          questions: core.questions || [], meetingDraft: core.meetingDraft || '', focusOrder: core.focusOrder || [], tasks: tasks,
          activity: h.activity || [], meetings: h.meetings || [], reviews: h.reviews || [], templates: x.templates || [] };
        var blob = new Blob([JSON.stringify(st, null, 1)], { type: 'application/json' });
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = 'corner-backup-' + new Date().toISOString().slice(0, 10) + '.json'; document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
        LS.set('cp-lastbackup:' + uid, Date.now()); drawFab();
      });
    }).catch(function (e) { alertBox('Couldn’t make a backup: ' + ((e && e.message) || 'try again.')); });
  }
  function alertBox(msg) { var d = document.createElement('div'); d.className = 'cp-menu'; d.innerHTML = '<div class="cp-mh" style="color:inherit">' + esc(msg) + '</div>'; document.body.appendChild(d); setTimeout(function () { d.remove(); }, 4000); }

  function wipeLocal() {
    Object.keys(localStorage).forEach(function (k) { if (/^cp-cache:|^cp-meta:|^pm-/.test(k)) LS.del(k); });
  }
  function lockDevice() {
    if (!confirmBox('Lock this device? You’ll need your passphrase to open it again here.')) return;
    keyDel('k:' + uid).then(function () { wipeLocal(); location.reload(); });
  }
  function signOut() {
    if (fab && !confirmBox('Sign out on this device? Your data stays safe in your space.')) return;
    var id = uid;
    Promise.resolve(id ? keyDel('k:' + id) : null).then(function () { return sb ? sb.auth.signOut().catch(function () {}) : null; })
      .then(function () { wipeLocal(); location.reload(); });
  }
  function confirmBox(m) { try { return window.confirm(m); } catch (e) { return true; } }

  /* ---------------- start-up: get to an unlocked space ---------------- */
  var ready = null;
  function start() {
    if (ready) return ready;
    ready = (function step() {
      var c = config();
      if (!c.url || !c.key) return screenConnect().then(step);
      try { client(); } catch (e) { show('<h1>Couldn’t start</h1><p>' + esc(e.message) + '</p><p class="cp-hint">Check your internet and reload.</p>'); return new Promise(function () {}); }
      return sb.auth.getSession().then(function (r) {
        var s = r && r.data && r.data.session;
        if (s) return s;
        return screenAuth(LS.get('cp-everin') ? 'signin' : 'signup').then(function (x) { if (x === 'reconfig') return step(); return x; });
      }).then(function (session) {
        if (!session || !session.user) return step();
        uid = session.user.id; LS.set('cp-everin', 1); LS.set('cp-email:' + uid, session.user.email || '');
        return keyGet('k:' + uid).then(function (k) {
          if (k) return k;
          return readMeta().then(function (meta) {
            return (meta ? screenUnlock(meta) : screenNewPassphrase()).then(function (key) { return keyPut('k:' + uid, key).then(function () { return key; }); });
          });
        });
      }).then(function (key) {
        KEY = key; hide(); drawFab();
        if (backupDue() && LS.get('cp-seen:' + uid)) setTimeout(function () { if (fab) fab.animate && fab.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 700, iterations: 2 }); }, 2500);
        return makeDb();
      });
    })();
    return ready;
  }

  /* ---------------- what the app asks for ---------------- */
  window.claude = {
    use: function (name) {
      if (name === 'db') return start();
      if (name === 'user') return start().then(function () { return { isOwner: function () { return true; }, canEdit: function () { return true; } }; });
      return Promise.reject({ code: 'capability_disabled' });   /* no uploads, comments or AI in the private version */
    }
  };
  window.CORNER_PRIVATE = { version: '1', lockDevice: lockDevice, signOut: signOut };
})();
