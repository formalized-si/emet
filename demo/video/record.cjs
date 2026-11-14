#!/usr/bin/env node
// Record the demo video from the live page. A headless Chromium is driven frame by frame, so the picture is the
// real page doing what script.json says: it scrolls, a pointer moves, the select changes, the button is pressed
// and the contract's answer arrives. One scene runs a command of this repository and shows what it printed.
//
// To run it (Node 20+, ffmpeg with libx264, and Playwright with its Chromium: `npx playwright install chromium`):
//
//   python3 -m http.server 8000 --bind 127.0.0.1 &          # in the repository root; or use the hosted page
//   demo/video/build.sh --url http://127.0.0.1:8000/demo/web/patches.html
//
//   node demo/video/record.cjs --url <page url> [--audio-dir <dir>] [--skip id,id] [--only hero] [--draft]
//        [--out docs/assets/demo.mp4] [--hero docs/assets/hero.png] [--sheet run-output/video/contact-sheet.png]
//        [--script demo/video/script.json] [--work run-output/video]
//
// It writes the video (1920x1080, H.264, captions burnt in, a silent sound track), the hero image and a sheet
// with one frame every two seconds. The video has no voice unless --audio-dir holds <scene id>.wav|m4a|mp3:
// a scene with such a file lasts as long as that recording, any other as long as its `seconds`.
//
// Nothing is written into the page sources: the pointer, the highlights, the captions, the title cards and the
// terminal pane are an overlay this script adds to the loaded page. The script points at the page by its words.
// When the page no longer has something a scene points at, or reads differently from what a scene `expect`s, no
// video is written and every such place is listed (--draft renders anyway, to look at). The hero image is
// written only if it shows what script.json says it must.
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const URL_ = arg('--url');
const SCRIPT = path.resolve(arg('--script', path.join(__dirname, 'script.json')));
const WORK = path.resolve(arg('--work', path.join(ROOT, 'run-output/video')));
const OUT = path.resolve(arg('--out', path.join(ROOT, 'docs/assets/demo.mp4')));
const HERO = path.resolve(arg('--hero', path.join(ROOT, 'docs/assets/hero.png')));
const SHEET = path.resolve(arg('--sheet', path.join(ROOT, 'run-output/video/contact-sheet.png')));
const AUDIO_DIR = arg('--audio-dir') && path.resolve(arg('--audio-dir'));
const SKIP = (arg('--skip', '') || '').split(',').filter(Boolean);
const ONLY = arg('--only');
if (!URL_) {
  console.error(
    'usage: node demo/video/record.cjs --url <page url> [--audio-dir <dir>] [--skip id,id] [--only hero] [--draft]',
  );
  process.exit(2);
}

const S = JSON.parse(fs.readFileSync(SCRIPT, 'utf8'));
const FPS = S.fps,
  VIEW = S.viewport,
  BAND = S.band,
  SEEN = VIEW.height - BAND; // SEEN: page height above the caption band
const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
const ffmpeg = (...args) => run('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
const seconds = (file) =>
  Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]));
const warnings = [];
const warn = (m) => {
  warnings.push(m);
  console.warn('  warning: ' + m);
};

// Playwright from this repository's node_modules or from the npx cache, and the Chromium it installed. When the
// cache holds a headless shell of another revision than this Playwright expects, that one is used.
function browserKit() {
  const under = (dir) =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .sort()
          .reverse()
          .map((d) => path.join(dir, d))
      : [];
  let pw = process.env.EMET_PLAYWRIGHT;
  if (!pw) {
    try {
      pw = require.resolve('playwright');
    } catch {
      pw = under(path.join(os.homedir(), '.npm/_npx'))
        .map((d) => path.join(d, 'node_modules/playwright'))
        .find((p) => fs.existsSync(p));
    }
  }
  if (!pw)
    throw Error(
      'the playwright package was not found: run `npx playwright install chromium` once, or set EMET_PLAYWRIGHT to its directory',
    );
  const { chromium } = require(pw);
  let exe = process.env.EMET_CHROMIUM;
  if (!exe && !fs.existsSync(chromium.executablePath())) {
    const cache =
      process.env.PLAYWRIGHT_BROWSERS_PATH ||
      path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
    exe = under(cache)
      .filter((d) => path.basename(d).startsWith('chromium_headless_shell-'))
      .flatMap(under)
      .flatMap((d) => ['chrome-headless-shell', 'headless_shell'].map((f) => path.join(d, f)))
      .find((p) => fs.existsSync(p));
    if (!exe)
      throw Error(
        'no Chromium was found: run `npx playwright install chromium`, or set EMET_CHROMIUM to a Chromium or Chrome binary',
      );
  }
  return { chromium, exe };
}

// ---- voice, if there is one ----------------------------------------------------------------------------------
// A recording per scene from --audio-dir, with the silence at both ends cut so that the scene starts on its first
// word. A scene without a recording is silent and lasts its `seconds`.
const TRIM =
  'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,areverse';
function voice() {
  const dir = path.join(WORK, 'audio'),
    length = {},
    file = {};
  for (const sc of S.scenes) {
    const given =
      AUDIO_DIR &&
      ['wav', 'm4a', 'mp3'].map((x) => path.join(AUDIO_DIR, `${sc.id}.${x}`)).find((p) => fs.existsSync(p));
    if (!given) {
      length[sc.id] = sc.seconds || 0;
      continue;
    }
    fs.mkdirSync(dir, { recursive: true });
    file[sc.id] = path.join(dir, `${sc.id}.wav`);
    ffmpeg('-i', given, '-af', TRIM, '-ar', '48000', '-ac', '2', file[sc.id]);
    length[sc.id] = seconds(file[sc.id]);
  }
  return { length, file };
}

// A command of this repository, run now: what it printed, line by line, with the second each line came at.
function capture(cmd) {
  return new Promise((resolve) => {
    const t0 = Date.now(),
      lines = [],
      child = spawn(cmd, { cwd: ROOT, shell: true, env: { ...process.env, PYTHONUNBUFFERED: '1' } }); // unbuffered, as on a terminal
    for (const stream of [child.stdout, child.stderr]) {
      let rest = '';
      const take = (text) => {
        const parts = (rest + text).split('\n');
        rest = parts.pop();
        for (const p of parts) lines.push([(Date.now() - t0) / 1000, p.replace(/\r$/, '')]);
      };
      stream.setEncoding('utf8');
      stream.on('data', take);
      stream.on('end', () => {
        if (rest) take('\n');
      });
    }
    child.on('close', (code) => resolve({ code, lines }));
  });
}

