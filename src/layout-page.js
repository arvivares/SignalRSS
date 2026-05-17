import { escapeHtml } from './view-utils.js';

export function renderLayout({ title, body, bodyClass = '', hideTopbar = false }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · SignalRSS</title>
  <style>
    :root {
      --bg: #f4efe6;
      --ink: #17130f;
      --muted: #6d6255;
      --card: #fffaf1;
      --line: #ded2c0;
      --accent: #c4552d;
      --accent-2: #1e6f63;
      --shadow: 0 18px 50px rgba(59, 42, 22, .12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at 16% 12%, rgba(196, 85, 45, .16), transparent 28rem),
        radial-gradient(circle at 82% 8%, rgba(30, 111, 99, .12), transparent 24rem),
        linear-gradient(135deg, #f4efe6 0%, #efe1ca 100%);
      font-family: Georgia, "Times New Roman", serif;
    }
    a { color: inherit; }
    .shell { max-width: 1180px; margin: 0 auto; padding: 32px 20px 60px; }
    body.news-fullscreen {
      overflow: hidden;
      background:
        radial-gradient(circle at 50% -10%, rgba(196, 85, 45, .24), transparent 22rem),
        radial-gradient(circle at 50% 110%, rgba(30, 111, 99, .22), transparent 20rem),
        linear-gradient(160deg, #14100c 0%, #271d15 48%, #10231f 100%);
    }
    body.news-fullscreen .shell {
      width: 100%;
      max-width: none;
      min-height: 100svh;
      padding: 0;
    }
    .topbar { display: flex; justify-content: space-between; gap: 20px; align-items: center; margin-bottom: 32px; }
    .brand { font-size: 13px; letter-spacing: .18em; text-transform: uppercase; color: var(--muted); }
    nav { display: flex; gap: 10px; flex-wrap: wrap; }
    nav a, .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 8px 12px;
      text-decoration: none;
      background: rgba(255, 250, 241, .7);
      font-size: 14px;
    }
    h1 { font-size: clamp(38px, 6vw, 78px); line-height: .9; letter-spacing: -.055em; margin: 0 0 18px; max-width: 900px; }
    h2 { font-size: 26px; letter-spacing: -.025em; margin: 0 0 14px; }
    h3 { margin: 0 0 10px; font-size: 22px; letter-spacing: -.02em; }
    p { color: var(--muted); line-height: 1.55; }
    .lede { font-size: 19px; max-width: 720px; margin: 0 0 28px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin: 28px 0; }
    .card {
      background: rgba(255, 250, 241, .88);
      border: 1px solid rgba(222, 210, 192, .95);
      border-radius: 24px;
      padding: 20px;
      box-shadow: var(--shadow);
    }
    .metric { font-size: 34px; font-weight: 700; letter-spacing: -.04em; }
    .label { color: var(--muted); font-size: 13px; text-transform: uppercase; letter-spacing: .11em; }
    .metric-card { min-height: 142px; display: flex; flex-direction: column; justify-content: space-between; }
    .metric-note { margin: 10px 0 0; font-size: 13px; color: var(--muted); }
    .dashboard-hero {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(280px, .65fr);
      gap: 18px;
      align-items: stretch;
      margin-bottom: 18px;
    }
    .status-panel {
      background: linear-gradient(135deg, rgba(23, 19, 15, .94), rgba(48, 39, 29, .92));
      color: #fffaf1;
      border-color: rgba(255, 250, 241, .18);
    }
    .status-panel p, .status-panel .label { color: rgba(255, 250, 241, .68); }
    .status-panel .metric { color: #fffaf1; }
    .dashboard-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(320px, .72fr);
      gap: 18px;
      margin-top: 18px;
    }
    .table { width: 100%; border-collapse: collapse; font-size: 14px; }
    .table th {
      color: var(--muted);
      font-size: 11px;
      letter-spacing: .12em;
      text-transform: uppercase;
      text-align: left;
      padding: 0 0 10px;
      border-bottom: 1px solid var(--line);
    }
    .table td {
      padding: 11px 0;
      border-bottom: 1px solid rgba(222, 210, 192, .78);
      vertical-align: top;
    }
    .table td:last-child, .table th:last-child { text-align: right; }
    .ranked-name { font-weight: 700; }
    .bar-list { display: grid; gap: 11px; margin-top: 10px; }
    .bar-row {
      display: grid;
      grid-template-columns: 130px minmax(0, 1fr) 64px;
      align-items: center;
      gap: 10px;
      font-size: 14px;
    }
    .bar-track {
      height: 10px;
      border-radius: 999px;
      overflow: hidden;
      background: rgba(109, 98, 85, .16);
    }
    .bar-fill {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
    }
    .status-list { display: grid; gap: 12px; margin-top: 12px; }
    .status-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: baseline;
      padding: 12px 0;
      border-top: 1px solid var(--line);
    }
    .status-row strong { font-size: 18px; }
    .status-row span { color: var(--muted); font-size: 13px; }
    .ok { color: var(--accent-2); font-weight: 700; }
    .warn { color: var(--accent); font-weight: 700; }
    .mini-chart {
      display: flex;
      align-items: end;
      gap: 3px;
      height: 116px;
      margin-top: 18px;
      padding-top: 10px;
      border-top: 1px solid var(--line);
    }
    .mini-bar {
      flex: 1;
      min-width: 4px;
      border-radius: 8px 8px 0 0;
      background: linear-gradient(180deg, var(--accent-2), rgba(30, 111, 99, .28));
    }
    .section { margin-top: 36px; }
    .toolbar { display: flex; gap: 10px; flex-wrap: wrap; margin: 18px 0 24px; }
    .toolbar a { text-decoration: none; }
    .cluster {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 170px;
      gap: 20px;
      margin-bottom: 14px;
    }
    .cluster-title { text-decoration: none; }
    .meta { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; color: var(--muted); font-size: 13px; }
    .articles { margin: 14px 0 0; padding: 0; list-style: none; }
    .articles li { padding: 12px 0; border-top: 1px solid var(--line); }
    .articles a { font-weight: 700; }
    .source { color: var(--accent-2); font-size: 13px; }
    .impact-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border-radius: 999px;
      border: 1px solid var(--line);
      padding: 7px 10px;
      background: rgba(30, 111, 99, .08);
      color: var(--ink);
      font-size: 13px;
      font-weight: 700;
    }
    .impact-badge.p0 { background: rgba(196, 85, 45, .16); border-color: rgba(196, 85, 45, .42); }
    .impact-badge.p1 { background: rgba(30, 111, 99, .14); border-color: rgba(30, 111, 99, .38); }
    .impact-badge.p2 { background: rgba(189, 139, 39, .14); border-color: rgba(189, 139, 39, .36); }
    .impact-badge.p3 { background: rgba(109, 98, 85, .12); border-color: rgba(109, 98, 85, .32); }
    .priority-filters {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 12px;
      margin: 22px 0 26px;
    }
    .priority-filter {
      min-height: 118px;
      border: 1px solid var(--line);
      border-radius: 24px;
      padding: 16px;
      text-decoration: none;
      background: rgba(255, 250, 241, .7);
      box-shadow: 0 10px 30px rgba(59, 42, 22, .08);
      transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease;
    }
    .priority-filter:hover, .priority-filter.active {
      transform: translateY(-2px);
      box-shadow: var(--shadow);
      border-color: rgba(23, 19, 15, .35);
    }
    .priority-filter strong {
      display: block;
      font-size: 32px;
      letter-spacing: -.04em;
      margin-bottom: 8px;
    }
    .priority-filter span { display: block; color: var(--muted); font-size: 13px; line-height: 1.35; }
    .priority-filter.active strong::after {
      content: " selected";
      display: inline-block;
      margin-left: 8px;
      border-radius: 999px;
      padding: 4px 7px;
      background: rgba(23, 19, 15, .12);
      font-size: 11px;
      letter-spacing: .02em;
      vertical-align: middle;
    }
    .priority-filter.p0 { background: linear-gradient(135deg, rgba(196, 85, 45, .24), rgba(255, 250, 241, .86)); }
    .priority-filter.p1 { background: linear-gradient(135deg, rgba(30, 111, 99, .20), rgba(255, 250, 241, .86)); }
    .priority-filter.p2 { background: linear-gradient(135deg, rgba(189, 139, 39, .18), rgba(255, 250, 241, .86)); }
    .priority-filter.p3 { background: linear-gradient(135deg, rgba(109, 98, 85, .14), rgba(255, 250, 241, .86)); }
    .filter-note { margin-top: -10px; }
    .impact-reasons { margin: 12px 0 0; padding-left: 18px; color: var(--muted); line-height: 1.45; }
    .impact-reasons li { margin: 5px 0; }
    .briefing { margin-bottom: 18px; }
    .briefing h2 { font-size: clamp(28px, 4vw, 48px); line-height: 1; }
    .briefing-links { margin: 18px 0 0; padding: 0; list-style: none; }
    .briefing-links li { padding: 12px 0; border-top: 1px solid var(--line); }
    .briefing-links a { font-weight: 700; }
    .pagination {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin: 24px 0;
      flex-wrap: wrap;
    }
    .pagination .disabled { opacity: .45; pointer-events: none; }
    .score { text-align: right; }
    .score strong { display: block; font-size: 28px; }
    .empty { padding: 40px; text-align: center; }
    .news-shell {
      min-height: calc(100svh - 130px);
      display: grid;
      grid-template-columns: minmax(0, .78fr) minmax(320px, 430px);
      grid-template-rows: 1fr auto;
      gap: 20px;
      align-items: center;
    }
    .news-copy h1 { max-width: 520px; }
    .news-stats { display: flex; flex-wrap: wrap; gap: 10px; margin: 18px 0; }
    .news-stats span {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 9px 12px;
      background: rgba(255, 250, 241, .62);
      color: var(--muted);
      font-size: 13px;
    }
    .news-stats strong { color: var(--ink); }
    .swipe-stage {
      position: relative;
      min-height: 620px;
      display: grid;
      place-items: center;
      perspective: 1200px;
    }
    .swipe-card {
      width: min(100%, 430px);
      min-height: 590px;
      border-radius: 34px;
      padding: 26px;
      color: #fff8e8;
      background:
        linear-gradient(155deg, rgba(255, 248, 232, .16), transparent 35%),
        radial-gradient(circle at 82% 14%, rgba(196, 85, 45, .34), transparent 15rem),
        linear-gradient(145deg, #19130f, #34271d 56%, #0f2320);
      box-shadow: 0 28px 80px rgba(23, 19, 15, .35);
      touch-action: none;
      user-select: none;
      transition: transform .18s ease, opacity .18s ease;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      overflow: hidden;
    }
    .swipe-card h2 {
      font-size: clamp(32px, 8vw, 54px);
      line-height: .92;
      letter-spacing: -.055em;
      margin: 34px 0 18px;
      color: #fff8e8;
    }
    .swipe-card p { color: rgba(255, 248, 232, .76); }
    .swipe-summary { font-size: 17px; line-height: 1.5; margin: 0 0 18px; overflow: auto; }
    .swipe-meta, .swipe-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      color: rgba(255, 248, 232, .66);
      font-size: 13px;
    }
    .swipe-date {
      margin-top: 12px;
      text-align: center;
      color: rgba(255, 248, 232, .62);
      font-size: 13px;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .swipe-card .impact-badge {
      color: #fff8e8;
      border-color: rgba(255, 248, 232, .24);
      background: rgba(255, 248, 232, .08);
    }
    .swipe-links {
      margin: auto 0 0;
      padding: 14px 0 0;
      border-top: 1px solid rgba(255, 248, 232, .18);
      list-style: none;
      color: rgba(255, 248, 232, .58);
      font-size: 12px;
      line-height: 1.35;
    }
    .swipe-links li { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 7px; }
    .swipe-actions { grid-column: 2; display: flex; justify-content: center; gap: 18px; }
    .swipe-button {
      width: 76px;
      height: 76px;
      border: 0;
      border-radius: 50%;
      font-family: inherit;
      font-size: 18px;
      font-weight: 800;
      cursor: pointer;
      box-shadow: var(--shadow);
    }
    .swipe-button.dismiss { background: #fff8e8; color: var(--accent); }
    .swipe-button.interest { background: var(--accent-2); color: #fff8e8; }
    .swipe-hint {
      position: absolute;
      top: 44px;
      z-index: 0;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 10px 14px;
      color: var(--muted);
      background: rgba(255, 250, 241, .58);
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: .12em;
    }
    .swipe-hint.left { left: 0; transform: rotate(-10deg); }
    .swipe-hint.right { right: 0; transform: rotate(10deg); }
    .leaving-left { transform: translateX(-140%) rotate(-18deg) !important; opacity: 0 !important; }
    .leaving-right { transform: translateX(140%) rotate(18deg) !important; opacity: 0 !important; }
    .card-empty {
      min-height: 430px;
      display: grid;
      place-content: center;
      text-align: center;
      color: rgba(255, 248, 232, .74);
    }
    .news-start {
      position: fixed;
      inset: 0;
      z-index: 20;
      display: grid;
      place-items: center;
      padding: 24px;
      background:
        radial-gradient(circle at 50% 18%, rgba(196, 85, 45, .32), transparent 18rem),
        linear-gradient(160deg, rgba(20, 16, 12, .98), rgba(16, 35, 31, .98));
      color: #fff8e8;
      transition: opacity .24s ease, transform .24s ease;
    }
    .news-start.hidden { opacity: 0; pointer-events: none; transform: scale(1.02); }
    .news-start-inner { width: min(100%, 430px); text-align: left; }
    .news-start h1 {
      color: #fff8e8;
      font-size: clamp(54px, 17vw, 82px);
      max-width: 360px;
      margin-bottom: 18px;
    }
    .news-start p { color: rgba(255, 248, 232, .72); font-size: 18px; max-width: 340px; }
    .news-priority-picker {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      margin-top: 26px;
      width: 100%;
    }
    .news-priority-picker button {
      border: 1px solid rgba(255, 248, 232, .22);
      border-radius: 18px;
      padding: 13px 8px;
      background: rgba(255, 248, 232, .08);
      color: rgba(255, 248, 232, .78);
      font-family: inherit;
      font-size: 15px;
      font-weight: 900;
      cursor: pointer;
    }
    .news-priority-picker button.active {
      border-color: rgba(255, 248, 232, .82);
      background: #fff8e8;
      color: #17130f;
    }
    .news-start .news-start-meta {
      margin: 14px 0 0;
      font-size: 14px;
      color: rgba(255, 248, 232, .58);
    }
    .news-start .news-start-meta strong { color: #fff8e8; }
    .news-start #startNewsButton {
      width: 100%;
      margin-top: 28px;
      border: 0;
      border-radius: 999px;
      padding: 18px 22px;
      background: #fff8e8;
      color: #17130f;
      font-family: inherit;
      font-size: 18px;
      font-weight: 800;
      cursor: pointer;
    }
    body.news-fullscreen .news-shell {
      min-height: 100svh;
      height: 100svh;
      grid-template-columns: 1fr;
      grid-template-rows: 1fr;
      gap: 0;
      padding: max(10px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right)) max(10px, env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-left));
      overflow: hidden;
    }
    body.news-fullscreen .news-copy {
      display: none;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: start;
      color: #fff8e8;
      z-index: 2;
    }
    body.news-fullscreen .news-copy h1 {
      font-size: 24px;
      letter-spacing: -.04em;
      line-height: 1;
      margin: 2px 0 4px;
      color: #fff8e8;
    }
    body.news-fullscreen .news-copy .lede {
      font-size: 13px;
      line-height: 1.3;
      margin: 0;
      color: rgba(255, 248, 232, .62);
      max-width: 260px;
    }
    body.news-fullscreen .news-copy .label,
    body.news-fullscreen .news-copy .toolbar { display: none; }
    body.news-fullscreen .news-stats { margin: 0; justify-content: flex-end; align-content: start; gap: 6px; }
    body.news-fullscreen .news-stats span {
      border-color: rgba(255, 248, 232, .16);
      background: rgba(255, 248, 232, .08);
      color: rgba(255, 248, 232, .62);
      padding: 7px 9px;
      font-size: 11px;
    }
    body.news-fullscreen .news-stats strong { color: #fff8e8; }
    body.news-fullscreen .swipe-stage { min-height: 0; height: 100%; align-items: stretch; padding: 0; }
    body.news-fullscreen .swipe-card {
      width: 100%;
      max-width: 480px;
      justify-self: center;
      min-height: 0;
      height: 100%;
      border-radius: 32px;
      padding: 20px;
    }
    body.news-fullscreen .swipe-card h2 {
      font-size: clamp(26px, 8.2vw, 44px);
      line-height: .96;
      margin: 22px 0 14px;
    }
    body.news-fullscreen .swipe-summary {
      display: block;
      max-height: 36svh;
      font-size: clamp(15px, 4vw, 18px);
      line-height: 1.42;
      color: rgba(255, 248, 232, .82);
      -webkit-overflow-scrolling: touch;
    }
    body.news-fullscreen .swipe-footer { margin-top: auto; }
    body.news-fullscreen .swipe-links { max-height: 68px; overflow: hidden; }
    body.news-fullscreen .swipe-actions { display: none; }
    body.news-fullscreen .swipe-button { width: 72px; height: 72px; }
    body.news-fullscreen .swipe-hint { display: none; }
    @media (max-width: 820px) {
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .dashboard-hero, .dashboard-grid { grid-template-columns: 1fr; }
      .news-shell { grid-template-columns: 1fr; grid-template-rows: auto auto auto; }
      body.news-fullscreen .news-shell { grid-template-rows: 1fr; }
      .news-copy h1, .news-copy .lede { max-width: none; }
      .swipe-stage { min-height: 570px; }
      .swipe-actions { grid-column: 1; }
      .priority-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .cluster { grid-template-columns: 1fr; }
      .score { text-align: left; }
    }
    @media (max-width: 520px) {
      .grid { grid-template-columns: 1fr; }
      .bar-row { grid-template-columns: 1fr; gap: 5px; }
      .priority-filters { grid-template-columns: 1fr; }
      .topbar { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body${bodyClass ? ` class="${escapeHtml(bodyClass)}"` : ''}>
  <main class="shell">
    ${hideTopbar ? '' : `<div class="topbar">
      <div class="brand">SignalRSS</div>
      <nav>
        <a href="/">Dashboard</a>
        <a href="/news">News</a>
        <a href="/clusters">Clusters</a>
        <a href="/impact">Impact</a>
        <a href="/p0">P0 ES</a>
        <a href="/p1">P1 ES</a>
        <a href="/p2">P2 ES</a>
        <a href="/p3">P3 ES</a>
        <a href="/cybersecurity/p0">Cyber P0</a>
        <a href="/cybersecurity/p1">Cyber P1</a>
        <a href="/cloud-infrastructure/p0">Cloud P0</a>
        <a href="/semiconductors/p0">Semi P0</a>
        <a href="/semiconductors/p1">Semi P1</a>
        <a href="/groups.xml">Groups RSS</a>
        <a href="/rss.xml">Raw RSS</a>
      </nav>
    </div>`}
    ${body}
  </main>
</body>
</html>`;
}
