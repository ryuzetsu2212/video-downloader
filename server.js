const express = require('express');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { ZipArchive } = require('archiver');

const PORT = process.env.PORT || 8017;
const DL_DIR = process.env.DL_DIR || path.join(require('os').tmpdir(), 'VideoDownloader');
fs.mkdirSync(DL_DIR, { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

const app = express();
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

// Rate limiting: max 30 request unduhan/inspeksi per menit per IP
const rateMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const rec = rateMap.get(ip) || { count: 0, reset: now + 60000 };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + 60000; }
  rec.count++;
  rateMap.set(ip, rec);
  if (rec.count > 30) {
    return res.status(429).json({ ok: false, error: 'Terlalu banyak permintaan. Harap tunggu sebentar.' });
  }
  next();
}

// Pencegahan SSRF & Pembatasan Domain
function isAllowedUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const h = parsed.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h.endsWith('.local')) return false;
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(h)) return false;
    const allowed = [
      'tiktok.com', 'douyin.com', 'iesdouyin.com', 'douyinvod.com', 'snssdk.com', 'zjcdn.com', 'douyinstatic.com',
      'instagram.com', 'youtube.com', 'youtu.be', 'twitter.com', 'x.com', 't.co',
      'facebook.com', 'fb.watch', 'fb.com', 'pinterest.com', 'pin.it', 'reddit.com', 'redd.it'
    ];
    return allowed.some(d => h === d || h.endsWith('.' + d));
  } catch {
    return false;
  }
}

const thumbs = new Map();   // filename -> cover url
const jobs = new Map();     // id -> {stage, pct, name, waName, msg}
let purgeStamp = 0;         // waktu terakhir user hapus file — job lama tidak boleh
                            // menulis ulang file setelah titik ini (biar tidak "balik lagi")
const procs = new Map();    // jobId -> child process (python/ffmpeg) supaya ✕ bisa mematikannya

function fetchJSON(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA, ...extraHeaders } }, res => {
      if (res.statusCode >= 300 && res.headers.location)
        return fetchJSON(res.headers.location, extraHeaders).then(resolve, reject);
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function shortcodeToPk(shortcode) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let clean = shortcode;
  if (clean.length > 28) clean = clean.slice(0, 28);
  let pk = 0n;
  for (const c of clean) {
    const val = chars.indexOf(c);
    if (val === -1) continue;
    pk = pk * 64n + BigInt(val);
  }
  return pk.toString();
}

function getCookieHeader(cookieFile) {
  if (!fs.existsSync(cookieFile)) return '';
  const content = fs.readFileSync(cookieFile, 'utf8');
  const cookies = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('\t');
    if (parts.length >= 7) {
      cookies.push(`${parts[5]}=${parts[6]}`);
    }
  }
  return cookies.join('; ');
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('http:') ? http : https;
    lib.get(url, { headers: { 'User-Agent': UA } }, res => {
      if (res.statusCode >= 300 && res.headers.location)
        return fetchText(res.headers.location).then(resolve, reject);
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA } }, res => {
      if (res.statusCode >= 300 && res.headers.location)
        return fetchBuffer(res.headers.location).then(resolve, reject);
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function tiktokMeta(url, job) {
  if (/vm\.tiktok\.com|vt\.tiktok\.com/.test(url)) {
    try {
      const r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      if (r && r.url) url = r.url;
    } catch {}
  }
  try {
    const data = await fetchJSON('https://tikwm.com/api/?url=' + encodeURIComponent(url));
    const d = data.data || {};
    const author = ((d.author || {}).unique_id || 'tiktok').replace(/[^\w.-]/g, '_');
    if (d.images && Array.isArray(d.images) && d.images.length) {
      return { type: 'images', images: d.images, id: d.id, author };
    }
    let vid = d.hdplay || d.play;
    if (vid) {
      if (vid.startsWith('/')) vid = 'https://tikwm.com' + vid;
      return { type: 'video', url: vid, name: `tiktok_${author}_${d.id || Date.now()}.mp4`, hd: !!d.hdplay, cover: d.cover };
    }
  } catch (err) {
    console.warn('TikWM gagal, beralih ke cadangan yt-dlp:', err.message);
  }
  return { type: 'ytdlp', url };
}

// unduh dengan progress (Content-Length total vs bytes masuk)
// job.pctBase/pctSpan: unduhan menempati porsi 0-60% dari bar (sisanya untuk
// encode 60-100%), supaya bar tidak mundur ke 0 saat fase encode dimulai.
function downloadFile(url, dst, job) {
  return new Promise((resolve, reject) => {
    const base = job.pctBase || 0;
    const span = job.pctSpan || 60;
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Referer': 'https://www.douyin.com/' } }, res => {
      if (res.statusCode >= 300 && res.headers.location) {
        res.resume();
        return downloadFile(res.headers.location, dst, job).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const total = +res.headers['content-length'] || 0;
      let got = 0;
      const ws = fs.createWriteStream(dst);
      res.on('data', c => {
        if (job.stage === 'error') {          // user hapus semua → hentikan unduhan
          req.destroy(); ws.destroy();
          try { fs.unlinkSync(dst); } catch {}
          return reject(new Error('dibatalkan'));
        }
        got += c.length;
        if (total) {
          const dl = Math.round(got / total * 100);
          job.pct = Math.round(base + got / total * span);
          job.msg = `mengunduh video ${dl}%`;
        }
      });
      res.pipe(ws);
      ws.on('finish', () => resolve());
      ws.on('error', reject);
    });
    req.on('error', reject);
  });
}

// info resolusi + bitrate + ukuran video (untuk putuskan perlu encode atau tidak)
function probe(file) {
  return new Promise(resolve => {
    execFile('ffprobe', ['-v', 'quiet', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,bit_rate',
      '-show_entries', 'format=duration,size', '-of', 'json', file],
      { timeout: 30000 }, (e, out) => {
        if (e) return resolve({});
        try {
          const j = JSON.parse(out);
          const s = (j.streams || [])[0] || {};
          const f = j.format || {};
          resolve({ width: +s.width, height: +s.height, vbps: +s.bit_rate,
            dur: +f.duration || 0, size: +f.size || 0 });
        } catch (err) { resolve({}); }
      });
  });
}