// ---- the overlay, in the page ------------------------------------------------------------------------------
// Built with DOM calls and style properties only, so it also works on a page with a strict content policy.
function overlay(cfg) {
  const C = cfg.colors,
    FONT = '"Inter Tight", Arial, sans-serif',
    MONO = '"IBM Plex Mono", ui-monospace, monospace';
  const u = cfg.width / 1088,
    px = (n) => Math.round(n * u * 10) / 10 + 'px',
    seen = cfg.height - cfg.band;
  const css = (e, s) => {
    Object.assign(e.style, s);
    return e;
  };
  const add = (tag, s, parent, text) => {
    const e = css(document.createElement(tag), s);
    if (text != null) e.textContent = text;
    parent.append(e);
    return e;
  };
  const root = css(document.createElement('div'), {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '100vw',
    height: '100vh',
    zIndex: '2147483647',
    pointerEvents: 'none',
    overflow: 'hidden',
    font: `${px(16)}/1.5 ${FONT}`,
    color: C.ink,
    textAlign: 'left',
    direction: 'ltr',
    letterSpacing: 'normal',
  });
  document.documentElement.append(root);
  document.body.style.paddingBottom = cfg.band + 'px';
  Element.prototype.scrollIntoView = () => {}; // the script is the camera: the page does not scroll itself while it is recorded
  const layer = { position: 'absolute', left: '0', top: '0', width: '100%', height: seen + 'px' };
  const marks = add('div', layer, root);
  const menu = add(
    'div',
    {
      position: 'absolute',
      display: 'none',
      background: '#1a1c18',
      border: `1px solid ${C.muted}`,
      borderRadius: '0',
      padding: '5px',
      boxShadow: '0 12px 32px rgba(0,0,0,.55)',
      boxSizing: 'border-box',
    },
    root,
  );
  const ripple = add(
    'div',
    {
      position: 'absolute',
      display: 'none',
      borderRadius: '50%',
      border: `2px solid ${C.accent}`,
      background: 'rgba(233,67,34,.2)',
      boxSizing: 'border-box',
    },
    root,
  );
  const NS = 'http://www.w3.org/2000/svg';
  const cursor = document.createElementNS(NS, 'svg');
  cursor.setAttribute('viewBox', '0 0 24 24');
  cursor.setAttribute('width', String(34 * u));
  cursor.setAttribute('height', String(34 * u));
  css(cursor, { position: 'absolute', left: '0', top: '0', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.7))' });
  const arrow = document.createElementNS(NS, 'path');
  arrow.setAttribute('d', 'M5 2.5v17l4.6-4.3 2.9 6.6 2.7-1.2-2.9-6.5h6.2z');
  arrow.setAttribute('fill', '#111');
  arrow.setAttribute('stroke', '#fff');
  arrow.setAttribute('stroke-width', '1.5');
  arrow.setAttribute('stroke-linejoin', 'round');
  cursor.append(arrow);
  root.append(cursor);
  // The terminal pane: the lines a command printed, as text. It reaches under the caption band, so that no row of
  // the page shows through where the two meet.
  const term = add('div', { ...layer, height: '100%', display: 'none', background: C.bg }, root);
  const termLine = 19.5 * u,
    termTop = 54 * u,
    termRoom = Math.floor((seen - termTop - 12 * u) / termLine) * termLine; // a whole number of lines, so that none is cut at the top
  const termHead = add(
    'div',
    {
      position: 'absolute',
      left: px(30),
      right: px(30),
      top: px(14),
      paddingBottom: px(9),
      borderBottom: `1px solid ${C.line}`,
      font: `500 ${px(14)}/${termLine}px ${MONO}`,
      color: C.ink,
    },
    term,
  );
  const termView = add(
    'div',
    {
      position: 'absolute',
      left: px(30),
      right: px(30),
      top: seen - 12 * u - termRoom + 'px',
      height: termRoom + 'px',
      overflow: 'hidden',
      font: `${px(13)}/${termLine}px ${MONO}`,
      color: C.ink,
    },
    term,
  );
  const termBody = add('div', {}, termView);
  const termSpeed = add(
    'div',
    {
      position: 'absolute',
      right: px(30),
      top: px(11),
      padding: `${px(2)} ${px(10)}`,
      borderRadius: '0',
      background: C.accent,
      font: `600 ${px(13)}/1.6 ${FONT}`,
      color: '#fff',
    },
    term,
  );
  let termRows = [],
    termShown = '';
  const band = add(
    'div',
    {
      position: 'absolute',
      left: '0',
      right: '0',
      bottom: '0',
      height: cfg.band + 'px',
      background: '#0b0c0e',
      borderTop: `1px solid ${C.line}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxSizing: 'border-box',
    },
    root,
  );
  const caption = add(
    'div',
    {
      font: `600 ${Math.round(cfg.band * 0.278)}px/1.27 ${FONT}`,
      color: '#fff',
      textAlign: 'center',
      whiteSpace: 'pre-line',
      letterSpacing: '-0.012em',
      padding: `0 ${px(60)}`,
    },
    band,
  );
  // Title cards fill the frame, over the band: their own text is what the scene says.
  const cards = {};
  for (const [name, c] of Object.entries(cfg.cards || {})) {
    const card = (cards[name] = add(
      'div',
      {
        position: 'absolute',
        left: '0',
        top: '0',
        width: '100%',
        height: '100%',
        background: C.bg,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: `0 ${px(96)}`,
        boxSizing: 'border-box',
        opacity: '0',
      },
      root,
    ));
    const brand = add('div', { font: `600 ${px(28)}/1.2 ${FONT}`, marginBottom: px(12) }, card, c.brand[0]);
    add('span', { font: `400 ${px(16)}/1.2 ${FONT}`, color: C.muted, marginLeft: px(11) }, brand, c.brand[1]);
    if (c.line)
      add(
        'div',
        { font: `${px(12.5)}/1.5 ${MONO}`, letterSpacing: '.08em', color: C.muted, marginBottom: px(20) },
        card,
        c.line,
      );
    let size = c.size || 92;
    const title = add(
      'div',
      { font: `500 ${px(size)}/1.02 ${FONT}`, letterSpacing: '-.05em', whiteSpace: 'nowrap' },
      card,
    );
    for (const [text, tone] of c.lines) add('div', { color: C[tone] || C.ink }, title, text);
    while (title.scrollWidth > title.clientWidth && size > 28) title.style.fontSize = px(--size); // a line too long for the frame is set smaller
    for (const [label, value] of c.rows || []) {
      add(
        'div',
        {
          font: `${px(13)}/1.5 ${MONO}`,
          letterSpacing: '.08em',
          color: C.muted,
          textTransform: 'uppercase',
          marginTop: px(label === c.rows[0][0] ? 40 : 14),
        },
        card,
        label,
      );
      add('div', { font: `${px(27)}/1.35 ${MONO}`, color: C.ink }, card, value);
    }
  }

  // A target is {sel, nth?, has?, child?} for an element, plus one of text / from / line / tight for the text in it.
  function element(t) {
    const want = t.has || t.text || t.from || t.line;
    let found = [...document.querySelectorAll(t.sel)];
    if (want) found = found.filter((e) => e.textContent.includes(want));
    const e = found[t.nth || 0];
    return e && t.child ? e.querySelector(t.child) : e;
  }
  // The boxes of a target: the element's own box, or one box per line of the wanted text (or one around them all).
  function lines(t) {
    const e = element(t);
    if (!e || !e.getClientRects().length) return [];
    if (!(t.text || t.from || t.line || t.tight)) {
      const b = e.getBoundingClientRect();
      return [{ x: b.left, y: b.top, w: b.width, h: b.height }];
    }
    const nodes = [],
      walk = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    let all = '';
    for (let n; (n = walk.nextNode()); ) {
      nodes.push([n, all.length]);
      all += n.data;
    }
    let i = 0,
      j = all.length;
    if (!t.tight) {
      i = all.indexOf(t.text || t.from || t.line);
      if (i < 0) return [];
      if (t.text) j = i + t.text.length;
      if (t.line) {
        j = all.indexOf('\n', i);
        if (j < 0) j = all.length;
        i = all.lastIndexOf('\n', i) + 1;
        while (all[i] === ' ') i++;
      }
    }
    const out = [],
      range = document.createRange();
    for (const [n, at] of nodes) {
      const a = Math.max(i, at) - at,
        b = Math.min(j, at + n.data.length) - at;
      if (b <= a) continue;
      range.setStart(n, a);
      range.setEnd(n, b);
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        const row = out.find((o) => Math.min(o.y + o.h, r.bottom) - Math.max(o.y, r.top) > Math.min(o.h, r.height) / 2);
        if (!row) {
          out.push({ x: r.left, y: r.top, w: r.width, h: r.height });
          continue;
        }
        const x2 = Math.max(row.x + row.w, r.right),
          y2 = Math.max(row.y + row.h, r.bottom);
        row.x = Math.min(row.x, r.left);
        row.y = Math.min(row.y, r.top);
        row.w = x2 - row.x;
        row.h = y2 - row.y;
      }
    }
    if (!t.box || !out.length) return out;
    const x = Math.min(...out.map((o) => o.x)),
      y = Math.min(...out.map((o) => o.y));
    return [{ x, y, w: Math.max(...out.map((o) => o.x + o.w)) - x, h: Math.max(...out.map((o) => o.y + o.h)) - y }];
  }
  let options = [],
    shown = null;
  window.__rec = {
    // The target's box in the viewport, with the end of its last line.
    rect(t) {
      const ls = lines(t);
      if (!ls.length) return null;
      const x = Math.min(...ls.map((o) => o.x)),
        y = Math.min(...ls.map((o) => o.y)),
        last = ls[ls.length - 1];
      return {
        x,
        y,
        w: Math.max(...ls.map((o) => o.x + o.w)) - x,
        h: Math.max(...ls.map((o) => o.y + o.h)) - y,
        end: [last.x + last.w, last.y + last.h],
        scrollY: window.scrollY,
      };
    },
    // The scroll offset nearest to y at which neither the top of the frame nor the caption band cuts through a line
    // of text or a control.
    clean(y) {
      const solid = [],
        walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT),
        range = document.createRange();
      const keep = (r, ink = 0) => {
        if (r.height > 4 && r.width > 1) solid.push([r.top + window.scrollY + ink, r.bottom + window.scrollY + ink]);
      };
      // checkVisibility: text in a closed <details> has boxes although nothing of it is drawn
      for (let n; (n = walk.nextNode()); ) {
        if (!n.data.trim() || root.contains(n) || !n.parentElement.checkVisibility()) continue;
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) keep(r, 2);
      } // 2: the top of a text box is empty, and a link's underline lies just below it
      for (const e of document.querySelectorAll('select, button, input, textarea')) keep(e.getBoundingClientRect());
      // A card's border, or a rule across the page, is not left as a sliver at an edge of the frame (table rows may be: a table goes on).
      for (const e of document.querySelectorAll('main *')) {
        const b = e.getBoundingClientRect();
        if (b.width < window.innerWidth / 2 || !b.height || /^T(D|H|R|BODY|HEAD)$/.test(e.tagName) || root.contains(e))
          continue;
        const cs = getComputedStyle(e);
        if (parseFloat(cs.borderTopWidth) >= 1) solid.push([b.top + window.scrollY - 6, b.top + window.scrollY + 6]);
        if (parseFloat(cs.borderBottomWidth) >= 1)
          solid.push([b.bottom + window.scrollY - 6, b.bottom + window.scrollY + 6]);
      }
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const room = (edge) =>
        Math.min(
          ...solid.map(([a, b]) => (a < edge && b > edge ? 0 : Math.min(Math.abs(a - edge), Math.abs(b - edge)))),
        );
      let best = Math.max(0, Math.min(max, y)),
        score = -Infinity;
      for (let d = -48; d <= 48; d++) {
        // any offset that cuts nothing beats one that does; then room at the edges against distance
        const c = y + d;
        if (c < 0 || c > max) continue;
        const free = Math.min(room(c), room(c + seen)),
          s = free ? 100 + Math.min(free, 10) - Math.abs(d) * 0.15 : -Math.abs(d);
        if (s > score) {
          score = s;
          best = c;
        }
      }
      return best;
    },
    seen: (t) => {
      const e = typeof t === 'string' ? document.querySelector(t) : element(t);
      return !!e && e.getClientRects().length > 0;
    },
    text: (sel) => (document.querySelector(sel)?.textContent || '').trim(),
    option(value) {
      const o = options.find((o) => o.value === value);
      if (!o) return null;
      const b = o.row.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height };
    },
    // Fill the terminal pane: the command as its heading, then its lines. Bold is the only style kept from the output.
    term(cmd, out) {
      termBody.replaceChildren();
      termShown = '';
      termHead.textContent = `$ ${cmd}`;
      termRows = out.map((text) => {
        const row = add(
          'div',
          {
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            minHeight: termLine + 'px',
            display: 'none',
            borderRadius: '0',
          },
          termBody,
        );
        text.split(/\u001b\[([0-9;]*)m/).forEach((part, i, all) => {
          if (i % 2 === 0 && part) add('span', { fontWeight: all[i - 1] === '1' ? '700' : '400' }, row, part);
        });
        return row;
      });
    },
    apply(s) {
      window.scrollTo(0, s.y);
      cursor.style.transform = `translate(${s.cur[0] - 7.1 * u}px, ${s.cur[1] - 3.5 * u}px)`;
      marks.replaceChildren();
      for (const m of s.marks)
        for (const r of lines(m.on)) {
          const pad = m.on.pad ?? (m.on.text || m.on.from || m.on.line || m.on.tight ? [6, 3] : [0, 0]),
            tone = C[m.tone] || C.accent;
          add(
            'div',
            {
              position: 'absolute',
              left: r.x - pad[0] + 'px',
              top: r.y - pad[1] + 'px',
              width: r.w + 2 * pad[0] + 'px',
              height: r.h + 2 * pad[1] + 'px',
              boxSizing: 'border-box',
              border: `2px solid ${tone}`,
              borderRadius: '0',
              background: tone + '26',
              opacity: String(m.a),
            },
            marks,
          );
        }
      if (!s.menu) {
        menu.style.display = 'none';
        shown = null;
      } else {
        const sel = document.querySelector(s.menu.sel),
          b = sel.getBoundingClientRect();
        if (shown !== s.menu.sel) {
          menu.replaceChildren();
          shown = s.menu.sel;
          options = [...sel.options].map((o) => {
            const row = add(
              'div',
              {
                position: 'relative',
                padding: '6px 16px 6px 30px',
                borderRadius: '0',
                whiteSpace: 'nowrap',
                font: getComputedStyle(sel).font,
              },
              menu,
              o.textContent,
            );
            if (o.selected) add('span', { position: 'absolute', left: '10px' }, row, '✓');
            return { value: o.value, row };
          });
        }
        css(menu, {
          display: 'block',
          left: b.left + 'px',
          top: b.bottom + 4 + 'px',
          minWidth: b.width + 'px',
          opacity: String(s.menu.a),
        });
        for (const { row } of options) {
          const r = row.getBoundingClientRect(),
            hot = s.cur[0] >= r.left && s.cur[0] <= r.right && s.cur[1] >= r.top && s.cur[1] <= r.bottom;
          row.style.background = hot ? C.accent : 'transparent';
          row.style.color = hot ? '#fff' : C.ink;
        }
      }
      if (!s.ripple) ripple.style.display = 'none';
      else {
        const d = 10 + 44 * s.ripple.p;
        css(ripple, {
          display: 'block',
          left: s.ripple.x - d / 2 + 'px',
          top: s.ripple.y - d / 2 + 'px',
          width: d + 'px',
          height: d + 'px',
          opacity: String(1 - s.ripple.p),
        });
      }
      if (!s.term) term.style.display = 'none';
      else if (termShown !== JSON.stringify(s.term)) {
        // the first n lines, the last of them marked when the run is over
        termShown = JSON.stringify(s.term);
        term.style.display = 'block';
        const last = s.term.done ? termRows.findLastIndex((row) => row.textContent.trim()) : -1;
        termRows.forEach((row, i) =>
          css(row, {
            display: i < s.term.n ? 'block' : 'none',
            width: i === last ? 'fit-content' : 'auto',
            padding: i === last ? `0 ${px(9)}` : '0',
            marginLeft: i === last ? px(2) : '0',
            background: i === last ? C.ok + '26' : 'transparent',
            boxShadow: i === last ? `0 0 0 2px ${C.ok}` : 'none',
          }),
        );
        termSpeed.textContent = s.term.speed || '';
        termSpeed.style.display = s.term.speed ? 'block' : 'none';
        termView.scrollTop = termView.scrollHeight;
      }
      if (caption.textContent !== s.cap) {
        // a caption too long for the band is set smaller until it fits
        caption.textContent = s.cap;
        let size = Math.round(cfg.band * 0.278);
        caption.style.fontSize = size + 'px';
        while (caption.offsetHeight > cfg.band - 10 && size > 14) caption.style.fontSize = --size + 'px';
      }
      caption.style.opacity = String(s.capA);
      for (const [name, card] of Object.entries(cards)) card.style.opacity = String(name === s.cardName ? s.card : 0);
    },
  };
}

// ---- the picture -----------------------------------------------------------------------------------------
const COLORS = {
  bg: '#10120f',
  ink: '#f5f4ef',
  muted: '#9a9d94',
  line: '#2f322c',
  accent: '#e94322',
  no: '#ff8466',
  ok: '#8fd19e',
}; // the palette of the page's dark stage
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2); // the pointer: slow, fast, slow
const pan = (x) => (1 - Math.cos(Math.PI * x)) / 2; // the page: an even glide, so a long scroll does not whip
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
class Skip extends Error {}

// A page set up like Chrome on a Mac. The headless shell's default fixed-width font is Courier, Chrome's is Menlo,
// and the page leaves its <pre> blocks to that default. Frames are captured through this session, which needs the
// device scale of its own to return them at full size.
async function openPage(browser, viewport, scheme, ready) {
  const ctx = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.scale,
    colorScheme: scheme,
  });
  const page = await ctx.newPage(),
    cdp = await ctx.newCDPSession(page);
  await cdp
    .send('Page.setFontFamilies', { fontFamilies: { fixed: 'Menlo' } })
    .catch((e) => warn(`the default fixed-width font stays as it is: ${e.message.split('\n')[0]}`));
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.scale,
    mobile: false,
  });
  await cdp.send('Emulation.setScrollbarsHidden', { hidden: true });
  await page.goto(URL_, { waitUntil: 'load' });
  try {
    await page.waitForFunction(ready, undefined, { timeout: 45000 });
  } catch {
    throw Error(
      `the page did not become ready at ${URL_}: ${await page.evaluate(() => (document.getElementById('patch-status')?.textContent || '') + ' ' + (document.getElementById('upgrade-evidence')?.textContent || '').slice(0, 200))}`,
    );
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}); // late reads of the page itself, such as the state of a board
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page, cdp };
}

async function picture(browser, sound) {
  const { ctx, page, cdp } = await openPage(
    browser,
    VIEW,
    'dark',
    () =>
      document.getElementById('failure')?.hidden === false &&
      document.getElementById('check-patch')?.disabled === false &&
      !!document.querySelector('#upgrade-evidence table'),
  );
  const file = path.join(WORK, 'picture.mp4'),
    asked = {}; // asked: requests the page makes while it is recorded, by host
  page.on('request', (r) => {
    try {
      const h = new URL(r.url()).host;
      asked[h] = (asked[h] || 0) + 1;
    } catch {
      /* a data: url */
    }
  });
  // The rate cap only bites while the page scrolls, where sharp text costs most and is seen least.
  const enc = spawn(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-framerate',
      String(FPS),
      '-c:v',
      'png',
      '-i',
      '-',
      '-vf',
      'scale=1920:1080:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p',
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '21',
      '-maxrate',
      '5M',
      '-bufsize',
      '10M',
      '-profile:v',
      'high',
      '-g',
      String(FPS * 5),
      '-r',
      String(FPS),
      file,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  // If the encoder goes away early (killed, or out of disk) the next frame fails with that, instead of waiting for ever.
  let stopped = null,
    waiting = null;
  const quit = (why) => {
    stopped = why;
    if (waiting) waiting(Error(`the encoder stopped early: ${why}`));
  };
  const encoded = new Promise((resolve) => {
    enc.on('error', (e) => {
      quit(e.message);
      resolve();
    });
    enc.on('close', (code, signal) => {
      if (code || signal) quit(signal || `code ${code}`);
      resolve();
    });
  });
  enc.stdin.on('error', () => {});
  const write = (buf) =>
    new Promise((resolve, reject) => {
      if (stopped) return reject(Error(`the encoder stopped early: ${stopped}`));
      if (enc.stdin.write(buf)) return resolve();
      waiting = reject;
      enc.stdin.once('drain', () => {
        waiting = null;
        resolve();
      });
    });

  const st = {
    y: 0,
    cur: [S.pointer[0], S.pointer[1]],
    marks: [],
    menu: null,
    ripple: null,
    term: null,
    cap: '',
    capA: 1,
    card: 0,
    cardGoal: 0,
    cardName: null,
  };
  let count = 0,
    clock = null; // clock: the scene's first frame, how long its words take, and what its command printed
  // A card's small line is quoted from the page (its eyebrow says which network this is).
  const cards = {};
  for (const [name, c] of Object.entries(S.cards || {}))
    cards[name] = {
      ...c,
      line: c.line && (await page.evaluate((sel) => (document.querySelector(sel)?.textContent || '').trim(), c.line)),
    };
  await page.evaluate(overlay, { colors: COLORS, band: BAND, width: VIEW.width, height: VIEW.height, cards });

  const step = () => {
    st.capA = Math.min(1, st.capA + 0.25);
    for (const m of st.marks) m.a = clamp(m.a + (m.goal ? 0.2 : -0.25), 0, 1);
    st.marks = st.marks.filter((m) => m.goal || m.a > 0);
    if (st.menu) st.menu.a = Math.min(1, st.menu.a + 0.34);
    if (st.ripple && (st.ripple.p += 1 / 9) >= 1) st.ripple = null;
    st.card = clamp(st.card + Math.sign(st.cardGoal - st.card) / 7, 0, 1);
    if (st.card >= 1) st.term = null; // a card that covers the terminal pane puts it away
  };
  let capNext = null,
    capAt = 0; // a scene's caption appears when its words start
  const shot = async () => {
    if (capNext != null && count >= capAt) {
      if (st.cap !== capNext) {
        st.cap = capNext;
        st.capA = 0;
      }
      capNext = null;
    }
    step();
    await page.evaluate((s) => window.__rec.apply(s), st);
    return Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
  };
  const frames = async (n) => {
    for (let i = 0; i < n; i++) {
      await write(await shot());
      count++;
    }
  };
  const first = await shot(),
    size = `${first.readUInt32BE(16)}x${first.readUInt32BE(20)}`; // a PNG states its size at bytes 16-23
  if (size !== '1920x1080')
    warn(`frames are captured at ${size} and scaled to 1920x1080: choose a viewport and scale that multiply to it`);
  const tween = async (sec, fn, curve = ease) => {
    const k = Math.max(1, Math.round(sec * FPS));
    for (let i = 1; i <= k; i++) {
      fn(curve(i / k));
      await frames(1);
    }
  };
  const missing = []; // what a scene points at and the page does not have
  const rect = async (t, what) => {
    const r = await page.evaluate((t) => window.__rec.rect(t), t);
    if (!r) missing.push(`${clock.id}: ${what} ${JSON.stringify(t)}`);
    return r;
  };
  const glide = (x, y, sec) => {
    const [x0, y0] = st.cur,
      d = Math.hypot(x - x0, y - y0);
    return d < 2
      ? null
      : tween(sec ?? clamp(0.25 + d / 1500, 0.3, 0.8), (e) => {
          st.cur = [x0 + (x - x0) * e, y0 + (y - y0) * e];
        });
  };
  const tap = () => {
    st.ripple = { x: st.cur[0], y: st.cur[1], p: 0 };
  };
  // A place for the pointer: {to} and a point of its box as fractions {at: [x, y]} plus {dx, dy}; by default just
  // past the end of its text. `up` is how far the page is about to scroll.
  const spot = async (a, what, up = 0) => {
    const r = await rect(a.to, what);
    if (!r) return null;
    const [x, y] = a.at ? [r.x + r.w * a.at[0], r.y + r.h * a.at[1]] : [r.end[0] + 10, r.end[1] - 8];
    return [clamp(x + (a.dx || 0), 4, VIEW.width - 24), clamp(y + (a.dy || 0) - up, 4, SEEN - 36)]; // the whole arrow stays above the caption band
  };

  const act = {
    // {t} holds for t seconds; {at} holds until that fraction of the scene's words has passed.
    async wait(a) {
      await frames(
        a.t != null
          ? Math.round(a.t * FPS)
          : Math.max(0, Math.round(clock.start + (clock.lead + a.at * clock.words) * FPS) - count),
      );
    },
    // Bring the target's top to `top` px below the top of the frame, then to the nearest offset that cuts no line
    // of text. {t: 0} jumps. With {pointer: {to, at, dx, dy}} the pointer travels with the page and arrives there.
    async scroll(a) {
      const r = await rect(a.to, 'scroll');
      if (!r) return;
      const y0 = st.y,
        y1 = await page.evaluate((y) => window.__rec.clean(y), Math.round(r.scrollY + r.y - (a.top ?? 24)));
      const c0 = st.cur,
        c1 = (a.pointer && (await spot(a.pointer, 'scroll pointer', y1 - y0))) || c0;
      if (a.t === 0) {
        st.y = y1;
        st.cur = c1;
      } else if (y1 !== y0 || c1 !== c0)
        await tween(
          a.t ?? clamp(0.45 + Math.abs(y1 - y0) / 1300, 0.5, 1.6),
          (e) => {
            st.y = Math.round(y0 + (y1 - y0) * e);
            st.cur = [c0[0] + (c1[0] - c0[0]) * e, c0[1] + (c1[1] - c0[1]) * e];
          },
          pan,
        );
    },
    // After the page has changed its own layout (a verdict, an opened <details>): to the nearest offset that cuts no text.
    async settle(a) {
      const y0 = st.y,
        y1 = await page.evaluate((y) => window.__rec.clean(y), y0);
      if (y1 !== y0)
        await tween(
          a.t ?? 0.3,
          (e) => {
            st.y = Math.round(y0 + (y1 - y0) * e);
          },
          pan,
        );
    },
    async point(a) {
      const c = await spot(a, 'point');
      if (c) await glide(c[0], c[1], a.t);
    },
    // Highlight one target or several; with no target the highlights fade out. A highlight already there stays.
    async mark(a) {
      const key = (on, tone) => JSON.stringify([on, tone]),
        wanted = [].concat(a.on || []).map((on) => [on, on.tone ?? a.tone]); // a target may carry its own tone
      for (const m of st.marks) m.goal = wanted.some(([on, tone]) => key(on, tone) === key(m.on, m.tone)) ? 1 : 0;
      for (const [on, tone] of wanted)
        if (!st.marks.some((m) => m.goal && key(on, tone) === key(m.on, m.tone)) && (await rect(on, 'mark')))
          st.marks.push({ on, tone, a: 0, goal: 1 });
    },
    // A real mouse click on the target, at {at} of its box.
    async click(a) {
      const r = await page.evaluate((t) => window.__rec.rect(t), a.to);
      if (!r) throw Error(`click: nothing on the page matches ${JSON.stringify(a.to)}`);
      await glide(r.x + r.w * (a.at?.[0] ?? 0.5), r.y + r.h * (a.at?.[1] ?? 0.5), a.t);
      await frames(3);
      tap();
      await page.mouse.move(st.cur[0], st.cur[1]);
      await page.mouse.down();
      await frames(2);
      await page.mouse.up();
      await frames(2);
    },
    // A <select> opens as a native menu, which a headless browser does not draw: the overlay lists the same
    // options under it, and choosing one sets the real control and fires its change event.
    async open(a) {
      const r = await page.evaluate((t) => window.__rec.rect(t), { sel: a.select });
      if (!r) throw Error(`open: no ${a.select} on the page`);
      await glide(r.x + r.w * 0.8, r.y + r.h * 0.58, a.t);
      await frames(3);
      tap();
      st.menu = { sel: a.select, a: 0 };
      await frames(5);
      if (a.hover) await act.hover(a);
    },
    async hover(a) {
      const o = await page.evaluate((v) => window.__rec.option(v), a.hover || a.value);
      if (!o) throw Error(`${a.select} has no option ${a.hover || a.value}`);
      await glide(o.x + o.w - 8, o.y + o.h * 0.5, a.t); // at the end of the row, clear of its words
    },
    async choose(a) {
      await act.hover(a);
      await frames(3);
      tap();
      await frames(2);
      await page.selectOption(a.select, a.value);
      st.menu = null;
      await frames(3);
    },
    // Wait for the page itself (a network answer). It lasts in the video as long as it really took.
    async until(a) {
      const t0 = Date.now();
      let out = 0;
      for (;;) {
        const done = await page.evaluate((sel) => window.__rec.seen(sel), a.sel),
          buf = await shot();
        const due = Math.max(out + 1, Math.round(((Date.now() - t0) / 1000) * FPS));
        for (; out < due; out++, count++) await write(buf);
        if (done) {
          if (a.log) console.log(`    the page: ${await page.evaluate((sel) => window.__rec.text(sel), a.log)}`);
          return;
        }
        if (Date.now() - t0 > (a.timeout || 30) * 1000)
          throw Error(`until: ${a.sel} did not appear in ${a.timeout || 30} s`);
      }
    },
    // A title card over everything: {name} of script.json's cards, {now} without a fade, {off} away again.
    async card(a) {
      st.cardGoal = a.off ? 0 : 1;
      if (a.name) st.cardName = a.name;
      if (a.now) st.card = st.cardGoal;
    },
    // What the scene's command printed, in a pane over the page: the first {head} seconds as they were, the rest
    // fitted into {t} seconds with the factor shown, then {hold} seconds on its last line. {off} puts the pane away.
    async terminal(a) {
      if (a.off) {
        st.term = null;
        return;
      }
      const { cmd, lines } = clock.ran,
        T = lines[lines.length - 1][0],
        head = Math.min(a.head ?? 1, a.t, T),
        k = T > a.t ? (T - head) / (a.t - head) : 1;
      await page.evaluate(([c, out]) => window.__rec.term(c, out), [cmd, lines.map((l) => l[1])]);
      for (let i = 0, n = Math.round(Math.min(T, a.t) * FPS); i <= n; i++) {
        const tau = i / FPS,
          real = tau <= head ? tau : head + (tau - head) * k;
        st.term = {
          n: lines.filter((l) => l[0] <= real).length,
          speed: k > 1.05 && tau > head && i < n ? `shown ${Math.round(k)}× faster` : '',
        };
        await frames(1);
      }
      st.term = { n: lines.length, done: true };
      await frames(Math.round((a.hold ?? 2) * FPS));
    },
  };

  const recorded = [];
  for (const sc of S.scenes) {
    if (SKIP.includes(sc.id)) continue;
    if (sc.when && !(await page.evaluate((t) => window.__rec.seen(t), sc.when))) {
      console.log(
        `  ${sc.id}: skipped, the page has no ${typeof sc.when === 'string' ? sc.when : JSON.stringify(sc.when)}`,
      );
      continue;
    }
    try {
      // The scene's command is run before its first frame. If it fails, or does not end as the scene says, the scene is left out.
      let ran = null;
      if (sc.run) {
        console.log(`    $ ${sc.run.cmd}`);
        const out = await capture(sc.run.cmd),
          last =
            out.lines
              .map((l) => l[1])
              .filter((x) => x.trim())
              .pop() || '';
        if (out.code !== 0 || !last.includes(sc.run.ends))
          throw new Skip(
            `\`${sc.run.cmd}\` ended with code ${out.code} and the line "${last}", not with "${sc.run.ends}"`,
          );
        console.log(`    ${last}`);
        ran = { cmd: sc.run.cmd, lines: out.lines };
      }
      const lead = sc.lead ?? S.lead,
        words = sound.length[sc.id];
      clock = { id: sc.id, start: count, lead, words, ran };
      // What the page must read for this scene's words to be true (spacing aside), checked when the scene starts.
      for (const [sel, text] of Object.entries(sc.expect || {})) {
        const said = await page.evaluate((sel) => window.__rec.text(sel), sel),
          flat = (x) => x.replace(/\s+/g, '');
        if (flat(said) !== flat(text))
          missing.push(`${sc.id}: ${sel} reads "${said.replace(/\s+/g, ' ')}", not "${text}"`);
      }
      // {{selector}} in a caption is the text the page shows there when the scene starts; {{selector|pattern}} the part of it the pattern's group matches.
      let cap = sc.caption || '';
      for (const q of cap.match(/\{\{.+?\}\}/g) || []) {
        const [sel, pattern] = q.slice(2, -2).split('|'),
          text = await page.evaluate((sel) => window.__rec.text(sel), sel);
        const said = pattern ? (text.match(new RegExp(pattern)) || [])[1] : text;
        if (!said) missing.push(`${sc.id}: caption ${q}`);
        cap = cap.replace(q, said || '');
      }
      if (!recorded.length) {
        st.cap = cap;
        st.capA = 1;
      } else {
        capNext = cap;
        capAt = count + Math.round(lead * FPS);
        if (lead > 0.3 && st.cap !== cap) st.cap = '';
      } // no caption while the page travels
      for (const a of sc.actions || []) await act[a.do](a);
      await frames(Math.max(0, clock.start + Math.ceil((lead + words + (sc.tail ?? S.tail)) * FPS) - count));
      recorded.push({ id: sc.id, frames: count - clock.start, lead, voice: sound.file[sc.id] || null, caption: cap });
      console.log(`  ${sc.id.padEnd(10)} ${((count - clock.start) / FPS).toFixed(2).padStart(6)} s`);
    } catch (e) {
      if (!(e instanceof Skip)) throw e;
      warn(`${sc.id}: skipped, ${e.message}`);
    }
  }
  enc.stdin.end();
  await encoded;
  await ctx.close();
  if (stopped) throw Error(`the encoder stopped early: ${stopped}`);
  console.log(
    `  requests made by the page during the recording: ${
      Object.entries(asked)
        .map(([h, n]) => `${h} ${n}`)
        .join(', ') || 'none'
    }`,
  );
  return { file, scenes: recorded, missing };
}

