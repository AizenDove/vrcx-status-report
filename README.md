# VRCX Status Report

A friends-list dashboard and cleanup tool that runs **inside [VRCX](https://github.com/vrcx-team/VRCX)**.

See who's online and what status they're on, how long friends have kept the same status, who hasn't logged in for months or years, and bulk-remove inactive friends safely, with a 5-step confirmation and a record of everyone removed.

> **Not affiliated with VRChat or the VRCX team.** This is a community script that uses VRCX's custom-script support. Unfriending is permanent; read [Safety](#safety) before using Cleanup.

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Status colours](#status-colours)
- [Safety](#safety)
- [Limitations](#limitations)
- [Uninstalling](#uninstalling)
- [Standalone scripts](#standalone-scripts)
- [Privacy](#privacy)
- [Troubleshooting](#troubleshooting)

---

## Features

| Tab | What it does |
|---|---|
| **Report** | Every friend with their live state (**Offline**, or their status colour if online), how long they've had their status, when they were last online, and their status text. Filter by state and last-online time, search by name or status text, sort by any column. |
| **Timeline** | One bar per friend showing their status history over time, coloured by status. Hover for exact dates and durations; a "most of the time" column summarises each person (e.g. *Orange 71% · Green 29%*). |
| **Cleanup** | Find friends by **last online** (1+, 3+, 6+, 12+ months) and/or **unchanged orange status** (1+, 3+, 6+, 12+ months), review the list, and unfriend the selection. Favorites and anyone online right now are skipped by default. |
| **Removed** | A "bin" of everyone VRCX's Friend Log recorded as no longer a friend, with a **Send friend request** button to undo a removal. |

Also:

- Opens from a **Status Report** entry in VRCX's left sidebar, or **Ctrl+Shift+O**.
- Matches VRCX's look and works in any VRCX language.
- Data reloads each time you open the panel or change a filter.

## How it works

VRCX loads a file called `custom.js` from its data folder at startup and runs it inside its window. This project is that file. It reads:

| Data | Source |
|---|---|
| Status changes, online/offline events, unfriend log | VRCX's local database (`%AppData%\VRCX\VRCX.sqlite3`), read-only `SELECT` queries |
| Current status, online state, last login, favorites | VRCX's live friend list (already loaded from VRChat by VRCX) |

The script only talks to VRChat for the two actions you explicitly confirm: **unfriending** and **sending a friend request**. Both go through VRCX's own request service, using your existing VRCX login. No passwords or tokens are read or stored by this script.

## Requirements

- **Windows** with **VRCX** installed and logged in. Tested on VRCX **2026.09.16**.
- VRCX must have been running for a while: status history starts from when *your* VRCX started recording (see [Limitations](#limitations)).
- Optional: **Python 3.9+** for the [standalone scripts](#standalone-scripts).

## Installation

### Option 1: install script (recommended)

1. Download or clone this repository.
2. In the repository folder, run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

   This copies `custom.js` to `%AppData%\VRCX\custom.js`. If you already had a different `custom.js`, it's backed up first as `custom.js.bak-<date>`.
3. **Restart VRCX.**

### Option 2: manual

1. Copy `custom.js` from this repository to:

   ```
   %AppData%\VRCX\custom.js
   ```

   (Paste `%AppData%\VRCX` into the File Explorer address bar to open the folder.)
2. **Restart VRCX.**

> If you already use a `custom.js` for something else, VRCX only loads one file, so you'll need to combine them.

### Updating

Pull or download the latest version and run the install script again (or copy `custom.js` again), then restart VRCX.

## Usage

Open **Status Report** in the VRCX sidebar (just below **Tools**) or press **Ctrl+Shift+O**. **Esc** closes the panel.

### Report

- **Cards** at the top show *online now*, *offline now*, *not online in 6+ months* and *not online in 12+ months*. Click a card to filter to it.
- **Filter buttons:** All · Online · Green · Blue · Orange · Red · Offline. Counts follow the other filters.
- **Last-online dropdown:** any, or not online in 1+ / 3+ / 6+ / 12+ months.
- **Search** matches display names and status text.
- Click a **column header** to sort; click a **name** to open their VRCX profile.
- Once a filter is active, rows get checkboxes and you can unfriend the selection from the bar at the bottom (same 5-step confirmation as Cleanup).

### Timeline

- Each bar runs from when VRCX started recording to now. Colours show the status they had set at each point.
- **Hover** a bar for the date, the status, and how long that status lasted.
- Uses the same filters and search as Report.

### Cleanup

1. Pick **Last online** and/or **Unchanged orange for**. At least one is required, so it can never select everyone.
2. Leave **Skip favorites** and **Skip anyone online now** on unless you mean otherwise.
3. Everyone matching is pre-ticked. **Untick anyone you want to keep**, or use *Select all / Select none*.
4. Click **Unfriend N selected…** and go through the confirmations:
   1. Summary of the filter and count
   2. The full list of names, with warnings for favorites and anyone online in the last 30 days
   3. A reminder that unfriending can't be undone
   4. Type the exact number of people
   5. Choose a speed and type **UNFRIEND**
5. A progress window shows each removal. **Stop** works at any time.

Rows here show what people have *set* even when they're offline (e.g. *Offline · set to Orange for 1 year*), because that's what the orange filter matches on.

### Removed

- Lists everyone VRCX's Friend Log recorded as unfriended (by you or by them) who isn't your friend again.
- Filter by *last 24 hours / 7 days / 30 days* or *only removed by Status Report*, and search by name.
- **Send friend request** sends a normal friend request (after one confirmation). They have to accept it.

## Status colours

Colours follow VRChat's own:

| Colour | VRChat status |
|---|---|
| 🟢 Green | Online |
| 🔵 Blue | Join Me |
| 🟠 Orange | Ask Me |
| 🔴 Red | Busy / Do Not Disturb |
| ⚪ Grey | Offline |

In VRChat, a status is a setting that **stays set while someone is offline**. Report shows *Offline* for anyone not online; Timeline and Cleanup work with the status they have set.

## Safety

Unfriending in VRChat is **permanent**: the only way back is a new friend request that the other person accepts. The script is built around that:

- **5 separate confirmations**, including typing the number of people and the word `UNFRIEND`.
- **Never selects everyone:** a filter is required before anything can be selected.
- **Favorites and online friends are skipped** by default.
- **Rate-limit aware:** choose *Fast* (no pause, like VRCX's built-in Bulk Unfriend), *Normal* (1 s, default) or *Careful* (4 s). If VRChat replies "too many requests", the run pauses, retries, and slows down automatically.
- **Stop** at any time; already-removed friends stay removed, the rest are untouched.
- Every removal is logged in VRCX's Friend Log and listed in the **Removed** tab.

VRChat doesn't publish its API limits and does monitor unusual account activity. For a first run, try **one** person and check they're gone before doing a large batch. You use the unfriend feature at your own risk.

## Limitations

- **History starts when your VRCX started recording.** If VRCX first saw someone already orange, durations are shown as "at least …".
- **VRCX only records while it's running.** Status changes and sessions that happen while VRCX is closed aren't captured. "Last online" also uses VRChat's last-login time from VRCX's friend list, so it's usually accurate even for long absences.
- **Friends only.** VRCX doesn't track non-friends, and this script doesn't either.
- **Uses VRCX internals** (`custom.js`, its database bridge, its request service, its sidebar markup), not an official plugin API. A VRCX update may break part of the panel until this script is updated; VRCX itself keeps working.
- Windows VRCX only (the Linux build uses a different bridge and is untested).

## Uninstalling

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

or delete `%AppData%\VRCX\custom.js`, then restart VRCX. If the installer backed up an earlier `custom.js`, rename the `custom.js.bak-<date>` file back to `custom.js` to restore it.

## Standalone scripts

The [`tools/`](tools) folder has two read-only Python scripts that work without the VRCX panel. Neither one changes anything.

| Script | What it does |
|---|---|
| `tools/make_report.py` | Builds `friends_report.html` (a filterable, sortable report) next to the script and opens it in your browser. |
| `tools/orange_report.py` | Prints friends currently on a given status and for how long, in the terminal. |

```bash
python tools/make_report.py
python tools/orange_report.py --min-days 7
python tools/orange_report.py --status busy --csv busy.csv
```

These only use VRCX's database, so they don't have live online state.

## Privacy

- Everything runs locally on your PC. Nothing is sent anywhere except the unfriend / friend-request calls you confirm, which go to VRChat through VRCX.
- Generated reports (`friends_report.html`, CSV exports) contain your friends' names and IDs. They're in `.gitignore`; don't share or commit them.

## Troubleshooting

| Problem | Try |
|---|---|
| No **Status Report** in the sidebar | Restart VRCX. If there's still no entry, a small **Status report** button appears bottom-right instead; the panel works the same. Make sure the file is named exactly `custom.js` in `%AppData%\VRCX`. |
| Panel says *Could not read VRCX data* | VRCX hasn't finished loading or you're logged out. Log in, wait a moment, then press **Refresh**. |
| Clicking a name opens the browser instead of VRCX's profile | VRCX's internals changed; the browser link is a fallback and still works. |
| *Can't unfriend from here* | This VRCX version doesn't expose its request service to scripts. Report, Timeline and Removed still work. |
| Unfriending pauses with a countdown | VRChat asked for fewer requests. Wait; it resumes and slows down by itself. |