// encode dengan progress dari ffmpeg -progress
// Tujuan: menghasilkan file ≥1080p supaya tombol HD di WhatsApp HIDUP.
// Tanpa itu WA menganggap video "bukan HD" dan memaksa turun ke 480p
// (inilah yang user lihat sebagai "dikompres jadi 3,5 MB").
function encodeWA(src, job, info, capOverride) {
  return new Promise((resolve, reject) => {
    const dst = src.replace(/\.[^.]+$/, '') + '_wa.mp4';
    const w = info && info.width ? info.width : 0;
    const h = info && info.height ? info.height : 0;
    // sisi pendek dijadikan 1080 (definisi 1080p). Video vertikal → lebar 1080,
    // video landscape → tinggi 1080. Sumber di bawah 1080 akan di-upscale —
    // tidak menambah detail, tapi membuat WA memakai jalur HD (720p) bukan 480p.
    const portrait = h >= w;
    // Batas bitrate: WA status maksimal 16 MB, jadi hitung bitrate yang aman untuk
    // durasi video (target ~14 MB), tapi jangan lewat 3,5 Mbps supaya tidak di-recompress.
    const dur0 = (info && info.dur) || 0;
    // Dua mode:
    //  - durasi ≤30 dtk (bisa jadi status WA): sisi pendek dipaksa 1080 → tombol HD hidup
    //  - durasi >30 dtk (video chat biasa): JANGAN upscale, cukup batasi lebar ≤1080
    //    (memaksa 1080p pada video panjang dengan bitrate kecil malah lebih buruk)
    const isStatus = dur0 <= 30;
    const vf = isStatus
      ? (portrait ? 'scale=1080:-2:flags=lanczos' : 'scale=-2:1080:flags=lanczos')
      : "scale='min(1080,iw)':-2:flags=lanczos";
    let capBps = 3500000;
    if (dur0 > 0) capBps = Math.min(capBps, Math.floor((14 * 1024 * 1024 * 8) / dur0));
    if (capOverride) capBps = capOverride;
    // capBps dalam bit/detik → ffmpeg mau kbps. Lantai 500 kbps (BUKAN 500000 —
    // pernah salah tulis sehingga maxrate jadi "500000k" = tanpa batas sama sekali,
    // hasilnya file 26 MB dari video 18 detik).
    const capStr = Math.max(500, Math.round(capBps / 1000)) + 'k';
    // durasi sudah tersedia dari probe (info.dur) — jangan ambil ulang secara async:
    // dulu dur=0 saat progress pertama datang → bar encode diam di 0%.
    let dur = dur0;
    if (!dur) {
      execFile('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration',
        '-of', 'csv=p=0', src], { timeout: 30000 }, (e, out) => { dur = parseFloat(out) || 0; });
    }
    // bar tidak boleh mundur: encode menempati porsi 60-100% (unduhan 0-60%)
    const base = job.pctBase || 60;
    const span = job.pctSpan || 40;
    const p = spawn('ffmpeg', ['-y', '-i', src,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'high', '-level', '4.1',
      '-crf', '20', '-maxrate', capStr, '-bufsize', '7000k',
      '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-progress', 'pipe:1', '-nostats', '-movflags', '+faststart', dst]);
    if (job && job.id) procs.set(job.id, p);   // supaya ✕ bisa mematikan ffmpeg juga
    p.on('close', () => { if (job && job.id) procs.delete(job.id); });
    p.stdout.on('data', chunk => {
      if (job.stage === 'error') { try { p.kill('SIGKILL'); } catch {} return; }  // ✕ ditekan
      const m = chunk.toString().match(/out_time_ms=(\d+)/);
      if (m && dur > 0) {
        const sec = +m[1] / 1e6;
        const pct = Math.min(100, Math.round(sec / dur * 100));
        job.pct = Math.min(99, Math.round(base + pct / 100 * span));
        job.msg = `encode WA HD ${pct}%`;
      }
    });
    p.on('close', code => {
      if (code === 0 && fs.existsSync(dst)) {
        thumbs.set(path.basename(dst), null);
        resolve(dst);
      } else reject(new Error('ffmpeg exit ' + code));
    });
    p.on('error', reject);
  });
}