// ---- sound, and the file ---------------------------------------------------------------------------------
// Each scene's recording starts `lead` seconds into the scene; a scene without one is silent. With no recording
// at all the track is silence, so that players and uploaders that expect sound get it.
function mux(pic) {
  const inputs = [],
    chain = [];
  pic.scenes.forEach((sc, i) => {
    const d = sc.frames / FPS;
    if (sc.voice) {
      inputs.push('-i', sc.voice);
      chain.push(`[${inputs.length / 2 - 1}:a]adelay=${Math.round(sc.lead * 1000)}:all=1,apad,atrim=0:${d}[a${i}]`);
    } else chain.push(`anullsrc=r=48000:cl=stereo,atrim=0:${d}[a${i}]`);
  });
  const track = path.join(WORK, 'sound.wav');
  ffmpeg(
    ...inputs,
    '-filter_complex',
    `${chain.join(';')};${pic.scenes.map((_, i) => `[a${i}]`).join('')}concat=n=${pic.scenes.length}:v=0:a=1[a]`,
    '-map',
    '[a]',
    '-ar',
    '48000',
    track,
  );
  let gain = 0; // one gain for the whole voice: -16 LUFS, or less if that would clip
  if (inputs.length)
    try {
      const said = spawnSync(
        'ffmpeg',
        ['-hide_banner', '-nostats', '-i', track, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'],
        { encoding: 'utf8' },
      ).stderr;
      const m = JSON.parse(said.slice(said.lastIndexOf('{'), said.lastIndexOf('}') + 1));
      gain = Math.min(-16 - Number(m.input_i), -1.5 - Number(m.input_tp));
      if (!Number.isFinite(gain)) throw Error('no level in the measurement');
    } catch (e) {
      gain = 0;
      warn(`loudness was not measured (${e.message.split('\n')[0]}); the voice keeps its level`);
    }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  ffmpeg(
    '-i',
    pic.file,
    '-i',
    track,
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    'copy',
    '-af',
    `volume=${gain.toFixed(2)}dB`,
    '-c:a',
    'aac',
    '-b:a',
    inputs.length ? '160k' : '32k',
    '-movflags',
    '+faststart',
    OUT,
  );
  fs.rmSync(track);
}

// The file is what was asked for, and its sound is as long as its picture.
function checkOutput(pic) {
  const streams = JSON.parse(
    run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_name,width,height,pix_fmt,duration',
      '-of',
      'json',
      OUT,
    ]),
  ).streams;
  const v = streams.find((s) => s.codec_name === 'h264'),
    a = streams.find((s) => s.codec_name === 'aac'),
    want = pic.scenes.reduce((n, s) => n + s.frames, 0) / FPS;
  if (!v || !a || v.width !== 1920 || v.height !== 1080 || v.pix_fmt !== 'yuv420p')
    throw Error(`${OUT} is not 1920x1080 H.264 yuv420p with AAC sound`);
  if (Math.abs(v.duration - want) > 1 / FPS || Math.abs(a.duration - want) > 0.05)
    throw Error(
      `the picture lasts ${v.duration} s and the sound ${a.duration} s; both should last ${want.toFixed(2)} s`,
    );
}

