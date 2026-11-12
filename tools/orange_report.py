"""
orange_report.py - how long have your VRChat friends been on orange ("Ask Me")?

Reads VRCX's local database (read-only, never writes to it) and, for every
current friend whose most recent recorded status change was to "ask me",
shows how long ago that change happened.

Because VRCX only records changes it sees, the duration is a MINIMUM:
"orange for at least X". If VRCX first saw them already orange, the time is
when VRCX first noticed.

Usage:
    python orange_report.py                 # everyone currently orange
    python orange_report.py --min-days 7    # orange for a week or more
    python orange_report.py --status busy   # same thing for red
    python orange_report.py --csv out.csv   # also save to a CSV file
"""

import argparse
import csv
import os
import sqlite3
import sys
from datetime import datetime, timezone

DB_PATH = os.path.expandvars(r"%APPDATA%\VRCX\VRCX.sqlite3")


def parse_ts(s):
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def fmt_span(seconds):
    days, rem = divmod(int(seconds), 86400)
    hours, rem = divmod(rem, 3600)
    minutes = rem // 60
    if days >= 1:
        return f"{days}d {hours}h"
    if hours >= 1:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def find_prefixes(con):
    """VRCX makes one set of tables per logged-in account: usr<id>_feed_status, ..."""
    rows = con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%\\_feed_status' ESCAPE '\\'"
    ).fetchall()
    return [r[0][: -len("_feed_status")] for r in rows]


def report(con, prefix, status, min_days):
    now = datetime.now(timezone.utc)
    q = f"""
    WITH latest AS (
        SELECT user_id, display_name, status, status_description, created_at,
               ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
        FROM "{prefix}_feed_status"
    ),
    last_online AS (
        SELECT user_id, MAX(created_at) AS last_seen
        FROM "{prefix}_feed_online_offline"
        GROUP BY user_id
    )
    SELECT l.user_id, COALESCE(f.display_name, l.display_name), l.status_description,
           l.created_at, o.last_seen
    FROM latest l
    JOIN "{prefix}_friend_log_current" f ON f.user_id = l.user_id
    LEFT JOIN last_online o ON o.user_id = l.user_id
    WHERE l.rn = 1 AND l.status = ?
    """
    rows = []
    for user_id, name, desc, since, last_seen in con.execute(q, (status,)):
        since_dt = parse_ts(since)
        age = (now - since_dt).total_seconds()
        if age < min_days * 86400:
            continue
        seen_dt = parse_ts(last_seen)
        rows.append({
            "display_name": name,
            "user_id": user_id,
            "since_utc": since_dt.strftime("%Y-%m-%d %H:%M"),
            "duration": fmt_span(age),
            "seconds": int(age),
            "last_online_event": fmt_span((now - seen_dt).total_seconds()) + " ago" if seen_dt else "?",
            "status_text": desc or "",
        })
    rows.sort(key=lambda r: r["seconds"], reverse=True)
    return rows


def main():
    # VRChat names often use symbols the Windows console codepage can't show
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--status", default="ask me", help='status to look for: "ask me" (orange, default), "busy", "join me", "active"')
    ap.add_argument("--min-days", type=float, default=0, help="only show people at this status for at least N days")
    ap.add_argument("--csv", help="also write results to this CSV file")
    ap.add_argument("--db", default=DB_PATH, help="path to VRCX.sqlite3")
    args = ap.parse_args()

    if not os.path.exists(args.db):
        sys.exit(f"VRCX database not found at {args.db}")

    # mode=ro: read-only, safe to run while VRCX is open
    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    all_rows = []
    for prefix in find_prefixes(con):
        rows = report(con, prefix, args.status, args.min_days)
        all_rows += rows
        print(f"\n== account {prefix}: {len(rows)} friends currently '{args.status}' ==")
        print(f"{'Name':<28} {'At least':>10}  {'Since (UTC)':<17} {'Last on/offline':>16}  Status text")
        print("-" * 100)
        for r in rows:
            print(f"{r['display_name'][:28]:<28} {r['duration']:>10}  {r['since_utc']:<17} "
                  f"{r['last_online_event']:>16}  {r['status_text'][:30]}")

    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(all_rows[0].keys()) if all_rows else ["display_name"])
            w.writeheader()
            w.writerows(all_rows)
        print(f"\nSaved {len(all_rows)} rows to {args.csv}")


if __name__ == "__main__":
    main()