app.post('/api/download', rateLimit, async (req, res) => {
  let url = (req.body.url || '').trim();
  const quality = req.body.quality; // number e.g. 720, 1080, or 'audio'

  if (url.startsWith('@')) {
    const uname = url.slice(1).trim().replace(/\/$/, '');
    if (uname) url = `https://www.instagram.com/stories/${uname}/`;
  } else if (/^(?:https?:\/\/)?(?:www\.)?instagram\.com\/stories\/([a-zA-Z0-9_.]+)/i.test(url)) {
    const m = url.match(/(?:instagram\.com\/stories\/)([a-zA-Z0-9_.]+)/i);
    if (m && m[1]) url = `https://www.instagram.com/stories/${m[1]}/`;
  } else if (/^(?:www\.)?instagram\.com/i.test(url)) {
    url = `https://${url.replace(/^https?:\/\//i, '')}`;
  } else if (/^(?:(?:vt|vm)\.)?tiktok\.com/i.test(url)) {
    url = `https://${url.replace(/^https?:\/\//i, '')}`;
  }

  if (!/^https?:\/\//.test(url) || !isAllowedUrl(url)) return res.json({ ok: false, error: 'URL atau domain tidak didukung' });
  const id = Date.now().toString(36);
  const job = { id, stage: 'downloading', pct: 0, name: '', waName: '', msg: 'mulai…' };
  const startStamp = purgeStamp;
  jobs.set(id, job);
  res.json({ ok: true, jobId: id });
  (async () => {
    try {
      let src, hd;
      if (/douyin\.com|iesdouyin\.com/i.test(url) && !/\.mp4(\?|$)/i.test(url)) {
        // Douyin: blokir request anonim + butuh signature JS → ambil URL stream
        // lewat Selenium + Firefox headless (buka halaman, baca src tag <video>).
        // Proses ini butuh ~20-30 detik (Firefox start + Douyin hitung signature),
        // jadi tampilkan pesan jelas + hitungan detik supaya tidak terlihat macet.
        const t0 = Date.now();
        const detik = () => Math.round((Date.now() - t0) / 1000);
        job.msg = 'sedang membuka Douyin, harap tunggu…';
        const vurl = await new Promise((resolve, reject) => {
          const ch = spawn('python', [path.join(__dirname, 'douyin_fetch.py'), url]);
          procs.set(id, ch);
          let out = '', errOut = '';
          let stage = 'sedang membuka Douyin, harap tunggu…';
          const render = () => {
            if (job.stage === 'error') return;
            // bar progres tidak boleh diam di 0% selama proses ini (terlihat macet).
            // Naik perlahan sampai 20%; unduhan mengisi 20-60%, encode 60-100%.
            if (job.pct < 20) job.pct = Math.min(20, (job.pct || 0) + 1);
            job.msg = `${stage} (${detik()} detik)`;
          };
          const tick = setInterval(render, 1000);
          const finish = (fn, arg) => {
            clearInterval(tick);
            clearTimeout(killTimer);
            procs.delete(id);
            fn(arg);
          };
          ch.stdout.on('data', d => { out += d.toString(); });
          ch.stderr.on('data', d => {
            errOut += d.toString();
            // baris terakhir stderr = tahap sekarang (menyiapkan browser / menunggu video)
            const line = d.toString().trim().split('\n').pop();
            if (line && job.stage !== 'error') { stage = line; render(); }
          });
          ch.on('close', () => {
            const u = out.trim();
            if (/^https?:\/\//.test(u)) return finish(resolve, u);
            const last = (errOut.trim().split('\n').pop() || 'gagal ambil video Douyin');
            finish(reject, new Error(last.slice(0, 200)));
          });
          ch.on('error', e => finish(reject, e));
          const killTimer = setTimeout(() => { try { ch.kill(); } catch {} }, 180000);
        });
        src = path.join(DL_DIR, `douyin_${Date.now()}.mp4`); hd = true;
        job.name = path.basename(src);
        job.msg = 'mengunduh video…';
        job.pctBase = 20; job.pctSpan = 40;
        await downloadFile(vurl, src, job);
      } else if (!/(reddit|tiktok|youtube|youtu\.be|instagram|facebook|fb\.watch|pinterest|twitter|x\.com)/i.test(url) && (/\.mp4(\?|$)/i.test(url) || /douyinvod|snssdk|zjcdn|douyinstatic/i.test(url))) {
        // Douyin: user paste URL video mentah dari F12 > Network (anti-bot Douyin
        // memblokir scraper otomatis; URL stream-nya sendiri bisa diunduh langsung)
        src = path.join(DL_DIR, `douyin_${Date.now()}.mp4`); hd = true;
        job.name = path.basename(src);
        job.msg = 'mengunduh video…';
        await downloadFile(url, src, job);
      } else if (/tiktok\.com/.test(url)) {
        const m = await tiktokMeta(url, job);
        if (m.type === 'images') {
          job.msg = 'mengunduh foto TikTok…';
          job.pct = 50;
          for (let i = 0; i < m.images.length; i++) {
            const imgUrl = m.images[i];
            const ext = (imgUrl.match(/\.(png|jpe?g|webp)/i) || ['', 'jpg'])[1].replace('jpeg', 'jpg');
            const fname = `tiktok_${m.author}_${m.id || Date.now()}${m.images.length > 1 ? '_' + (i + 1) : ''}.${ext}`;
            const dst = path.join(DL_DIR, fname);
            const buf = await fetchBuffer(imgUrl);
            fs.writeFileSync(dst, buf);
            if (i === 0) { job.name = fname; job.waName = fname; }
          }
          job.stage = 'done'; job.pct = 100; job.msg = 'selesai';
          setTimeout(() => { jobs.delete(id); }, 60000);
          return;
        } else if (m.type === 'video' && m.name && m.url) {
          src = path.join(DL_DIR, m.name); hd = m.hd;
          if (m.cover) thumbs.set(m.name, m.cover);
          job.name = m.name;
          await downloadFile(m.url, src, job);
        } else {
          job.msg = 'mengunduh video TikTok (cadangan yt-dlp)…';
          const out = path.join(DL_DIR, 'tiktok_%(id)s.%(ext)s');
          const args = ['-f', 'bv*[height<=1080]+ba/b', '--merge-output-format', 'mp4', '-o', out, '--no-playlist', url];
          await new Promise((resolve, reject) => {
            execFile('yt-dlp', args, { timeout: 600000, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
              if (err) return reject(new Error((stderr || err.message).split('\n').pop().slice(0, 300)));
              resolve();
            });
          });
          const cand = fs.readdirSync(DL_DIR).filter(f => /^tiktok_.*\.mp4$/i.test(f)).map(f => ({ f, m: fs.statSync(path.join(DL_DIR, f)).mtimeMs }))
            .sort((a, b) => b.m - a.m)[0];
          if (!cand || !cand.f) throw new Error('File hasil unduhan TikTok tidak ditemukan');
          src = path.join(DL_DIR, cand.f);
          job.name = path.basename(src); hd = true;
        }
      } else if (/x\.com|twitter\.com/i.test(url)) {
        const twMatch = url.match(/(?:status|statuses)\/(\d+)/i);
        if (twMatch) {
          try {
            let photos = [];
            try {
              const twData = await fetchJSON(`https://cdn.syndication.twimg.com/tweet-result?id=${twMatch[1]}&token=5`);
              if (twData && twData.photos && twData.photos.length && (!twData.video)) {
                photos = twData.photos.map(p => p.url).filter(Boolean);
              }
            } catch {}

            if (!photos.length) {
              try {
                const fxData = await fetchJSON(`https://api.fxtwitter.com/status/${twMatch[1]}`);
                const tw = (fxData && fxData.tweet) || {};
                if (tw.media && tw.media.photos && tw.media.photos.length && (!tw.media.videos || !tw.media.videos.length)) {
                  photos = tw.media.photos.map(p => p.url).filter(Boolean);
                }
              } catch {}
            }

            if (photos.length) {
              job.msg = `mengunduh ${photos.length} foto X…`;
              job.pct = 50;
              for (let i = 0; i < photos.length; i++) {
                let pUrl = photos[i];
                if (pUrl.includes('?')) pUrl = pUrl.split('?')[0] + '?name=orig';
                else pUrl += '?name=orig';
                const ext = (pUrl.match(/\.(png|jpe?g|webp)/i) || ['', 'jpg'])[1].replace('jpeg', 'jpg');
                const fname = `x_${twMatch[1]}${photos.length > 1 ? '_' + (i + 1) : ''}.${ext}`;
                const dst = path.join(DL_DIR, fname);
                const buf = await fetchBuffer(pUrl);
                fs.writeFileSync(dst, buf);
                if (i === 0) { job.name = fname; job.waName = fname; }
              }
              job.stage = 'done'; job.pct = 100; job.msg = `selesai (${photos.length} foto)`;
              return;
            }
          } catch {}
        }
        job.msg = 'mengunduh video X…';
        const out = path.join(DL_DIR, '%(extractor_key)s_%(id)s.%(ext)s');
        const args = ['-f', 'bv*[height<=1080]+ba/b', '--merge-output-format', 'mp4', '-o', out, '--no-playlist', url];
        await new Promise((resolve, reject) => {
          execFile('yt-dlp', args, { timeout: 600000, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || err.message).split('\n').pop().slice(0, 300)));
            resolve();
          });
        });
        const cand = fs.readdirSync(DL_DIR).filter(f => /\.(mp4|webm|mkv|mov)$/i.test(f)).map(f => ({ f, m: fs.statSync(path.join(DL_DIR, f)).mtimeMs }))
          .sort((a, b) => b.m - a.m)[0];
        if (!cand || !cand.f) throw new Error('File hasil unduhan TikTok tidak ditemukan');
        src = path.join(DL_DIR, cand.f);
        job.name = path.basename(src); hd = true;
      } else if (/reddit\.com|redd\.it/i.test(url)) {
        job.msg = 'memeriksa konten Reddit…';
        let isRedditVideo = false;
        const filename = `reddit_${Date.now()}.mp4`;
        src = path.join(DL_DIR, filename);
        const args = [
          '-f', 'bv*+ba/b',
          '--merge-output-format', 'mp4',
          '-o', src,
          '--no-playlist',
          url
        ];
        try {
          await new Promise((resolve, reject) => {
            execFile('yt-dlp', args, { timeout: 600000, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
              if (err) return reject(new Error(stderr || err.message));
              resolve();
            });
          });
          if (fs.existsSync(src)) isRedditVideo = true;
        } catch {}

        if (isRedditVideo) {
          job.name = path.basename(src);
          hd = true;
        } else {
          job.msg = 'mengunduh foto Reddit…';
          let imgUrl = '';
          try {
            const html = await fetchText(url);
            const matchOg = html.match(/<meta\s+property=["']og:image["']\s+content=["'](https?:\/\/[^"']+)["']/i);
            if (matchOg && !matchOg[1].includes('redditstatic.com')) {
              imgUrl = matchOg[1].replace(/&amp;/g, '&');
            } else {
              const matchImg = html.match(/https?:\/\/(?:i|preview)\.redd\.it\/[a-zA-Z0-9._-]+/);
              if (matchImg) imgUrl = matchImg[0];
            }
          } catch {}

          if (imgUrl) {
            const ext = (imgUrl.match(/\.(png|jpe?g|webp)/i) || ['', 'jpg'])[1].replace('jpeg', 'jpg');
            const photoName = `reddit_${Date.now()}.${ext}`;
            const photoDst = path.join(DL_DIR, photoName);
            const buf = await fetchBuffer(imgUrl);
            fs.writeFileSync(photoDst, buf);
            job.name = photoName; job.waName = photoName;
            job.stage = 'done'; job.pct = 100; job.msg = 'selesai';
            return;
          } else {
            throw new Error('Gagal mengunduh media dari Reddit');
          }
        }
      } else if (/pinterest\.com|pin\.it/i.test(url)) {
        job.msg = 'memeriksa media Pinterest…';
        let isPinVideo = false;
        const filename = `pinterest_${Date.now()}.mp4`;
        src = path.join(DL_DIR, filename);
        try {
          await new Promise((resolve, reject) => {
            execFile('yt-dlp', ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4', '-o', src, '--no-playlist', url],
              { timeout: 60000 }, (err, stdout, stderr) => {
                if (err) return reject(new Error(stderr || err.message));
                resolve();
              });
          });
          if (fs.existsSync(src)) isPinVideo = true;
        } catch {}

        if (isPinVideo) {
          job.name = filename;
          hd = true;
        } else {
          job.msg = 'mengunduh foto Pinterest…';
          let imgUrl = '';
          try {
            const html = await fetchText(url);
            const matches = html.match(/https:\/\/i\.pinimg\.com\/(?:originals|\d+x)\/[a-zA-Z0-9/_.-]+\.(?:jpg|jpeg|png|webp)/gi);
            if (matches && matches.length) {
              imgUrl = matches[0].replace(/\/\d+x\//, '/originals/');
            }
          } catch {}
          if (imgUrl) {
            const ext = (imgUrl.match(/\.(png|jpe?g|webp)/i) || ['', 'jpg'])[1].replace('jpeg', 'jpg');
            const fname = `pinterest_${Date.now()}.${ext}`;
            const dst = path.join(DL_DIR, fname);
            const buf = await fetchBuffer(imgUrl);
            fs.writeFileSync(dst, buf);
            job.name = fname; job.waName = fname;
            job.stage = 'done'; job.pct = 100; job.msg = 'selesai';
            return;
          } else {
            throw new Error('Gagal mengunduh media dari Pinterest');
          }
        }
      } else if (/instagram\.com/i.test(url)) {
        job.msg = 'memeriksa media Instagram…';
        const storyMatch = url.match(/\/stories\/([a-zA-Z0-9_.]+)/i);
        const cookieFile = path.join(__dirname, 'cookies.txt');

        if (storyMatch) {
          const username = storyMatch[1];
          job.msg = `mengunduh story @${username}…`;
          job.pct = 20;
          const outTpl = path.join(DL_DIR, `story_${username}_%(id)s.%(ext)s`);
          const thumbTpl = path.join(DL_DIR, `story_${username}_%(id)s_thumb.%(ext)s`);
          const args = [
            '--cookies', cookieFile,
            '--write-thumbnail',
            '--convert-thumbnails', 'jpg',
            '-f', 'bv*+ba/b',
            '--merge-output-format', 'mp4',
            '-o', outTpl,
            '-o', `thumbnail:${thumbTpl}`,
            url
          ];
          await new Promise((resolve, reject) => {
            const ch = execFile('yt-dlp', args, { timeout: 180000, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
              if (err) return reject(new Error(stderr || err.message));
              resolve();
            });
            procs.set(id, ch);
          });
          const downloaded = fs.readdirSync(DL_DIR)
            .filter(f => f.startsWith(`story_${username}_`) && !f.endsWith('_thumb.jpg'))
            .map(f => ({ f, m: fs.statSync(path.join(DL_DIR, f)).mtimeMs }))
            .filter(x => Date.now() - x.m < 180000)
            .sort((a, b) => b.m - a.m);

          if (downloaded.length) {
            downloaded.forEach(item => {
              if (item.f.endsWith('.mp4')) makeThumb(path.join(DL_DIR, item.f));
            });
            job.name = downloaded[0].f;
            job.waName = downloaded[0].f;
            job.stage = 'done'; job.pct = 100; job.msg = `selesai (${downloaded.length} story)`;
            return;
          } else {
            throw new Error(`Tidak ada story aktif atau akun @${username} privat`);
          }
        }

        const scMatch = url.match(/\/(?:p|reel|tv)\/([a-zA-Z0-9_-]+)/);
        const shortcode = scMatch ? scMatch[1] : '';

        // Coba jalur resmi via cookies.txt (mendukung carousel multi-foto & resolusi HD penuh)
        const cookieHdr = getCookieHeader(cookieFile);
        let igHandled = false;

        if (shortcode && cookieHdr) {
          try {
            const pk = shortcodeToPk(shortcode);
            const igApiUrl = `https://www.instagram.com/api/v1/media/${pk}/info/`;
            const igData = await fetchJSON(igApiUrl, {
              'X-IG-App-ID': '936619743392459',
              'X-ASBD-ID': '359341',
              'X-IG-WWW-Claim': '0',
              'Cookie': cookieHdr,
              'Origin': 'https://www.instagram.com',
              'Referer': `https://www.instagram.com/p/${shortcode}/`,
              'Accept': '*/*',
            });

            if (igData && igData.items && igData.items.length) {
              const item = igData.items[0];
              // Carousel / Album multi-foto
              if (item.carousel_media && Array.isArray(item.carousel_media) && item.carousel_media.length) {
                const total = item.carousel_media.length;
                job.msg = `mengunduh 0/${total} foto Instagram…`;
                job.pct = 10;
                for (let i = 0; i < total; i++) {
                  const cm = item.carousel_media[i];
                  const cands = cm.image_versions2 && cm.image_versions2.candidates;
                  if (cands && cands.length) {
                    const imgUrl = cands[0].url;
                    const fname = `instagram_${shortcode}_${i + 1}.jpg`;
                    const dst = path.join(DL_DIR, fname);
                    const buf = await fetchBuffer(imgUrl);
                    fs.writeFileSync(dst, buf);
                    if (i === 0) { job.name = fname; job.waName = fname; }
                    job.msg = `mengunduh ${i + 1}/${total} foto Instagram…`;
                    job.pct = Math.round(10 + ((i + 1) / total) * 85);
                  }
                }
                job.stage = 'done'; job.pct = 100; job.msg = 'selesai';
                igHandled = true;
                return;
              } else if (item.image_versions2 && item.image_versions2.candidates && item.image_versions2.candidates.length) {
                // Foto tunggal resolusi penuh
                job.msg = 'mengunduh foto Instagram…';
                const imgUrl = item.image_versions2.candidates[0].url;
                const fname = `instagram_${shortcode}.jpg`;
                const dst = path.join(DL_DIR, fname);
                const buf = await fetchBuffer(imgUrl);
                fs.writeFileSync(dst, buf);
                job.name = fname; job.waName = fname;
                job.stage = 'done'; job.pct = 100; job.msg = 'selesai';
                igHandled = true;
                return;
              }
            }
          } catch (e) {
            console.log('[Instagram API Error]', e.message);
          }
        }

        if (!igHandled) {
          let isIgVideo = false;
          const out = path.join(DL_DIR, '%(extractor_key)s_%(id)s.%(ext)s');
          const args = ['-f', 'bv*[height<=1080]+ba/b', '--merge-output-format', 'mp4', '-o', out, '--no-playlist', url];
          try {
            await new Promise((resolve, reject) => {
              execFile('yt-dlp', args, { timeout: 60000, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
                if (err) return reject(new Error(stderr || err.message));
                resolve();
              });
            });
            const cand = fs.readdirSync(DL_DIR).filter(f => /\.(mp4|webm|mkv|mov)$/i.test(f))
              .map(f => ({ f, m: fs.statSync(path.join(DL_DIR, f)).mtimeMs }))
              .sort((a, b) => b.m - a.m)[0];
            if (cand && (Date.now() - cand.m < 60000)) {
              src = path.join(DL_DIR, cand.f);
              job.name = path.basename(src);
              hd = true;
              isIgVideo = true;
            }
          } catch {}

          if (!isIgVideo) {
            job.msg = 'mengunduh foto Instagram…';
            let imgUrl = '';
            try {
              const html = await new Promise((resolve, reject) => {
                const reqHeaders = { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' };
                https.get(url, { headers: reqHeaders }, res => {
                  if (res.statusCode >= 300 && res.headers.location) {
                    return https.get(res.headers.location, { headers: reqHeaders }, r2 => {
                      let d = ''; r2.on('data', c => d += c); r2.on('end', () => resolve(d));
                    }).on('error', reject);
                  }
                  let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
                }).on('error', reject);
              });
              const og = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
              if (og && og[1]) imgUrl = og[1].replace(/&amp;/g, '&');
            } catch {}

            if (imgUrl) {
              const fname = `instagram_${shortcode || Date.now()}.jpg`;
              const dst = path.join(DL_DIR, fname);
              const buf = await fetchBuffer(imgUrl);
              fs.writeFileSync(dst, buf);
              job.name = fname; job.waName = fname;
              job.stage = 'done'; job.pct = 100; job.msg = 'selesai';
              return;
            } else {
              throw new Error('Gagal mengunduh media dari Instagram');
            }
          }
        }
      } else {
        const isAudio = quality === 'audio';
        job.msg = isAudio ? 'mengunduh audio MP3…' : `mengunduh stream video ${quality ? '(' + quality + 'p)' : ''}…`;
        const out = path.join(DL_DIR, '%(extractor_key)s_%(id)s.%(ext)s');
        const args = isAudio
          ? ['-x', '--audio-format', 'mp3', '-o', out, '--no-playlist', url]
          : ['-f', quality ? `bv*[height<=${quality}]+ba/b` : 'bv*[height<=1080]+ba/b',
             '--merge-output-format', 'mp4', '-o', out, '--no-playlist', url];

        await new Promise((resolve, reject) => {
          execFile('yt-dlp', args, { timeout: 600000, maxBuffer: 1 << 24 },
            (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).split('\n').pop().slice(0, 300))) : resolve());
        });

        if (isAudio) {
          const cand = fs.readdirSync(DL_DIR).filter(f => /\.mp3$/i.test(f)).map(f => ({ f, m: fs.statSync(path.join(DL_DIR, f)).mtimeMs }))
            .sort((a, b) => b.m - a.m)[0];
          if (!cand || !cand.f) throw new Error('File hasil unduhan audio tidak ditemukan');
          src = path.join(DL_DIR, cand.f);
          job.name = path.basename(src);
          job.waName = job.name;
          job.stage = 'done'; job.pct = 100; job.msg = 'selesai';
          return;
        }

        const cand = fs.readdirSync(DL_DIR).filter(f => /\.(mp4|webm|mkv|mov)$/i.test(f)).map(f => ({ f, m: fs.statSync(path.join(DL_DIR, f)).mtimeMs }))
          .sort((a, b) => b.m - a.m)[0];
        if (!cand || !cand.f) throw new Error('File hasil unduhan video tidak ditemukan');
        src = path.join(DL_DIR, cand.f);
        job.name = path.basename(src); hd = true;
      }
      // Tujuan akhirnya: tombol HD di WhatsApp harus HIDUP, dan itu hanya muncul
      // kalau video ≥1080p. Kalau sumber sudah ≥1080p DAN ≤3,5 Mbps, file asli
      // sudah ideal → pakai apa adanya. Selain itu wajib di-encode ke 1080p,
      // kalau tidak WA akan menganggapnya "bukan HD" dan memaksa 480p.
      const info = await probe(src);
      const shortSide = info.width && info.height ? Math.min(info.width, info.height) : 0;
      let dst;
      if (shortSide >= 1080 && info.vbps && info.vbps <= 3500000) {
        dst = src; job.msg = 'asli sudah HD (tanpa encode)';
      } else {
        job.stage = 'encoding';
        // encode menempati porsi 60-100% dari bar (unduhan sudah mengisi 0-60%)
        job.pctBase = 60; job.pctSpan = 40;
        job.msg = 'encode WA HD 0%';
        dst = await encodeWA(src, job, info);
        // WA status menolak file > 16 MB — kalau kelewat, encode ulang dengan
        // bitrate lebih rendah (target 13 MB) supaya benar-benar bisa diposting.
        try {
          const st = fs.statSync(dst);
          if (st.size > 16 * 1024 * 1024 && info.dur > 0) {
            job.msg = 'kecilkan ke bawah 16 MB…';
            const cap = Math.floor((13 * 1024 * 1024 * 8) / info.dur);
            fs.unlinkSync(dst);
            dst = await encodeWA(src, job, info, cap);
          }
        } catch { /* biarkan: user masih bisa cek ukurannya */ }
      }
      makeThumb(src);
      if (dst !== src) makeThumb(dst);
      if (startStamp !== purgeStamp || job.stage === 'error') {
        // user hapus semua / tekan ✕ saat proses jalan → buang hasilnya
        for (const f of [src, dst]) { try { fs.unlinkSync(f); } catch {} }
        job.stage = 'error'; job.msg = 'dibatalkan';
        return;
      }
      job.stage = 'done'; job.pct = 100; job.msg = 'selesai';
      job.waName = path.basename(dst);
      job.hd = hd;
      setTimeout(() => { jobs.delete(id); }, 45000);
    } catch (e) {
      job.stage = 'error'; job.msg = (e.message || 'gagal').slice(0, 200);
      setTimeout(() => { jobs.delete(id); }, 30000);
    }
  })();
});

app.get('/api/jobs', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json([...jobs.entries()].map(([id, j]) => ({ id, ...j })));
});

app.get('/api/download-all-zip', (req, res) => {
  const files = fs.readdirSync(DL_DIR)
    .filter(f => /\.(mp4|webm|mkv|mov|mp3|jpg|jpeg|png|webp)$/i.test(f))
    .filter(f => !/_thumb\.jpg$/i.test(f));

  if (!files.length) {
    return res.status(404).send('Tidak ada file untuk diunduh');
  }

  const zipName = `unduhan_${Date.now()}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on('error', err => {
    console.error('Archive error:', err);
    if (!res.headersSent) res.status(500).send({ error: err.message });
  });

  archive.pipe(res);

  for (const f of files) {
    const fullPath = path.join(DL_DIR, f);
    if (fs.existsSync(fullPath)) {
      archive.file(fullPath, { name: f });
    }
  }

  archive.finalize();
});

app.get('/api/files', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const fs_ = fs.readdirSync(DL_DIR)
    .filter(f => /\.(mp4|webm|mkv|mov|mp3|jpg|jpeg|png|webp)$/i.test(f))
    .filter(f => !/_thumb\.jpg$/i.test(f))
    .map(f => ({ name: f, size: fs.statSync(path.join(DL_DIR, f)).size, mtime: fs.statSync(path.join(DL_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime).slice(0, 30);
  res.json(fs_);
});

// inspect format / resolusi video sebelum unduh (terutama YouTube)
app.post('/api/inspect', rateLimit, (req, res) => {
  const url = (req.body.url || '').trim();
  if (!/^https?:\/\//.test(url) || !isAllowedUrl(url)) return res.json({ ok: false, error: 'URL tidak valid atau domain tidak didukung' });

  execFile('yt-dlp', ['-J', '--no-playlist', url], { timeout: 35000, maxBuffer: 15 << 20 }, (err, stdout, stderr) => {
    if (err) {
      return res.json({ ok: false, error: (stderr || err.message).split('\n').pop().slice(0, 200) });
    }
    try {
      const data = JSON.parse(stdout);
      const formats = data.formats || [];
      const rawHeights = formats.map(f => f.height).filter(h => typeof h === 'number' && h >= 240);
      const uniqueHeights = [...new Set(rawHeights)].sort((a, b) => b - a);

      // Best audio size for estimating total
      const bestAudio = formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
        .sort((a, b) => (b.filesize || b.filesize_approx || 0) - (a.filesize || a.filesize_approx || 0))[0];
      const audioSize = bestAudio ? (bestAudio.filesize || bestAudio.filesize_approx || 0) : 0;

      const standardList = [2160, 1440, 1080, 720, 480, 360];
      const available = [];
      for (const h of standardList) {
        if (uniqueHeights.some(uh => Math.abs(uh - h) <= 20)) {
          let label = `${h}p`;
          let note = '';
          if (h === 2160) { label += ' (4K UHD)'; note = 'Kualitas tertinggi'; }
          else if (h === 1440) { label += ' (2K QHD)'; note = 'Sangat tajam'; }
          else if (h === 1080) { label += ' (Full HD)'; note = 'Rekomendasi'; }
          else if (h === 720) { label += ' (HD)'; note = 'Standar jernih'; }
          else if (h === 480) { label += ' (SD)'; note = 'Ukuran hemat'; }
          else { note = 'Super ringan'; }
          // Find best video format for this height
          const vidFmt = formats.filter(f => f.height && Math.abs(f.height - h) <= 20 && f.vcodec && f.vcodec !== 'none' && (f.filesize || f.filesize_approx))
            .sort((a, b) => (b.filesize || b.filesize_approx || 0) - (a.filesize || a.filesize_approx || 0))[0];
          const vidSize = vidFmt ? (vidFmt.filesize || vidFmt.filesize_approx || 0) : 0;
          const estSize = vidSize + audioSize;
          available.push({ quality: h, label, note, isBest: h === 1080, size: estSize || null });
        }
      }
      if (available.length === 0 && uniqueHeights.length > 0) {
        available.push({ quality: uniqueHeights[0], label: `${uniqueHeights[0]}p`, note: 'Terbaik' });
      }
      available.push({ quality: 'audio', label: 'Audio Saja (MP3)', note: 'Format lagu / podcast', size: audioSize || null });

      res.json({
        ok: true,
        title: data.title || 'Video',
        thumbnail: data.thumbnail || '',
        duration: data.duration || 0,
        formats: available
      });
    } catch (e) {
      res.json({ ok: false, error: 'Gagal membaca format video' });
    }
  });
});

app.get('/api/thumb/:name', async (req, res) => {
  const name = path.basename(req.params.name);
  if (/\.(jpg|jpeg|png|webp)$/i.test(name)) {
    const localImg = path.join(DL_DIR, name);
    if (fs.existsSync(localImg)) {
      res.setHeader('Content-Type', name.endsWith('.png') ? 'image/png' : 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return fs.createReadStream(localImg).pipe(res);
    }
  }
  const url = thumbs.get(name);
  // 1) thumbnail hasil ekstrak ffmpeg (untuk file WA / file tanpa cover)
  const local = path.join(DL_DIR, name.replace(/\.mp4$/i, '') + '_thumb.jpg');
  if (fs.existsSync(local)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return fs.createReadStream(local).pipe(res);
  }
  // 2) cover dari TikTok (di-cache ke disk saat pertama)
  if (!url) return res.status(404).end();
  try {
    const buf = await fetchBuffer(url);
    fs.writeFileSync(local, buf);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch { res.status(404).end(); }
});

// ekstrak frame pertama sebagai thumbnail
function makeThumb(videoPath) {
  const out = videoPath.replace(/\.mp4$/i, '') + '_thumb.jpg';
  execFile('ffmpeg', ['-y', '-i', videoPath, '-ss', '00:00:01', '-vframes', '1',
    '-vf', "scale='min(360,iw)':-2", '-q:v', '5', out],
    { timeout: 60000 }, () => {});
}

// hapus file dari daftar + disk (termasuk thumbnail)
app.delete('/api/file/:name', (req, res) => {
  const raw = path.basename(req.params.name);
  const base = raw.replace(/\.(mp4|mp3|webm|mkv|jpg|jpeg|png|webp)$/i, '').replace(/_wa$/i, '');
  let deleted = 0;
  for (const f of [base + '.mp4', base + '_wa.mp4', base + '.mp3', base + '.jpg', base + '.png', base + '.webp', base + '_thumb.jpg', base + '_wa_thumb.jpg', raw]) {
    const fp = path.join(DL_DIR, f);
    if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); deleted++; } catch {} }
  }
  thumbs.delete(base + '.mp4');
  thumbs.delete(base + '_wa.mp4');
  thumbs.delete(base + '.mp3');
  thumbs.delete(raw);
  // buang kartu job untuk file ini supaya tidak "balik lagi" di daftar
  for (const [id, j] of jobs) {
    if ((j.name && j.name.startsWith(base)) || (j.waName && j.waName.startsWith(base))) jobs.delete(id);
  }
  res.json({ ok: true, deleted });
});

// hapus file job (asli + versi WA + thumbnail). Di Windows, ffmpeg yang masih
// hidup memegang file-nya → unlink gagal. Jadi coba beberapa kali dengan jeda.
function wipeJobFiles(job, tries = 6) {
  const names = [];
  for (const n of [job.name, job.waName]) {
    if (!n) continue;
    const base = path.basename(n).replace(/\.mp4$/i, '');
    names.push(base + '.mp4', base + '_wa.mp4', base + '_thumb.jpg', base + '_wa_thumb.jpg');
  }
  const attempt = () => {
    let left = 0;
    for (const f of names) {
      const fp = path.join(DL_DIR, f);
      if (!fs.existsSync(fp)) continue;
      try { fs.unlinkSync(fp); } catch { left++; }
    }
    if (left && tries-- > 0) setTimeout(attempt, 500);
  };
  attempt();
}

// ✕ di kartu link/job: batalkan proses (kalau masih jalan) + hapus file + buang kartu
app.delete('/api/job/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (j) {
    j.stage = 'error'; j.msg = 'dibatalkan';   // downloadFile/encodeWA melihat ini lalu berhenti
    // matikan proses yang sedang jalan (python/Selenium, ffmpeg) beserta anak-anaknya.
    // taskkill /T penting: kalau python dibunuh saja, Firefox headless-nya jadi yatim.
    const ch = procs.get(req.params.id);
    if (ch && ch.pid) {
      try {
        if (process.platform === 'win32') {
          execFile('taskkill', ['/PID', String(ch.pid), '/T', '/F'], () => {});
        } else {
          process.kill(-ch.pid, 'SIGKILL');
        }
      } catch {
        try { ch.kill('SIGKILL'); } catch {}
      }
    }
    procs.delete(req.params.id);
    // hapus file yang sudah jadi (asli + versi WA + thumbnail)
    wipeJobFiles(j);
    jobs.delete(req.params.id);
  }
  res.json({ ok: true });
});

app.post('/api/clear', (req, res) => {
  let n = 0;
  for (const f of fs.readdirSync(DL_DIR)) {
    try { fs.unlinkSync(path.join(DL_DIR, f)); n++; } catch {}
  }
  thumbs.clear();
  // job yang masih jalan akan menulis ulang file setelah dihapus → tandai dibatalkan
  // lalu buang dari daftar supaya kartu "riwayat" ikut hilang
  purgeStamp = Date.now();
  for (const j of jobs.values()) if (j.stage === 'downloading' || j.stage === 'encoding') {
    j.stage = 'error'; j.msg = 'dibatalkan (file dihapus)';
  }
  for (const [jid, ch] of procs) {
    if (ch && ch.pid) {
      try {
        if (process.platform === 'win32') {
          execFile('taskkill', ['/PID', String(ch.pid), '/T', '/F'], () => {});
        } else {
          try { process.kill(-ch.pid, 'SIGKILL'); } catch { ch.kill('SIGKILL'); }
        }
      } catch {}
    }
    procs.delete(jid);
  }
  jobs.clear();
  res.json({ ok: true, deleted: n });
});

app.get('/api/file/:name', (req, res) => {
  const p = path.join(DL_DIR, path.basename(req.params.name));
  if (!fs.existsSync(p)) return res.status(404).end();
  const ext = path.extname(p).toLowerCase();
  const ct = (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg'
    : ext === '.png' ? 'image/png'
    : ext === '.webp' ? 'image/webp'
    : ext === '.mp3' ? 'audio/mpeg'
    : 'video/mp4';
  if (req.query.dl) res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(path.basename(p)) + '"');
  res.setHeader('Content-Type', ct);
  const stat = fs.statSync(p), range = req.headers.range;
  if (range && ct === 'video/mp4') {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    const start = +m[1], end = m[2] ? +m[2] : stat.size - 1;
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': ct });
    fs.createReadStream(p, { start, end }).pipe(res);
  } else {
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(p).pipe(res);
  }
});

// Pembersihan otomatis: hapus file unduhan yang berumur > 1 jam
const MAX_AGE_MS = 60 * 60 * 1000;
function autoCleanup() {
  const now = Date.now();
  try {
    const files = fs.readdirSync(DL_DIR);
    for (const f of files) {
      const fp = path.join(DL_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          fs.unlinkSync(fp);
          thumbs.delete(f);
        }
      } catch {}
    }
  } catch {}
}
setInterval(autoCleanup, 10 * 60 * 1000);
autoCleanup();

app.listen(PORT, '0.0.0.0', () => console.log(`Server: http://localhost:${PORT}`));
