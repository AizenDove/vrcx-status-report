/*
 * VRCX Status Report
 *
 * Adds a "Status Report" entry to VRCX's left sidebar (next to Tools). It opens a panel with:
 *   - Report:   filter friends by status, how long it's stayed the same, and last online,
 *               then unfriend the selection after 4 separate confirmations
 *   - Timeline: each friend's status history as coloured bars
 *   - Removed:  everyone no longer a friend, with "send friend request" to undo
 *
 * Install: copy to %AppData%\VRCX\custom.js and restart VRCX.  Shortcut: Ctrl+Shift+O.
 *
 * Reads VRCX's database with SELECT only. The only thing it ever changes is unfriending,
 * and only after the 4 confirmations. Relies on VRCX internals (SQLite.Execute,
 * window.$pinia, window.webApiService, the sidebar markup) that aren't an official API,
 * so a VRCX update may break parts of it.
 */
(function () {
    'use strict';
    const HOST_ID = 'orange-report-host';
    // VRCX can re-run custom.js: clean up a previous copy first
    document.getElementById(HOST_ID)?.remove();
    document.querySelectorAll('[data-orange-nav]').forEach((n) => n.remove());
    if (window.__orangeReport) {
        document.removeEventListener('keydown', window.__orangeReport.key);
        window.__orangeReport.observer?.disconnect();
        for (const t of window.__orangeReport.guardTypes || []) window.removeEventListener(t, window.__orangeReport.guard, true);
    }
    const state = (window.__orangeReport = {});

    const DAY = 86400000, MONTH = 30.44 * DAY;
    // pause between unfriends. VRCX's own Bulk Unfriend uses no pause; VRChat doesn't publish its limits,
    // so if VRChat answers 429 (too many requests) the run waits and slows itself down automatically.
    const SPEEDS = {
        fast: { ms: 0, label: "Fast: no pause (same as VRCX's own Bulk Unfriend)" },
        normal: { ms: 1000, label: 'Normal: 1 second between each' },
        careful: { ms: 4000, label: 'Careful: 4 seconds between each' },
    };
    const TEST_DELAY = window.__orangeReportDelayMs;
    const API = 'https://api.vrchat.cloud/api/1';
    // VRChat's own status colours: Online = green, Join Me = blue, Ask Me = orange, Busy = red
    const COLORS = { active: '#51e57e', 'join me': '#42caff', 'ask me': '#e88134', busy: '#e83f3f', offline: '#6b6b78', unknown: '#8a8a96' };
    const LABEL = { active: 'Green', 'join me': 'Blue', 'ask me': 'Orange', busy: 'Red', unknown: 'Unknown' };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ======================= data =======================
    async function sql(query) {
        const rows = await SQLite.Execute(query, null);
        // VRCX returns empty database values as {} objects: turn those into null
        const cell = (v) => (v === null || v === undefined || typeof v === 'object' ? null : v);
        return Array.from(rows || [], (r) => (Array.isArray(r) ? r : Object.values(r)).map(cell));
    }
    function stores() {
        const p = window.$pinia;
        return p ? Object.values(p).filter((s) => s && typeof s === 'object') : [];
    }
    function findStore(test) {
        for (const s of stores()) { try { if (test(s)) return s; } catch (e) { /* ignore */ } }
        return null;
    }
    const currentUserId = () => findStore((s) => typeof s.currentUser?.id === 'string')?.currentUser.id || null;
    const liveFriends = () => findStore((s) => s.friends instanceof Map)?.friends || null;

    function openUser(id) {
        const s = findStore((s) => typeof s.showUserDialog === 'function');
        if (s) { s.showUserDialog(id); hide(); return; }
        const url = 'https://vrchat.com/home/user/' + encodeURIComponent(id);
        if (window.AppApi?.OpenLink) AppApi.OpenLink(url); else window.open(url, '_blank');
    }

    async function pickPrefix() {
        const names = (await sql("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%\\_feed_status' ESCAPE '\\'"))
            .map((r) => String(r[0]).slice(0, -'_feed_status'.length));
        const me = currentUserId()?.replace(/[_-]/g, '');
        return names.includes(me) ? me : names[0];
    }

    const ts = (s) => { const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };

    async function load() {
        const p = await pickPrefix();
        if (!p) throw new Error('No VRCX feed tables found');
        const rows = await sql(`
            WITH st AS (
                SELECT user_id, status, status_description, created_at,
                       ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) rn
                FROM "${p}_feed_status"),
            oo AS (
                SELECT user_id, type, created_at,
                       ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) rn
                FROM "${p}_feed_online_offline")
            SELECT f.user_id, f.display_name, st.status, st.status_description, st.created_at, oo.type, oo.created_at
            FROM "${p}_friend_log_current" f
            LEFT JOIN st ON st.user_id = f.user_id AND st.rn = 1
            LEFT JOIN oo ON oo.user_id = f.user_id AND oo.rn = 1`);
        const startRow = await sql(`SELECT MIN(t) FROM (
            SELECT MIN(created_at) t FROM "${p}_feed_status" UNION ALL
            SELECT MIN(created_at) FROM "${p}_feed_online_offline")`);
        const start = ts(startRow[0]?.[0]);
        // full history for the Timeline tab
        const hist = new Map();
        for (const [uid, at, s, prev] of await sql(`SELECT user_id, created_at, status, previous_status FROM "${p}_feed_status" ORDER BY created_at`)) {
            if (!hist.has(uid)) hist.set(uid, []);
            hist.get(uid).push({ t: ts(at), s, prev });
        }
        // VRCX's game log: one row each time someone joins/leaves the instance you're in.
        // "time" on the leave row is how long you were together; distinct locations = joins.
        const agg = `SUM(CASE WHEN typeof(time) IN ('integer','real') THEN time ELSE 0 END), COUNT(DISTINCT location), MAX(created_at)`;
        const byId = new Map(), byName = new Map();
        for (const [uid, ms, joins, last] of await sql(`SELECT user_id, ${agg} FROM gamelog_join_leave WHERE user_id IS NOT NULL AND user_id != '' GROUP BY user_id`))
            byId.set(uid, { ms: Number(ms) || 0, joins: Number(joins) || 0, last: ts(last) || 0 });
        // older log rows may have only a display name, no user id
        for (const [dn, ms, joins, last] of await sql(`SELECT display_name, ${agg} FROM gamelog_join_leave WHERE user_id IS NULL OR user_id = '' GROUP BY display_name`))
            byName.set(dn, { ms: Number(ms) || 0, joins: Number(joins) || 0, last: ts(last) || 0 });
        const togetherFor = (id, ...names) => {
            const parts = [byId.get(id), ...new Set(names.filter(Boolean))].map((x) => (typeof x === 'string' ? byName.get(x) : x)).filter(Boolean);
            const last = Math.max(0, ...parts.map((x) => x.last));
            return {
                togetherMs: parts.reduce((a, x) => a + x.ms, 0),
                joins: parts.reduce((a, x) => a + x.joins, 0),
                lastTogether: last || null,
            };
        };
        // Mutual friends: VRCX's mutual graph (Charts > Mutual Friends). For each friend VRCX has
        // fetched, it stores their mutuals; a friend's count = how many fetched friends list them.
        const mutualMap = new Map();
        let mutualFetched = 0;
        try {
            for (const [mid, n] of await sql(`SELECT mutual_id, COUNT(*) FROM "${p}_mutual_graph_links" GROUP BY mutual_id`)) mutualMap.set(mid, Number(n) || 0);
            mutualFetched = Number((await sql(`SELECT COUNT(DISTINCT friend_id) FROM "${p}_mutual_graph_links"`))[0]?.[0]) || 0;
        } catch (e) { /* older VRCX without the mutual graph */ }
        const live = liveFriends();
        const now = Date.now();
        const friends = rows.map(([id, name, dbStatus, dbText, since, ev, evAt]) => {
            const entry = live?.get(id), ref = entry?.ref || {};
            let status = dbStatus || 'unknown', text = dbText || '', sinceT = ts(since);
            // VRCX's live data wins; if it disagrees with the log, we don't know when it changed.
            // Offline friends report "offline" there, so keep their last known status instead.
            const liveStatus = ref.status && ref.status !== 'offline' && LABEL[ref.status] ? ref.status : null;
            if (liveStatus && liveStatus !== status) { status = liveStatus; sinceT = null; }
            if (typeof ref.statusDescription === 'string' && ref.statusDescription) text = ref.statusDescription;
            const online = entry?.state === 'online' || ref.state === 'online';
            const seenT = Math.max(ts(evAt) || 0, ts(ref.last_login) || 0, ts(ref.last_activity) || 0) || null;
            return {
                id, name: ref.displayName || name || id, status, text,
                sinceMs: sinceT ? now - sinceT : -1,
                atLeast: !!(sinceT && start && sinceT - start < 2 * DAY), // seen on VRCX's first days: started earlier
                online,
                seenMs: online ? 0 : seenT ? now - seenT : Infinity,
                lastEvent: ev,
                fav: !!entry?.isVIP,
                hist: hist.get(id) || [],
                ...togetherFor(id, name, ref.displayName),
                mutuals: Math.max(mutualMap.get(id) || 0, typeof ref.$mutualCount === 'number' ? ref.$mutualCount : 0),
            };
        });
        // people VRCX's Friend Log recorded as unfriended (by you or by them) who aren't friends again
        const current = new Set(friends.map((f) => f.id));
        const seenIds = new Set();
        const removed = [];
        for (const [uid, name, at] of await sql(`SELECT user_id, display_name, created_at FROM "${p}_friend_log_history" WHERE type = 'Unfriend' ORDER BY created_at DESC`)) {
            if (!uid || current.has(uid) || seenIds.has(uid)) continue;
            seenIds.add(uid);
            removed.push({ id: uid, name: String(name || uid), at: ts(at) });
        }
        return { friends, start, removed, mutualFetched };
    }

    // ======================= formatting =======================
    const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    function ago(ms) {
        const d = ms / DAY, p = (n, u) => `${n} ${u}${n === 1 ? '' : 's'}`;
        if (d >= 365) { const m = Math.floor((d % 365) / 30.4); return p(Math.floor(d / 365), 'year') + (m ? ', ' + p(m, 'month') : ''); }
        if (d >= 30.4) return p(Math.floor(d / 30.4), 'month');
        if (d >= 7) return p(Math.floor(d / 7), 'week');
        if (d >= 1) return p(Math.floor(d), 'day');
        const h = Math.floor(ms / 3600000); return h ? p(h, 'hour') : 'under an hour';
    }
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // colours follow the status people have SET in VRChat, whether they're online or not
    function statusPhrase(f) {
        const off = f.online ? '' : ' <span class="muted">· offline</span>';
        if (f.status === 'unknown') return `<span class="muted">Unknown</span>${off}`;
        if (f.sinceMs < 0) return esc(LABEL[f.status] || f.status) + off;
        return `${esc(LABEL[f.status] || f.status)} for ${f.atLeast ? 'at least ' : ''}<b>${ago(f.sinceMs)}</b>${off}`;
    }
    function fmtTogether(ms) {
        const m = Math.round(ms / 60000), h = Math.floor(m / 60);
        if (h >= 100) return `${h}h`;
        if (h) return `${h}h ${m % 60}m`;
        return `${m}m`;
    }
    function togetherCells(f) {
        if (!f.joins) return '<div class="muted">Never met</div><div class="muted">0</div>';
        const title = f.lastTogether ? ` title="Last together ${esc(fmtDate(f.lastTogether))}"` : '';
        return `<div${title}><b>${fmtTogether(f.togetherMs)}</b></div><div>${f.joins}</div>`;
    }
    function seenPhrase(f) {
        if (f.online) return '<span class="ok">Online now</span>';
        if (f.seenMs === Infinity) return `<span class="warn">Not seen online${start ? ' since ' + fmtDate(start) : ''}</span>`;
        return `<span class="${f.seenMs > 180 * DAY ? 'warn' : ''}">Last online ${ago(f.seenMs)} ago</span>`;
    }

    // ======================= UI =======================
    const host = document.createElement('div');
    host.id = HOST_ID;
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' }); // keeps VRCX's styles and ours apart
    root.innerHTML = `
<style>
:host{--bg:#141417;--card:#1d1d22;--fg:#ececf1;--muted:#9a9aa8;--line:#2e2e37;--chip:#26262e;--warn:#ff6b6b;--ok:#4ade80;--danger:#dc2626;all:initial}
*{box-sizing:border-box;font-family:system-ui,"Segoe UI",sans-serif}
[hidden]{display:none!important}
.fab{position:fixed;right:16px;bottom:16px;z-index:99998;display:none;gap:7px;align-items:center;padding:7px 13px;border-radius:999px;
  border:1px solid var(--line);background:var(--card);color:var(--fg);font-size:13px;cursor:pointer;opacity:.8}
.fab.show{display:flex}
.dot{width:10px;height:10px;border-radius:50%;flex:none;display:inline-block}
.overlay{position:fixed;inset:0;z-index:99999;background:#000c;display:none;padding:10px}
.overlay.open{display:flex}
.panel{position:relative;background:var(--bg);color:var(--fg);width:100%;height:100%;border-radius:12px;border:1px solid var(--line);
  display:flex;flex-direction:column;overflow:hidden;font-size:13.5px;line-height:1.45}
.top{display:flex;align-items:center;gap:16px;padding:10px 16px;border-bottom:1px solid var(--line)}
.top .sub{flex:1;margin:0}
.main{flex:1;display:flex;min-height:0}
.filters{width:280px;flex:none;border-right:1px solid var(--line);overflow:auto;padding:14px 16px 20px;background:#17171b}
.fhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.fhead b{font-size:14px}
.link{background:none;border:0;color:var(--muted);cursor:pointer;font-size:12.5px;padding:2px 4px}
.link:hover{color:var(--fg);text-decoration:underline}
.filters input[type=text]{width:100%}
.fsec{margin-top:18px}
.fsec h4{margin:0 0 8px;font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;display:flex;justify-content:space-between;align-items:center;gap:8px}
.fsec h4 label{display:flex;gap:7px;align-items:center;cursor:pointer}
.fsec label.opt{display:flex;gap:8px;align-items:center;color:var(--fg);font-size:13px;margin:6px 0;cursor:pointer}
.slist{display:flex;flex-direction:column;gap:2px}
.sitem{display:flex;align-items:center;gap:9px;width:100%;padding:6px 9px;border:0;border-radius:7px;background:none;color:var(--fg);font-size:13px;cursor:pointer;text-align:left}
.sitem:hover{background:var(--chip)}
.sitem.on{background:var(--chip);box-shadow:inset 3px 0 0 var(--fg)}
.sitem .n{margin-left:auto;color:var(--muted);font-size:12px}
.sitem small{color:var(--muted);font-size:11.5px}
.seg{display:grid;grid-template-columns:repeat(var(--cols,2),1fr);gap:4px}
.seg button{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:7px;padding:5px 9px;font-size:12.5px;cursor:pointer}
.seg button:hover{border-color:var(--muted)}
.seg button.on{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.content{flex:1;display:flex;flex-direction:column;min-width:0}
.content .stats{padding:12px 16px 0;margin:0}
.pills{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:10px 16px;min-height:44px}
.pill{display:inline-flex;align-items:center;gap:6px;background:var(--chip);border:1px solid var(--line);border-radius:999px;padding:3px 6px 3px 11px;font-size:12.5px}
.pill button{background:none;border:0;color:var(--muted);cursor:pointer;font-size:14px;line-height:1;padding:0 3px}
.pill button:hover{color:var(--fg)}
.tabs{display:flex;gap:4px}
.tab{background:none;border:0;color:var(--muted);font-size:16px;font-weight:600;padding:4px 10px;border-radius:7px;cursor:pointer}
.tab.on{color:var(--fg);background:var(--chip)}
.btn{border:1px solid var(--line);background:var(--chip);color:var(--fg);border-radius:8px;padding:6px 12px;cursor:pointer;font-size:13px}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.danger{background:var(--danger);border-color:var(--danger);color:#fff;font-weight:600}
.sub{color:var(--muted);font-size:12.5px;margin:3px 0 10px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:10px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:8px 12px;cursor:pointer;display:flex;align-items:baseline;gap:10px}
.stat:hover{border-color:var(--muted)}
.stat b{font-size:20px}.stat span{color:var(--muted);font-size:12px}
.controls{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.fsec.off .range,.fsec.off .ticks,.fsec.off #offLabel{opacity:.35}
.range{position:relative;width:100%;height:22px}
.range .track,.range .fill{position:absolute;top:9px;height:4px;border-radius:2px}
.range .track{left:0;right:0;background:var(--line)}
.range .fill{background:var(--fg)}
.range input{position:absolute;left:0;top:0;width:100%;height:22px;margin:0;background:none;pointer-events:none;-webkit-appearance:none;appearance:none}
.range input::-webkit-slider-runnable-track{height:22px;background:transparent}
.range input::-webkit-slider-thumb{pointer-events:auto;-webkit-appearance:none;width:16px;height:16px;margin-top:3px;border-radius:50%;background:var(--fg);border:2px solid var(--bg);box-shadow:0 0 0 1px var(--line);cursor:pointer}
.ticks{position:relative;width:100%;height:12px;font-size:10px;color:var(--muted)}
.ticks span{position:absolute;transform:translateX(-50%)}
#offLabel{color:var(--fg);text-transform:none;letter-spacing:0;font-size:12.5px}
.controls label{color:var(--muted);font-size:12.5px;display:flex;gap:6px;align-items:center}
.chip{border:1px solid var(--line);background:var(--chip);color:var(--fg);border-radius:999px;padding:4px 11px;cursor:pointer;font-size:12.5px}
.chip.on{background:var(--fg);color:var(--bg)}
input,select{font-size:13px;padding:5px 9px;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
input[type=text]{flex:1;min-width:140px}
input[type=checkbox]{accent-color:var(--danger)}
.body{overflow:auto;flex:1}
.row{display:grid;grid-template-columns:26px minmax(0,1.3fr) minmax(0,1.15fr) minmax(0,1fr) minmax(0,.6fr) minmax(0,.4fr) minmax(0,.45fr);gap:12px;padding:7px 18px;border-top:1px solid var(--line);align-items:center}
.row.r5{grid-template-columns:26px minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)}
.head{position:sticky;top:0;z-index:1;background:var(--bg);font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;border-top:0}
.head div{cursor:pointer;user-select:none}
.name{display:flex;gap:8px;align-items:center;min-width:0}
.name a{color:inherit;font-weight:600;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.name a:hover{text-decoration:underline}
.star{color:#facc15;font-size:12px}
.muted,.txt{color:var(--muted)}.txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.warn{color:var(--warn);font-weight:600}.ok{color:var(--ok);font-weight:600}
.msg{padding:30px;text-align:center;color:var(--muted)}
.bar{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:10px 18px;border-top:1px solid var(--line);background:var(--card)}
.modal{position:absolute;inset:0;background:#000b;display:none;align-items:center;justify-content:center;padding:20px;z-index:5}
.modal.open{display:flex}
.box{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:20px 22px;width:min(560px,100%);max-height:90%;overflow:auto}
.box h3{margin:0 0 4px;font-size:17px}
.steps{display:flex;gap:5px;margin:2px 0 14px}.steps i{flex:1;height:4px;border-radius:2px;background:var(--line)}.steps i.on{background:var(--danger)}
.box p{margin:8px 0}
.names{max-height:180px;overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:12.5px;margin:8px 0}
.box input[type=text]{width:100%;margin-top:6px}
.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.prog{height:8px;background:var(--line);border-radius:4px;overflow:hidden;margin:10px 0}.prog div{height:100%;background:var(--danger);width:0}
.trow{display:grid;grid-template-columns:minmax(0,210px) minmax(0,1fr) minmax(0,170px);gap:14px;padding:6px 18px;border-top:1px solid var(--line);align-items:center}
.trow.head{padding-top:8px;padding-bottom:8px}
.tl{position:relative;height:22px;cursor:crosshair}
.tl .st{position:absolute;inset:3px 0;border-radius:3px}
.axis{position:relative;height:16px;font-size:11px;color:var(--muted);text-transform:none;letter-spacing:0}
.axis span{position:absolute;transform:translateX(-50%);white-space:nowrap}
.axis span::before{content:"";position:absolute;left:50%;top:15px;width:1px;height:6px;background:var(--line)}
.sum{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.legend{display:flex;flex-direction:column;gap:6px;font-size:12.5px;color:var(--fg)}
.legend span{display:flex;gap:5px;align-items:center}
.sw{width:14px;height:9px;border-radius:2px;display:inline-block}
.tip{position:fixed;z-index:10;pointer-events:none;background:var(--card);border:1px solid var(--line);border-radius:7px;padding:6px 9px;font-size:12px;display:none;max-width:280px}
.log{font-size:12px;color:var(--muted);max-height:220px;overflow:auto;background:var(--card);border-radius:8px;padding:8px 10px}
</style>
<button class="fab" title="Ctrl+Shift+O"><span class="dot" style="background:${COLORS['ask me']}"></span>Status report</button>
<div class="overlay"><div class="panel">
  <div class="top">
    <div class="tabs"><button class="tab on" data-tab="report">Report</button><button class="tab" data-tab="timeline">Timeline</button><button class="tab" data-tab="removed">Removed</button></div>
    <div class="sub" id="sub"></div>
    <span><button class="btn" data-act="refresh">Refresh</button> <button class="btn" data-act="close">Close</button></span>
  </div>
  <div class="main">
    <aside class="filters" id="filters">
      <div class="fhead"><b>Filters</b><button class="link" data-act="reset">Reset all</button></div>
      <input type="text" id="q" placeholder="Search name">
      <div class="fsec"><h4>Status</h4><div class="slist" id="chips"></div></div>
      <div class="fsec"><h4>Status unchanged for <span style="text-transform:none;letter-spacing:0">(months)</span></h4>
        <div class="seg" data-for="same" style="--cols:5"><button data-v="0">Any</button><button data-v="1">1+</button><button data-v="3">3+</button><button data-v="6">6+</button><button data-v="12">12+</button></div><input type="hidden" id="same" value="0"></div>
      <div class="fsec off" id="offRow"><h4><label><input type="checkbox" id="offOn"> Not online for</label><span id="offLabel"></span></h4>
        <div class="range"><div class="track"></div><div class="fill" id="offFill"></div>
          <input type="range" id="offMin" min="1" max="12" step="1" value="1">
          <input type="range" id="offMax" min="1" max="12" step="1" value="12"></div>
        <div class="ticks">${[1, 3, 6, 9, 12].map((m) => `<span style="left:calc(8px + ${(m - 1) / 11} * (100% - 16px))">${m === 12 ? '12+' : m}</span>`).join('')}</div>
      </div>
      <div class="fsec"><h4>Time together</h4>
        <div class="seg" data-for="together"><button data-v="">Any</button><button data-v="0">Never met</button><button data-v="1">Under 1 h</button><button data-v="10">Under 10 h</button></div><input type="hidden" id="together" value=""></div>
      <div class="fsec" id="skipRow"><h4>Protection</h4>
        <label class="opt"><input type="checkbox" id="skipFav" checked> Never select favorites</label>
        <label class="opt"><input type="checkbox" id="skipOnline" checked> Never select anyone online now</label>
      </div>
      <div class="fsec" id="legend" hidden><h4>Colours</h4><div class="legend">
        <span><i class="sw" style="background:${COLORS['join me']}"></i> Blue · Join Me</span>
        <span><i class="sw" style="background:${COLORS.active}"></i> Green · Online</span>
        <span><i class="sw" style="background:${COLORS['ask me']}"></i> Orange · Ask Me</span>
        <span><i class="sw" style="background:${COLORS.busy}"></i> Red · Do Not Disturb</span>
        <span><i class="sw" style="background:#3a3a44"></i> Unknown</span>
        <span class="muted">Hover a bar for dates</span></div></div>
    </aside>
    <aside class="filters" id="removedTop" hidden>
      <div class="fhead"><b>Filters</b></div>
      <input type="text" id="rq" placeholder="Search name">
      <div class="fsec"><h4>Removed</h4><div class="seg" data-for="rWhen"><button data-v="0">Any time</button><button data-v="1">24 h</button><button data-v="7">7 days</button><button data-v="30">30 days</button></div><input type="hidden" id="rWhen" value="0"></div>
      <div class="fsec"><h4>Removed by</h4><label class="opt"><input type="checkbox" id="rMine"> Only Status Report</label></div>
      <div class="fsec"><p class="muted" style="font-size:12.5px;margin:0">From VRCX's Friend Log: everyone who stopped being your friend (you or they removed it) and isn't a friend again. To undo, send a friend request; they have to accept it.</p></div>
    </aside>
    <section class="content">
      <div id="reportTop"><div class="stats" id="stats"></div><div class="pills" id="pills"></div></div>
      <div class="body" id="list"><div class="msg">Loading...</div></div>
      <div class="bar" id="cBar">
        <span id="cCount" class="muted"></span>
        <span><button class="btn" data-act="selall">Select all</button> <button class="btn" data-act="selnone">Select none</button>
        <button class="btn danger" data-act="unfriend">Unfriend selected...</button></span>
      </div>
    </section>
  </div>
  <div class="modal" id="modal"><div class="box" id="box"></div></div>
  <div class="tip" id="tip"></div>
</div></div>`;

    const $ = (s) => root.querySelector(s);
    const overlay = $('.overlay');
    let F = [], R = [], start = null, loaded = false, tab = 'report';
    let filter = 'all', sortKey = 'sinceMs', sortDir = -1;
    const selected = new Set(); // opt-in: nobody is ticked until you tick them
    let running = false;

    function hide() { if (!running) overlay.classList.remove('open'); }
    async function show() { if (!running) selected.clear(); overlay.classList.add('open'); await refresh(loaded); }
    // Re-reads VRCX's data. quiet = keep the current list on screen while loading (no flicker).
    // Clicks during a reload are merged into one more reload afterwards.
    let loading = null, again = false;
    async function refresh(quiet = false) {
        if (running) return;
        if (loading) { again = true; return loading; }
        loading = (async () => {
            do { again = false; await reloadOnce(quiet); quiet = true; } while (again);
        })();
        try { await loading; } finally { loading = null; }
    }
    async function reloadOnce(quiet) {
        if (!quiet) $('#list').innerHTML = '<div class="msg">Loading...</div>';
        const scroll = $('#list').scrollTop;
        try {
            let mutualFetched;
            ({ friends: F, start, removed: R, mutualFetched } = await load());
            loaded = true;
            $('#sub').textContent = `${F.length} friends` + (start ? ` · VRCX history starts ${fmtDate(start)}, so older status times are "at least"` : '')
                + ` · mutuals fetched for ${mutualFetched} of ${F.length} friends` + (mutualFetched < F.length * 0.9 ? ' (run Charts → Mutual Friends in VRCX to fetch the rest)' : '');
            drawStats(); drawChips(); draw();
            if (quiet) $('#list').scrollTop = scroll;
        } catch (e) {
            console.error('[orange-report]', e);
            $('#list').innerHTML = '<div class="msg"></div>';
            $('#list .msg').textContent = 'Could not read VRCX data: ' + (e?.message || e);
        }
    }
    function setTab(t) {
        tab = t;
        if (!running) selected.clear(); // each tab starts with nobody selected
        root.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
        $('#reportTop').hidden = t === 'removed';
        $('#filters').hidden = t === 'removed';
        $('#removedTop').hidden = t !== 'removed';
        $('#skipRow').hidden = t !== 'report';
        $('#legend').hidden = t !== 'timeline';
        $('#cBar').hidden = t === 'timeline' || t === 'removed';
        draw();
    }
    const draw = () => (tab === 'timeline' ? renderTimeline() : tab === 'removed' ? renderRemoved() : renderReport());

    // ---------- removed tab (the "bin") ----------
    const store = {
        get(k) { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { return []; } },
        set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
    };
    function renderRemoved() {
        const mine = new Set(store.get('orangeReport.removed').map((r) => r.id));
        const requested = new Set(store.get('orangeReport.requested'));
        const days = +$('#rWhen').value, q = $('#rq').value.toLowerCase(), onlyMine = $('#rMine').checked, now = Date.now();
        const rows = R.filter((r) => (!days || (r.at && now - r.at < days * DAY))
            && (!onlyMine || mine.has(r.id)) && (!q || r.name.toLowerCase().includes(q)));
        const L = $('#list'); L.className = 'body'; L.innerHTML = '';
        const head = document.createElement('div'); head.className = 'row head r5';
        head.innerHTML = `<div></div><div>Name · ${rows.length} shown</div><div>Removed</div><div>How</div><div></div>`;
        L.appendChild(head);
        const frag = document.createDocumentFragment();
        for (const r of rows) {
            const row = document.createElement('div'); row.className = 'row r5';
            const nm = document.createElement('div'); nm.className = 'name';
            nm.innerHTML = '<a title="Open profile"></a>';
            nm.querySelector('a').textContent = r.name; nm.querySelector('a').onclick = () => openUser(r.id);
            const btn = document.createElement('button'); btn.className = 'btn';
            if (requested.has(r.id)) { btn.textContent = 'Request sent'; btn.disabled = true; } else { btn.textContent = 'Send friend request'; btn.onclick = () => reAdd(r, btn); }
            const c4 = document.createElement('div'); c4.appendChild(btn);
            row.append(document.createElement('div'), nm);
            row.insertAdjacentHTML('beforeend', `<div>${r.at ? `${esc(fmtDate(r.at))} <span class="muted">(${ago(now - r.at)} ago)</span>` : '?'}</div>
                <div class="muted">${mine.has(r.id) ? 'Status Report' : 'Unfriended'}</div>`);
            row.appendChild(c4);
            frag.appendChild(row);
        }
        L.appendChild(frag);
        if (!rows.length) L.insertAdjacentHTML('beforeend', '<div class="msg">Nobody here.</div>');
    }
    async function reAdd(r, btn) {
        if (!window.webApiService?.execute) return;
        modal(`<h3>Send a friend request to ${esc(r.name)}?</h3><p>They'll get a normal friend request and have to accept it before you're friends again.</p>
            <div class="actions"><button class="btn" id="no">Cancel</button><button class="btn" id="yes">Send request</button></div>`);
        const ok = await new Promise((res) => { $('#no').onclick = () => res(false); $('#yes').onclick = () => res(true); });
        closeModal();
        if (!ok) return;
        btn.disabled = true; btn.textContent = 'Sending...';
        let status;
        try {
            status = (await window.webApiService.execute({
                url: `${API}/user/${encodeURIComponent(r.id)}/friendRequest`, method: 'POST',
                headers: { 'Content-Type': 'application/json;charset=utf-8' }, body: '{}',
            })).status;
        } catch (e) { status = String(e?.message || e); }
        if (status === 200) {
            store.set('orangeReport.requested', [...new Set([...store.get('orangeReport.requested'), r.id])]);
            btn.textContent = 'Request sent';
        } else { btn.disabled = false; btn.textContent = `Failed (${status}) - retry`; }
    }

    // ---------- timeline tab ----------
    const UNKNOWN_BG = '#3a3a44';
    // status segments from the start of VRCX's history until now
    function segments(f, t0, now) {
        const h = f.hist.filter((e) => e.t);
        if (!h.length) return [{ a: t0, b: now, s: f.status }]; // no change recorded: same status the whole time
        const segs = [{ a: t0, b: h[0].t, s: h[0].prev || 'unknown' }];
        h.forEach((e, i) => segs.push({ a: e.t, b: i + 1 < h.length ? h[i + 1].t : now, s: e.s }));
        return segs.filter((s) => s.b > s.a);
    }
    function gradient(parts, t0, span, bg) {
        const pc = (t) => (((Math.min(Math.max(t, t0), t0 + span) - t0) / span) * 100).toFixed(3) + '%';
        const stops = [];
        let at = t0;
        for (const { a, b, c } of parts) {
            if (bg && a > at) stops.push(`${bg} ${pc(at)} ${pc(a)}`);
            stops.push(`${c} ${pc(a)} ${pc(b)}`);
            at = b;
        }
        if (bg && at < t0 + span) stops.push(`${bg} ${pc(at)} 100%`);
        return stops.length ? `linear-gradient(to right, ${stops.join(', ')})` : (bg || 'transparent');
    }
    function summary(segs) {
        const tot = {}; let all = 0;
        for (const s of segs) { const d = s.b - s.a; tot[s.s] = (tot[s.s] || 0) + d; all += d; }
        return Object.entries(tot).filter(([s, d]) => s !== 'unknown' && d / all >= 0.01).sort((a, b) => b[1] - a[1]).slice(0, 2)
            .map(([s, d]) => `${LABEL[s] || s} ${Math.round((d / all) * 100)}%`).join(' · ') || 'Unknown';
    }
    function renderTimeline() {
        const now = Date.now(), t0 = start || now - 365 * DAY, span = Math.max(now - t0, DAY);
        const rows = reportMatches().sort(sorter(sortKey, sortDir));
        const L = $('#list'); L.className = 'body'; L.innerHTML = '';
        // header with month ticks
        const head = document.createElement('div'); head.className = 'trow head';
        const hn = document.createElement('div'); hn.textContent = `Name · ${rows.length} shown` + (sortKey === 'name' ? (sortDir < 0 ? ' ▼' : ' ▲') : '');
        hn.style.cursor = 'pointer'; hn.onclick = () => { sortDir = sortKey === 'name' ? -sortDir : 1; sortKey = 'name'; renderTimeline(); };
        const axis = document.createElement('div'); axis.className = 'axis';
        const d = new Date(t0); d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() + 1);
        const months = []; for (; d.getTime() < now; d.setMonth(d.getMonth() + 1)) months.push(d.getTime());
        const every = Math.ceil(months.length / 8);
        months.forEach((m, i) => {
            if (i % every) return;
            const s = document.createElement('span'); s.style.left = ((m - t0) / span) * 100 + '%';
            const md = new Date(m);
            s.textContent = md.toLocaleDateString(undefined, { month: 'short' }) + (md.getMonth() === 0 || i === 0 ? ` '${String(md.getFullYear()).slice(2)}` : '');
            axis.appendChild(s);
        });
        const hs = document.createElement('div'); hs.textContent = 'Most of the time';
        head.append(hn, axis, hs);
        L.appendChild(head);

        const frag = document.createDocumentFragment();
        for (const f of rows) {
            const segs = segments(f, t0, now);
            const r = document.createElement('div'); r.className = 'trow';
            const tl = document.createElement('div'); tl.className = 'tl';
            tl.innerHTML = '<div class="st"></div>';
            tl.firstChild.style.background = gradient(segs.map((s) => ({ a: s.a, b: s.b, c: COLORS[s.s] && s.s !== 'unknown' ? COLORS[s.s] : UNKNOWN_BG })), t0, span);
            tl.onmousemove = (e) => showTip(e, f, segs, t0, span);
            tl.onmouseleave = () => { $('#tip').style.display = 'none'; };
            const sm = document.createElement('div'); sm.className = 'sum'; sm.textContent = summary(segs);
            r.append(nameCell(f), tl, sm);
            frag.appendChild(r);
        }
        L.appendChild(frag);
        if (!rows.length) L.insertAdjacentHTML('beforeend', '<div class="msg">Nobody matches these filters.</div>');
    }
    function showTip(e, f, segs, t0, span) {
        const rect = e.currentTarget.getBoundingClientRect();
        const t = t0 + ((e.clientX - rect.left) / rect.width) * span;
        const seg = segs.find((s) => t >= s.a && t <= s.b);
        const tip = $('#tip');
        tip.innerHTML = `<b>${esc(f.name)}</b><br>${esc(fmtDate(t))}` +
            (seg ? `<br><span class="dot" style="background:${COLORS[seg.s] || UNKNOWN_BG}"></span> ${esc(LABEL[seg.s] || seg.s)}: ${esc(fmtDate(seg.a))} – ${seg.b >= Date.now() - 60000 ? 'now' : esc(fmtDate(seg.b))} (${ago(seg.b - seg.a)})` : '');
        tip.style.display = 'block';
        const panel = root.querySelector('.panel').getBoundingClientRect();
        tip.style.left = Math.min(e.clientX + 14, panel.right - 290) + 'px';
        tip.style.top = (e.clientY + 16) + 'px';
    }

    // ---------- report tab ----------
    function drawStats() {
        const stats = [
            [F.filter((f) => f.status === 'ask me').length, 'orange (Ask Me)', () => { filter = 'ask me'; setOffline(null); }],
            [F.filter((f) => f.status === 'busy').length, 'red (Do Not Disturb)', () => { filter = 'busy'; setOffline(null); }],
            [F.filter((f) => f.seenMs > 6 * MONTH).length, 'not online 6+ months', () => { filter = 'all'; setOffline(6, 12); }],
            [F.filter((f) => f.seenMs > 12 * MONTH).length, 'not online 12+ months', () => { filter = 'all'; setOffline(12, 12); }],
        ];
        const box = $('#stats'); box.innerHTML = '';
        for (const [n, label, fn] of stats) {
            const d = document.createElement('div'); d.className = 'stat';
            d.innerHTML = `<b>${n}</b><span>${esc(label)}</span>`;
            d.onclick = () => { fn(); drawChips(); draw(); refresh(true); };
            box.appendChild(d);
        }
    }
    function drawChips() {
        // counts follow the search and both dropdowns
        const base = F.filter(passesOther);
        const c = $('#chips'); c.innerHTML = '';
        for (const s of ['all', 'join me', 'active', 'ask me', 'busy', 'unknown']) {
            const n = base.filter((f) => matchesFilter(f, s)).length;
            if (s === 'unknown' && !n && filter !== 'unknown') continue; // only show Unknown when there is any
            const b = document.createElement('button');
            b.className = 'sitem' + (filter === s ? ' on' : '');
            b.innerHTML = (s !== 'all' ? `<span class="dot" style="background:${COLORS[s]}"></span>` : '<span class="dot" style="background:none;border:1px solid var(--muted)"></span>')
                + `${esc(FILTER_LABEL[s])}${STATUS_NAME[s] ? ` <small>${esc(STATUS_NAME[s])}</small>` : ''}<span class="n">${n}</span>`;
            b.onclick = () => { filter = s; drawChips(); draw(); refresh(true); };
            c.appendChild(b);
        }
        syncSegs();
        drawPills();
    }
    // segmented buttons: each group stores its value in a hidden input
    function syncSegs() {
        root.querySelectorAll('.seg').forEach((g) => {
            const v = $('#' + g.dataset.for).value;
            g.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
        });
    }
    function setSeg(id, v) { $('#' + id).value = v; syncSegs(); $('#' + id).onchange?.(); }
    // the filters that are on, as removable pills above the list
    function drawPills() {
        const pills = [];
        if (filter !== 'all') pills.push([`Status: ${FILTER_LABEL[filter]}`, () => { filter = 'all'; }]);
        if (sameMonths()) pills.push([`Same status ${sameMonths()}+ months`, () => { $('#same').value = '0'; }]);
        const off = offlineRange();
        if (off) pills.push([`Not online for ${offlineText(off)}`, () => setOffline(null)]);
        const tg = togetherMax();
        if (tg !== '') pills.push([tg === '0' ? 'Never met' : `Under ${tg} h together`, () => { $('#together').value = ''; }]);
        const q = $('#q').value.trim();
        if (q) pills.push([`Name: “${q}”`, () => { $('#q').value = ''; }]);
        const box = $('#pills'); box.innerHTML = '';
        if (!pills.length) { box.innerHTML = '<span class="muted">No filters. Pick some on the left to find people to remove.</span>'; return; }
        for (const [label, clear] of pills) {
            const el = document.createElement('span'); el.className = 'pill';
            el.textContent = label;
            const x = document.createElement('button'); x.textContent = '×'; x.title = 'Remove filter';
            x.onclick = () => { clear(); drawChips(); draw(); refresh(true); };
            el.appendChild(x); box.appendChild(el);
        }
        if (pills.length > 1) {
            const all = document.createElement('button'); all.className = 'link'; all.textContent = 'Clear all';
            all.onclick = resetFilters; box.appendChild(all);
        }
    }
    function resetFilters() {
        filter = 'all'; $('#same').value = '0'; $('#together').value = ''; $('#q').value = '';
        setOffline(null); drawChips(); draw(); refresh(true);
    }
    function sorter(key, dir) {
        return (a, b) => { const x = a[key], y = b[key]; return (typeof x === 'string' ? x.localeCompare(y) : (x > y) - (x < y)) * dir; };
    }
    function header(cols, key, dir, onSort, extra) {
        const head = document.createElement('div'); head.className = 'row head';
        if (extra) head.appendChild(extra);
        for (const [k, l] of cols) {
            const s = document.createElement('div');
            s.textContent = l + (key === k ? (dir < 0 ? ' ▼' : ' ▲') : '');
            if (k) s.onclick = () => onSort(k);
            head.appendChild(s);
        }
        return head;
    }
    function nameCell(f) {
        const d = document.createElement('div'); d.className = 'name';
        d.innerHTML = `<a title="Open profile"></a>${f.fav ? '<span class="star" title="Favorite">★</span>' : ''}`;
        const a = d.querySelector('a'); a.textContent = f.name; a.onclick = () => openUser(f.id);
        return d;
    }
    const FILTER_LABEL = { all: 'All', active: 'Green', 'join me': 'Blue', 'ask me': 'Orange', busy: 'Red', unknown: 'Unknown' };
    const STATUS_NAME = { active: 'Online', 'join me': 'Join Me', 'ask me': 'Ask Me', busy: 'Do Not Disturb', unknown: 'No status recorded' };
    function matchesFilter(f, s) { return s === 'all' || f.status === s; }
    // "Not online for" slider: null when off, else {min, max} in months; max 12 means "12+" (no upper limit)
    function offlineRange() {
        if (!$('#offOn').checked) return null;
        const a = +$('#offMin').value, b = +$('#offMax').value;
        return { min: Math.min(a, b), max: Math.max(a, b) };
    }
    function offlineText(r) {
        if (r.max === 12) return `${r.min === 12 ? '12' : r.min}+ months`;
        if (r.min === r.max) return `${r.min} month${r.min === 1 ? '' : 's'}`;
        return `${r.min}–${r.max} months`;
    }
    function setOffline(min, max) { // used by the cards; null turns it off
        $('#offOn').checked = min != null;
        if (min != null) { $('#offMin').value = min; $('#offMax').value = max; }
        syncSlider();
    }
    function syncSlider() {
        const on = $('#offOn').checked, a = +$('#offMin').value, b = +$('#offMax').value;
        const lo = Math.min(a, b), hi = Math.max(a, b), pc = (m) => ((m - 1) / 11) * 100;
        $('#offFill').style.left = `calc(8px + ${pc(lo) / 100} * (100% - 16px))`;
        $('#offFill').style.width = `calc(${(pc(hi) - pc(lo)) / 100} * (100% - 16px))`;
        $('#offRow').classList.toggle('off', !on);
        $('#offLabel').textContent = offlineText({ min: lo, max: hi });
    }
    const sameMonths = () => +$('#same').value;
    const togetherMax = () => $('#together').value; // '' = any, '0' = never met, else hours
    // search + last-online + same-status filters (everything except the status button)
    function passesOther(f) {
        const q = $('#q').value.toLowerCase(), off = offlineRange(), same = sameMonths();
        return (!q || f.name.toLowerCase().includes(q))
            && (!off || (f.seenMs > off.min * MONTH && (off.max === 12 || f.seenMs <= (off.max + 1) * MONTH)))
            && (!same || f.sinceMs > same * MONTH)
            && passesTogether(f);
    }
    function passesTogether(f) {
        const t = togetherMax();
        if (t === '') return true;
        if (t === '0') return f.joins === 0;
        return f.togetherMs < +t * 3600000;
    }
    function reportMatches() { return F.filter((f) => matchesFilter(f, filter) && passesOther(f)); }
    // protected rows: shown, but never ticked or unfriended
    const skipped = (f) => ($('#skipFav').checked && f.fav) || ($('#skipOnline').checked && f.online);
    // rows are always selectable in Report (protected rows excepted); nothing is ticked until you tick it
    const reportFiltered = () => true;
    function buildRow(f, selectable) {
        const r = document.createElement('div'); r.className = 'row';
        const c0 = document.createElement('div');
        if (selectable && skipped(f)) {
            c0.innerHTML = '<span class="muted" title="Protected by the \'Never select\' options">–</span>';
        } else if (selectable) {
            const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = selected.has(f.id);
            cb.onchange = () => { cb.checked ? selected.add(f.id) : selected.delete(f.id); updateCount(); };
            c0.appendChild(cb);
        }
        r.appendChild(c0);
        r.appendChild(nameCell(f));
        r.insertAdjacentHTML('beforeend', `<div>${statusPhrase(f)}</div><div>${seenPhrase(f)}</div>${togetherCells(f)}<div${f.mutuals ? '' : ' class="muted"'}>${f.mutuals}</div>`);
        return r;
    }
    function renderReport() {
        const rows = reportMatches().sort(sorter(sortKey, sortDir));
        const selectable = reportFiltered();
        const L = $('#list'); L.className = 'body'; L.innerHTML = '';
        L.appendChild(header([['name', `Name · ${rows.length} shown`], ['sinceMs', 'Status'], ['seenMs', 'Last online'], ['togetherMs', 'Time together'], ['joins', 'Joins'], ['mutuals', 'Mutuals']],
            sortKey, sortDir, (k) => { sortDir = sortKey === k ? -sortDir : (k === 'name' || k === 'text' ? 1 : -1); sortKey = k; renderReport(); },
            document.createElement('div')));
        const frag = document.createDocumentFragment();
        for (const f of rows) frag.appendChild(buildRow(f, selectable));
        L.appendChild(frag);
        if (!rows.length) L.insertAdjacentHTML('beforeend', '<div class="msg">Nobody matches these filters.</div>');
        updateCount();
    }

    function filterText() {
        const parts = [];
        const off = offlineRange(), same = sameMonths(), q = $('#q').value.trim();
        if (filter !== 'all') parts.push(`status ${FILTER_LABEL[filter] || filter}`);
        if (same) parts.push(`same status for ${same}+ months`);
        const tg = togetherMax();
        if (tg === '0') parts.push('never met');
        else if (tg) parts.push(`under ${tg} hour${tg === '1' ? '' : 's'} together`);
        if (off) parts.push(`not online for ${offlineText(off)}`);
        if (q) parts.push(`matching "${q}"`);
        return parts.join(' AND ') || 'no filters (everyone shown)';
    }
    // rows the selection bar acts on: whatever the current tab shows (null = no filter yet)
    function currentRows() {
        if (tab !== 'report' || !reportFiltered()) return null;
        return reportMatches().filter((f) => !skipped(f));
    }
    function chosen() { return (currentRows() || []).filter((f) => selected.has(f.id)); }
    function updateCount() {
        const m = currentRows(), n = chosen().length;
        $('#cCount').textContent = m ? `${n} of ${m.length} selected` : '';
        $('[data-act=unfriend]').disabled = !n || running;
        $('[data-act=unfriend]').textContent = n ? `Unfriend ${n} selected...` : 'Unfriend selected...';
    }

    // ---------- 4-step confirmation ----------
    function modal(html) { $('#box').innerHTML = html; $('#modal').classList.add('open'); }
    function closeModal() { $('#modal').classList.remove('open'); }
    function stepBox(step, title, body, { input, yes = 'Continue', danger = false } = {}) {
        return new Promise((resolve) => {
            modal(`<div class="steps">${[1, 2, 3, 4].map((i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>
                <div class="muted" style="font-size:12px">Confirmation ${step} of 4</div><h3>${title}</h3>${body}
                ${input ? `<input type="text" id="cIn" autocomplete="off" placeholder="${esc(input)}">` : ''}
                <div class="actions"><button class="btn" id="no">Cancel</button><button class="btn ${danger ? 'danger' : ''}" id="yes">${yes}</button></div>`);
            const yesB = $('#yes'), inp = $('#cIn');
            if (inp) { yesB.disabled = true; inp.oninput = () => { yesB.disabled = inp.value.trim() !== input; }; inp.focus(); }
            $('#no').onclick = () => { closeModal(); resolve(false); };
            yesB.onclick = () => { closeModal(); resolve(true); };
        });
    }
    async function confirmAndRun() {
        const list = chosen();
        const n = list.length;
        if (!n || running) return;
        if (!window.webApiService?.execute) {
            modal(`<h3>Can't unfriend from here</h3><p>This VRCX version doesn't expose its request service to custom scripts, so unfriending isn't available. The report still works.</p><div class="actions"><button class="btn" id="no">OK</button></div>`);
            $('#no').onclick = closeModal; return;
        }
        const names = list.map((f) => esc(f.name)).join('<br>');
        const favs = list.filter((f) => f.fav).length;
        const recent = list.filter((f) => f.seenMs < 30 * DAY).length;
        if (!await stepBox(1, `Unfriend ${n} ${n === 1 ? 'person' : 'people'}?`,
            `<p>Filter: <b>${esc(filterText())}</b>.</p><p>Nothing has been changed yet.</p>`)) return;
        if (!await stepBox(2, 'Check the list', `<p>These are the people who will be unfriended:</p><div class="names">${names}</div>` +
            (favs ? `<p class="warn">${favs} of them are favorites.</p>` : '') +
            (recent ? `<p class="warn">${recent} of them were online in the last 30 days.</p>` : ''), { yes: 'These are right' })) return;
        if (!await stepBox(3, 'This can\'t be undone', `<p>VRChat has no "undo" for unfriending. To get anyone back you'd have to send them a new friend request and they'd have to accept it.</p>
            <p>VRCX's Friend Log will still record who was removed.</p>`, { yes: 'I understand' })) return;
        let speed = 'normal';
        try { if (SPEEDS[localStorage.getItem('orangeReport.speed')]) speed = localStorage.getItem('orangeReport.speed'); } catch (e) { /* ignore */ }
        const eta = (k) => { const sec = n * (SPEEDS[k].ms + 400) / 1000; return sec < 90 ? `about ${Math.ceil(sec)} seconds` : `about ${Math.ceil(sec / 60)} minutes`; };
        // last step: pick a speed and type the number of people to start
        const final = stepBox(4, 'Final confirmation', `<p>Speed:</p><select id="speed" style="width:100%">${Object.entries(SPEEDS)
            .map(([k, v]) => `<option value="${k}" ${k === speed ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select>
            <p class="muted" id="eta"></p>
            <p>If VRChat says it's going too fast, the run pauses and slows down on its own. You can stop it at any time.</p>
            <p>Type <b>${n}</b> (the number of people) to start.</p>`, { input: String(n), yes: `Unfriend ${n}`, danger: true });
        const setEta = () => { $('#eta').textContent = `${n} ${n === 1 ? 'person' : 'people'}: ${eta(speed)}.`; };
        $('#speed').onchange = () => { speed = $('#speed').value; setEta(); try { localStorage.setItem('orangeReport.speed', speed); } catch (e) { /* ignore */ } };
        setEta();
        if (!await final) return;
        await runUnfriend(list, TEST_DELAY ?? SPEEDS[speed].ms);
    }

    async function unfriendOne(id) {
        const res = await window.webApiService.execute({
            url: `${API}/auth/user/friends/${encodeURIComponent(id)}`, method: 'DELETE',
            headers: { 'Content-Type': 'application/json;charset=utf-8' }, body: '{}',
        });
        return res.status;
    }
    async function runUnfriend(list, delay) {
        running = true; updateCount();
        let stop = false, done = 0, failed = 0;
        const removed = [];
        modal(`<h3>Unfriending...</h3><div class="prog"><div id="pg"></div></div><div id="pt" class="muted"></div>
            <div class="log" id="plog"></div><div class="actions"><button class="btn danger" id="stopB">Stop</button></div>`);
        $('#stopB').onclick = () => { stop = true; $('#stopB').disabled = true; $('#stopB').textContent = 'Stopping...'; };
        const log = (t) => { $('#plog').insertAdjacentHTML('afterbegin', `<div>${esc(t)}</div>`); };
        for (let i = 0; i < list.length && !stop; i++) {
            const f = list[i];
            $('#pt').textContent = `${i + 1} / ${list.length}: ${f.name}`;
            let status;
            for (let attempt = 1; attempt <= 4 && !stop; attempt++) {
                try { status = await unfriendOne(f.id); } catch (e) { status = String(e?.message || e); }
                if (status !== 429) break;
                // VRChat says too many requests: wait, then keep going slower
                const wait = 30000 * attempt;
                delay = Math.max(delay * 2, 2000);
                log(`VRChat asked to slow down. Waiting ${wait / 1000} s, then 1 every ${delay / 1000} s.`);
                for (let t = wait; t > 0 && !stop; t -= 1000) { $('#pt').textContent = `Paused by VRChat rate limit: resuming in ${t / 1000} s`; await sleep(1000); }
            }
            if (stop && status === 429) break;
            if (status === 200) { done++; removed.push({ id: f.id, name: f.name, at: new Date().toISOString() }); log(`Removed ${f.name}`); console.log(`[orange-report] Unfriended ${f.name} (${f.id})`); }
            else if (status === 404) { log(`${f.name}: already not a friend`); }
            else { failed++; log(`${f.name}: failed (${status})`); if (status === 401) { stop = true; log('Not logged in - stopped.'); } }
            $('#pg').style.width = `${((i + 1) / list.length) * 100}%`;
            if (i < list.length - 1 && !stop && delay) await sleep(delay + Math.random() * delay * 0.25);
        }
        try {
            const hist = JSON.parse(localStorage.getItem('orangeReport.removed') || '[]');
            localStorage.setItem('orangeReport.removed', JSON.stringify(hist.concat(removed)));
        } catch (e) { /* ignore */ }
        running = false;
        const gone = new Set(removed.map((r) => r.id));
        F = F.filter((f) => !gone.has(f.id));
        $('#pt').textContent = `${stop ? 'Stopped' : 'Finished'}: ${done} removed${failed ? `, ${failed} failed` : ''}.`;
        $('#stopB').outerHTML = '<button class="btn" id="okB">Close</button>';
        $('#okB').onclick = () => { closeModal(); drawStats(); drawChips(); draw(); };
    }

    // ---------- wiring ----------
    $('.fab').onclick = show;
    overlay.onclick = (e) => { if (e.target === overlay) hide(); };
    root.querySelector('[data-act=close]').onclick = hide;
    root.querySelector('[data-act=refresh]').onclick = () => refresh();
    root.querySelector('[data-act=unfriend]').onclick = confirmAndRun;
    root.querySelector('[data-act=reset]').onclick = resetFilters;
    root.querySelectorAll('.seg').forEach((g) => g.querySelectorAll('button').forEach((b) => (b.onclick = () => setSeg(g.dataset.for, b.dataset.v))));
    root.querySelector('[data-act=selall]').onclick = () => { (currentRows() || []).forEach((f) => selected.add(f.id)); draw(); };
    root.querySelector('[data-act=selnone]').onclick = () => { (currentRows() || []).forEach((f) => selected.delete(f.id)); draw(); };
    root.querySelectorAll('.tab').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
    $('#q').oninput = () => { drawChips(); draw(); };
    $('#rq').oninput = () => renderRemoved();
    $('#rWhen').onchange = () => { syncSegs(); renderRemoved(); };
    $('#rMine').onchange = () => renderRemoved();
    for (const id of ['#offMin', '#offMax']) {
        $(id).oninput = () => { $('#offOn').checked = true; syncSlider(); drawChips(); draw(); };
        $(id).onchange = () => refresh(true);
    }
    $('#offOn').onchange = () => { syncSlider(); drawChips(); draw(); refresh(true); };
    syncSlider();
    $('#same').onchange = () => { drawChips(); draw(); refresh(true); };
    $('#together').onchange = () => { drawChips(); draw(); refresh(true); };
    ['#skipFav', '#skipOnline'].forEach((s) => ($(s).onchange = () => renderReport()));
    state.key = (e) => {
        if (e.ctrlKey && e.shiftKey && (e.key === 'O' || e.key === 'o')) { e.preventDefault(); overlay.classList.contains('open') ? hide() : show(); }
        else if (e.key === 'Escape' && overlay.classList.contains('open') && !$('#modal').classList.contains('open')) hide();
    };
    document.addEventListener('keydown', state.key);
    // VRCX's UI library traps focus and listens to keys on the whole document. It can't see inside our
    // shadow DOM, so it treats clicks/typing in our search box as "outside" and pulls focus back.
    // Catch our panel's focus and key events at the very top (window, capture phase) before any VRCX
    // listener runs, and hide them from VRCX. Typing itself still works: that's the browser's default action.
    const fromPanel = (e) => e.composedPath().includes(host) || e.relatedTarget === host;
    state.guard = (e) => {
        if (!fromPanel(e)) return;
        if (e.type === 'keydown') state.key(e);
        e.stopImmediatePropagation();
    };
    state.guardTypes = ['keydown', 'keyup', 'keypress', 'focusin', 'focusout'];
    for (const type of state.guardTypes) window.addEventListener(type, state.guard, true);

    // ======================= sidebar entry =======================
    // Copies VRCX's own "Tools" sidebar item (so it matches the theme) and puts it right below.
    function injectNav() {
        if (document.querySelector('[data-orange-nav]')) return true;
        const icon = document.querySelector('[data-sidebar="menu-item"] i.ri-tools-line');
        const item = icon?.closest('[data-sidebar="menu-item"]');
        if (!item) return false;
        const clone = item.cloneNode(true); // cloneNode doesn't copy VRCX's click handlers
        clone.setAttribute('data-orange-nav', '');
        clone.querySelectorAll('[data-active]').forEach((e) => e.setAttribute('data-active', 'false'));
        clone.querySelectorAll('[aria-current]').forEach((e) => e.removeAttribute('aria-current'));
        clone.querySelectorAll('a[href]').forEach((e) => e.removeAttribute('href'));
        const ic = clone.querySelector('i.ri-tools-line');
        ic.classList.replace('ri-tools-line', 'ri-user-search-line');
        // replace the label text (whatever language VRCX is in)
        const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
        let node, labelled = false;
        while ((node = walker.nextNode())) {
            if (node.nodeValue.trim()) { node.nodeValue = labelled ? '' : 'Status Report'; labelled = true; }
        }
        clone.querySelectorAll('[title]').forEach((e) => e.setAttribute('title', 'Status Report'));
        clone.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); show(); }, true);
        item.after(clone);
        return true;
    }
    function syncNav() { $('.fab').classList.toggle('show', !injectNav()); }
    let pending = false;
    state.observer = new MutationObserver(() => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; syncNav(); });
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
    syncNav();
})();
