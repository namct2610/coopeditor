import { createServer } from "node:http";

const html = `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Frame Editor</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0d1117;
        --panel: #161b22;
        --line: #273244;
        --text: #edf2f7;
        --muted: #95a3b8;
        --accent: #f97316;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, sans-serif;
        background:
          radial-gradient(circle at top left, rgba(249, 115, 22, 0.22), transparent 25%),
          linear-gradient(180deg, #0b1020, #0d1117 40%);
        color: var(--text);
      }
      .wrap {
        max-width: 1200px;
        margin: 0 auto;
        padding: 32px 20px 80px;
      }
      .hero {
        display: grid;
        gap: 16px;
        margin-bottom: 24px;
      }
      .eyebrow {
        color: var(--accent);
        text-transform: uppercase;
        letter-spacing: 0.14em;
        font-size: 12px;
      }
      h1 {
        font-size: clamp(32px, 5vw, 64px);
        line-height: 0.98;
        margin: 0;
        max-width: 10ch;
      }
      p {
        color: var(--muted);
        max-width: 70ch;
        line-height: 1.6;
      }
      .grid {
        display: grid;
        grid-template-columns: 2fr 1fr;
        gap: 20px;
      }
      .card {
        background: rgba(22, 27, 34, 0.82);
        border: 1px solid var(--line);
        border-radius: 20px;
        overflow: hidden;
        backdrop-filter: blur(10px);
      }
      .player {
        aspect-ratio: 16 / 9;
        display: grid;
        place-items: center;
        background:
          linear-gradient(135deg, rgba(249, 115, 22, 0.15), transparent),
          #05080f;
        border-bottom: 1px solid var(--line);
      }
      .meta, .comments {
        padding: 18px;
      }
      .bar {
        height: 10px;
        background: #0b1220;
        border-radius: 999px;
        overflow: hidden;
        margin: 14px 0 8px;
      }
      .bar > span {
        display: block;
        width: 37%;
        height: 100%;
        background: linear-gradient(90deg, #f97316, #fb923c);
      }
      .comment {
        padding: 12px 0;
        border-bottom: 1px solid var(--line);
      }
      .comment:last-child {
        border-bottom: 0;
      }
      .time {
        color: var(--accent);
        font-size: 13px;
      }
      @media (max-width: 900px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <section class="hero">
        <div class="eyebrow">Frame Editor MVP</div>
        <h1>Review video 4K tren NAS bang proxy nhe hon.</h1>
        <p>
          Source goc nam tren NAS, worker transcode thanh HLS 540p/720p/1080p,
          editor xem muot va dat comment chinh xac theo timeline.
        </p>
      </section>
      <section class="grid">
        <article class="card">
          <div class="player">Player placeholder / HLS.js se nam o day</div>
          <div class="meta">
            <strong>demo/clip-a-cam.mov</strong>
            <div class="bar"><span></span></div>
            <p>Proxy mac dinh: 720p / 3.5 Mbps. Timeline comment se gan voi timestampMs va frameNumber.</p>
          </div>
        </article>
        <aside class="card comments">
          <strong>Timeline Comments</strong>
          <div class="comment">
            <div class="time">00:00:12.840</div>
            <div>Cat nhanh hon o dau shot nay.</div>
          </div>
          <div class="comment">
            <div class="time">00:00:47.120</div>
            <div>Tang audio ambience them mot chut.</div>
          </div>
          <div class="comment">
            <div class="time">00:01:09.300</div>
            <div>Check lai color khung hinh nay voi version moi nhat.</div>
          </div>
        </aside>
      </section>
    </main>
  </body>
</html>`;

const server = createServer((_, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(html);
});

const port = Number(process.env.PORT ?? 3000);

server.listen(port, () => {
  console.log(`Web preview listening on http://localhost:${port}`);
});
