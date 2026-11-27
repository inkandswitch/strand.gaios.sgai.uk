# Draws the "folder tabs" sketches as SVG: python3 folder-tabs.py <out dir>
import html, sys, textwrap
OUT = sys.argv[1] if len(sys.argv) > 1 else "."
W, APP_H, H = 1600, 960, 1090
GROUND, SURFACE, FIELD = "#efede6", "#ffffff", "#faf9f6"
INK, SECOND, MUTED, FAINT = "#1f1e1d", "#5f5e5a", "#8a8883", "#b9b6ae"
EDGE, HOVER, PRESSED = "#e2dfd7", "#edebe5", "#e3e0d8"
OURS, OURS_FILL, THEIRS, THEIRS_FILL = "#3b7dd8", "#e6effb", "#9b5de5", "#f2eafc"
ADDED, MODIFIED = "#3b8f4f", "#dba617"
NOTE = "#c2410c"
SANS = "'PT Sans', 'Fira Sans', 'Segoe UI', system-ui, -apple-system, Helvetica, Arial, sans-serif"
MONO = "'PT Mono', ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace"

LUCIDE = {
    "folder": ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
    "file": ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4"],
    "right": ["m9 18 6-6-6-6"], "down": ["m6 9 6 6 6-6"],
    "fold": ["M12 22v-6", "M12 8V2", "M4 12H2", "M10 12H8", "M16 12h-2", "M22 12h-2", "m15 19-3-3-3 3", "m15 5-3 3-3-3"],
    "open": ["M7 7h10v10", "M7 17 17 7"], "check": ["M20 6 9 17l-5-5"], "x": ["M18 6 6 18", "m6 6 12 12"],
    "swap": ["M8 3 4 7l4 4", "M4 7h16", "m16 21 4-4-4-4", "M20 17H4"],
    "clock": ["M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20", "M12 6v6l4 2"],
    "comment": ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
    "panel": ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2", "M9 3v18"],
    "plus": ["M5 12h14", "M12 5v14"],
}
# the compare-modes package's own icons
MODE = {
    "side-by-side": '<rect x="4" y="5" width="7" height="14" rx="2" fill="#8a8780"/><rect x="13" y="5" width="7" height="14" rx="2" fill="#8a8780"/>',
    "stacked": '<rect x="4" y="4" width="16" height="7" rx="2" fill="#8a8780"/><rect x="4" y="13" width="16" height="7" rx="2" fill="#8a8780"/>',
    "onion-skin": '<rect x="3" y="4" width="12" height="11" rx="2.5" fill="#8a8780"/><rect x="9" y="9" width="12" height="11" rx="2.5" fill="#c4c0b8" fill-opacity="0.7"/>',
    "swipe": '<path d="M6.5 5H12v14H6.5A2.5 2.5 0 0 1 4 16.5v-9A2.5 2.5 0 0 1 6.5 5Z" fill="#8a8780"/><path d="M12 5h5.5A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5H12Z" fill="#c4c0b8"/><rect x="11" y="2" width="2" height="20" rx="1" fill="#5f5c57"/>',
    "inline": '<rect x="8" y="3.5" width="13" height="2.5" rx="1.25" fill="#8a8780" fill-opacity="0.35"/><circle cx="4.5" cy="10" r="1.75" fill="#8a8780"/><rect x="8" y="8.75" width="13" height="2.5" rx="1.25" fill="#8a8780"/><circle cx="4.5" cy="15" r="1.75" fill="#c4c0b8"/><rect x="8" y="13.75" width="10" height="2.5" rx="1.25" fill="#c4c0b8"/><rect x="8" y="18.75" width="11" height="2.5" rx="1.25" fill="#8a8780" fill-opacity="0.35"/>',
}