// ---- the hero image: the same page, composed by a few injected rules ---------------------------------------
async function hero(browser) {
  const { ctx, page } = await openPage(
    browser,
    S.hero.viewport,
    S.hero.scheme,
    () => document.getElementById('failure')?.hidden === false,
  );
  await page.addStyleTag({ content: S.hero.css });
  const wrong = await page.evaluate(
    (shows) =>
      Object.entries(shows)
        .map(([sel, text]) => {
          const e = document.querySelector(sel),
            flat = (x) => x.replace(/\s+/g, '');
          if (!e || !e.getClientRects().length) return `${sel} is not on the page`;
          if (text != null && flat(e.textContent) !== flat(text))
            return `${sel} reads "${e.textContent.replace(/\s+/g, ' ').trim()}", not "${text}"`;
          const b = e.getBoundingClientRect();
          return b.left < 0 || b.top < 0 || b.right > innerWidth || b.bottom > innerHeight
            ? `${sel} does not fit in the frame`
            : null;
        })
        .filter(Boolean),
    S.hero.shows || {},
  );
  if (wrong.length) throw Error(`${path.relative(ROOT, HERO)} was not written: ${wrong.join('; ')}`);
  fs.mkdirSync(path.dirname(HERO), { recursive: true });
  await page.screenshot({ path: HERO });
  await ctx.close();
}

