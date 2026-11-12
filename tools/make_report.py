"""
make_report.py - builds a visual friends report from VRCX and opens it in your browser.

    python make_report.py

Writes friends_report.html next to this script (read-only access to VRCX's
database; nothing is changed). Re-run any time to refresh it.
"""

import json
import os
import sqlite3
import sys
import webbrowser
from datetime import datetime, timezone

DB_PATH = os.path.expandvars(r"%APPDATA%\VRCX\VRCX.sqlite3")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "friends_report.html")


def prefixes(con):
    rows = con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%\\_feed_status' ESCAPE '\\'"
    ).fetchall()
    return [r[0][: -len("_feed_status")] for r in rows]


def collect(con, p):
    q = f"""
    WITH st AS (
        SELECT user_id, status, status_description, created_at,
               ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) rn
        FROM "{p}_feed_status"
    ),
    oo AS (
        SELECT user_id, type, created_at,
               ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) rn
        FROM "{p}_feed_online_offline"
    )
    SELECT f.user_id, f.display_name, st.status, st.status_description, st.created_at,
           oo.type, oo.created_at
    FROM "{p}_friend_log_current" f
    LEFT JOIN st ON st.user_id = f.user_id AND st.rn = 1
    LEFT JOIN oo ON oo.user_id = f.user_id AND oo.rn = 1
    """
    out = []
    for uid, name, status, desc, since, ev_type, ev_at in con.execute(q):
        out.append({
            "id": uid, "name": name or uid, "status": status or "unknown",
            "text": desc or "", "since": since, "lastEvent": ev_type, "lastSeen": ev_at,
        })
    starts = [con.execute(f'SELECT MIN(created_at) FROM "{p}_{t}"').fetchone()[0]
              for t in ("feed_status", "feed_online_offline")]
    starts = [s for s in starts if s]
    return out, (min(starts) if starts else None)


def main():
    if not os.path.exists(DB_PATH):
        sys.exit(f"VRCX database not found at {DB_PATH}")
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    friends, starts = [], []
    for p in prefixes(con):
        f, s = collect(con, p)
        friends += f
        if s:
            starts.append(s)
    data = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "trackingStart": min(starts) if starts else None,
        "friends": friends,
    }
    blob = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(TEMPLATE.replace("/*DATA*/null", blob))
    print(f"Wrote {OUT} ({len(friends)} friends)")
    webbrowser.open("file:///" + OUT.replace("\\", "/"))