class S:
    def __init__(s): s.o = []; s.defs = []
    def add(s, x): s.o.append(x)
    def rect(s, x, y, w, h, fill="none", stroke="none", rx=0, sw=1, op=None, extra=""):
        o = f' opacity="{op}"' if op else ""
        s.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{o}{extra}/>')
    def line(s, x1, y1, x2, y2, stroke=EDGE, sw=1, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        s.add(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" stroke-width="{sw}"{d}/>')
    def circle(s, x, y, r, fill="none", stroke="none", sw=1, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        s.add(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')
    def text(s, x, y, t, size=13, fill=INK, weight=400, anchor="start", italic=False, mono=False, ls=None):
        a = ' font-style="italic"' if italic else ""
        if mono: a += f' font-family="{MONO}" xml:space="preserve"'
        if ls: a += f' letter-spacing="{ls}"'
        s.add(f'<text x="{x}" y="{y}" font-size="{size}" fill="{fill}" font-weight="{weight}" text-anchor="{anchor}"{a}>{html.escape(t)}</text>')
    def path(s, d, stroke=INK, fill="none", sw=1.2, dash=None):
        da = f' stroke-dasharray="{dash}"' if dash else ""
        s.add(f'<path d="{d}" stroke="{stroke}" fill="{fill}" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round"{da}/>')
    def icon(s, name, x, y, size=16, stroke=SECOND, sw=1.75):
        k = size / 24
        s.add(f'<g transform="translate({x},{y}) scale({k:.4f})" fill="none" stroke="{stroke}" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round">'
              + "".join(f'<path d="{d}"/>' for d in LUCIDE[name]) + "</g>")
    def mode(s, name, x, y, size=16):
        s.add(f'<g transform="translate({x},{y}) scale({size / 24:.4f})">{MODE[name]}</g>')
    def out(s):
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="{SANS}">'
                f'<defs>{"".join(s.defs)}</defs>' + "".join(s.o) + "</svg>")

def tw(t, size, mono=False): return len(t) * size * (0.6 if mono else 0.55)
def fit(t, width, size):
    if tw(t, size) <= width: return t
    return t[: max(1, int(width / (size * 0.55)) - 1)].rstrip() + "…"

def marker(s, n, x, y):
    s.circle(x, y, 10, fill=NOTE, stroke="#fff", sw=1.5)
    s.text(x, y + 4, str(n), 11.5, "#fff", 700, "middle")

# ------------------------------------------------------------------ the frame
CARD_X, CARD_Y, CARD_R, TREE_R = 214, 46, 1313, 414
HIST_X = 1320

def app(s, pill):
    """Ground, the workspace list, the bar with its version unit, the card."""
    s.rect(0, 0, W, H, fill="#f7f5f0")
    s.rect(0, 0, W, APP_H, fill=GROUND)
    s.text(17, 22, "GAIOS", 10, MUTED, 700, ls="0.8")
    s.icon("plus", 181, 10, 15, MUTED)
    s.text(17, 52, "Yesterday", 11, MUTED)
    s.text(17, 80, "Vibe modeling", 13.5)
    s.rect(10, 94, 193, 32, fill=SURFACE, rx=6)
    s.text(17, 115, "pushwork", 13.5, INK, 700)
    s.text(17, 150, "This month", 11, MUTED)
    s.text(17, 178, "Mon 3:39 PM", 13.5)
    s.text(17, 212, "pushwork", 13.5)
    s.text(17, 246, "hospital-capacity-model", 13.5)
    s.text(17, 940, "Packages", 12.5, SECOND); s.text(86, 940, "Account", 12.5, SECOND)
    # the bar
    s.rect(214, 7, 26, 26, fill=PRESSED, rx=6); s.icon("panel", 219, 12, 16, INK)
    s.text(247, 25, "pushwork", 14, INK, 700)
    x = 330
    cx = x + 12
    parts = []
    for item in pill:
        kind = item[0]
        if kind == "version":
            _, name, color = item
            w = (12 if color else 0) + tw(name, 13) + 20
            parts.append((item, cx, w)); cx += w + 6
        elif kind == "swap": parts.append((item, cx, 16)); cx += 24
        elif kind == "sep": parts.append((item, cx, 1)); cx += 13
        elif kind == "x": parts.append((item, cx, 14)); cx += 16
        else:
            w = tw(item[1], 12.5); parts.append((item, cx, w)); cx += w + 14
    s.rect(x, 4, cx - x + 4, 32, fill=SURFACE, rx=8)
    for item, px, w in parts:
        kind = item[0]
        if kind == "version":
            _, name, color = item
            tx = px
            if color: s.circle(px + 4, 20, 4, fill=color); tx += 12
            s.text(tx, 24.5, name, 13)
            s.icon("down", tx + tw(name, 13) + 4, 14, 12, MUTED)
        elif kind == "swap": s.icon("swap", px, 12, 15, MUTED)
        elif kind == "sep": s.line(px, 4, px, 36, EDGE)
        elif kind == "x": s.icon("x", px, 13, 14, MUTED)
        elif kind == "muted": s.text(px, 24.5, item[1], 12.5, MUTED)
        else: s.text(px, 24.5, item[1], 12.5)
    end = cx + 4
    s.rect(1533, 7, 28, 26, fill=PRESSED, rx=6); s.icon("clock", 1539, 12, 16, INK)
    s.icon("comment", 1573, 12, 16, SECOND)
    # the card
    s.rect(CARD_X, CARD_Y, CARD_R - CARD_X, APP_H - CARD_Y - 6, fill=SURFACE, rx=8)
    s.path(f"M{CARD_X + 8},{CARD_Y} H{TREE_R} V{APP_H - 6} H{CARD_X + 8} a8,8 0 0 1 -8,-8 V{CARD_Y + 8} a8,8 0 0 1 8,-8 z", stroke="none", fill=FIELD)
    s.line(TREE_R, CARD_Y, TREE_R, APP_H - 6)
    return end

def dots(s, x, y, colors):
    for i, c in enumerate(reversed(colors)):
        s.circle(x - i * 9, y, 3.2, fill=c)

def tree(s, items):
    y = 74
    for it in items:
        ind = it.get("indent", 0)
        x = 228 + ind * 14
        if it.get("selected"): s.rect(CARD_X + 4, y - 21, TREE_R - CARD_X - 8, 31, fill=HOVER, rx=6)
        color = FAINT if it.get("dim") else INK
        if "folder" in it:
            s.icon("down" if it["folder"] == "open" else "right", x - 3, y - 12, 13, FAINT if it.get("dim") else MUTED); x += 15
        s.text(x, y, fit(it["label"], TREE_R - x - (34 if it.get("marks") else 10), 13.5), 13.5, color, 700 if it.get("bold") else 400)
        if it.get("marks"): dots(s, TREE_R - 14, y - 5, it["marks"])
        y += 33

def tabs(s, items, left=TREE_R, right=CARD_R, actions=None):
    s.line(left, 76, right, 76)
    x = left + 6
    for t in items:
        label = t["label"]
        w = tw(label, 12.5) + 20 + (20 if t.get("folder") else 0) + (20 if not t.get("pinned") else 0)
        tx = x + 10
        if t.get("folder"): s.icon("folder", tx, 54, 14, INK if t.get("active") else MUTED); tx += 20
        s.text(tx, 65.5, label, 12.5, INK if t.get("active") else SECOND, 400)
        if not t.get("pinned"): s.icon("x", x + w - 20, 55, 12, INK if t.get("active") else MUTED)
        if t.get("active"): s.line(x, 75.5, x + w, 75.5, INK, 2)
        t["x"], t["w"] = x, w
        x += w + 2
    if actions == "file":
        s.text(right - 30, 65.5, "File", 12, SECOND, 400, "end"); s.icon("down", right - 27, 55, 12, MUTED)
    return items

def history(s, rows, lanes=1):
    """rows: (lane, label, when, kind) with kind in head / entry / fork / shared / selected."""
    s.text(HIST_X + 7, 64, "History", 12.5, INK, 700)
    lx = [HIST_X + 18, HIST_X + 34]
    tx = HIST_X + (58 if lanes == 2 else 42)
    y0, step = 96, 30
    ys = [y0 + i * step for i in range(len(rows))]
    col = {0: rows[0][4] if len(rows[0]) > 4 else INK}
    colors = [r[4] if len(r) > 4 else INK for r in rows]
    fork = next((i for i, r in enumerate(rows) if r[3] == "fork"), None)
    # lane lines
    for lane in range(lanes):
        mine = [i for i, r in enumerate(rows) if r[0] == lane and r[3] in ("head", "entry", "selected")]
        if not mine: continue
        c = colors[mine[0]]
        head, first = mine[0], (mine[1] if len(mine) > 1 else mine[0])
        end = fork if fork is not None else len(rows) - 1
        s.line(lx[lane], ys[head] - 4, lx[lane], ys[first] - 4, c, 1.6, "2 3")
        if lane == 0 or fork is None:
            s.line(lx[lane], ys[first] - 4, lx[lane], ys[end] - 4, c, 1.8)
        else:
            last = mine[-1]
            s.line(lx[lane], ys[first] - 4, lx[lane], ys[fork] - 4 - 18, c, 1.8)
            s.path(f"M{lx[lane]},{ys[fork] - 22} C{lx[lane]},{ys[fork] - 8} {lx[0] + 4},{ys[fork] - 4} {lx[0]},{ys[fork] - 4}", stroke=c, sw=1.8)
    if fork is not None and fork < len(rows) - 1:
        s.line(lx[0], ys[fork] - 4, lx[0], ys[-1] - 4, MUTED, 1.8)
    for i, r in enumerate(rows):
        lane, label, when, kind = r[:4]
        c = colors[i]
        y = ys[i]
        if kind == "selected": s.rect(HIST_X + 2, y - 20, W - HIST_X - 8, 30, fill=PRESSED, rx=6)
        if kind == "head": s.circle(lx[lane], y - 4, 5, fill=GROUND, stroke=c, sw=1.5, dash="2.4 2.2")
        elif kind == "fork": s.circle(lx[0], y - 4, 4.2, fill=SECOND)
        elif kind == "shared": s.circle(lx[0], y - 4, 3, fill=MUTED)
        else: s.circle(lx[lane], y - 4, 3.4, fill=c)
        room = (1564 - tx - (34 if kind == "fork" else 0)) * (0.88 if kind == "selected" else 1)
        s.text(tx, y, fit(label, room, 12), 12, MUTED if kind == "shared" else INK, 700 if kind == "selected" else 400)
        if kind == "fork": s.text(1560, y, "fork", 10.5, SECOND, 700, "end")
        s.text(1592, y, when, 10.5, MUTED, 400, "end")

def notes(s, items):
    colw = (W - 48) / len(items)
    for i, (n, t) in enumerate(items):
        x = 24 + i * colw
        marker(s, n, x + 10, APP_H + 30)
        for j, ln in enumerate(textwrap.wrap(t, int((colw - 60) / 6.3))):
            s.text(x + 30, APP_H + 34 + j * 18, ln, 13, INK)

# ------------------------------------------------------------------ pieces of the folder tab
def code(s, x, right, y, rows, gutter=34, size=12.5, step=20):
    """rows: (number, text, kind). kind: None, ours, theirs, added, modified, fold, gap."""
    fills = {"ours": (OURS_FILL, OURS), "theirs": (THEIRS_FILL, THEIRS), "added": ("#e5f3e8", ADDED), "modified": ("#fbf2d6", MODIFIED)}
    for number, textline, kind in rows:
        if kind == "fold":
            s.rect(x, y, right - x, step, fill="#f4f2ec")
            s.icon("fold", x + gutter + 6, y + 3.5, 13, MUTED)
            s.text(x + gutter + 26, y + 14, textline, 11, MUTED)
            y += step; continue
        if kind == "gap":
            s.rect(x, y, right - x, step, fill="#f7f6f2")
            y += step; continue
        if kind in fills:
            fill, edge = fills[kind]
            s.rect(x, y, right - x, step, fill=fill); s.rect(x, y, 3, step, fill=edge)
        if number: s.text(x + gutter - 8, y + 14, str(number), 10, FAINT, 400, "end", mono=True)
        comment = textline.lstrip().startswith("#") or textline.lstrip().startswith('"""')
        if "#" in textline and not comment:
            head, tail = textline.split("#", 1)
            s.text(x + gutter + 6, y + 14.5, head, size, INK, mono=True)
            s.text(x + gutter + 6 + tw(head, size, True), y + 14.5, "#" + tail, size, MUTED, italic=True, mono=True)
        else:
            s.text(x + gutter + 6, y + 14.5, textline, size, MUTED if comment else INK, italic=comment, mono=True)
        y += step
    return y

def section(s, y, name, path, mode=None, fold=None, open_=True, left=TREE_R, right=CARD_R, mark=None):
    """A changed document's header in the review: fold it, its compare controls, open it."""
    s.rect(left + 0.5, y, right - left - 0.5, 34, fill=FIELD)
    s.line(left, y, right, y); s.line(left, y + 34, right, y + 34)
    s.icon("down" if open_ else "right", left + 10, y + 10, 14, SECOND)
    s.text(left + 32, y + 22, name, 13, INK, 700)
    if path: s.text(left + 40 + tw(name, 13) * 1.08, y + 22, path, 12, MUTED)
    x = right - 12
    s.icon("open", x - 16, y + 9, 16, SECOND); x -= 30
    spots = {"open": x + 22}
    if fold is not None:
        if fold: s.rect(x - 22, y + 5, 24, 24, fill=PRESSED, rx=5)
        s.icon("fold", x - 18, y + 9, 16, INK if fold else SECOND); spots["fold"] = x - 10; x -= 30
    if mode:
        s.mode(mode, x - 32, y + 9, 16); s.icon("down", x - 14, y + 11, 12, MUTED); spots["mode"] = x - 20
    return spots

def menu(s, x, y, items):
    """The compare picker's menu, open: (mode id, name, checked)."""
    w, h = 176, len(items) * 30 + 10
    s.rect(x + 1, y + 3, w, h, fill="#000", rx=8, op="0.08")
    s.rect(x, y, w, h, fill=SURFACE, stroke=EDGE, rx=8)
    for i, (mode, name, checked) in enumerate(items):
        iy = y + 5 + i * 30
        if checked: s.icon("check", x + 10, iy + 8, 14, INK)
        s.mode(mode, x + 32, iy + 7, 16)
        s.text(x + 56, iy + 20, name, 12.5)

def listing(s, left, right, rows, time_x=None):
    """A folder's own entries: name, when it was last edited, and whether this version changed it."""
    x0, x1 = left + 24, right - 24
    tx = time_x or x1 - 26
    s.text(x0 + 30, 104, "Name", 11, MUTED, 400)
    s.text(tx, 104, "Last edited", 11, MUTED, 400, "end")
    y = 116
    s.line(x0, y, x1, y)
    for r in rows:
        cy = y + 18
        s.icon("folder" if r.get("folder") else "file", x0 + 4, cy - 8, 15, SECOND if r.get("folder") else MUTED, 1.6)
        s.text(x0 + 30, cy + 4.5, r["name"], 13.5, INK, 400)
        s.text(tx, cy + 4.5, r["when"], 12, MUTED, 400, "end")
        if r.get("mark"): s.circle(x1 - 6, cy, 3.2, fill=r["mark"])
        y += 36
        s.line(x0, y, x1, y, "#eeece6")
    return y

def chart(s, x, y, w, h, heights, title, clip=None, line=None):
    g = f' clip-path="url(#{clip})"' if clip else ""
    s.add(f"<g{g}>")
    s.rect(x, y, w, h, fill="#ffffff")
    s.text(x + 16, y + 24, title, 12.5, INK, 700)
    bx, by, bw, bh = x + 44, y + 40, w - 64, h - 72
    for i in range(5):
        gy = by + bh - i * bh / 4
        s.line(bx, gy, bx + bw, gy, "#ebe8e1")
        s.text(bx - 8, gy + 3.5, str(i * 20), 9.5, MUTED, 400, "end")
    n = len(heights); step = bw / n
    for i, v in enumerate(heights):
        s.rect(round(bx + i * step + 3, 1), round(by + bh - v / 80 * bh, 1), round(step - 6, 1), round(v / 80 * bh, 1), fill="#9fb4cf", rx=1.5)
        if i % 2 == 0: s.text(round(bx + i * step + step / 2, 1), by + bh + 15, f"{6 + i}:00", 9, MUTED, 400, "middle")
    if line:
        pts = " ".join(f"{round(bx + i * step + step / 2, 1)},{round(by + bh - v / 80 * bh, 1)}" for i, v in enumerate(line))
        s.add(f'<polyline points="{pts}" fill="none" stroke="#d98a3b" stroke-width="1.8"/>')
    s.add("</g>")

TREE_COMPARING = [
    dict(label="pushwork", bold=True, selected=True, marks=(OURS, THEIRS)),
    dict(label=".gitignore", indent=1, dim=True), dict(label=".pushworkattributes", indent=1, dim=True),
    dict(label=".pushworkignore", indent=1, dim=True), dict(label="pyproject.toml", indent=1, dim=True),
    dict(label="data", indent=1, folder="closed", dim=True),
    dict(label="config.yaml", indent=1, marks=(OURS, THEIRS)), dict(label="analysis.py", indent=1, marks=(OURS, THEIRS)),
    dict(label="make_figures.py", indent=1, dim=True),
    dict(label="figures", indent=1, folder="open", marks=(OURS, THEIRS)),
    dict(label="beds_in_ed.png", indent=3, dim=True), dict(label="beds_total.png", indent=3, marks=(OURS, THEIRS)),
    dict(label="beds_yet_to_arrive.png", indent=3, dim=True),
    dict(label="notebooks", indent=1, folder="closed", marks=(OURS, THEIRS)),
]

def plain_tree(marks, color):
    names = [(".gitignore", None), (".pushworkattributes", None), (".pushworkignore", None), ("pyproject.toml", None), ("data", "closed"),
             ("config.yaml", None), ("analysis.py", None), ("make_figures.py", None), ("figures", "closed"), ("notebooks", "closed")]
    out = [dict(label="pushwork", bold=True, selected=True, marks=(color,) if marks else None)]
    for name, folder in names:
        row = dict(label=name, indent=1)
        if folder: row["folder"] = folder
        if name in marks: row["marks"] = (color,)
        out.append(row)
    return out

def rows_of(when, marks, color):
    names = [("data", True), ("figures", True), ("notebooks", True), (".gitignore", False), (".pushworkattributes", False), (".pushworkignore", False),
             ("analysis.py", False), ("config.yaml", False), ("make_figures.py", False), ("pyproject.toml", False)]
    return [dict(name=n, folder=f, when=when[n], mark=color if n in marks else None) for n, f in names]

# ------------------------------------------------------------------ 1: comparing
def review():
    s = S()
    end = app(s, [("version", "Main", OURS), ("swap",), ("version", "explore/july-calibration", THEIRS), ("x",)])
    # every panel's mode, beside the unit: several are in use, so it names none
    s.text(end + 14, 24.5, "Mode", 12.5, SECOND); s.icon("down", end + 14 + tw("Mode", 12.5) + 5, 14, 12, MUTED)
    marker(s, 1, end + 14 + tw("Mode", 12.5) + 32, 20)
    tree(s, TREE_COMPARING)
    tabs(s, [dict(label="pushwork", folder=True, active=True), dict(label="config.yaml")])
    L, R = TREE_R, CARD_R
    # config.yaml: combined, what's unchanged folded away
    spots = section(s, 76, "config.yaml", "", mode="inline", fold=True)
    marker(s, 2, spots["mode"] - 22, 76)
    y = code(s, L, R, 110, [
        (None, "20 unchanged lines", "fold"),
        (21, "modelling_dates:", None),
        (22, "  - 2031-03-01 # start training set", None),
        (23, "  - 2031-08-01 # start calibration set", "ours"),
        (None, "  - 2031-07-01 # start calibration set", "theirs"),
        (24, "  - 2031-09-01 # start validation set", None),
        (25, "  - 2031-10-01 # start test set", None),
        (None, "14 unchanged lines", "fold"),
        (40, "# Target proportion of patients admitted by time x1.", None),
        (41, "y1: .80", "ours"),
        (None, "y1: .70", "theirs"),
        (None, "22 unchanged lines", "fold"),
    ])
    # analysis.py: side by side, its picker open
    spots2 = section(s, y, "analysis.py", "", mode="side-by-side", fold=False)
    y2 = y + 34
    mid = (L + R) // 2
    for x, name, color in ((L, "Main", OURS), (mid, "explore/july-calibration", THEIRS)):
        s.circle(x + 16, y2 + 13, 3.5, fill=color); s.text(x + 26, y2 + 17, name, 12, SECOND)
    s.line(L, y2 + 26, R, y2 + 26)
    left = [(14, "def calibration_window(dates):", None), (15, '    """Dates the calibration set spans."""', None),
            (16, "    start, end = dates[1], dates[2]", None), (None, "", "gap"), (None, "", "gap"),
            (17, "    return start, end", "modified"), (18, "", None), (19, "def load_config(path):", None), (20, "    with open(path) as f:", None)]
    right = [(14, "def calibration_window(dates):", None), (15, '    """Dates the calibration set spans."""', None),
             (16, "    start, end = dates[1], dates[2]", None), (17, "    if end <= start:", "added"), (18, '        raise ValueError("empty window")', "added"),
             (19, "    return start, end - timedelta(days=1)", "modified"), (20, "", None), (21, "def load_config(path):", None), (22, "    with open(path) as f:", None)]
    y3 = code(s, L, mid, y2 + 26, left)
    code(s, mid, R, y2 + 26, right)
    s.line(mid, y2, mid, y3)
    # beds_total.png: swipe
    spots3 = section(s, y3, "beds_total.png", "figures/", mode="swipe")
    cy, ch = y3 + 34, 266
    cx, cw = L + 24, 600
    s.rect(L + 0.5, cy, R - L - 0.5, ch + 24, fill="#f7f6f2")
    at = cx + cw * 0.56
    s.defs.append(f'<clipPath id="swipe-a"><rect x="{cx}" y="{cy + 12}" width="{at - cx}" height="{ch}"/></clipPath>')
    s.defs.append(f'<clipPath id="swipe-b"><rect x="{at}" y="{cy + 12}" width="{cx + cw - at}" height="{ch}"/></clipPath>')
    a = [22, 30, 41, 55, 62, 58, 66, 71, 64, 52, 47, 38, 31, 26]
    b = [20, 27, 36, 49, 60, 63, 70, 76, 73, 61, 50, 42, 33, 24]
    chart(s, cx, cy + 12, cw, ch, a, "Total beds occupied", "swipe-a")
    chart(s, cx, cy + 12, cw, ch, b, "Total beds occupied, calibrated from July", "swipe-b", line=[24, 30, 40, 52, 62, 66, 72, 77, 74, 63, 52, 44, 35, 27])
    s.rect(cx, cy + 12, cw, ch, stroke=EDGE)
    s.line(at, cy + 12, at, cy + 12 + ch, INK, 2)
    s.rect(at - 5, cy + 12 + ch / 2 - 14, 10, 28, fill=INK, rx=5)
    marker(s, 4, at, cy + 12)
    # the last one, folded away
    y4 = cy + ch + 24
    section(s, y4, "patientflow_sample_analysis.ipynb", "notebooks/", open_=False, mode="side-by-side")
    marker(s, 5, L + 17, y4)
    # the open picker, over what's beneath it
    mx = spots2["mode"] - 150
    menu(s, mx, y + 36, [("side-by-side", "Side by side", True), ("stacked", "Stacked", False), ("inline", "Combined", False)])
    marker(s, 3, mx + 176, y + 36)
    history(s, [(0, "Main", "now", "head", OURS), (1, "explore/july-calibration", "now", "head", THEIRS),
                (0, "beds_in_ed.png", "18h", "entry", OURS), (0, "config.yaml", "19h", "entry", OURS),
                (0, "patientflow_sample_analysis.ipynb", "22h", "entry", OURS), (0, "analysis.py", "1d", "entry", OURS),
                (1, "analysis.py", "3d", "entry", THEIRS), (0, "config.yaml", "4d", "entry", OURS),
                (1, "beds_total.png, patientflow_sample_ana…", "5d", "entry", THEIRS), (0, "analysis.py", "6d", "entry", OURS),
                (0, "config.yaml", "7d", "entry", OURS), (1, "config.yaml", "10d", "entry", THEIRS),
                (0, "beds_total.png, Untitled Notebook +3", "11d", "fork", SECOND),
                (0, "config.yaml", "14d", "shared", MUTED), (0, "config.yaml, .pushworkattributes +3", "15d", "shared", MUTED)], lanes=2)
    notes(s, [(1, "The bar's picker still sets the mode for every document at once, in every pane. With several modes in use it names none."),
              (2, "Each document's header has the controls its own tab has today: its compare mode, folding away what's unchanged, and opening it in a tab."),
              (3, "The picker offers only the modes that document's view takes: text has Combined, images have Onion skin and Swipe."),
              (4, "A mode's own controls stay where they are now: Swipe's divider in the view, Onion skin's slider up in the bar."),
              (5, "The arrow folds a whole document away. Only documents that differ are listed; the tree dims the rest.")])
    return s.out()

# ------------------------------------------------------------------ 2: not comparing
def files():
    s = S()
    end = app(s, [("version", "explore/july-calibration", THEIRS)])
    marker(s, 3, end + 14, 20)
    changed = {"config.yaml", "analysis.py", "figures", "notebooks"}
    tree(s, plain_tree(changed, THEIRS))
    t = tabs(s, [dict(label="pushwork", folder=True, active=True), dict(label="analysis.py")])
    marker(s, 1, t[0]["x"] + t[0]["w"] + 2, 48)
    when = {"data": "15d", "figures": "5d", "notebooks": "5d", ".gitignore": "15d", ".pushworkattributes": "15d", ".pushworkignore": "15d",
            "analysis.py": "3d", "config.yaml": "10d", "make_figures.py": "14d", "pyproject.toml": "15d"}
    listing(s, TREE_R, CARD_R, rows_of(when, changed, THEIRS))
    marker(s, 2, CARD_R - 30, 116 + 36 + 18 - 16)
    history(s, [(0, "Working copy", "now", "head", THEIRS), (0, "analysis.py", "3d", "entry", THEIRS),
                (0, "beds_total.png, patientflow_sample_analysis.ipynb", "5d", "entry", THEIRS), (0, "config.yaml", "10d", "entry", THEIRS),
                (0, "beds_total.png, Untitled Notebook +3", "11d", "fork", SECOND),
                (0, "config.yaml", "14d", "shared", MUTED), (0, "config.yaml, .pushworkattributes +3", "15d", "shared", MUTED)])
    notes(s, [(1, "A folder opens in a tab like a file: the project from the tree's top row, any other folder from its own. With nothing else open, this is what the main pane shows."),
              (2, "Just the folder's own entries, folders first. A dot means this draft changed it, or something inside it, the same mark the tree uses. On Main there are no dots."),
              (3, "No statistics, nothing sorted or hidden. Comparing this draft with Main turns the tab into the list of changed documents.")])
    return s.out()

# ------------------------------------------------------------------ 3: a version from history, two panes
def version():
    s = S()
    app(s, [("version", "Main", None), ("sep",), ("text", "beds_total.png, patientflow_sample_analysis.ipynb +3"), ("muted", "read-only"), ("x",)])
    changed = {"analysis.py", "figures", "notebooks"}
    tree(s, plain_tree(changed, INK))
    mid = 800
    tabs(s, [dict(label="pushwork", folder=True, active=True)], TREE_R, mid)
    tabs(s, [dict(label="analysis.py", active=True), dict(label="config.yaml")], mid, CARD_R, actions="file")
    s.line(mid, CARD_Y, mid, APP_H - 6)
    when = {"data": "15d", "figures": "7d", "notebooks": "7d", ".gitignore": "15d", ".pushworkattributes": "15d", ".pushworkignore": "15d",
            "analysis.py": "7d", "config.yaml": "7d", "make_figures.py": "9d", "pyproject.toml": "15d"}
    listing(s, TREE_R, mid, rows_of(when, changed, INK))
    marker(s, 1, mid - 30, 116 + 36 + 18 - 16)
    ry = 116 + 6 * 36 + 18
    s.path(f"M{TREE_R + 150},{ry} C{TREE_R + 260},{ry - 30} {mid - 80},300 {mid - 14},300", stroke=NOTE, sw=1.4)
    marker(s, 2, mid, 300)
    src = '''import yaml
from datetime import timedelta

from patientflow.load import load_config_file
from patientflow.prepare import create_temporal_splits


def calibration_window(dates):
    """Dates the calibration set spans."""
    start, end = dates[1], dates[2]
    return start, end


def load_config(path):
    with open(path) as f:
        return yaml.safe_load(f)


def split(visits, config):
    # Training, calibration, validation, test.
    dates = config["modelling_dates"]
    start, end = calibration_window(dates)
    train, valid, test = create_temporal_splits(
        visits,
        dates[0],
        dates[-3],
        dates[-2],
        dates[-1],
        col_name="arrival_datetime",
    )
    calibration = visits[
        (visits.arrival_datetime >= start)
        & (visits.arrival_datetime < end)
    ]
    return train, calibration, valid, test


def main():
    config = load_config("config.yaml")
    visits = load_config_file(config["data"])'''.split("\n")
    code(s, mid + 1, CARD_R, 84, [(i + 1, line, None) for i, line in enumerate(src)], size=12.5, step=21)
    hist = [(0, "Working copy", "now", "head", INK), (0, "beds_in_ed.png", "18h", "entry"), (0, "config.yaml", "19h", "entry"),
            (0, "patientflow_sample_analysis.ipynb", "22h", "entry"), (0, "analysis.py", "1d", "entry"),
            (0, "patientflow_sample_analysis.ipynb, beds_total.png", "4d", "entry"), (0, "config.yaml", "4d", "entry"),
            (0, "analysis.py", "6d", "entry"), (0, "beds_total.png, patientflow_sample_ana… +3", "7d", "selected"), (0, "config.yaml", "7d", "entry"),
            (0, "beds_total.png, patientflow_sample_ana… +1", "8d", "entry"), (0, "analysis.py", "8d", "entry"), (0, "analysis.py", "9d", "entry"),
            (0, "beds_yet_to_arrive.png, beds_total.png +2", "13d", "entry"), (0, "config.yaml", "14d", "entry"),
            (0, "config.yaml, .pushworkattributes +3", "15d", "entry")]
    history(s, hist)
    marker(s, 3, HIST_X + 7 + tw("History", 12.5) + 30, 60)
    notes(s, [(1, "Picking a version moves every pane to it. The folder lists its entries as they were then; a dot marks what that version changed. Nothing is ever left empty."),
              (2, "A row opens in the pane beside when there is one, so the list stays in view. With a single pane it opens as a tab in the same one."),
              (3, "History and comments cover what's visible in any pane. It only says so when that's less than the project, e.g. “History · figures”. Picking a second version compares the two.")])
    return s.out()

for name, fn in (("1-comparing", review), ("2-files", files), ("3-version-two-panes", version)):
    open(f"{OUT}/folder-tabs-{name}.svg", "w").write(fn())
    print(name)
