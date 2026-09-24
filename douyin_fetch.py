"""Ambil URL stream video Douyin lewat Selenium + Firefox headless.

Dipakai server.js: python douyin_fetch.py "<url douyin>"  ->  cetak URL .mp4 ke stdout.

Douyin memblokir request anonim (403) dan butuh signature JS, jadi satu-satunya
cara andal: buka halaman di browser sungguhan, ambil src dari tag <video>.

CATATAN KECEPATAN (hasil pengukuran 2026-09-16):
  - Firefox start dingin   : ~7 detik  (tidak bisa dihindari)
  - d.get() dengan strategi "normal": menunggu halaman benar-benar selesai —
    halaman Douyin TIDAK PERNAH selesai (streaming terus) → membuang ~50 detik.
  - d.get() dengan strategi "eager" (berhenti di DOMContentLoaded): ~1-2 detik.
  - URL stream baru muncul ~17 detik setelah start (Douyin menghitung signature
    di browser). Ini batas dari Douyin, bukan sesuatu yang bisa dipercepat.
  Total realistis: ~18-20 detik per video.
"""
import sys
import time
import json

from selenium import webdriver
from selenium.webdriver.firefox.options import Options

FIREFOX = r"C:\Program Files\Mozilla Firefox\firefox.exe"

# Berapa lama menunggu URL stream muncul (detik) sebelum menyerah.
MAX_WAIT = 30


def log(msg: str) -> None:
    """Progress ke stderr — server bisa menampilkannya, stdout khusus URL."""
    print(msg, file=sys.stderr, flush=True)


def get_video_url(url: str, wait: int = MAX_WAIT) -> str:
    opts = Options()
    opts.binary_location = FIREFOX
    opts.add_argument("-headless")
    # PENTING: browser ini dipakai untuk membaca URL video, bukan untuk menonton.
    # Tanpa mute, audio video Douyin ikut keluar dari speaker laptop.
    # Jangan blokir autoplay — kalau diblokir, video tidak dimuat dan URL tidak muncul.
    opts.set_preference("media.volume_scale", "0.0")      # volume output = 0
    opts.set_preference("media.autoplay.default", 0)      # tetap boleh autoplay
    opts.set_preference("media.autoplay.allow-muted", True)
    # jangan tunggu gambar/font/iklan selesai — cukup DOM siap
    opts.page_load_strategy = "eager"

    d = webdriver.Firefox(options=opts)
    d.set_page_load_timeout(12)          # eager: halaman siap cepat; timeout pendek
    try:
        log("menyiapkan browser…")
        try:
            d.get(url)
        except Exception:
            pass  # timeout load tidak masalah, DOM sudah terisi
        log("membaca halaman Douyin…")

        # kalau link-nya sudah mati, Douyin melempar ke halaman depan (tanpa /video/)
        # → tidak ada gunanya menunggu 30 detik, langsung beri tahu.
        # (halaman depan juga punya tag <video> untuk feed, jadi cek URL-nya, bukan elemennya)
        for _ in range(8):
            if "/video/" in (d.current_url or ""):
                break
            time.sleep(0.5)
        if "/video/" not in (d.current_url or ""):
            raise RuntimeError("link tidak mengarah ke video (mungkin sudah dihapus/dibatasi)")
        log("membaca halaman video…")

        deadline = time.time() + wait
        best = None
        n = 0
        while time.time() < deadline:
            try:
                d.execute_script('document.querySelectorAll("video").forEach(v=>{v.muted=true;v.volume=0})')
            except Exception:
                pass
            cands = d.execute_script(
                'return Array.from(document.querySelectorAll("video"))'
                '.map(v=>({s:v.src||v.currentSrc,d:v.duration||0,w:v.videoWidth||0,h:v.videoHeight||0}))'
                '.filter(x=>x.s&&(x.s.includes(".mp4")||x.s.includes("video/tos")||x.s.includes("douyinvod")||x.s.includes("zjcdn")))'
            )
            # halaman Douyin punya beberapa tag <video> (iklan/placeholder/preview).
            # Placeholder durasinya ~2,6 detik dan sering muncul LEBIH DULU, jadi jangan
            # langsung pulang: kumpulkan kandidat, pilih durasi terpanjang.
            cands = [c for c in cands if c["d"] and c["d"] > 1.0]
            for c in cands:
                if best is None or c["d"] > best["d"]:
                    best = c
            if best and best["d"] > 8.0:      # video asli sudah termuat → cukup
                return best["s"]
            n += 1
            if n % 8 == 0:
                log("menunggu video dimuat…")
            time.sleep(0.3)

        if best:
            return best["s"]
        # tidak ada video sama sekali → kemungkinan link mati / sudah dihapus
        cur = d.current_url or ""
        if "/video/" not in cur:
            raise RuntimeError("link tidak mengarah ke video (mungkin sudah dihapus/dibatasi)")
        raise RuntimeError("video tidak termuat dalam waktu tunggu")
    finally:
        try:
            d.quit()
        except Exception:
            pass


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        print(get_video_url(target) or "")
    except Exception as e:  # noqa: BLE001
        print(str(e), file=sys.stderr)
        sys.exit(1)