// ---- one frame every two seconds, labelled, on one sheet ---------------------------------------------------
async function sheet(browser, pic) {
  const dir = path.join(WORK, 'frames');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  ffmpeg(
    '-i',
    OUT,
    '-vf',
    `select='not(mod(n,${FPS * 2}))',scale=960:-2`,
    '-fps_mode',
    'vfr',
    '-q:v',
    '3',
    path.join(dir, 'f%03d.jpg'),
  );
  const at = (t) => {
    let f = t * FPS;
    for (const sc of pic.scenes) {
      if (f < sc.frames) return sc.id;
      f -= sc.frames;
    }
    return '';
  };
  const cells = fs
    .readdirSync(dir)
    .sort()
    .map(
      (name, i) =>
        `<figure><img src="${name}"><figcaption>${Math.floor((i * 2) / 60)}:${String((i * 2) % 60).padStart(2, '0')} · ${at(i * 2)}</figcaption></figure>`,
    );
  fs.writeFileSync(
    path.join(dir, 'sheet.html'),
    `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:10px;background:#0b0c0e;color:#c9ccd1;font:13px/1.9 -apple-system,sans-serif;display:grid;grid-template-columns:repeat(5,384px);gap:6px 10px}figure{margin:0}img{width:384px;display:block}</style>${cells.join('')}`,
  );
  const ctx = await browser.newContext({ viewport: { width: 5 * 384 + 60, height: 600 }, colorScheme: 'dark' }),
    page = await ctx.newPage();
  await page.goto('file://' + path.join(dir, 'sheet.html'));
  fs.mkdirSync(path.dirname(SHEET), { recursive: true });
  await page.screenshot({ path: SHEET, fullPage: true });
  await ctx.close();
}