TEMPLATE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VRCX Friends Report</title>
<style>
:root{--bg:#f6f6f8;--card:#fff;--fg:#1c1c22;--muted:#6b6b78;--line:#e3e3ea;--chip:#ececf2;
--orange:#e88134;--red:#e83f3f;--green:#2fbf5a;--blue:#1ea7e6;--gray:#9a9aa6}
@media (prefers-color-scheme:dark){:root{--bg:#141418;--card:#1d1d23;--fg:#ececf1;--muted:#9a9aa8;--line:#2c2c35;--chip:#2a2a33}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 60px}
h1{font-size:22px;margin:0 0 4px}
.sub{color:var(--muted);margin-bottom:18px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:18px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;cursor:pointer}
.stat b{display:block;font-size:24px}
.stat span{color:var(--muted);font-size:12.5px}
.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
.chip{border:1px solid var(--line);background:var(--chip);color:var(--fg);border-radius:999px;padding:5px 12px;cursor:pointer;font:inherit}
.chip.on{background:var(--fg);color:var(--bg)}
input,select{font:inherit;padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
input{flex:1;min-width:160px}
.list{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.row{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.2fr);gap:12px;padding:10px 14px;border-top:1px solid var(--line);align-items:center}
.row:first-child{border-top:0}
.head{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;cursor:pointer;user-select:none}
.name{display:flex;gap:9px;align-items:center;min-width:0}
.name a{color:inherit;text-decoration:none;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.name a:hover{text-decoration:underline}
.dot{width:11px;height:11px;border-radius:50%;flex:none}
.muted{color:var(--muted)}
.txt{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.warn{color:var(--red);font-weight:600}
@media (max-width:700px){.row{grid-template-columns:1fr 1fr}.head{display:none}.txt{grid-column:1/-1}}
</style></head><body><main>
<h1>VRCX Friends Report</h1>
<div class="sub" id="sub"></div>
<div class="stats" id="stats"></div>
<div class="controls">
  <span id="chips"></span>
  <select id="seen">
    <option value="0">Any last-online</option>
    <option value="30">Not online in 30+ days</option>
    <option value="90">Not online in 90+ days</option>
    <option value="180">Not online in 6+ months</option>
    <option value="never">Never seen online since tracking began</option>
  </select>
  <input id="q" placeholder="Search name or status text">
</div>
<div class="sub" id="count"></div>
<div class="list" id="list"></div>
</main>
<script>
const DATA = /*DATA*/null;
const NOW = Date.now();
const COLORS = {"active":"var(--green)","join me":"var(--blue)","ask me":"var(--orange)","busy":"var(--red)","unknown":"var(--gray)"};
const LABEL  = {"active":"Green","join me":"Blue","ask me":"Orange","busy":"Red","unknown":"Unknown"};
const start = DATA.trackingStart ? Date.parse(DATA.trackingStart) : null;
const fmtDate = t => new Date(t).toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"});

function ago(ms){
  const d = ms/86400000;
  const p = (n,u)=>`${n} ${u}${n===1?"":"s"}`;
  if (d >= 365) return p(Math.floor(d/365),"year") + (Math.floor((d%365)/30.4) ? ", " + p(Math.floor((d%365)/30.4),"month") : "");
  if (d >= 30.4) return p(Math.floor(d/30.4),"month");
  if (d >= 7) return p(Math.floor(d/7),"week");
  if (d >= 1) return p(Math.floor(d),"day");
  const h = Math.floor(ms/3600000); return h ? p(h,"hour") : "under an hour";
}

const F = DATA.friends.map(f => {
  const since = f.since ? Date.parse(f.since) : null;
  const seen = f.lastSeen ? Date.parse(f.lastSeen) : null;
  // if VRCX saw them at this status on its very first day, the real start is earlier
  const atLeast = since && start && since - start < 2*86400000;
  return {...f, sinceMs: since ? NOW - since : -1, seenMs: seen ? NOW - seen : Infinity, atLeast, seen};
});

let filter = "ask me", sortKey = "sinceMs", sortDir = -1;
const $ = id => document.getElementById(id);

$("sub").textContent = `${F.length} friends · report made ${fmtDate(Date.parse(DATA.generated))}` +
  (start ? ` · VRCX history starts ${fmtDate(start)}, so older times are "at least"` : "");

const orange = F.filter(f=>f.status==="ask me");
const stats = [
  [orange.length, "currently orange", ()=>{filter="ask me";$("seen").value="0"}],
  [orange.filter(f=>f.sinceMs>30*86400000).length, "orange for 30+ days", ()=>{filter="ask me";$("seen").value="0"}],
  [F.filter(f=>f.seenMs>180*86400000).length, "not online in 6+ months", ()=>{filter="all";$("seen").value="180"}],
  [F.filter(f=>f.seenMs===Infinity).length, "never seen online since tracking", ()=>{filter="all";$("seen").value="never"}],
];
stats.forEach(([n,l,fn])=>{const d=document.createElement("div");d.className="stat";
  d.innerHTML=`<b>${n}</b><span></span>`;d.querySelector("span").textContent=l;
  d.onclick=()=>{fn();drawChips();render()};$("stats").appendChild(d)});

function drawChips(){
  const c=$("chips"); c.innerHTML="";
  ["all","active","join me","ask me","busy","unknown"].forEach(s=>{
    const b=document.createElement("button"); b.className="chip"+(filter===s?" on":"");
    const n = s==="all"?F.length:F.filter(f=>f.status===s).length;
    b.textContent=(s==="all"?"All":LABEL[s])+` (${n})`;
    b.onclick=()=>{filter=s;drawChips();render()}; c.appendChild(b);
  });
}

function statusPhrase(f){
  if (f.status==="unknown") return `<span class="muted">No status change seen</span>`;
  return `${LABEL[f.status]} for ${f.atLeast?"at least ":""}<b>${ago(f.sinceMs)}</b>`;
}
function seenPhrase(f){
  if (f.seenMs===Infinity) return `<span class="warn">Not seen online${start?" since "+fmtDate(start):""}</span>`;
  const cls = f.seenMs>180*86400000 ? "warn" : "";
  const word = f.lastEvent==="Online" ? "Came online" : "Last online";
  return `<span class="${cls}">${word} ${ago(f.seenMs)} ago</span>`;
}

function render(){
  const q=$("q").value.toLowerCase(), seen=$("seen").value;
  let rows=F.filter(f=>(filter==="all"||f.status===filter)
    && (!q || f.name.toLowerCase().includes(q) || f.text.toLowerCase().includes(q))
    && (seen==="0" || (seen==="never" ? f.seenMs===Infinity : f.seenMs>seen*86400000)));
  rows.sort((a,b)=>{const x=a[sortKey],y=b[sortKey];
    return (typeof x==="string"?x.localeCompare(y):(x>y)-(x<y))*sortDir});
  $("count").textContent=`Showing ${rows.length}`;
  const L=$("list"); L.innerHTML="";
  const head=document.createElement("div"); head.className="row head";
  [["name","Name"],["sinceMs","Status"],["seenMs","Last online"],["text","Status text"]].forEach(([k,l])=>{
    const s=document.createElement("div"); s.textContent=l+(sortKey===k?(sortDir<0?" ▼":" ▲"):"");
    s.onclick=()=>{sortDir = sortKey===k ? -sortDir : (k==="name"||k==="text"?1:-1); sortKey=k; render()};
    head.appendChild(s)});
  L.appendChild(head);
  for(const f of rows){
    const r=document.createElement("div"); r.className="row";
    r.innerHTML=`<div class="name"><span class="dot" style="background:${COLORS[f.status]||"var(--gray)"}"></span><a target="_blank" rel="noopener"></a></div>
      <div>${statusPhrase(f)}</div><div>${seenPhrase(f)}</div><div class="txt"></div>`;
    const a=r.querySelector("a"); a.textContent=f.name; a.href="https://vrchat.com/home/user/"+encodeURIComponent(f.id);
    a.title="Open VRChat profile";
    const t=r.querySelector(".txt"); t.textContent=f.text; t.title=f.text;
    L.appendChild(r);
  }
}
$("q").oninput=render; $("seen").onchange=render;
drawChips(); render();
</script></body></html>"""

if __name__ == "__main__":
    main()