// ---- NARRATION.md: what to say in each scene, for whoever records a voice ------------------------------------
function narrationSheet() {
  const lines = [
    '# Narration',
    '',
    'The video has no voice. To add one, read each block as one take. Save each take under the name of its scene:',
    '`<scene>.wav`, `.m4a` or `.mp3`. Then run `demo/video/build.sh --url <page url> --audio-dir <that directory>`',
    'to build the video again. A scene with a recording lasts as long as the recording, so the speed of the read',
    'moves nothing out of step. A scene without a recording stays silent and lasts the seconds given here.',
    '`record.cjs` writes this file from `script.json`. Edit the text there.',
    '',
  ];
  let part = null;
  for (const sc of S.scenes) {
    if (sc.part && sc.part !== part) {
      part = sc.part;
      lines.push(`## ${part}`, '');
    }
    const shown =
      sc.seconds ?? (sc.actions || []).filter((a) => a.do === 'terminal').reduce((n, a) => n + a.t + (a.hold ?? 2), 0);
    lines.push(
      `**${sc.id}** · ${shown.toFixed(1)} s${sc.when ? ' · only when the page has `' + (typeof sc.when === 'string' ? sc.when : JSON.stringify(sc.when)) + '`' : ''}`,
      '',
      `> ${sc.narration || '(no words)'}`,
      '',
    );
  }
  lines.push(
    `${S.scenes.map((s) => (s.narration || '').split(/\s+/).filter(Boolean).length).reduce((a, b) => a + b, 0)} words in all.`,
    '',
  );
  fs.writeFileSync(path.join(path.dirname(SCRIPT), 'NARRATION.md'), lines.join('\n'));
}

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const kit = browserKit(),
    browser = await kit.chromium.launch({ executablePath: kit.exe });
  try {
    if (!AUDIO_DIR) narrationSheet();
    if (ONLY !== 'hero') {
      const sound = voice();
      console.log('picture');
      const pic = await picture(browser, sound);
      if (pic.missing.length && !process.argv.includes('--draft')) {
        fs.rmSync(pic.file);
        throw Error(
          `the page does not have what ${pic.missing.length} place(s) of ${path.basename(SCRIPT)} point at, so the picture would not match its captions. No video was written.\n  ${pic.missing.join('\n  ')}\nChange those places, or pass --draft to render anyway.`,
        );
      }
      pic.missing.forEach((m) => warn(`not on the page: ${m}`));
      const length = pic.scenes.reduce((n, s) => n + s.frames, 0) / FPS;
      if (S.max_seconds && length > S.max_seconds && !process.argv.includes('--draft')) {
        fs.rmSync(pic.file);
        throw Error(
          `the cut is ${length.toFixed(1)} s, over the ${S.max_seconds} s that ${path.basename(SCRIPT)} allows (max_seconds). No video was written: record again if the network was slow, shorten a scene, or raise that limit.`,
        );
      }
      mux(pic);
      checkOutput(pic);
      fs.writeFileSync(path.join(WORK, 'scenes.json'), JSON.stringify(pic.scenes, null, 1));
      fs.rmSync(pic.file);
      await sheet(browser, pic);
      const total = pic.scenes.reduce((n, s) => n + s.frames, 0) / FPS;
      console.log(
        `${path.relative(ROOT, OUT)}: ${total.toFixed(1)} s, ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB; ${path.relative(ROOT, SHEET)}`,
      );
    }
    await hero(browser);
    console.log(path.relative(ROOT, HERO));
  } finally {
    await browser.close();
  }
  if (warnings.length) console.log(`\n${warnings.length} warning(s):\n` + warnings.map((w) => '  ' + w).join('\n'));
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
