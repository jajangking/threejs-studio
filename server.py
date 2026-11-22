#!/usr/bin/env python3
"""Studio server: static files + API state/scene/feedback + live AI agent chat.

Single source of truth: scene.json di root proyek.
Agent menulis scene.json + iterations/; user melihat via studio & menyimpan edit via POST.
Semua dependensi = python stdlib. Tidak ada paket baru.
"""
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request, urllib.parse
import html as htmlmod
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get('STUDIO_PORT', '8091'))
LOCK = threading.Lock()          # menulis scene.json / feedback.json
CHAT_LOCK = threading.Lock()     # satu job agent aktif

ROUTER_URL = 'http://127.0.0.1:8645/v1/chat/completions'
ROUTER_MODELS_URL = 'http://127.0.0.1:8645/v1/models'
OPENCODE_URL = 'http://127.0.0.1:49374'
HERMES_URL = 'http://127.0.0.1:8642/v1/chat/completions'

# Urutan fallback model gratis di router (yang pertama paling kuat).
FREE_ROUTER_MODELS = [
    'qwen/qwen4-max:free',
    'meituan/longcat-2.5:free',
    'upstage/solar-mini4:free',
    'tencent/hy4-flash:free',
    'stepfun/step-3.7-flash:free',
]
DEFAULT_MODEL = 'qwen/qwen4-max:free'
OPENCODE_FALLBACK_MODELS = ['big-pickle', 'deepseek-v4.1-flash-free', 'minimax-m3.1-flash-free']
HERMES_MODELS = ['hermes-4-405b']

KNOWN_OBJECT_TYPES = {
    'box', 'sphere', 'cylinder', 'cone', 'torus', 'torusKnot', 'plane',
    'capsule', 'icosahedron', 'ring', 'gltf', 'sky', 'stars', 'instances', 'group', 'rope', 'trigger',
}
KNOWN_LIGHT_TYPES = {'ambient', 'hemisphere', 'directional', 'point', 'spot'}

# ── Riset knowledge card dari internet (web_search → extract → sitasi ledger) ──
KB = {}
KB_LOCK = __import__('threading').Lock()
SOURCES_PY = os.path.expanduser('~/.hermes/skills/research/grounded-citations/scripts/sources.py')

def kb_research(job, topic):
    try:
        ledger = os.path.join(ROOT, '.kb-ledger-' + job + '.json')
        SC = ['python3', SOURCES_PY, '--ledger', ledger]
        subprocess.run([*SC, 'reset'], capture_output=True, timeout=20)
        ua = {'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36'}
        urls = []
        try:
            req = urllib.request.Request('https://www.bing.com/search?q=' + urllib.parse.quote(topic), headers=ua)
            page = urllib.request.urlopen(req, timeout=25).read().decode('utf-8', 'ignore')
            for href in re.findall(r'<h2[^>]*>.*?<a[^>]*href="([^"]+)"', page, re.S):
                href = htmlmod.unescape(href)
                m = re.search(r'[?&]u=a1([^&]+)', href)
                if m:
                    b = m.group(1)
                    b += '=' * (-len(b) % 4)
                    real = base64.urlsafe_b64decode(b).decode('utf-8', 'ignore')
                else:
                    real = href
                if real.startswith('http') and real not in urls:
                    urls.append(real)
        except Exception:
            pass
        if not urls:  # fallback: DDG -> Wikipedia
            try:
                req = urllib.request.Request('https://html.duckduckgo.com/html/?q=' + urllib.parse.quote(topic), headers=ua)
                page = urllib.request.urlopen(req, timeout=20).read().decode('utf-8', 'ignore')
                for href in re.findall(r'class="result__a"[^>]*href="([^"]+)"', page):
                    real = urllib.parse.parse_qs(urllib.parse.urlparse(href).query).get('uddg', [href])[0]
                    if real.startswith('http') and real not in urls:
                        urls.append(real)
            except Exception:
                pass
        if not urls:
            try:
                req = urllib.request.Request('https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
                                             urllib.parse.quote(topic) + '&format=json', headers=ua)
                hits = json.loads(urllib.request.urlopen(req, timeout=20).read().decode('utf-8', 'ignore'))
                urls = ['https://en.wikipedia.org/wiki/' + urllib.parse.quote(x['title'].replace(' ', '_'))
                        for x in (hits.get('query') or {}).get('search', [])[:4]]
            except Exception:
                pass
        if not urls:
            raise RuntimeError('tidak ada hasil pencarian')
        urls = urls[:4]
        excerpts = []
        for i, u in enumerate(urls):
            try:
                rq = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
                raw = urllib.request.urlopen(rq, timeout=18).read().decode('utf-8', 'ignore')
                txt = re.sub(r'<script.*?</script>|<style.*?</style>', ' ', raw, flags=re.S | re.I)
                txt = re.sub(r'<[^>]+>', ' ', txt)
                txt = re.sub(r'\s+', ' ', txt).strip()
                excerpts.append(f'[{i + 1}] {u}\n{txt[:5500]}')
            except Exception as e:
                excerpts.append(f'[{i + 1}] {u}\n(gagal diambil: {e})')
        add = subprocess.run([*SC, 'add', *urls], capture_output=True, timeout=20)
        if add.returncode != 0:
            raise RuntimeError('ledger gagal: ' + add.stderr.decode()[-200:])
        q = ('Kamu peneliti komponen 3D. Dari ekstrak halaman berikut, susun SATU knowledge card JSON valid '
             'untuk agent pembuat scene Three.js. Format: '
             '{"id":"slug","title":"judul","keywords":["kata kunci"],"facts":"fakta teknis ringkas & terukur "'
             'dengan sitasi [n] pada tiap kalimat","required_parts":[{"key":"...","label":"...","keywords":["..."],"min":1}],'
             '"note":"catatan"}. Gunakan HANYA nomor sumber [1]-[%d] yang diberikan. '
             'Jangan mengarang angka tanpa sumber; beri label [unverified] bila perlu. '
             'Balas HANYA JSON.\n\n' % len(excerpts) + '\n\n'.join(excerpts))
        raw = call_router('tencent/hy4-flash:free', [
            {'role': 'system', 'content': 'Kamu peneliti teknis. Balas JSON valid saja.'},
            {'role': 'user', 'content': q}], max_tokens=3000)
        text = raw[0] if isinstance(raw, tuple) else raw
        card = extract_json_object(text)
        def templated(c):
            return (not c or str(c.get('id')) == 'slug' or 'Format:' in str(c.get('facts'))
                    or 'kata kunci' in str(c.get('keywords'))
                    or any(str(p.get('label')) == '...' for p in (c.get('required_parts') or [])))
        if templated(card):  # model kadang mengembalikan contoh template — coba model lain sekali
            raw2 = call_router('qwen/qwen4-max:free', [
                {'role': 'system', 'content': 'Balas HANYA JSON card yang sudah diisi, BUKAN contoh format.'},
                {'role': 'user', 'content': q}], max_tokens=3000)
            t2 = raw2[0] if isinstance(raw2, tuple) else raw2
            card = extract_json_object(t2)
        if templated(card):
            raise RuntimeError('model menghasilkan card template — coba topik yang lebih spesifik')
        if not isinstance(card.get('required_parts'), list):
            raise RuntimeError('model tidak menghasilkan card valid')
        slug = re.sub(r'[^a-z0-9-]', '-', str(card.get('id') or topic).lower()).strip('-')[:48] or 'card'
        card['sources'] = [{'n': i + 1, 'url': u} for i, u in enumerate(urls)]
        card['researched_at'] = time.time()
        with open(os.path.join(KNOWLEDGE_DIR, slug + '.json'), 'w') as f:
            json.dump(card, f, ensure_ascii=False, indent=2)
        md = (f"# {card.get('title', topic)}\n\n{card.get('facts', '')}\n\n"
              f"## Komponen wajib\n" + '\n'.join(f"- {p.get('label')}: {p.get('keywords')} (min {p.get('min', 1)})"
                                                   for p in card['required_parts']) + '\n')
        mdp = os.path.join(KNOWLEDGE_DIR, slug + '.md')
        with open(mdp, 'w') as f:
            f.write(md)
        render = subprocess.run([*SC, 'render', '--style', 'plain'], capture_output=True, timeout=20)
        if render.returncode == 0:
            with open(mdp, 'a') as f:
                f.write('\n' + render.stdout.decode('utf-8', 'ignore'))
        verify = subprocess.run([*SC, 'verify', mdp], capture_output=True, timeout=20)
        with KB_LOCK:
            KB[job] = {'status': 'done', 'slug': slug, 'card': card,
                       'verified': verify.returncode == 0,
                       'verify': (verify.stdout + verify.stderr).decode('utf-8', 'ignore')[-400:]}
    except Exception as e:
        with KB_LOCK:
            KB[job] = {'status': 'error', 'error': str(e)}

# ── Imitasi gerak kamera dari clip referensi (vision pada contact sheet) ──
CLIP = {}

def heuristic_clip_analysis(src):
    """Fallback tanpa model: estimasi pan/zoom dari pergeseran piksel antar frame."""
    W, H = 160, 90
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', src, '-vf', 'fps=2,scale=160:90,format=gray',
                                   '-f', 'rawvideo', '-'], timeout=120)
    sz = W * H
    frames = [raw[i * sz:(i + 1) * sz] for i in range(len(raw) // sz)]
    shifts = []
    for a, b in zip(frames, frames[1:]):
        best = (1e9, 0, 0)
        for dy in range(-6, 7):
            for dx in range(-6, 7):
                sad, cnt = 0, 0
                for y in range(8, H - 8, 3):
                    for x in range(8, W - 8, 3):
                        x2, y2 = x + dx, y + dy
                        if 0 <= x2 < W and 0 <= y2 < H:
                            sad += abs(a[y * W + x] - b[y2 * W + x2]); cnt += 1
                if cnt:
                    sad /= cnt
                    if sad < best[0]: best = (sad, dx, dy)
        shifts.append(best)
    if not shifts:
        raise RuntimeError('clip terlalu pendek untuk dianalisis')
    n = len(shifts)
    adx = sum(s[1] for s in shifts) / n
    ady = sum(s[2] for s in shifts) / n
    dur = max(4, min(10, round(n * 1.5)))
    if abs(adx) >= abs(ady) and abs(adx) >= 1:
        pts = [[-7, 2, 5], [0, 2, 4], [7, 2, 5]]
        if adx < 0: pts = pts[::-1]
        shots = [{'id': 'clip-pan', 'type': 'path', 'points': pts, 'target': [0, 2, 0],
                  'duration': dur, 'caption': 'Sapuan kamera mengikuti arah klip referensi'}]
        note = f'Kamera bergeser {"kanan" if adx > 0 else "kiri"} (Δx≈{adx:.1f}px/frame)'
    elif abs(ady) >= 1:
        shots = [{'id': 'clip-crane', 'type': 'crane', 'from': [5, 1 if ady < 0 else 6, 5],
                  'toY': 8 if ady < 0 else 1, 'target': [0, 2, 0], 'duration': dur,
                  'caption': 'Kamera naik mengikuti klip referensi'}]
        note = f'Kamera bergerak {"atas" if ady < 0 else "bawah"} (Δy≈{ady:.1f}px/frame)'
    else:
        shots = [{'id': 'clip-orbit', 'type': 'orbit', 'target': [0, 2, 0], 'radius': 7,
                  'height': 3, 'sweep': 180, 'duration': dur, 'caption': 'Putaran kamera mengikuti klip referensi'}]
        note = f'Pergeseran piksel kecil (Δ≈{adx:.1f},{ady:.1f}) — diartikan sebagai orbit'
    return {'shots': shots, 'note': note + ' — analisis heuristik (model vision sibuk)',
            'source': 'heuristic', 'shiftPerFrame': [[round(s[1], 1), round(s[2], 1)] for s in shifts]}

def clip_imitate(job, src):
    try:
        d = os.path.join(ROOT, 'clip-reference-' + job)
        os.makedirs(d, exist_ok=True)
        frames = []
        # 8 frame merata dari clip
        r = subprocess.run(['ffmpeg', '-y', '-i', src, '-vf', 'fps=1,scale=320:-1', '-frames:v', '8',
                            os.path.join(d, 'f-%02d.png')], capture_output=True, timeout=120)
        frames = sorted(f for f in os.listdir(d) if f.startswith('f-') and f.endswith('.png'))
        if not frames:
            raise RuntimeError('ffmpeg tidak menghasilkan frame dari clip')
        lst = os.path.join(d, 'list.txt')
        with open(lst, 'w') as f:
            for fn in frames:
                f.write(f"file '{os.path.join(d, fn)}'\n")
        sheet = os.path.join(d, 'sheet.png')
        subprocess.run(['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', lst,
                        '-vf', 'scale=240:135,tile=4x2', '-frames:v', '1', sheet], capture_output=True, timeout=90)
        img = base64.b64encode(open(sheet, 'rb').read()).decode()
        q = ('Analisis storyboard 8 frame dari sebuah video. Deskripsikan GERAK KAMERA dalam bahasa Indonesia '
             'dan keluarkan JSON cameraPath yang menirunya: {"shots":[{"type":"orbit|dolly|zoom|crane|path|journey",'
             '"duration":detik,"caption":"..."}],"note":"..."}. Perhatikan arah sapuan, kedekatan subjek, '
             'perubahan ketinggian, dan jumlah shot. Balas HANYA JSON valid.')
        data = None
        for vm in VISION_MODELS:
            try:
                out = http_json(ROUTER_URL, {'model': vm, 'max_tokens': 900, 'temperature': 0.2,
                    'messages': [{'role': 'user', 'content': [
                        {'type': 'text', 'text': q},
                        {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + img}}]}]}, timeout=120)
                txt = _message_text((out.get('choices') or [{}])[0].get('message'))
                data = extract_json_object(txt)
                if data:
                    break
            except Exception:
                continue
        if not data:
            data = heuristic_clip_analysis(src)
            data['sheet'] = f'/clip-reference-{job}/sheet.png'
        with open(os.path.join(ROOT, 'clip-analysis.json'), 'w') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        with CLIP_LOCK:
            CLIP[job] = {'status': 'done', 'analysis': data, 'sheet': f'/clip-reference-{job}/sheet.png'}
    except Exception as e:
        with CLIP_LOCK:
            CLIP[job] = {'status': 'error', 'error': str(e)}

CLIP_LOCK = __import__('threading').Lock()

# ── Storyboard: satu keyframe per shot + shot list CSV ──
STORY = {}
STORY_LOCK = __import__('threading').Lock()
STORY_DIR = os.path.join(ROOT, 'storyboards')

def story_generate(job, shots):
    try:
        d = os.path.join(STORY_DIR, job)
        os.makedirs(d, exist_ok=True)
        files = []
        acc = 0.0
        for i, sh in enumerate(shots):
            sh = dict(sh)
            sh['t0'] = acc
            acc += float(sh.get('duration', 4))
            mid = sh['t0'] + float(sh.get('duration', 4)) / 2
            out = os.path.join(d, f'shot-{i:02d}.png')
            url = f'http://127.0.0.1:8091/render.html?scene=scene.json&w=960&h=540&t={mid:.2f}'
            cmd = ['chromium', '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server',
                   '--enable-unsafe-swiftshader', '--virtual-time-budget=60000', '--window-size=960,540',
                   f'--screenshot={out}', url]
            r = subprocess.run(cmd, capture_output=True, timeout=120)
            if r.returncode != 0 or not os.path.isfile(out):
                raise RuntimeError(f'keyframe shot {i + 1} gagal')
            files.append(out)
        lst = os.path.join(d, 'list.txt')
        with open(lst, 'w') as f:
            for fp in files:
                f.write(f"file '{fp}'\n")
        sheet = os.path.join(d, 'sheet.png')
        cols = 2
        rows = max(1, (len(files) + cols - 1) // cols)
        r = subprocess.run(['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', lst,
                            '-vf', f'scale=320:180,tile={cols}x{rows}', '-frames:v', '1', sheet],
                           capture_output=True, timeout=90)
        if r.returncode != 0:
            raise RuntimeError('tile storyboard gagal: ' + r.stderr.decode()[-200:])
        csvp = os.path.join(d, 'shot-list.csv')
        import csv as _csv
        with open(csvp, 'w', newline='') as f:
            w = _csv.writer(f)
            w.writerow(['no', 'id', 'type', 'detik', 'target', 'framing_fill', 'jarak_m', 'explode', 'transisi', 'narasi'])
            for i, sh in enumerate(shots):
                fr = sh.get('framing') or {}
                w.writerow([i + 1, sh.get('id', ''), sh.get('type', ''), sh.get('duration', ''),
                            str(sh.get('target', ''))[:60], fr.get('fill', ''), sh.get('radius', ''),
                            str(sh.get('explode', '')), sh.get('transition', ''), (sh.get('caption') or '')[:200]])
        with STORY_LOCK:
            STORY[job] = {'status': 'done', 'sheet': f'/storyboards/{job}/sheet.png',
                          'csv': f'/storyboards/{job}/shot-list.csv', 'shots': len(shots)}
    except Exception as e:
        with STORY_LOCK:
            STORY[job] = {'status': 'error', 'error': str(e)}

# ── Narasi TTS per shot (satu MP3 per shot → timeline kontrak) ──
TTS = {}
VOICE_DIR = os.path.join(ROOT, 'voice')

def tts_signature(cp):
    return hashlib.sha1(json.dumps([(s.get('id'), s.get('caption', '')) for s in (cp or {}).get('shots', [])], ensure_ascii=False).encode()).hexdigest()[:12]

def tts_generate(job, shots, voice):
    try:
        os.makedirs(os.path.join(VOICE_DIR, job), exist_ok=True)
        boundaries, total = [], 0.0
        files = []
        for i, sh in enumerate(shots):
            text = (sh.get('caption') or '').strip()
            mp3 = os.path.join(VOICE_DIR, job, f'shot-{i:02d}.mp3')
            if text:
                cmd = ['edge-tts', '--voice', voice, '--text', text, '--write-media', mp3]
                r = subprocess.run(cmd, capture_output=True, timeout=90)
                if r.returncode != 0 or not os.path.isfile(mp3):
                    raise RuntimeError(f'TTS shot {i + 1} gagal: ' + r.stderr.decode()[-200:])
                dur = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', mp3]).decode().strip())
            else:
                open(mp3, 'wb').close(); dur = 0.0
            files.append(mp3)
            boundaries.append({'index': i, 'id': sh.get('id'), 'start': round(total, 3), 'end': round(total + dur, 3),
                               'voiceDuration': round(dur, 2), 'suggestedShotDuration': round(max(float(sh.get('duration') or 4), dur + 0.6), 2)})
            total += dur + 0.35
        # jeda 0,35s antar shot
        concat = os.path.join(VOICE_DIR, job, 'list.txt')
        with open(concat, 'w') as f:
            for i, mp3 in enumerate(files):
                f.write(f"file '{mp3}'\n")
                if i < len(files) - 1:
                    gap = os.path.join(VOICE_DIR, job, f'gap-{i:02d}.mp3')
                    subprocess.run(['ffmpeg', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '0.35', '-q:a', '9', gap], capture_output=True, timeout=30)
                    f.write(f"file '{gap}'\n")
        out = os.path.join(VOICE_DIR, job, 'narration.mp3')
        r = subprocess.run(['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', concat, '-c:a', 'libmp3lame', '-q:a', '4', out], capture_output=True, timeout=90)
        if r.returncode != 0:
            raise RuntimeError('gagal gabung narasi: ' + r.stderr.decode()[-250:])
        tl = {'job': job, 'voice': voice, 'total': round(total, 2), 'boundaries': boundaries, 'audio': out}
        with open(os.path.join(VOICE_DIR, job, 'timeline.json'), 'w') as f:
            json.dump(tl, f, ensure_ascii=False, indent=2)
        with TTS_LOCK:
            TTS[job] = {**tl, 'status': 'done'}
        with VIDEO_LOCK:
            cp = read_json(os.path.join(ROOT, 'scene.json'), {}).get('cameraPath') or {}
            VIDEO['voice'] = {'job': job, 'audio': out, 'signature': tts_signature(cp)}
        with open(os.path.join(VOICE_DIR, 'current.json'), 'w') as f:
            json.dump(VIDEO['voice'], f)
    except Exception as e:
        with TTS_LOCK:
            TTS[job] = {'status': 'error', 'error': str(e)}

TTS_LOCK = __import__('threading').Lock()

VIDEO = {}  # job -> {status, frames, total, fps, path, error}
VIDEO_LOCK = __import__('threading').Lock()

CHAT = {
    'running': False,
    'job_id': None,
    'model': DEFAULT_MODEL,
    'started_at': None,
    'status_lines': [],
    'error': None,
    'last_iteration': None,
}
CHAT_STATUS_MAX = 80
CONSOLE_JOURNAL = os.path.join(ROOT, 'console-journal.json')
try:
    _journal = json.load(open(CONSOLE_JOURNAL))
    if isinstance(_journal, list):
        CHAT['status_lines'] = _journal[-CHAT_STATUS_MAX:]
except Exception:
    pass


# ─────────────────────────── util file ───────────────────────────
def read_json(path, default=None):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def write_json(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def read_text(path, default=''):
    try:
        with open(path, encoding='utf-8') as f:
            return f.read()
    except Exception:
        return default


def append_chat_message(msg):
    path = os.path.join(ROOT, 'chat.json')
    with LOCK:
        msgs = read_json(path, [])
        if not isinstance(msgs, list):
            msgs = []
        msgs.append(msg)
        write_json(path, msgs)


# ─────────────────────────── state API ───────────────────────────
def state():
    scene_path = os.path.join(ROOT, 'scene.json')
    iters = []
    idir = os.path.join(ROOT, 'iterations')
    if os.path.isdir(idir):
        for name in sorted(os.listdir(idir)):
            d = os.path.join(idir, name)
            if not os.path.isdir(d):
                continue
            shot = os.path.join(d, 'shot.png')
            iters.append({
                'id': name,
                'shot': f'iterations/{name}/shot.png' if os.path.exists(shot) else None,
                'checklist': read_json(os.path.join(d, 'checklist.json')),
                'notes': read_text(os.path.join(d, 'notes.md')),
                'mtime': os.path.getmtime(shot) if os.path.exists(shot) else os.path.getmtime(d),
            })
    return {
        'project': active_project(),
        'scene': read_json(scene_path),
        'scene_mtime': os.path.getmtime(scene_path) if os.path.exists(scene_path) else 0,
        'contract': read_text(os.path.join(ROOT, 'contract.md')),
        'iterations': iters,
        'feedback': read_json(os.path.join(ROOT, 'feedback.json'), []),
        'server_time': time.time(),
    }


def chat_state():
    msgs = read_json(os.path.join(ROOT, 'chat.json'), [])
    with LOCK:
        running = CHAT['running']
        last_iter = CHAT['last_iteration']
        if not last_iter and isinstance(msgs, list):
            for m in reversed(msgs):
                if m.get('role') == 'agent' and m.get('iteration'):
                    last_iter = m['iteration']
                    break
        return {
            'running': running,
            'job_id': CHAT['job_id'],
            'status_lines': list(CHAT['status_lines'][-CHAT_STATUS_MAX:]),
            'messages': msgs if isinstance(msgs, list) else [],
            'model': CHAT['model'],
            'started_at': CHAT['started_at'],
            'error': CHAT['error'],
            'last_iteration': last_iter,
        }


def status(line):
    stamp = time.strftime('%H:%M:%S')
    entry = {'at': time.time(), 'time': stamp, 'text': line}
    with LOCK:
        CHAT['status_lines'].append(entry)
        del CHAT['status_lines'][:-CHAT_STATUS_MAX]
        snapshot = list(CHAT['status_lines'][-CHAT_STATUS_MAX:])
    try:
        with open(CONSOLE_JOURNAL, 'w') as f:
            json.dump(snapshot, f, ensure_ascii=False)
    except Exception:
        pass
    print(f'[chat {stamp}] {line}', flush=True)


# ─────────────────────────── iterations ───────────────────────────
def next_iteration_id():
    """iter-03, iter-04, ... berdasarkan folder yang ada (tidak pernah menimpa)."""
    n = 0
    idir = os.path.join(ROOT, 'iterations')
    if os.path.isdir(idir):
        for name in os.listdir(idir):
            m = re.fullmatch(r'iter-(\d+)', name)
            if m:
                n = max(n, int(m.group(1)))
    return 'iter-%02d' % (n + 1)


# ─────────────────────────── validasi spec ───────────────────────────
def validate_spec(spec):
    errs = []
    if not isinstance(spec, dict):
        return ['scene harus berupa objek JSON']
    for key in ('objects', 'lights', 'camera'):
        if key not in spec:
            errs.append(f'field wajib "{key}" tidak ada')
    objs = spec.get('objects')
    if not isinstance(objs, list):
        errs.append('"objects" harus array')
        objs = []
    # flatten group.children untuk validasi id/type rekursif
    flat = []
    def walk(lst):
        for o in lst:
            if isinstance(o, dict):
                flat.append(o)
                if isinstance(o.get('children'), list):
                    walk(o['children'])
    walk(objs)
    objs = flat
    if not isinstance(spec.get('lights'), list):
        errs.append('"lights" harus array')
    cam = spec.get('camera')
    if not isinstance(cam, dict):
        errs.append('"camera" harus objek')
    else:
        for k in ('position', 'target'):
            if not (isinstance(cam.get(k), list) and len(cam.get(k)) == 3):
                errs.append(f'camera.{k} harus array 3 angka')
        if not isinstance(cam.get('fov', 50), (int, float)):
            errs.append('camera.fov harus angka')
    seen = set()
    for i, o in enumerate(objs):
        if not isinstance(o, dict):
            errs.append(f'objects[{i}] bukan objek')
            continue
        oid = o.get('id')
        if not oid or not isinstance(oid, str):
            errs.append(f'objects[{i}] tidak punya id string')
        elif oid in seen:
            errs.append(f'id objek duplikat: {oid}')
        else:
            seen.add(oid)
        if o.get('type') not in KNOWN_OBJECT_TYPES:
            errs.append(f'objek {oid or i}: type "{o.get("type")}" tidak dikenal')
        if 'position' in o and not (isinstance(o['position'], list) and len(o['position']) == 3):
            errs.append(f'objek {oid or i}: position harus array 3 angka')
    lights = spec.get('lights') or []
    for i, l in enumerate(lights):
        if not isinstance(l, dict) or l.get('type') not in KNOWN_LIGHT_TYPES:
            errs.append(f'lights[{i}]: type lampu tidak dikenal')
    if not any(isinstance(l, dict) and l.get('type') != 'ambient' for l in lights):
        errs.append('lampu minimal 1 selain ambient')
    return errs


# ─────────────────────────── LLM adapters ───────────────────────────
def http_json(url, payload=None, headers=None, timeout=3, method=None):
    data = None
    hdrs = {'Accept': 'application/json'}
    if headers:
        hdrs.update(headers)
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
        hdrs['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=hdrs,
                                 method=method or ('POST' if data else 'GET'))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        return json.loads(raw.decode('utf-8')) if raw else {}


def _message_text(msg):
    """Ambil teks dari message OpenAI-compatible; dukung field reasoning."""
    if not isinstance(msg, dict):
        return ''
    for key in ('content', 'reasoning', 'reasoning_content'):
        val = msg.get(key)
        if isinstance(val, str) and val.strip():
            return val
        if isinstance(val, list):
            parts = []
            for p in val:
                if isinstance(p, dict) and isinstance(p.get('text'), str):
                    parts.append(p['text'])
                elif isinstance(p, str):
                    parts.append(p)
            if ''.join(parts).strip():
                return ''.join(parts)
    return ''


def call_router(model, messages, max_tokens=20000, temperature=0.4):
    """OpenAI-compatible router tanpa auth.

    Dua gelombang: model utama + longcat (mampu output besar) lebih dulu.
    Model kecil hanya dipakai jika gelombang pertama gagal, karena output scene
    penuh (~4-5k token) sering terpotong di model dengan limit output kecil.
    """
    import queue
    primary = []
    for m in [model, 'meituan/longcat-2.5:free']:
        if m not in primary:
            primary.append(m)
    secondary = [m for m in FREE_ROUTER_MODELS if m not in primary]
    q = queue.Queue()

    def worker(m):
        try:
            data = http_json(ROUTER_URL, {
                'model': m,
                'messages': messages,
                'temperature': temperature,
                'max_tokens': max_tokens,
                'stream': False,
            }, timeout=240)
            choices = data.get('choices') or []
            text = _message_text(choices[0].get('message')) if choices else ''
            q.put((m, text.strip(), None))
        except urllib.error.HTTPError as e:
            detail = ''
            try:
                detail = e.read().decode('utf-8', 'replace')[:200]
            except Exception:
                pass
            q.put((m, '', f'HTTP {e.code} {detail}'.strip()))
        except Exception as e:
            q.put((m, '', str(e)))

    def collect(group, deadline, errors):
        threads = []
        for m in group:
            t = threading.Thread(target=worker, args=(m,), daemon=True)
            t.start()
            threads.append(t)
        status('memanggil model: ' + ', '.join(group))
        for _ in group:
            remain = deadline - time.time()
            if remain <= 0:
                break
            try:
                m, text, err = q.get(timeout=remain)
            except queue.Empty:
                break
            if text:
                if m != model:
                    status(f'respons dari {m} (fallback dari {model})')
                return (text, m)
            errors.append(f'{m}: {err}')
        return None

    errors = []
    deadline = time.time() + 300
    got = collect(primary, deadline, errors)
    if got:
        return got
    status('model utama + longcat gagal — mencoba model free lain…')
    got = collect(secondary, deadline, errors)
    if got:
        return got
    raise RuntimeError('semua model router gagal — ' + ' | '.join(errors[-3:] or ['timeout']))


def _opencode_auth():
    path = os.path.expanduser('~/.config/opencode/service.json')
    conf = read_json(path, {})
    pw = conf.get('password') if isinstance(conf, dict) else None
    if not pw:
        raise RuntimeError('password opencode service tidak ditemukan')
    token = base64.b64encode(('opencode:' + pw).encode()).decode()
    return {'Authorization': 'Basic ' + token}


def _opencode_get(path, timeout=5):
    return http_json(OPENCODE_URL + path, headers=_opencode_auth(), timeout=timeout)


def _opencode_post(path, payload, timeout=120):
    return http_json(OPENCODE_URL + path, payload, headers=_opencode_auth(), timeout=timeout)


def call_opencode(model, prompt_text):
    """OpenCode HTTP v2: buat session -> prompt -> tunggu idle -> baca pesan assistant."""
    sid_resp = _opencode_post('/api/session', {'title': 'studio-agent'}, timeout=15)
    sid = (sid_resp.get('data') or {}).get('id') or sid_resp.get('id')
    if not sid:
        raise RuntimeError('opencode: gagal membuat session')
    _opencode_post(f'/api/session/{sid}/prompt', {
        'text': prompt_text,
        'model': {'providerID': 'opencode', 'modelID': model},
        'resume': True,
    }, timeout=30)
    status('🧠 berpikir… model menyusun spec 3D (sesi aktif, bisa 1-3 menit)')
    _opencode_post(f'/api/experimental/session/{sid}/wait', {}, timeout=330)
    status('✍️ model merespons — membaca & memvalidasi jawaban…')
    msgs = _opencode_get(f'/api/session/{sid}/message', timeout=20)
    items = msgs.get('data', msgs) if isinstance(msgs, dict) else msgs
    if isinstance(items, dict):
        items = items.get('messages', [])
    texts = []
    for item in items or []:
        if not isinstance(item, dict) or item.get('type') != 'assistant':
            continue
        for part in item.get('content') or []:
            if isinstance(part, dict) and part.get('type') == 'text' and part.get('text'):
                texts.append(part['text'])
    text = '\n'.join(texts).strip()
    if not text:
        raise RuntimeError('opencode: respons assistant kosong (cek kuota / model)')
    return text, model


def _hermes_key():
    key = os.environ.get('API_SERVER_KEY', '').strip()
    if key:
        return key
    env_path = os.path.join(ROOT, '.env')
    for line in read_text(env_path).splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        if k.strip() == 'API_SERVER_KEY':
            return v.strip().strip('"').strip("'")
    return ''


def call_hermes(model, messages, max_tokens=20000, temperature=0.4):
    key = _hermes_key()
    if not key:
        raise RuntimeError('hermes belum dikonfigurasi: perlu API_SERVER_KEY')
    data = http_json(HERMES_URL, {
        'model': model,
        'messages': messages,
        'temperature': temperature,
        'max_tokens': max_tokens,
    }, headers={'Authorization': 'Bearer ' + key}, timeout=110)
    choices = data.get('choices') or []
    text = _message_text(choices[0].get('message')) if choices else ''
    if not text.strip():
        raise RuntimeError('hermes: respons kosong')
    return text, model


# ─────────────────────────── parse & prompt ───────────────────────────
def extract_json_object(text):
    """Toleran: buang code fence, cari objek JSON valid pertama."""
    if not text:
        return None
    t = text.strip()
    t = re.sub(r'^```(?:json|JSON)?\s*', '', t)
    t = re.sub(r'\s*```\s*$', '', t).strip()
    try:
        obj = json.loads(t)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    dec = json.JSONDecoder()
    for m in re.finditer(r'\{', t):
        try:
            obj, _end = dec.raw_decode(t[m.start():])
            if isinstance(obj, dict):
                return obj
        except Exception:
            continue
    return None


SYSTEM_PROMPT = """Kamu adalah "Scene Designer" untuk Three.js Studio. Tugasmu mengubah scene 3D
berdasarkan permintaan user dan menghasilkan spec JSON yang valid serta enak dilihat.

OUTPUT WAJIB: HANYA SATU objek JSON valid. Tanpa markdown, tanpa code fence, tanpa teks lain.
MODE DIFF (DEFAULT — cepat, output kecil, jangan tulis ulang scene penuh):
{"reply":"penjelasan singkat dalam Bahasa Indonesia (1-3 kalimat)",
 "diff":{
   "upserts":[{...objek lengkap: id, type, params, position, rotation, scale, material...}],
   "remove_ids":["id-objek-lama"],
   "lights":[...HANYA bila berubah; array lampu lengkap...],
   "joints":[...HANYA bila berubah; array joint lengkap...],
   "camera":{...HANYA bila berubah...},
   "environment":{...HANYA bila berubah...},
   "post":{...HANYA bila berubah...}
 },
 "contract":"markdown kontrak baru (opsional, string)",
 "resolved_feedback":[0,2]}
BATAS KEMAMPUAN (JUJUR — jangan klaim fitur yang tidak kamu buat):
- Kamu HANYA mengubah SPEC scene (objek/lampu/kamera/animasi/fisika/kontrol). Kamu TIDAK bisa mengubah kode UI studio.
- Fitur UI yang SUDAH BUILT-IN (jangan klaim "menambahkan" ini): tombol ⏸ Jeda/▶ Putar (membekukan animasi & fisika),
  ↺ Reset fisika, gizmo W/E/R, inspector, saklar power (dari spec.power), slider/toggle (dari spec.controls),
  panel 🔬 Bedah: exploded view hierarkis (slider), section/cutaway (sumbu X/Y/Z + posisi potong + caps irisan solid),
  X-ray, Isolasi part, Label nama, alat ukur jarak (klik 2 titik), timeline scrub 0-10s (fisika deterministik).
  Export menu termasuk BOM daftar part (.csv).
- Bila user minta fitur yang sudah built-in (mis. "jeda fisika"): jawab bahwa tombolnya sudah ada di viewport dan cara pakainya.
- Bila user minta fitur UI baru yang tidak bisa lewat spec: katakan jujur itu perlu perubahan kode studio, bukan spec.
- Balasanmu akan diverifikasi terhadap diff yang benar-benar diterapkan — jangan menyebut perubahan yang tidak ada di diff.

AUDIO MEKANIKA (WebAudio sintetis, tanpa file): spec.audio {"hum":{"object":"motor","baseFreq":70,"gain":0.12},"impacts":true}
Tombol 🔊 di viewport/export mengaktifkan: dengung motor spasial (pitch ikut kecepatan, gain ikut power),
suara benturan fisika (volume ~ kecepatan tumbukan, posisi 3D), klik saklar. Audio mulai setelah gesture user (kebijakan browser).

INTERAKTIVITAS: objek bisa "onClick":{"action":"power"} (toggle saklar), {"action":"impulse","impulse":[x,y,z]},
{"action":"explode","force":8,"radius":5}, {"action":"toggle"} (sembunyikan). Berlaku di studio & export (klik objek).
Export juga: Shift+drag angkat body fisika, tombol 🚶 Jalan (WASD first-person).

FISIKA LANJUTAN:
- rope: {"type":"rope","id":"tali","anchor":[x,y,z],"length":3,"segments":12,"radius":0.04,"color":"#b08d57","attachBody":"bola"}
  (rantai segmen dinamis + spherical joint; anchorBody=id untuk gantung dari body bergerak)
- trigger: {"type":"trigger","id":"zona","position":[x,y,z],"params":{"radius":1.5},"onEnter":{"action":"explode","force":8,"radius":4},"cooldown":2}
  action: explode | impulse {"impulse":[x,y,z]} | power (toggle saklar). Sensor transparan biru.
- ledakan: spec.explosion {"center":[x,y,z],"force":8,"radius":5} + tombol 💥 di viewport; onClick action 'explode'
- impuls awal: physics.impulse [x,y,z] pada body
- drag fisika: SHIFT+klik+geser objek dynamic di viewport (mouse joint)

KAMERA SINEMATIK (cameraPath) — kamu bisa menyutradarai kamera profesional:
Format: "cameraPath": {"shots":[...], "loop":true, "autoplay":true}
Shot types (tiap shot punya duration detik, ease linear/in/out/inOut, caption teks narasi, target=id objek ATAU [x,y,z]):
- orbit: {"type":"orbit","target":"head","radius":7,"height":4,"startAngle":0,"sweep":360,"duration":6}
  radius bisa diganti framing terukur: "framing":{"object":"motor","fill":0.5} → jarak dihitung otomatis
  dari ukuran objek & fov (fill = fraksi frame yang diisi objek; preset: closeup 0.7, medium 0.4, wide 0.18, establish 0.1)
- dolly: {"type":"dolly","from":[x,y,z],"to":[x,y,z],"target":"motor","duration":4}
- zoom: {"type":"zoom","target":"blade-1-s1","fromDistance":8,"toDistance":2,"duration":3}
- crane: {"type":"crane","from":[6,1,6],"toY":9,"target":"base","duration":4}
- path: {"type":"path","points":[[...],[...],[...]],"target":"head","duration":8} — spline Catmull-Rom mulus
- journey: SATU shot tanpa potong — kamera meluncur menyusuri banyak titik:
  {"type":"journey","duration":12,"stops":[{"target":"usb-c","fill":0.6,"offset":[0.4,0.3,1],"hold":1,"caption":"..."},
  {"target":"kawat-vbus","fill":0.5,"caption":"..."},{"target":"usb-a","fill":0.6,"caption":"..."}]}
  Cocok untuk "dari USB geser ke kabel lalu ke ujung lain" — tidak ada hard cut.
- Efek produksi: "dof":{"enabled":true,"target":"id objek","aperture":0.00012,"maxblur":0.012} —
  rack focus mengikuti objek (atau focusMode:"manual" + focus:<meter>).
- Tiap shot bisa "transition":"fade|dissolve|wipe","transitionDuration":0.6 (transisi saat render MP4)
- Tiap shot bisa "explode":[0,0.6] — kamera bergerak sambil part meledak perlahan (reveal detail assembly).
- caption: narasi per shot, mis. "Motor memutar rotor 10 rad/detik" — untuk tur "cara kerja mesin".
Alternatif keyframes manual: {"keyframes":[{"t":0,"pos":[...],"target":[...],"fov":50,"caption":"..."},...],"duration":10}
EKSPRESI & PUSTAKA SHOT (boleh dipakai agent, bukan desain):
- Pustaka bernama: {"preset":"hero-orbit|hitchcock|whip-reveal|snorricam|top-down-explode|macro-detail|crane-reveal|parallax-walk","duration":6,"target":"id"} — framework yang isi parameter profesionalnya.
- Ekspresi deterministik pada field shot/keyframe: {"fov":"ramp(50,25,ease)","pos":"orbit('id',3,1.5,90,6)","target":"track('id')"};
  tersedia ramp(a,b,ease|linear), orbit(id,r,h,sweep,dur), path(id1,id2,...), track(id), wave(base,amp,period).
- Efek film di cameraPath.effects (urutan penting): [{"type":"colorGrade","look":"clean|teal|noir|warm"},
  {"type":"vignette"},{"type":"letterbox","ratio":0.09},{"type":"motionBlur"},{"type":"glitch","slices":4}].
- shot bisa "transition":"fade|dissolve|wipe".
ATURAN: untuk "tunjukkan detail/cara kerja", buat tur 4-6 shot: establish orbit → closeup komponen kunci (framing!)
→ exploded reveal → pull back. Jarak SELALU terukur lewat framing/fill, jangan angka asal.
Verifikasi shot: render.py --time <detik> menghasilkan screenshot pose shot tsb.

ATURAN DIFF:
- upserts HANYA objek baru/berubah. id sama = ganti objek itu; id baru = tambah.
- JANGAN salin objek yang tidak berubah ke upserts. Output kecil = cepat.
- Objek lama yang tidak disebut TETAP DIPERTAHANKAN server (merge otomatis).
- Untuk SCENE BARU TOTAL saja: {"reply":..., "scene":{spec penuh}, "contract":...}.
- Bila scene saat ini KOSONG (projek baru, objects=[]), kamu WAJIB menyertakan "contract" lengkap
  (konsep, objek wajib, palet hex, kamera, lighting, acceptance criteria) — kontrak tidak boleh tetap stub.
- id objek lama dipertahankan persis; hapus hanya yang diminta user atau yang rusak.
- Hapus objek fisika: joint yang merujuknya DI-PRUNE OTOMATIS oleh server (tidak perlu kirim joints).
  Untuk mengubah joint secara eksplisit, kirim array "joints" lengkap di diff.
- MEMINDAH/MENGUBAH objek = upsert dengan id yang SAMA PERSIS untuk semua part-nya (mis. mobil: badan+kabin+4 roda+lampu). JANGAN membuat id baru/varian untuk objek yang sudah ada (duplikat visual!).

SCHEMA SPEC (semua field):
{
 "meta":{"name":"...","concept":"...","seed":42,"spec_version":1},
 "environment":{"background":"#0b1020","fog":{"color":"#0b1020","near":18,"far":55},
   "ground":{"size":60,"color":"#10131c","roughness":0.95},"exposure":1.1},
 "camera":{"position":[14,9,16],"target":[0,2,0],"fov":45},
 "lights":[{"id":"hemi","type":"hemisphere","color":"#2a3550","groundColor":"#0c0e14","intensity":0.5},
   {"id":"moon","type":"directional","color":"#8fa8d8","intensity":0.8,"position":[-10,14,-8],"castShadow":true}],
 "objects":[{"id":"gedung-1","type":"box","position":[0,2,0],"rotation":[0,0,0],
   "scale":[1,1,1],"params":{"width":2,"height":4,"depth":2},
   "material":{"color":"#232a3a","metalness":0.1,"roughness":0.8,
     "emissive":"#000000","emissiveIntensity":1,"opacity":1,"wireframe":false,"flatShading":false,
     "fog":true,"doubleSide":false}}]
}

Tipe objek: box, sphere, cylinder, cone, torus, torusKnot, plane, capsule, icosahedron, ring, gltf.
params per tipe: box {width,height,depth}; sphere {radius}; cylinder {radiusTop,radiusBottom,height};
cone {radius,height}; torus {radius,tube}; torusKnot {radius,tube}; plane {width,height};
capsule {radius,length}; icosahedron {radius,detail}; ring {innerRadius,outerRadius}; gltf {url}.
Tipe lampu: ambient, hemisphere, directional, point, spot. Position array [x,y,z] dalam meter.

TIPE LANJUTAN (wajib dipakai untuk kualitas sinematik):
- sky: {"type":"sky","params":{"top":"#04060e","horizon":"#1c2a4a","radius":220}} — langit gradasi, pengganti background polos.
- stars: {"type":"stars","params":{"count":700,"radius":200,"size":0.8,"color":"#a8bcff","seed":7}} — bintang malam.
- instances: {"type":"instances","geometry":{"type":"box","params":{...}},"material":{...},
  "transforms":[{"p":[x,y,z],"r":[0,90,0],"s":1}, ...]} — ratusan objek berulang (jendela!) dalam 1 draw call.
  Jendela gedung: grid individual 0.34x0.48, ~55% nyala (emissive hangat 2.4), sisanya kaca gelap — JANGAN strip polos.
- post: {"bloom":{"strength":0.55,"radius":0.5,"threshold":0.72}} di root spec — bloom sinematik untuk sumber cahaya.
Material tambahan: "fog":false untuk bulan/langit; emissiveIntensity 2-5 untuk objek menyala agar bloom bekerja.

ATURAN LAYOUT & CAHAYA (pelajaran terverifikasi — pelanggaran membuat hasil ditolak vision):
- Matahari/bulan HARUS menyinari fasad yang menghadap kamera (cek posisi light vs kamera). Fasad bayangan = gedung hitam pekat. Tambahkan warm fill redup dari sisi jendela.
- Gedung di sisi kamera (foreground) RENDAH (≤2.5 m); gedung tinggi di belakang. Gedung tinggi di depan menghalangi mobil/orang (cek oklusi raycast otomatis akan menolak).
- Mobil/orang/lampu jalan letakkan di area terbuka (persimpangan/trotoar) yang tidak terhalang gedung/pohon dari kamera.
- Objek langit (bulan/matahari/awan) posisikan via vektor kamera: arah = forward + kanan×lr + atas×ud dengan lr≤0.4, ud≤0.35 (FOV ~49); lebih = di luar frame. Beri "sky":true pada awan.
- textureRepeat skala objek: jalan [24,1], trotoar [12,1], ground [24,24]; tanpa ini tekstur tak terbaca.
- Malam: jendela instanced ~55% emissive #ffb45e intensity 2.4, lampu jalan point 18 + bulb emissive 4.5, bloom .55/.5/.72, fog gelap, bintang, bulan fog:false.
- Siang: jendela kaca gelap reflektif (metalness .7 roughness .12), lampu mati, sun 3.0, hemi .75, bloom .25 threshold .9, langit gradasi biru + awan.

MEKANIKA & ANIMASI (untuk permintaan "bisa nyala/berputar/bergerak"):
- group: {"id":"rotor","type":"group","position":[x,y,z],"children":[{objek posisi LOKAL relatif group}]}
  Pivot rotasi = posisi group. Bilah kipas WAJIB children rotor (koordinat lokal dari poros), bukan objek flat.
- animate pada objek/group:
  spin: {"type":"spin","axis":"z","speed":10} — rad/detik, poros lokal; visual enak 5-15 (jangan >50, strobing)
  oscillate: {"type":"oscillate","axis":"y","amplitude":35,"period":6} — derajat, goyang kiri-kanan
  float: {"type":"float","amplitude":0.2,"period":3} — naik-turun
  blink: {"type":"blink","period":1,"min":0.05,"max":3} — emissiveIntensity berkedip
  colorCycle: {"type":"colorCycle","period":3,"saturation":0.9,"lightness":0.55,"tintBody":true} — warna emissive berputar pelangi (objek bersinar warna-warni); boleh pada body fisika (material, bukan transform)
- power (saklar Nyala/Mati muncul di viewport): {"label":"Nyala","default":true,"affects":["rotor","head","led"]}
  affects = id animasi/emissive yang berhenti saat power off. WAJIB ada untuk mekanika "bisa nyala".
- Pola kipas: group "head" (oscillate y) berisi motor+gril+panel; di dalamnya group "rotor" (spin z)
  berisi hub+bilah; LED blink; power affects ["rotor","head","led"]. Posisi children = world - posisi group.
- accel (opsional pada spin): {"accel":1.5} = ramp-up 1.5 detik dari diam (kesan motor menyala bertahap).
- controls (UI interaktif di viewport + export, array di root spec):
  slider: {"id":"ctl-speed","type":"slider","label":"Kecepatan","target":"rotor","param":"speed","min":0,"max":30,"step":0.5,"default":10}
  toggle: {"id":"ctl-osc","type":"toggle","label":"Osilasi","target":"head","default":true}
  param yang bisa diikat: speed (spin), amplitude/period (oscillate/float/blink), enabled (toggle).
  Untuk permintaan "pengaturan kecepatan/atur sendiri" WAJIB tambah slider yang mengikat animasinya.
- Mekanika custom tersusun dari grup + animasi: roda gigi = dua group spin berlawanan, speed berbanding rasio;
  piston = group float + batang penghubung; pendulum = oscillate poros lokal. Jelaskan rasio di reply.

FISIKA RAPIER (untuk simulasi nyata: jatuh, tumbukan, domino, bandul, roda bermotor):
- spec.physics: {"gravity":[0,-9.81,0]} — mengaktifkan engine Rapier (WASM). Ground otomatis jadi collider fixed.
- Per objek root-level: "physics":{"body":"dynamic"|"fixed"|"kinematic","restitution":0.4,"friction":0.6,"density":1,"linvel":[x,y,z],"angvel":[x,y,z]}
  Collider otomatis dari geometri (box/sphere/cylinder/capsule). Objek physics TIDAK boleh children group dan jangan diberi animate (fisika menang).
- spec.joints: [{"type":"revolute","body1":"tiang","body2":"lengan","anchor1":[0,1,0],"anchor2":[0,0,0],"axis1":[0,1,0],"axis2":[0,1,0],"motor":{"velocity":4,"factor":1}}]
  anchor koordinat LOKAL masing-masing body; type: revolute (engsel), spherical (bola), fixed. motor = kecepatan rad/s.
- Pola demo fisika: ramp fixed (box rotasi z ~-18°) + bola dynamic di puncak + barisan domino (box tipis 0.12x1x0.5, jarak 0.6-0.7, restitution 0.1).
- Objek fixed = statis (ramp, tiang); dynamic = jatuh/tertumbuk. Mulai bola sedikit di atas ramp agar menggelinding.
- MOTOR pada joint HANYA bila body1 fixed (tiang tertanam). Bila body1 dynamic (akan jatuh), JANGAN pakai motor — solver bisa meledak (NaN). Tanpa motor, joint tetap merangkai kedua body.
- emissiveIntensity WAJIB ≤ 5 (nilai 12 membuat objek blown-out putih dan merusak penilaian vision).
- Reset fisika tersedia di viewport; render headless mensimulasikan 2 detik sebelum screenshot.

SATU PROMPT UNTUK MODEL BERLAPIS (jam, mesin, motor, konektor, dll):
- Dalam SATU jawaban, tulis KONTRAK + daftar komponen DALAM + assembly + cameraPath exploded. Jangan hanya bentuk luar lalu disusul kemudian.
- Wajib sertakan: "assembly":{"mode":"layered","axis":"z","layers":[{"id":"depan","offset":1.2},{"id":"tengah","offset":0.4},{"id":"dalam","offset":-0.4},{"id":"belakang","offset":-1.2}]}
  (offset dalam meter, searah sumbu; objek luar offset positif, objek dalam negatif).
- Setiap objek (termasuk roda gigi/jarum/komponen internal) WAJIB punya field "layer" yang sama dengan id layer.
- Wajib ada shot dengan "explode":[0,0.8] di cameraPath supaya kedalaman terlihat langsung saat diputar.
- Benda non-lapis seperti kabel tetap boleh radial (tanpa assembly) — itu sudah didukung.

REFERENSI TEKNIS: bila prompt disertai bagian '=== REFERENSI TEKNIS ===', itu fakta ukuran & daftar komponen dari sumber eksternal — ikuti, jangan karang bentuk generik. Beri id objek yang mengandung keyword yang tercantum supaya gerbang semantik bisa memverifikasi. Contoh: kabel data harus punya jacket, shield, drain, vbus, gnd, dplus, dminus, cc, strain, usb-a, usb-c, tongue, dan pin (boleh instances 24 transform). Detail teknis lebih penting daripada dekorasi.

STANDAR ESTETIKA (smoke test lolos SAJA TIDAK CUKUP — hasil harus layak final, bukan seperti tutorial):
- Komposisi 3 lapis: foreground (jalan/trotoar), midground (subjek), background (langit/bulan).
- Detail: atap gedung punya AC unit/tangki/antena; jalan punya trotoar, crosswalk, marka; ada elemen skala manusia (mobil/orang).
- Material: variasi roughness/metalness; gedung malam JANGAN hitam pekat — biru/abu gelap yang terbaca cahaya.
- Cahaya: key light + fill (bounce hangat dari sisi jendela) + hemisphere; bayangan aktif.
- Atmosfer: langit gradasi + bintang (malam) atau awan/gradasi biru (siang); fog kedalaman; bloom.

ATURAN KETAT:
- Satuan meter. Skala wajar (gedung 2-8 m, manusia 1.7 m).
- Kamera JANGAN berada di dalam objek; beri jarak dari subjek.
- Semua objek utama harus masuk frame dari kamera (tidak terpotong di tepi).
- Palet warna hex konkret; jangan biarkan material default abu-abu terang bocor.
- Jangan hapus objek yang tidak diminta user hapus. Perubahan incremental:
  pertahankan struktur scene yang ada kecuali user minta scene baru total.
- Jika user minta scene baru, ganti seluruh objects/lights/environment/camera dan tulis kontrak baru.
- Minimal 1 lampu selain ambient. Background jangan putih polos. Emissive untuk objek menyala.
  Fog opsional.
- id objek unik, huruf kecil dengan tanda hubung. Pertahankan id objek lama bila tidak diubah.
- Feedback terbuka: selesaikan yang relevan dan sebutkan indeksnya di resolved_feedback
  (indeks array feedback yang diberikan, 0-based). Hanya tandai yang benar-benar selesai.

SMOKE TEST otomatis akan mengecek: no_build_errors, all_objects_built, has_lighting,
not_black_frame, subject_in_frame (coverage 2-70%), framing_not_extreme, objects_in_view.
Pastikan scene lolos semuanya: cukup terang, subjek mengisi frame, semua objek terlihat.
Tulis JSON PADAT (satu baris, tanpa indentasi/spasi berlebih) agar tidak terpotong.
Jawab selalu dalam Bahasa Indonesia untuk field "reply" dan "contract"."""


def build_agent_prompt(user_text, repair=None, selection=None):
    scene = read_json(os.path.join(ROOT, 'scene.json'), {})
    contract = read_text(os.path.join(ROOT, 'contract.md'))
    fb = read_json(os.path.join(ROOT, 'feedback.json'), [])
    open_fb = [(i, f) for i, f in enumerate(fb) if f.get('status') == 'open']
    history = read_json(os.path.join(ROOT, 'chat.json'), [])
    history = history[-4:] if isinstance(history, list) else []

    parts = ['=== KONTRAK SCENE SAAT INI ===', contract or '(belum ada)', '']
    if CHAT.get('scope') == 'production':
        parts += ['=== MODE PRODUKSI (STUDIO REKAMAN) — BATASAN KERAS ===',
                  'Kamu HANYA boleh mengubah cameraPath (shot kamera, keyframe, caption, explode) dan audio.',
                  'DILARANG mengubah objects, lights, camera statis, environment, post, controls, atau contract — ',
                  'itu wilayah Studio Design. Server akan membuang bagian diff di luar cameraPath/audio.',
                  'Fokus: sutradarai konten — shot profesional, narasi tiap shot, transisi, dan urutan tur.', '']
    cards = knowledge_for(user_text, scene if isinstance(scene, dict) else None)
    if cards:
        parts += ['=== REFERENSI TEKNIS — WAJIB, JANGAN BUAT MODEL GENERIK ===']
        for c in cards:
            parts += [f"## {c.get('title')}", c.get('facts', ''), 'BAGIAN WAJIB (id objek HARUS mengandung salah satu keyword):']
            for s in (c.get('sources') or []):
                parts.append(f"- Sumber [{s.get('n')}]: {s.get('url')}")
            for req in c.get('required_parts', []):
                parts.append(f"- {req.get('label')}: keyword {req.get('keywords')}, minimal {req.get('min')}")
        parts.append('Setiap bagian wajib harus ADA di spec dengan id yang cocok — gerbang semantik akan menolak bila hilang. Detail teknis > dekorasi.')
        parts.append('')
    clip_an = read_json(os.path.join(ROOT, 'clip-analysis.json'), None)
    if clip_an:
        parts += ['=== REFERENSI GERAK KAMERA DARI CLIP (analisis vision — tiru shot-nya) ===',
                  json.dumps(clip_an, ensure_ascii=False)[:1200], '']
    ref = read_text(os.path.join(ROOT, 'reference-analysis.md'))
    if ref:
        parts += ['=== REFERENSI FOTO USER (analisis vision — bangun scene MENDEKATI referensi ini) ===', ref, '']
    parts += ['=== SCENE SAAT INI (JSON) ===',
              json.dumps(scene, ensure_ascii=False)[:28000], '']
    if open_fb:
        parts.append('=== FEEDBACK TERBUKA (indeks array asli) ===')
        for i, f in open_fb:
            parts.append(f'[{i}] {f.get("text", "")}')
        parts.append('')
    if history:
        parts.append('=== RIWAYAT CHAT TERAKHIR ===')
        for m in history:
            parts.append(f'{m.get("role", "?")}: {str(m.get("text", ""))[:700]}')
        parts.append('')
    if repair:
        parts += ['=== PERBAIKAN DIPERLUKAN (SMOKE TEST GAGAL) ===', repair, '']
    if selection:
        # Objek yang sedang dipilih user di viewport — permintaan mengacu ke sini
        found = None
        def find_obj(lst):
            for o in lst:
                if isinstance(o, dict):
                    if o.get('id') == selection:
                        return o
                    if isinstance(o.get('children'), list):
                        r = find_obj(o['children'])
                        if r: return r
            return None
        found = find_obj(scene.get('objects') or [])
        if found is None:
            found = next((l for l in (scene.get('lights') or []) if l.get('id') == selection), None)
        if found is None and selection in ('__camera', '__env'):
            found = scene.get('camera') if selection == '__camera' else scene.get('environment')
        parts.append('=== OBJEK TERPILIH USER (TARGET PERMINTAAN) ===')
        parts.append(f'id: {selection}')
        parts.append(json.dumps(found, ensure_ascii=False) if found else '(id tidak ditemukan di scene)')
        parts.append('Permintaan user MENGACU ke objek ini. Edit dengan upsert id yang SAMA PERSIS; '
                     'jangan ubah objek lain kecuali diminta. Bila objek di dalam group, pertahankan struktur group-nya.')
        parts.append('')
    parts.append('=== PERMINTAAN USER ===')
    parts.append(user_text)
    parts.append('')
    parts.append('Ingat: balas HANYA satu objek JSON valid sesuai format di system prompt.')
    return '\n'.join(parts)


def ask_llm(model, user_text, repair=None, max_tokens=20000):
    selection = CHAT.get('selection')
    """model: 'router:<id>' | 'opencode:<id>' | 'hermes:<id>' | '<id>' (router).

    Catatan: id router seperti 'qwen/qwen4-max:free' mengandung ':' sehingga
    hanya prefix backend yang dikenal yang boleh dipecah.
    """
    backend, mid = 'router', model
    for known in ('router', 'opencode', 'hermes'):
        if model.startswith(known + ':'):
            backend, mid = known, model[len(known) + 1:]
            break
    prompt = build_agent_prompt(user_text, repair, selection)
    if backend == 'opencode':
        status(f'memanggil opencode:{mid} (bisa 1-3 menit, harap tunggu)…')
        try:
            return call_opencode(mid, SYSTEM_PROMPT + '\n\n' + prompt)
        except Exception as e:
            if not any(k in str(e).lower() for k in ('timeout', 'timed out', '504', 'gateway')):
                raise
            fb = 'tencent/hy4-flash:free'  # model cepat, tidak perlu API key
            status(f'⚠️ opencode timeout — fallback otomatis ke {fb} (jangan perlu kirim ulang)')
            msgs = [{'role': 'system', 'content': SYSTEM_PROMPT}, {'role': 'user', 'content': prompt}]
            out = call_router(fb, msgs, max_tokens=max_tokens)
            status('✍️ fallback merespons — memvalidasi jawaban…')
            return (out[0] if isinstance(out, tuple) else out), fb
    messages = [{'role': 'system', 'content': SYSTEM_PROMPT},
                {'role': 'user', 'content': prompt}]
    if backend == 'hermes':
        status(f'memanggil hermes:{mid} — 🧠 berpikir…')
        return call_hermes(mid, messages, max_tokens=max_tokens)
    status(f'🧠 {mid} berpikir…')
    out = call_router(mid, messages, max_tokens=max_tokens)
    status('✍️ model merespons — membaca & memvalidasi jawaban…')
    return out


# ─────────────────────────── agent job ───────────────────────────
def _apply_result(result, iter_id):
    """Tulis scene.json + contract.md, resolve feedback. Return spec."""
    spec = result['scene']
    spec.setdefault('meta', {})
    spec['meta']['last_edit'] = 'agent'
    spec['meta']['iteration'] = iter_id
    spec['meta']['saved_at'] = time.time()
    with LOCK:
        write_json(os.path.join(ROOT, 'scene.json'), spec)
        contract = result.get('contract')
        if isinstance(contract, str) and contract.strip():
            with open(os.path.join(ROOT, 'contract.md'), 'w', encoding='utf-8') as f:
                f.write(contract.strip() + '\n')
        resolved = result.get('resolved_feedback') or []
        if resolved:
            fb = read_json(os.path.join(ROOT, 'feedback.json'), [])
            changed = False
            for idx in resolved:
                if isinstance(idx, int) and 0 <= idx < len(fb):
                    fb[idx]['status'] = 'resolved'
                    fb[idx]['resolved_by'] = iter_id
                    changed = True
            if changed:
                write_json(os.path.join(ROOT, 'feedback.json'), fb)
    return spec


def _render(iter_id, notes):
    status(f'render {iter_id} (headless chromium)…')
    cmd = [sys.executable, os.path.join(ROOT, 'scripts', 'render.py'), iter_id,
           '--notes', notes[:800]]
    try:
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=150)
    except subprocess.TimeoutExpired:
        status(f'render {iter_id} timeout (>150s)')
        return {'ok': False, 'smoke': {'pass': False, 'checks': []},
                'errors': ['render timeout']}
    rep = read_json(os.path.join(ROOT, 'iterations', iter_id, 'checklist.json'), {})
    checks = (rep.get('smoke') or {}).get('checks', []) if isinstance(rep, dict) else []
    npass = sum(1 for c in checks if c.get('pass'))
    smoke_pass = bool(isinstance(rep, dict) and rep.get('ok')
                      and (rep.get('smoke') or {}).get('pass'))
    status(f"smoke {iter_id}: {npass}/{len(checks)} {'✓' if smoke_pass else '✗'}")
    if proc.returncode not in (0, 2) and not checks:
        status('render gagal: ' + (proc.stderr or '')[-300:])
    return {'ok': smoke_pass, 'smoke': rep.get('smoke') if isinstance(rep, dict) else {},
            'checks': checks, 'npass': npass, 'ntotal': len(checks),
            'errors': (rep.get('errors') if isinstance(rep, dict) else []) or []}


# ── Knowledge card teknis + gerbang semantik ──
KNOWLEDGE_DIR = os.path.join(ROOT, 'knowledge')

def knowledge_for(text, spec=None):
    """Pilih card paling relevan. Satu keyword umum ('kabel') tidak boleh mengaktifkan
    card USB pada scene raket yang hanya menyebut 'jalur kabel' di dalamnya."""
    low = (text or '').lower()
    if isinstance(spec, dict):
        low += ' ' + str((spec.get('meta') or {}).get('name') or '').lower()
        low += ' ' + ' '.join(str(o.get('id') or '') + ' ' + str(o.get('name') or '')
                             for o in (spec.get('objects') or []) if isinstance(o, dict))
    scored = []
    try:
        names = sorted(os.listdir(KNOWLEDGE_DIR))
    except OSError:
        return []
    for fn in names:
        if not fn.endswith('.json'):
            continue
        card = read_json(os.path.join(KNOWLEDGE_DIR, fn), None)
        if not isinstance(card, dict):
            continue
        hits = [k for k in card.get('keywords', []) if str(k).lower() in low]
        if not hits:
            continue
        score = sum(max(1, len(str(k))) for k in hits)
        # butuh 2 kecocokan ATAU satu frasa spesifik (>=8 char, mis. 'kabel data', 'raket nyamuk')
        if len(hits) >= 2 or max(len(str(k)) for k in hits) >= 8:
            scored.append((score, card))
    scored.sort(key=lambda x: -x[0])
    return [c for _, c in scored[:2]]

def semantic_check(spec, text):
    """Cek bagian WAJIB sesuai knowledge card — verifikasi makna, bukan cuma struktur."""
    cards = knowledge_for(text, spec)
    if not cards:
        return None
    summaries = []
    for card in cards:
        found = {}
        for req in card.get('required_parts', []):
            n = 0
            def walk(o):
                nonlocal n
                hay = ((o.get('id') or '') + ' ' + (o.get('name') or '')).lower()
                must = req.get('must_type')
                type_ok = (not must or str(o.get('type') or '').lower() == str(must).lower())
                if type_ok and any(k.lower() in hay for k in req.get('keywords', [])):
                    tr = (o.get('instances') or {}).get('transforms') or []
                    n += max(1, len(tr)) if req.get('count_instances') and tr else 1
                for c in o.get('children') or []:
                    walk(c)
            for o in spec.get('objects', []):
                walk(o)
            mn = req.get('min', 1)
            found[req['key']] = {'label': req.get('label', req['key']), 'count': n, 'min': mn, 'ok': n >= mn}
        if card.get('requiresAssembly'):
            asm = spec.get('assembly') or {}
            layers = asm.get('layers') or []
            objs = spec.get('objects') or []
            tagged = sum(1 for o in objs if isinstance(o, dict) and o.get('layer'))
            okasm = (asm.get('mode') == 'layered' and len(layers) >= card.get('minLayers', 3)
                     and tagged >= max(3, len(objs) // 2))
            found['assembly'] = {'label': f"Assembly layered ≥{card.get('minLayers', 3)} lapis + field layer pada objek",
                                 'count': len(layers) if asm.get('mode') == 'layered' else 0,
                                 'min': card.get('minLayers', 3), 'ok': okasm}
        missing = [f"{v['label']} ({v['count']}/{v['min']})" for v in found.values() if not v['ok']]
        summaries.append({
            'card': card.get('id'), 'title': card.get('title'),
            'ok': not missing,
            'score': round(100 * sum(v['ok'] for v in found.values()) / max(1, len(found))),
            'found': found, 'missing': missing,
        })
    score = min(s['score'] for s in summaries)
    return {'ok': all(s['ok'] for s in summaries), 'score': score, 'cards': summaries,
            'missing': [m for s in summaries for m in s['missing']]}

VISION_MODELS = ['meituan/longcat-2.5:free', 'qwen/qwen4-max:free']

def vision_question(spec=None):
    """Rubrik vision mengikuti kontrak proyek — jangan pakai rubrik kota untuk semua scene."""
    spec = spec if isinstance(spec, dict) else read_json(os.path.join(ROOT, 'scene.json'), {})
    meta = spec.get('meta') or {}
    contract = read_text(os.path.join(ROOT, 'contract.md')) or ''
    m = re.search(r'## Konsep\s*\n(.+)', contract)
    concept = (meta.get('concept') or (m.group(1).strip() if m else '') or meta.get('name') or 'subjek utama')
    names = [o.get('id') for o in (spec.get('objects') or [])[:14] if o.get('id')]
    return (
        'Kritik render 3D ini sebagai karya FINAL (bukan cek teknis), sesuai proyek berikut. '
        f'NAMA: {meta.get("name", "scene")}. KONSEP: {concept[:350]}. '
        f'KOMPONEN KUNCI: {", ".join(names)}. '
        'Nilai 1-10 tiap dimensi: '
        'komposisi (kedalaman 3 lapis, subjek sesuai konsep jadi focal point), '
        'detail (komponen kunci terbaca, tidak berantakan/aliasing), '
        'material (metal/plastik/kaca terbaca, tidak flat atau blowout), '
        'cahaya (arah konsisten, bayangan masuk akal, highlight tidak berlebihan), '
        'atmosfer (mood sesuai konsep, latar tidak mengganggu subjek). '
        'Cek pula: apakah subjek utama sesuai konsep benar-benar terlihat jelas? '
        'Jangan menyebut objek yang tidak ada di daftar komponen di atas. '
        'WAJIB akhiri respons dengan tiga baris persis format ini:\n'
        'SKOR: komposisi=<n> detail=<n> material=<n> cahaya=<n> atmosfer=<n>\n'
        'VERDICT: <LAYAK FINAL atau MASIH TUTORIAL>\n'
        'KRITIK: <satu kalimat perbaikan paling berdampak, bahasa Indonesia>')
VISION_QUESTION = (
    'Kritik render 3D ini sebagai karya final (bukan cek teknis). Nilai 1-10 tiap dimensi: '
    'komposisi (kedalaman 3 lapis, focal point), detail (jendela individual, atap, elemen kehidupan), '
    'material (tekstur terbaca, tidak flat), cahaya (arah konsisten, bayangan, bloom bila malam), '
    'atmosfer (langit gradasi, kabut, mood). Cek juga: apakah subjek utama (mobil/orang/lampu) terlihat? '
    'WAJIB akhiri respons dengan tiga baris persis format ini:\n'
    'SKOR: komposisi=<n> detail=<n> material=<n> cahaya=<n> atmosfer=<n>\n'
    'VERDICT: <LAYAK FINAL atau MASIH TUTORIAL>\n'
    'KRITIK: <satu kalimat perbaikan paling berdampak, bahasa Indonesia>')


def vision_gate(iter_id):
    """Nilai shot.png dengan model vision. Return {pass, avg, scores, critique} atau None bila unavailable."""
    shot = os.path.join(ROOT, 'iterations', iter_id, 'shot.png')
    if not os.path.exists(shot):
        return None
    img = base64.b64encode(open(shot, 'rb').read()).decode()
    for vm in VISION_MODELS:
        try:
            data = http_json(ROUTER_URL, {
                'model': vm, 'max_tokens': 700, 'temperature': 0.1,
                'messages': [{'role': 'user', 'content': [
                    {'type': 'text', 'text': vision_question()},
                    {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + img}},
                ]}],
            }, timeout=90)
            text = _message_text((data.get('choices') or [{}])[0].get('message'))
            ms = re.search(r'komposisi=(\d+)\s+detail=(\d+)\s+material=(\d+)\s+cahaya=(\d+)\s+atmosfer=(\d+)', text)
            mv = re.search(r'VERDICT:\s*(LAYAK FINAL|MASIH TUTORIAL)', text)
            mk = re.search(r'KRITIK:\s*(.+)', text)
            if not ms:
                continue
            scores = {k: int(v) for k, v in zip(['komposisi', 'detail', 'material', 'cahaya', 'atmosfer'], ms.groups())}
            avg = sum(scores.values()) / 5
            verdict_ok = (mv.group(1) == 'LAYAK FINAL') if mv else (avg >= 7)
            return {'pass': bool(verdict_ok and avg >= 6.0), 'avg': avg,
                    'scores': ', '.join(f'{k}={v}' for k, v in scores.items()),
                    'critique': (mk.group(1).strip() if mk else text[-200:])}
        except Exception:
            continue
    return None


def _fail_summary(render):
    failing = [f"{c.get('id')}: {c.get('detail', '')}"
               for c in render.get('checks', []) if not c.get('pass')]
    lines = failing or render.get('errors') or ['smoke test gagal tanpa detail']
    return '\n'.join('- ' + x for x in lines)


def _job_active(job_id):
    with LOCK:
        return CHAT.get('job_id') == job_id and CHAT.get('running')


def apply_diff(current, diff):
    """Gabungkan diff kecil ke scene penuh: upsert by id, remove_ids, ganti lights/camera/env/post opsional."""
    if CHAT.get('scope') == 'production':
        # Studio Rekaman HANYA boleh mengubah produksi — geometri/lighting/camera
        # statis milik Studio Design dan tidak boleh tersentuh dari sini.
        allowed = {'cameraPath', 'audio'}
        filtered = {k: v for k, v in diff.items() if k in allowed}
        if len(filtered) != len(diff):
            status('mode produksi: perubahan design pada diff dibuang (objects/lights/camera dll.)')
        diff = filtered
    spec = json.loads(json.dumps(current))
    objs = spec.get('objects') or []
    removes = set(diff.get('remove_ids') or [])
    objs = [o for o in objs if o.get('id') not in removes]
    by_id = {o.get('id'): i for i, o in enumerate(objs)}
    n_up = 0
    for o in diff.get('upserts') or []:
        if not isinstance(o, dict) or not o.get('id'):
            continue
        if o['id'] in by_id:
            objs[by_id[o['id']]] = o
        else:
            objs.append(o)
            by_id[o['id']] = len(objs) - 1
        n_up += 1
    if not objs:
        raise ValueError('diff menghapus semua objek tanpa pengganti')
    spec['objects'] = objs
    if isinstance(diff.get('lights'), list):
        spec['lights'] = diff['lights']
    if isinstance(diff.get('joints'), list):
        spec['joints'] = diff['joints']
    if isinstance(diff.get('cameraPath'), dict):
        spec['cameraPath'] = diff['cameraPath']
    # Auto-prune: joint yang merujuk body terhapus/tidak ada dibuang otomatis
    # (hapus objek fisika tidak boleh meninggalkan joint yatim -> build error)
    if isinstance(spec.get('joints'), list):
        ids = {o.get('id') for o in objs}
        spec['joints'] = [j for j in spec['joints']
                          if isinstance(j, dict) and j.get('body1') in ids and j.get('body2') in ids]
    for key in ('camera', 'environment', 'post', 'meta'):
        if isinstance(diff.get(key), dict):
            spec[key] = {**(spec.get(key) or {}), **diff[key]}
    return spec, n_up, len(removes)


def materialize_result(result):
    """Terima {diff:...} (default, cepat) atau {scene:...} (scene baru total). Return (spec, mode)."""
    if not isinstance(result, dict):
        return None, ''
    if isinstance(result.get('scene'), dict):
        return result['scene'], 'full'
    if isinstance(result.get('diff'), dict):
        current = read_json(os.path.join(ROOT, 'scene.json'), {})
        spec, n_up, n_rm = apply_diff(current, result['diff'])
        return spec, f'diff (+{n_up} upsert, -{n_rm} hapus)'
    return None, ''


def run_agent_job(job_id, user_text, model):
    try:
        status(f'job {job_id} dimulai · model {model}')
        status('menyiapkan konteks (contract, scene, feedback, riwayat)…')
        raw, used_model = ask_llm(model, user_text)
        if not _job_active(job_id):
            return  # dibatalkan saat menunggu model — jangan proses respons zombie
        status(f'memanggil model {used_model}… respons diterima, mem-parsing JSON')
        result = extract_json_object(raw)
        spec0, mode0 = materialize_result(result)

        if not spec0:
            status('JSON tidak valid — potongan respons: ' + repr(raw[:220]))
            status('retry sekali dengan instruksi tegas')
            raw, used_model = ask_llm(
                model, user_text,
                repair='Respons sebelumnya bukan JSON valid. Balas HANYA satu objek JSON '
                       'dengan kunci reply, diff (upserts/remove_ids), contract, resolved_feedback.')
            result = extract_json_object(raw)
            spec0, mode0 = materialize_result(result)
        if not spec0:
            raise RuntimeError('model tidak menghasilkan JSON diff/scene yang valid setelah retry')
        result['scene'] = spec0
        status(f'mode {mode0}')

        errs = validate_spec(result['scene'])
        if errs:
            status('validasi spec gagal — retry sekali: ' + '; '.join(errs[:4]))
            raw, used_model = ask_llm(
                model, user_text,
                repair='Spec sebelumnya TIDAK VALID:\n' + '\n'.join('- ' + e for e in errs) +
                       '\nPerbaiki dan kirim JSON lengkap yang valid.')
            result = extract_json_object(raw)
            spec1, _ = materialize_result(result)
            if not spec1:
                raise RuntimeError('retry validasi gagal: ' + '; '.join(errs[:4]))
            result['scene'] = spec1
            errs = validate_spec(result['scene'])
            if errs:
                raise RuntimeError('spec tetap tidak valid: ' + '; '.join(errs[:6]))
        status(f"validasi spec OK ({len(result['scene'].get('objects', []))} objek, "
               f"{len(result['scene'].get('lights', []))} lampu)")

        if not _job_active(job_id):
            return  # job sudah dibatalkan/diganti watchdog — jangan tulis apa pun
        if CHAT.get('proposal_only'):
            spec_p = result['scene'] or {}
            proposal = {'brief': user_text, 'cameraPath': spec_p.get('cameraPath') or {},
                        'reply': str(result.get('reply') or ''), 'model': used_model, 'at': time.time()}
            with open(os.path.join(ROOT, 'direct-proposal.json'), 'w') as f:
                json.dump(proposal, f, ensure_ascii=False, indent=2)
            with LOCK:
                CHAT['proposal_only'] = False
            status(f'usul sutradara siap — {len((proposal["cameraPath"].get("shots") or []))} shot, menunggu persetujuan')
            append_chat_message({'role': 'agent', 'text': '📋 Usul storyboard: ' + proposal['reply'][:400] +
                                 '\nKlik ✅ Setujui & Terapkan di panel Skills bila setuju.', 'at': time.time(), 'model': used_model})
            return
        if CHAT.get('design_proposal_only'):
            sp = result['scene'] or {}
            prop = {
                'brief': user_text,
                'contract': result.get('contract') or read_text(os.path.join(ROOT, 'contract.md')),
                'reply': str(result.get('reply') or '').strip(),
                'assembly': sp.get('assembly'),
                'parts': [{'id': o.get('id'), 'name': o.get('name'), 'type': o.get('type'),
                           'layer': o.get('layer'), 'children': len(o.get('children') or [])}
                          for o in (sp.get('objects') or [])][:120],
                'model': used_model, 'at': time.time(),
            }
            with open(os.path.join(ROOT, 'design-proposal.json'), 'w') as f:
                json.dump(prop, f, ensure_ascii=False, indent=2)
            with LOCK:
                CHAT['design_proposal_only'] = False
            status(f'usul desain siap — {len(prop["parts"])} komponen diusulkan, menunggu persetujuan')
            append_chat_message({'role': 'agent', 'text': '📐 Usul desain: ' + prop['reply'][:500] +
                                 '\nCek usul kontrak & daftar komponen, lalu klik ✅ Setujui & Bangun.',
                                 'at': time.time(), 'model': used_model})
            return
        reply = str(result.get('reply') or '').strip() or 'Scene diperbarui.'
        iter_id = next_iteration_id()
        _apply_result(result, iter_id)
        status(f'menulis scene.json + contract.md · {iter_id}')
        render = _render(iter_id, reply)

        # Gerbang semantik: bagian teknis sesuai knowledge card (bukan model generik)
        sem = semantic_check(result['scene'], user_text)
        sem_summary = ''
        if sem:
            sem_summary = f"Semantik: {sem['score']}% {'LENGKAP ✓' if sem['ok'] else 'KURANG ✗ — ' + ', '.join(sem['missing'][:4])}"
            status(sem_summary)
            try:
                with open(os.path.join(ROOT, 'iterations', iter_id, 'semantic.json'), 'w') as f:
                    json.dump(sem, f, ensure_ascii=False, indent=2)
            except OSError:
                pass
        else:
            status('semantik: tidak ada knowledge card untuk prompt ini')

        # Satu ronde perbaikan jika smoke gagal.
        if not render['ok']:
            if not _job_active(job_id):
                return
            status('smoke gagal — satu ronde perbaikan otomatis')
            repair_text = ('Smoke test otomatis GAGAL untuk iterasi ini. Perbaiki scene.\n' +
                           _fail_summary(render) +
                           '\nKirim JSON DIFF (upserts/remove_ids) yang memperbaiki poin gagal — JANGAN tulis ulang seluruh scene.')
            raw, used_model = ask_llm(model, user_text, repair=repair_text)
            fixed = extract_json_object(raw)
            fixed_spec, _ = materialize_result(fixed)
            if fixed_spec:
                fixed['scene'] = fixed_spec
            if fixed_spec and not validate_spec(fixed_spec):
                reply = str(fixed.get('reply') or reply).strip() or reply
                iter_id2 = next_iteration_id()
                _apply_result(fixed, iter_id2)
                status(f'menulis perbaikan · {iter_id2}')
                render2 = _render(iter_id2, reply)
                if render2['ok']:
                    iter_id, render, result = iter_id2, render2, fixed
                else:
                    status('perbaikan masih gagal — iterasi terakhir disimpan sebagai bukti')
                    iter_id, render = iter_id2, render2
            else:
                status('perbaikan model tidak valid — mempertahankan iterasi gagal')

        # Gerbang estetika otomatis: vision menilai hasil; maks 2 ronde perbaikan.
        # Edit kecil (diff ≤8 objek, tanpa ubah lighting/kamera/lingkungan) cukup cek teknis —
        # menilai ulang seluruh scene untuk satu mobil tambahan = buang waktu 2-3 menit.
        vision_summary = ''
        d = result.get('diff') or {}
        minor_edit = (isinstance(result.get('diff'), dict)
                      and len(d.get('upserts') or []) <= 15
                      and len(d.get('remove_ids') or []) <= 8
                      and not any(k in d for k in ('lights', 'camera', 'environment', 'post')))
        if render['ok'] and minor_edit:
            status('edit kecil — gerbang estetika dilewati (smoke + oklusi cukup untuk perubahan minor)')
            vision_summary = 'Edit minor: cek teknis 8/8 (gerbang estetika untuk perubahan besar/scene baru)'
        if render['ok'] and not minor_edit:
            for vround in range(2):
                if not _job_active(job_id):
                    return
                status(f'gerbang estetika: cek vision ronde {vround + 1}…')
                v = vision_gate(iter_id)
                if v is None:
                    status('vision tidak tersedia — gerbang estetika dilewati (smoke tetap pass)')
                    break
                if v['pass']:
                    vision_summary = f"Estetika: LAYAK FINAL (skor {v['scores']})"
                    status(f"estetika LAYAK FINAL (rata-rata {v['avg']:.1f})")
                    break
                status(f"estetika belum final (rata-rata {v['avg']:.1f}) — perbaikan otomatis")
                raw, used_model = ask_llm(model, user_text, repair=(
                    'Smoke test LOLOS tapi gerbang estetika vision MENOLAK hasil ini.\n'
                    f"Skor: {v['scores']}\nKritik vision: {v['critique']}\n"
                    'Perbaiki HANYA poin kritik dengan mengubah material/lighting/post pada objek yang ADA; '
                    'JANGAN menambah objek dekoratif baru atau varian id; tanpa menghapus '
                    'objek yang sudah ada dan tanpa mengubah layout yang sudah lolos oklusi. '
                    'Kirim JSON DIFF (upserts/remove_ids) — JANGAN tulis ulang seluruh scene.'))
                fixed = extract_json_object(raw)
                fixed_spec, _ = materialize_result(fixed)
                if fixed_spec:
                    fixed['scene'] = fixed_spec
                if fixed_spec and not validate_spec(fixed_spec):
                    reply = str(fixed.get('reply') or reply).strip() or reply
                    iter_id2 = next_iteration_id()
                    _apply_result(fixed, iter_id2)
                    status(f'menulis perbaikan estetika · {iter_id2}')
                    render2 = _render(iter_id2, reply)
                    if render2['ok']:
                        iter_id, render, result = iter_id2, render2, fixed
                    else:
                        status('perbaikan estetika gagal smoke — scene dikembalikan ke iterasi lolos terakhir')
                        with LOCK:
                            write_json(os.path.join(ROOT, 'scene.json'), result['scene'])
                        break
                else:
                    status('perbaikan estetika tidak valid — berhenti di iterasi terakhir')
                    break
            else:
                vision_summary = 'Estetika: belum final setelah 2 ronde perbaikan (iterasi terbaik disimpan)'

        with LOCK:
            CHAT['last_iteration'] = iter_id
        smoke = render.get('smoke') or {}
        ok = bool(render.get('ok'))
        npass, ntotal = render.get('npass', 0), render.get('ntotal', 0)
        summary = (f"Smoke {npass}/{ntotal} {'lolos ✓' if ok else 'gagal ✗'} · iterasi {iter_id}"
                   if ntotal else f"Render selesai · iterasi {iter_id} (tanpa checklist)")
        if not _job_active(job_id):
            return
        perubahan = f"Perubahan diterapkan: {mode0}" if mode0 else ''
        full_reply = f"{reply}\n\n{summary}" + (f"\n{sem_summary}" if sem_summary else '') + (f"\n{vision_summary}" if vision_summary else '') + (f"\n{perubahan}" if perubahan else '')
        append_chat_message({
            'role': 'agent', 'text': full_reply, 'at': time.time(),
            'iteration': iter_id, 'model': used_model,
            'smoke': {'pass': ok, 'passed': npass, 'total': ntotal},
        })
        try: os.remove(os.path.join(ROOT, 'job.json'))
        except OSError: pass
        status(f'selesai · {iter_id} · smoke ' + ('PASS' if ok else 'FAIL'))
        if not ok:
            with LOCK:
                CHAT['error'] = 'smoke test gagal: ' + _fail_summary(render)[:400]
    except Exception as e:
        if not _job_active(job_id):
            return  # job sudah dibatalkan/diganti — zombie jangan menulis apa pun
        msg = f'Agent gagal: {e} — coba kirim ulang atau ganti model router yang lebih cepat di dropdown'
        status(msg)
        append_chat_message({'role': 'agent', 'text': msg, 'at': time.time(),
                             'iteration': None, 'model': model, 'error': True})
        with LOCK:
            CHAT['error'] = str(e)
    finally:
        with LOCK:
            if CHAT.get('job_id') == job_id:
                CHAT['running'] = False
                try: os.remove(os.path.join(ROOT, 'job.json'))
                except OSError: pass


def start_job(text, model, selection=None, scope=None):
    with CHAT_LOCK:
        with LOCK:
            if CHAT['running']:
                return None
            job_id = 'job-%d' % int(time.time() * 1000)
            CHAT.update({
                'running': True, 'job_id': job_id, 'model': model,
                'started_at': time.time(), 'status_lines': [],
                'error': None, 'last_iteration': None, 'selection': selection,
            })
        append_chat_message({'role': 'user', 'text': text, 'at': time.time(),
                             'iteration': None, 'model': model})
        write_json(os.path.join(ROOT, 'job.json'),
                   {'job_id': job_id, 'text': text, 'model': model, 'selection': selection, 'started_at': time.time()})
        t = threading.Thread(target=run_agent_job, args=(job_id, text, model), daemon=True)
        t.start()

        def _watchdog(jid):
            time.sleep(1080)
            with LOCK:
                stale = CHAT.get('job_id') == jid and CHAT.get('running')
                if stale:
                    CHAT['running'] = False
                    CHAT['job_id'] = None
                    CHAT['error'] = 'timeout watchdog 1080s — job dibatalkan otomatis'
            if stale:
                status('watchdog: job macet >1080s, dibatalkan otomatis')
                append_chat_message({'role': 'agent', 'at': time.time(), 'iteration': None,
                                     'model': model, 'error': True,
                                     'text': 'Agent gagal: macet >18 menit (watchdog). Model terlalu lama atau kuota habis. Coba lagi, atau ganti backend/model di dropdown.'})
        threading.Thread(target=_watchdog, args=(job_id,), daemon=True).start()
        return job_id


# ─────────────────────────── backend discovery ───────────────────────────
def _router_backends():
    try:
        data = http_json(ROUTER_MODELS_URL, timeout=3)
        ids = [m.get('id') for m in data.get('data', []) if isinstance(m, dict)]
        free = [i for i in ids if i and 'free' in i.lower()]
        models = free or FREE_ROUTER_MODELS
        return {'id': 'router', 'label': 'Router (OpenAI-compatible)',
                'available': True, 'status': 'ready', 'reason': '',
                'models': [{'id': m, 'value': m, 'backend': 'router', 'label': m} for m in models]}
    except Exception as e:
        return {'id': 'router', 'label': 'Router (OpenAI-compatible)',
                'available': False, 'status': 'unavailable',
                'reason': f'router tidak merespons: {e}',
                'models': [{'id': m, 'value': m, 'backend': 'router', 'label': m}
                           for m in FREE_ROUTER_MODELS]}


def _opencode_models():
    try:
        data = _opencode_get('/api/model', timeout=3)
        items = data.get('data', data) if isinstance(data, dict) else data
        out = []
        for m in items or []:
            if not isinstance(m, dict) or m.get('providerID') != 'opencode':
                continue
            if m.get('enabled') is False:
                continue
            mid = m.get('modelID') or m.get('id')
            if not mid:
                continue
            out.append(mid)
        # prioritaskan model free yang diketahui
        order = {m: i for i, m in enumerate(OPENCODE_FALLBACK_MODELS)}
        out.sort(key=lambda x: (order.get(x, 99), x))
        seen, uniq = set(), []
        for m in out:
            if m not in seen:
                seen.add(m)
                uniq.append(m)
        return uniq or OPENCODE_FALLBACK_MODELS
    except Exception:
        return OPENCODE_FALLBACK_MODELS


def _start_opencode():
    try:
        proc = subprocess.run(['opencode', 'service', 'start'], capture_output=True,
                              text=True, timeout=15)
        return proc.returncode == 0
    except Exception:
        return False


def _opencode_backend():
    models = _opencode_models()
    try:
        info = _opencode_get('/api/info', timeout=3)
        ver = info.get('version', '?')
        return {'id': 'opencode', 'label': 'OpenCode service', 'available': True,
                'status': 'ready', 'reason': '', 'version': ver,
                'models': [{'id': m, 'value': 'opencode:' + m, 'backend': 'opencode',
                            'label': m} for m in models]}
    except Exception:
        if _start_opencode():
            models = _opencode_models()
            try:
                info = _opencode_get('/api/info', timeout=4)
                return {'id': 'opencode', 'label': 'OpenCode service', 'available': True,
                        'status': 'ready', 'reason': '', 'version': info.get('version', '?'),
                        'models': [{'id': m, 'value': 'opencode:' + m, 'backend': 'opencode',
                                    'label': m} for m in models]}
            except Exception as e:
                reason = str(e)
        else:
            reason = 'server opencode tidak aktif dan gagal dihidupkan'
        return {'id': 'opencode', 'label': 'OpenCode service', 'available': False,
                'status': 'unavailable', 'reason': reason,
                'models': [{'id': m, 'value': 'opencode:' + m, 'backend': 'opencode',
                            'label': m} for m in models]}


def _hermes_backend():
    key = _hermes_key()
    models = [{'id': m, 'value': 'hermes:' + m, 'backend': 'hermes', 'label': m}
              for m in HERMES_MODELS]
    if not key:
        return {'id': 'hermes', 'label': 'Hermes gateway', 'available': False,
                'status': 'unconfigured', 'reason': 'perlu API_SERVER_KEY',
                'models': models}
    try:
        http_json(HERMES_URL.replace('/chat/completions', '/models'),
                  headers={'Authorization': 'Bearer ' + key}, timeout=3)
        return {'id': 'hermes', 'label': 'Hermes gateway', 'available': True,
                'status': 'ready', 'reason': '', 'models': models}
    except Exception as e:
        return {'id': 'hermes', 'label': 'Hermes gateway', 'available': False,
                'status': 'unavailable', 'reason': f'gateway: {e}', 'models': models}


def backends():
    return {'backends': [_router_backends(), _opencode_backend(), _hermes_backend()],
            'default_model': DEFAULT_MODEL}


# ─────────────────────────── HTTP handler ───────────────────────────

# ─────────────────────────── projek & export ───────────────────────────
import shutil, zipfile, io, datetime

PROJECTS = os.path.join(ROOT, 'projects')
ACTIVE_FILE = os.path.join(ROOT, 'active.json')
PROJECT_FILES = ['scene.json', 'contract.md', 'feedback.json', 'chat.json']


def slugify(name):
    s = re.sub(r'[^a-z0-9]+', '-', str(name).lower()).strip('-')
    return s[:40] or 'projek'


def active_project():
    a = read_json(ACTIVE_FILE, {})
    return a.get('name') or slugify((read_json(os.path.join(ROOT, 'scene.json'), {}).get('meta') or {}).get('name') or 'tanpa-nama')


def set_active(name):
    write_json(ACTIVE_FILE, {'name': name, 'at': time.time()})


def snapshot_current(name):
    """Salin workspace root ke projects/<name> (auto-save sebelum new/load)."""
    dst = os.path.join(PROJECTS, slugify(name))
    os.makedirs(dst, exist_ok=True)
    for f in PROJECT_FILES:
        src = os.path.join(ROOT, f)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(dst, f))
    idir = os.path.join(ROOT, 'iterations')
    if os.path.isdir(idir):
        shutil.copytree(idir, os.path.join(dst, 'iterations'), dirs_exist_ok=True)
    return dst


def list_projects():
    out = []
    if os.path.isdir(PROJECTS):
        for name in sorted(os.listdir(PROJECTS)):
            d = os.path.join(PROJECTS, name)
            if not os.path.isdir(d):
                continue
            sc = read_json(os.path.join(d, 'scene.json'), {})
            idir = os.path.join(d, 'iterations')
            iters = sorted([x for x in os.listdir(idir)]) if os.path.isdir(idir) else []
            thumb = None
            for it in reversed(iters):
                p = os.path.join(idir, it, 'shot.png')
                if os.path.exists(p):
                    thumb = f'projects/{name}/iterations/{it}/shot.png'
                    break
            out.append({'name': name, 'title': (sc.get('meta') or {}).get('name') or name,
                        'objects': len(sc.get('objects') or []), 'iterations': len(iters),
                        'mtime': os.path.getmtime(os.path.join(d, 'scene.json')) if os.path.exists(os.path.join(d, 'scene.json')) else 0,
                        'thumb': thumb})
    return out


def starter_spec(title):
    return {
        'meta': {'name': title, 'concept': '', 'seed': 42, 'spec_version': 1},
        'environment': {'background': '#10131a', 'ground': {'size': 40, 'color': '#1a1e26', 'roughness': 0.95}, 'exposure': 1.1},
        'camera': {'position': [7, 5, 9], 'target': [0, 1, 0], 'fov': 50},
        'lights': [
            {'id': 'hemi', 'type': 'hemisphere', 'color': '#8899bb', 'groundColor': '#222233', 'intensity': 0.7},
            {'id': 'key', 'type': 'directional', 'color': '#fff2d8', 'intensity': 2.0, 'position': [8, 12, 6], 'castShadow': True, 'shadowExtent': 20}],
        'objects': []}


def reset_workspace(title):
    write_json(os.path.join(ROOT, 'scene.json'), starter_spec(title))
    with open(os.path.join(ROOT, 'contract.md'), 'w', encoding='utf-8') as f:
        f.write(f'# Kontrak — {title}\n\n## Konsep\n(belum ada — tulis prompt di tab Agent untuk membangun scene)\n\n## Acceptance criteria\nA. Smoke 8/8 pass.\nB. Gerbang estetika vision ≥6 + verdict layak final (untuk perubahan besar).\n')
    write_json(os.path.join(ROOT, 'feedback.json'), [])
    write_json(os.path.join(ROOT, 'chat.json'), [])
    idir = os.path.join(ROOT, 'iterations')
    if os.path.isdir(idir):
        shutil.rmtree(idir)
    os.makedirs(idir, exist_ok=True)


def load_project_dir(name):
    src = os.path.join(PROJECTS, slugify(name))
    if not os.path.isdir(src):
        raise RuntimeError(f'projek "{name}" tidak ditemukan')
    for f in PROJECT_FILES:
        p = os.path.join(src, f)
        if os.path.exists(p):
            shutil.copy2(p, os.path.join(ROOT, f))
    idir = os.path.join(ROOT, 'iterations')
    if os.path.isdir(idir):
        shutil.rmtree(idir)
    shutil.copytree(os.path.join(src, 'iterations'), idir, dirs_exist_ok=True)


CDN = 'https://cdn.jsdelivr.net/npm/three@0.160.0'


def standalone_html(spec):
    """HTML mandiri satu file: spec inline + builder inline (import CDN) + viewer orbit."""
    builder = read_text(os.path.join(ROOT, 'js', 'scene-builder.js'))
    builder = re.sub(r"^import \* as THREE from 'three';\s*\n", '', builder, flags=re.M)
    builder = builder.replace("from '../vendor/GLTFLoader.js'", f"from '{CDN}/examples/jsm/loaders/GLTFLoader.js'")
    builder = builder.replace("from '../vendor/rapier.es.js'", "from 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/rapier.es.js'")
    builder = re.sub(r"from '../vendor/jsm/postprocessing/([^']+)'",
                     lambda m: f"from '{CDN}/examples/jsm/postprocessing/{m.group(1)}'", builder)
    title = (spec.get('meta') or {}).get('name') or 'Three.js Scene'
    return f"""<!DOCTYPE html>
<html lang="id"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title} — Three.js Studio Export</title>
<style>html,body{{margin:0;height:100%;overflow:hidden;background:#000}}canvas{{display:block;width:100%;height:100%}}
#info{{position:fixed;top:10px;left:12px;color:#cfd3dc;font:12px/1.4 system-ui;background:rgba(15,17,22,.7);padding:6px 12px;border-radius:6px;pointer-events:none}}
</style>
<script type="importmap">{{"imports":{{"three":"{CDN}/build/three.module.js"}}}}</script>
</head><body>
<canvas id="cv"></canvas><div id="info"><b>{title}</b> · drag: orbit · scroll: zoom · export Three.js Studio</div>
<div id="bedah"></div>
<div id="mech"></div>
<div id="ctl"></div>
<style>#ctl{{position:fixed;bottom:12px;right:12px;display:flex;gap:6px}}
#ctl button{{background:rgba(30,33,40,.9);border:1px solid #2e333d;color:#cfd3dc;border-radius:6px;padding:8px 14px;font:600 13px system-ui;cursor:pointer}}
#ctl button.on{{background:#1d3a2a;border-color:#3fb96b;color:#7ee2a8}}
#mech{{position:fixed;bottom:58px;right:12px;background:rgba(22,24,29,.88);border:1px solid #2e333d;border-radius:8px;padding:8px 12px;display:flex;flex-direction:column;gap:6px;max-width:260px;font:11px system-ui;color:#8b91a0}}
#mech:empty{{display:none}}
#mech .row{{display:flex;align-items:center;gap:8px}}
#mech .lab{{width:92px;flex:none}}
#mech input[type=range]{{flex:1;accent-color:#4f8cff;min-width:70px}}
#mech .val{{font-family:monospace;color:#cfd3dc;width:34px;text-align:right}}
#mech button{{background:#232730;border:1px solid #2e333d;color:#8b91a0;border-radius:5px;padding:4px 10px;font-size:11px;cursor:pointer;width:100%;text-align:left}}
#mech button.on{{border-color:#3fb96b;color:#7ee2a8}}
#bedah{{position:fixed;top:12px;left:12px;background:rgba(22,24,29,.9);border:1px solid #2e333d;border-radius:8px;padding:8px 12px;max-width:270px;font:11px system-ui;color:#8b91a0;display:flex;flex-direction:column;gap:6px}}
#bedah .row{{display:flex;align-items:center;gap:8px}}
#bedah .lab{{width:86px;flex:none}}
#bedah input[type=range]{{flex:1;accent-color:#4f8cff;min-width:60px}}
#bedah .val{{font-family:monospace;color:#cfd3dc;width:38px;text-align:right}}
#bedah button{{background:#232730;border:1px solid #2e333d;color:#8b91a0;border-radius:5px;padding:4px 8px;font-size:11px;cursor:pointer}}
#bedah button.on{{border-color:#3fb96b;color:#7ee2a8}}
#bedah select{{background:#16181d;border:1px solid #2e333d;color:#cfd3dc;border-radius:4px;padding:2px 4px}}</style>
<script type="module">
import * as THREE from 'three';
import {{ OrbitControls }} from '{CDN}/examples/jsm/controls/OrbitControls.js';
import {{ PointerLockControls }} from '{CDN}/examples/jsm/controls/PointerLockControls.js';
{builder}
const SPEC = {json.dumps(spec, ensure_ascii=False)};
const cv = document.getElementById('cv');
const handle = await buildScene(SPEC);
if (SPEC.cameraPath?.dof?.enabled) handle.dof = SPEC.cameraPath.dof;
const cinePath = compileCameraPath(handle);
let cinePlaying = !!(cinePath && cinePath.autoplay), cineT = 0;
const renderer = makeRenderer(cv, innerWidth, innerHeight, {{ exposure: SPEC.environment?.exposure ?? 1.1 }});
handle.camera.aspect = innerWidth / innerHeight; handle.camera.updateProjectionMatrix();
handle.composer = makeComposer(handle, renderer, innerWidth, innerHeight);
const controls = new OrbitControls(handle.camera, cv);
// ── Interaktivitas: onClick objek, shift-drag fisika, mode jalan first-person ──
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let downXY = null, dragPlane = null;
const dragVec = new THREE.Vector3();
function findSpec(id) {{ return (SPEC.objects || []).find(x => x.id === id); }}
function clickAction(o) {{
  const act = o && o.onClick; if (!act) return;
  if (act.action === 'power') {{ powerOn = !powerOn; audioClick(handle); }}
  else if (act.action === 'impulse') {{ const b = handle.bodyMap.get(o.id); if (b && act.impulse) b.applyImpulse({{ x: act.impulse[0], y: act.impulse[1], z: act.impulse[2] }}, true); }}
  else if (act.action === 'explode') applyExplosion(handle, act.center || o.position || [0, 1, 0], act.force ?? 8, act.radius ?? 5);
  else if (act.action === 'toggle') {{ const m = handle.registry.get(o.id); if (m) m.visible = !m.visible; }}
}}
function pick(e) {{
  const r = cv.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, handle.camera);
  const meshes = (SPEC.objects || []).map(o => handle.registry.get(o.id)).filter(m => m && m.visible !== false);
  const hits = ray.intersectObjects(meshes, true);
  if (!hits.length) return null;
  let o = hits[0].object;
  while (o && !o.userData.specId) o = o.parent;
  return {{ id: o && o.userData.specId, point: hits[0].point }};
}}
cv.addEventListener('pointerdown', e => {{
  downXY = [e.clientX, e.clientY];
  if (e.shiftKey && handle.physicsWorld && !cinePlaying && !walkOn) {{
    const h = pick(e);
    if (h && h.id && startDrag(handle, h.id, h.point)) {{
      const cd = new THREE.Vector3(); handle.camera.getWorldDirection(cd);
      dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(cd, h.point);
      controls.enabled = false;
    }}
  }}
}});
cv.addEventListener('pointermove', e => {{
  if (handle.drag && dragPlane) {{
    const r = cv.getBoundingClientRect();
    ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ptr, handle.camera);
    if (ray.ray.intersectPlane(dragPlane, dragVec)) moveDrag(handle, dragVec);
  }}
}});
cv.addEventListener('pointerup', e => {{
  if (handle.drag) {{ endDrag(handle); dragPlane = null; if (!cinePlaying && !walkOn) controls.enabled = true; downXY = null; return; }}
  if (!downXY || walkOn) return;
  const moved = Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]);
  downXY = null;
  if (moved > 5 || e.button !== 0) return;
  const h = pick(e);
  if (h && h.id) clickAction(findSpec(h.id));
}});
// Mode jalan first-person (WASD + mouse look, tinggi mata 1.7m)
const plc = new PointerLockControls(handle.camera, cv);
let walkOn = false;
const keys = {{}};
addEventListener('keydown', e => {{ keys[e.code] = true; }});
addEventListener('keyup', e => {{ keys[e.code] = false; }});
const wb = document.createElement('button');
wb.textContent = '🚶 Jalan';
wb.style.cssText = 'position:fixed;top:12px;right:110px;background:rgba(22,24,29,.92);border:1px solid #2e333d;color:#cfd3dc;border-radius:8px;padding:6px 12px;font:12px system-ui;cursor:pointer;z-index:9';
wb.onclick = () => {{ if (!walkOn) plc.lock(); else plc.unlock(); }};
plc.addEventListener('lock', () => {{ walkOn = true; controls.enabled = false; handle.camera.position.y = 1.7; wb.textContent = '🚶 ESC keluar'; }});
plc.addEventListener('unlock', () => {{ walkOn = false; if (!cinePlaying) controls.enabled = true; wb.textContent = '🚶 Jalan'; }});
document.body.appendChild(wb);
const hint = document.createElement('div');
hint.textContent = 'Klik objek = aksi · Shift+drag = angkat fisika · 🚶 WASD jalan';
hint.style.cssText = 'position:fixed;bottom:44px;left:12px;color:#6b7280;font:10px system-ui;z-index:8';
document.body.appendChild(hint);
controls.enableDamping = true; controls.target.copy(handle.target);
addEventListener('resize', () => {{
  renderer.setSize(innerWidth, innerHeight, false);
  handle.composer?.setSize(innerWidth, innerHeight);
  handle.camera.aspect = innerWidth / innerHeight; handle.camera.updateProjectionMatrix();
}});
let animT = 0, powerOn = SPEC.power?.default ?? true, playing = true;
const clock = new THREE.Clock();
const ctl = document.getElementById('ctl');
function drawCtl() {{
  ctl.innerHTML = '';
  if (SPEC.power) {{
    const b = document.createElement('button');
    b.textContent = (powerOn ? '⏻ ' : '⭘ ') + (SPEC.power.label || 'Nyala');
    b.className = powerOn ? 'on' : '';
    b.onclick = () => {{ powerOn = !powerOn; drawCtl(); }};
    ctl.appendChild(b);
  }}
  if ((handle.animations || []).length || handle.physicsWorld) {{
    const b = document.createElement('button');
    b.textContent = playing ? '⏸ Jeda' : '▶ Putar';
    b.onclick = () => {{ playing = !playing; drawCtl(); }};
    ctl.appendChild(b);
  }}
}}
drawCtl();
const mech = document.getElementById('mech');
for (const c of SPEC.controls || []) {{
  if (!c.target || !handle.registry.has(c.target)) continue;
  const row = document.createElement('div'); row.className = 'row';
  handle.overrides[c.target] = handle.overrides[c.target] || {{}};
  if (c.type === 'toggle') {{
    const b = document.createElement('button');
    const get = () => handle.overrides[c.target].enabled ?? true;
    const paint = () => {{ b.textContent = (get() ? '☑ ' : '☐ ') + c.label; b.className = get() ? 'on' : ''; }};
    b.onclick = () => {{ handle.overrides[c.target].enabled = !get(); paint(); }};
    paint(); row.appendChild(b);
  }} else {{
    const lab = document.createElement('span'); lab.className = 'lab'; lab.textContent = c.label;
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = c.min ?? 0; inp.max = c.max ?? 100; inp.step = c.step ?? 1;
    inp.value = handle.overrides[c.target][c.param || 'speed'] ?? c.default ?? 0;
    const val = document.createElement('span'); val.className = 'val'; val.textContent = inp.value;
    inp.oninput = () => {{ handle.overrides[c.target][c.param || 'speed'] = parseFloat(inp.value); val.textContent = inp.value; }};
    row.appendChild(lab); row.appendChild(inp); row.appendChild(val);
  }}
  mech.appendChild(row);
}}
// Panel bedah assembly
const bedah = document.getElementById('bedah');
let explodeF = 0, lastExplodeF = 0, xrayOn = false;
const secOpts = {{ enabled: false, axis: 'x', pos: 0, flip: false }};
{{
  const head = document.createElement('div'); head.innerHTML = '<b style="color:#cfd3dc">🔬 Bedah</b>'; bedah.appendChild(head);
  const r1 = document.createElement('div'); r1.className = 'row';
  r1.innerHTML = '<span class="lab">Exploded</span>';
  const s1 = document.createElement('input'); s1.type = 'range'; s1.min = 0; s1.max = 1; s1.step = 0.01; s1.value = 0;
  const v1 = document.createElement('span'); v1.className = 'val'; v1.textContent = '0%';
  s1.oninput = () => {{ explodeF = parseFloat(s1.value); v1.textContent = Math.round(explodeF * 100) + '%'; }};
  r1.append(s1, v1); bedah.appendChild(r1);
  const r2 = document.createElement('div'); r2.className = 'row';
  const t2 = document.createElement('button'); t2.textContent = '☐ Section';
  t2.onclick = () => {{ secOpts.enabled = !secOpts.enabled; t2.textContent = (secOpts.enabled ? '☑' : '☐') + ' Section'; t2.className = secOpts.enabled ? 'on' : ''; setSection(handle, renderer, secOpts); }};
  const ax = document.createElement('select');
  ['x','y','z'].forEach(a => {{ const o = document.createElement('option'); o.value = a; o.textContent = a.toUpperCase(); ax.appendChild(o); }});
  ax.onchange = () => {{ secOpts.axis = ax.value; setSection(handle, renderer, secOpts); }};
  const fl = document.createElement('button'); fl.textContent = '⇄'; fl.title = 'Balik arah potong';
  fl.onclick = () => {{ secOpts.flip = !secOpts.flip; setSection(handle, renderer, secOpts); }};
  r2.append(t2, ax, fl); bedah.appendChild(r2);
  const r3 = document.createElement('div'); r3.className = 'row';
  r3.innerHTML = '<span class="lab">Posisi potong</span>';
  const s3 = document.createElement('input'); s3.type = 'range'; s3.min = -10; s3.max = 10; s3.step = 0.05; s3.value = 0;
  const v3 = document.createElement('span'); v3.className = 'val'; v3.textContent = '0.0';
  s3.oninput = () => {{ secOpts.pos = parseFloat(s3.value); v3.textContent = secOpts.pos.toFixed(1); setSection(handle, renderer, secOpts); }};
  r3.append(s3, v3); bedah.appendChild(r3);
  const r4 = document.createElement('div'); r4.className = 'row';
  const xr = document.createElement('button'); xr.textContent = '☐ X-ray';
  xr.onclick = () => {{ xrayOn = !xrayOn; xr.textContent = (xrayOn ? '☑' : '☐') + ' X-ray'; xr.className = xrayOn ? 'on' : ''; setXray(handle, xrayOn, null); }};
  r4.appendChild(xr);
  const cp = document.createElement('button'); cp.textContent = '☑ Caps'; cp.className = 'on';
  cp.onclick = () => {{ secOpts.caps = !secOpts.caps; cp.textContent = (secOpts.caps ? '☑' : '☐') + ' Caps'; cp.className = secOpts.caps ? 'on' : ''; if (secOpts.enabled) setSection(handle, renderer, secOpts); }};
  r4.appendChild(cp); bedah.appendChild(r4);
}}
// Audio mekanika
let audioOn = false;
const ab = document.createElement('button');
ab.textContent = '🔇 Suara';
ab.style.cssText = 'position:fixed;top:12px;right:12px;background:rgba(22,24,29,.92);border:1px solid #2e333d;color:#cfd3dc;border-radius:8px;padding:6px 12px;font:12px system-ui;cursor:pointer;z-index:9';
ab.onclick = () => {{ audioOn = !audioOn; if (audioOn) {{ const a = makeAudio(handle); if (a) a.ctx.resume(); }} ab.textContent = audioOn ? '🔊 Suara' : '🔇 Suara'; }};
document.body.appendChild(ab);
// Caption + tombol sinematik
const cineCap = document.createElement('div');
cineCap.style.cssText = 'position:fixed;bottom:64px;left:50%;transform:translateX(-50%);background:rgba(10,12,16,.85);border:1px solid #2e333d;color:#e8eaef;padding:7px 18px;border-radius:8px;font:13px system-ui;display:none;max-width:70%;text-align:center;z-index:9';
document.body.appendChild(cineCap);
if (cinePath) {{
  const cb = document.createElement('button');
  cb.textContent = cinePlaying ? '⏹ Stop' : '🎥 Putar';
  cb.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);background:rgba(22,24,29,.92);border:1px solid #4f8cff;color:#cfd3dc;border-radius:8px;padding:6px 14px;font:12px system-ui;cursor:pointer;z-index:9';
  cb.onclick = () => {{ cinePlaying = !cinePlaying; controls.enabled = !cinePlaying; cb.textContent = cinePlaying ? '⏹ Stop' : '🎥 Putar'; if (cinePlaying) cineT = 0; else {{ cineCap.style.display = 'none'; const sm = sampleCameraPath(handle, cinePath, cineT); if (sm) controls.target.copy(sm.target); }} }};
  document.body.appendChild(cb);
}}
// Timeline scrub
const tl = document.createElement('div');
tl.style.cssText = 'position:fixed;bottom:14px;left:50%;transform:translateX(-50%);display:flex;gap:8px;align-items:center;background:rgba(22,24,29,.9);border:1px solid #2e333d;border-radius:8px;padding:5px 12px;font:11px system-ui;color:#8b91a0';
const tlPlay = document.createElement('button'); tlPlay.textContent = '⏸';
tlPlay.style.cssText = 'background:#232730;border:1px solid #2e333d;color:#cfd3dc;border-radius:5px;padding:2px 9px;cursor:pointer';
tlPlay.onclick = () => {{ playing = !playing; tlPlay.textContent = playing ? '⏸' : '▶'; }};
const tlTime = document.createElement('span'); tlTime.textContent = '0.0s'; tlTime.style.cssText = 'font-family:monospace;width:38px;text-align:right';
const tlSlider = document.createElement('input'); tlSlider.type = 'range'; tlSlider.min = 0; tlSlider.max = 10; tlSlider.step = 0.05; tlSlider.value = 0;
tlSlider.style.cssText = 'width:180px;accent-color:#4f8cff';
if (cinePath) tlSlider.max = cinePath.dur.toFixed(1);
tlSlider.oninput = () => {{
  playing = false; tlPlay.textContent = '▶';
  if (cinePath) {{
    cineT = parseFloat(tlSlider.value);
    const sm = sampleCameraPath(handle, cinePath, cineT);
    if (sm) {{ handle.camera.position.copy(sm.pos); handle.camera.lookAt(sm.target); handle.camera.fov = sm.fov; handle.camera.updateProjectionMatrix(); if (sm.explode !== null) {{ applyExplode(handle, sm.explode); lastExplodeF = sm.explode; }} cineCap.textContent = sm.caption || ''; cineCap.style.display = sm.caption ? 'block' : 'none'; }}
    tlTime.textContent = cineT.toFixed(1) + 's';
    return;
  }}
  animT = parseFloat(tlSlider.value);
  if (handle.physicsWorld) {{ resetPhysics(handle); const n = Math.min(600, Math.round(animT * 60)); for (let i = 0; i < n; i++) stepPhysics(handle, 1 / 60); }}
  applyAnimations(handle, animT, powerOn);
  tlTime.textContent = animT.toFixed(1) + 's';
}};
tl.append(tlPlay, tlTime, tlSlider);
if ((handle.animations || []).length || handle.physicsWorld || cinePath) document.body.appendChild(tl);
let physAcc = 0;
if (handle.physicsWorld) {{
  const b = document.createElement('button');
  b.textContent = '↺ Reset fisika';
  b.onclick = () => location.reload();
  ctl.appendChild(b);
}}
renderer.setAnimationLoop(() => {{
  const dt = Math.min(clock.getDelta(), 0.1);
  if (walkOn) {{
    const sp = 3.5 * dt;
    if (keys['KeyW']) plc.moveForward(sp);
    if (keys['KeyS']) plc.moveForward(-sp);
    if (keys['KeyA']) plc.moveRight(-sp);
    if (keys['KeyD']) plc.moveRight(sp);
    handle.camera.position.y = 1.7;
  }}
  if (cinePlaying && cinePath) {{
    controls.enabled = false;
    cineT += dt;
    const sm = sampleCameraPath(handle, cinePath, cineT);
    if (sm) {{
      handle.camera.position.copy(sm.pos); handle.camera.lookAt(sm.target);
      controls.target.copy(sm.target);
      handle.camera.fov = sm.fov; handle.camera.updateProjectionMatrix();
      if (sm.explode !== null) {{ applyExplode(handle, sm.explode); lastExplodeF = sm.explode; }}
      cineCap.textContent = sm.caption || ''; cineCap.style.display = sm.caption ? 'block' : 'none';
    }}
    if (document.activeElement !== tlSlider) {{ tlSlider.value = (cineT % cinePath.dur).toFixed(2); tlTime.textContent = (cineT % cinePath.dur).toFixed(1) + 's'; }}
  }}
  if (playing) {{
    animT += dt;
    if (handle.physicsWorld && explodeF === 0 && !cinePlaying) {{
      physAcc += dt;
      let n = 0;
      while (physAcc >= 1 / 60 && n < 4) {{ stepPhysics(handle, 1 / 60); physAcc -= 1 / 60; n++; }}
    }}
  }}
  applyAnimations(handle, animT, powerOn);
  if (!cinePlaying && (explodeF > 0 || lastExplodeF > 0)) {{ applyExplode(handle, explodeF); lastExplodeF = explodeF; }}
  if (handle.capSystem) syncCaps(handle);
  if (audioOn && handle.audio) {{
    const spin = (handle.animations || []).find(a => a.anim.type === 'spin');
    const spd = spin ? ((handle.overrides?.[spin.id]?.speed ?? spin.anim.speed ?? 10) / 10) : 1;
    updateAudio(handle, powerOn, spd);
  }}
  if (playing && document.activeElement !== tlSlider) {{ tlSlider.value = (animT % 10).toFixed(2); tlTime.textContent = (animT % 10).toFixed(1) + 's'; }}
  controls.update();
  if (handle.composer) handle.composer.render(); else renderer.render(handle.scene, handle.camera);
}});
</script></body></html>"""


def export_zip(spec):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('scene.json', json.dumps(spec, ensure_ascii=False, indent=2))
        z.writestr('standalone.html', standalone_html(spec))
        for f in ['contract.md', 'feedback.json', 'chat.json']:
            p = os.path.join(ROOT, f)
            if os.path.exists(p):
                z.write(p, f)
        idir = os.path.join(ROOT, 'iterations')
        if os.path.isdir(idir):
            for it in sorted(os.listdir(idir)):
                for fn in os.listdir(os.path.join(idir, it)):
                    z.write(os.path.join(idir, it, fn), f'iterations/{it}/{fn}')
    return buf.getvalue()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        pass  # senyap; akses penting dicatat manual

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # scene.json / chat.json harus selalu segar untuk polling.
        if not self.path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_GET(self):
        path = self.path.split('?')[0]
        if path.startswith('/api/knowledge/state'):
            with KB_LOCK:
                return self._send(200, {'ok': True, **(KB.get(urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get('job', [''])[0]) or {'status': 'unknown'})})
        if path == '/api/clip/state':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            job = (qs.get('job') or [''])[0]
            with CLIP_LOCK:
                return self._send(200, CLIP.get(job, {'status': 'unknown'}))
        if path == '/api/storyboard/state':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            job = (qs.get('job') or [''])[0]
            with STORY_LOCK:
                return self._send(200, STORY.get(job, {'status': 'unknown'}))
        if path == '/api/tts/state':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            job = (qs.get('job') or [''])[0]
            with TTS_LOCK:
                return self._send(200, TTS.get(job, {'status': 'unknown'}))
        if path == '/api/tts/audio':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            job = re.sub(r'[^a-zA-Z0-9-]', '', (qs.get('job') or [''])[0])
            fp = os.path.join(VOICE_DIR, job, 'narration.mp3')
            if not os.path.isfile(fp):
                return self._send(404, {'error': 'narasi belum ada'})
            data = open(fp, 'rb').read()
            self.send_response(200)
            self.send_header('Content-Type', 'audio/mpeg')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path == '/api/state':
            return self._send(200, state())
        if path == '/api/health':
            return self._send(200, {'ok': True})
        if path == '/api/video/state':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            job = (qs.get('job') or [''])[0]
            with VIDEO_LOCK:
                return self._send(200, VIDEO.get(job, {'status': 'unknown'}))
        if path == '/api/video/file':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            job = re.sub(r'[^a-z0-9-]', '', (qs.get('job') or [''])[0])
            fp = os.path.join(ROOT, 'videos', job + '.mp4')
            if not os.path.isfile(fp):
                return self._send(404, {'error': 'video belum ada'})
            data = open(fp, 'rb').read()
            self.send_response(200)
            self.send_header('Content-Type', 'video/mp4')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Content-Disposition', f'attachment; filename="{job}.mp4"')
            self.end_headers()
            self.wfile.write(data)
            return
        if path == '/api/chat/state':
            return self._send(200, chat_state())
        if path == '/api/backends':
            return self._send(200, backends())
        if path == '/api/projects':
            return self._send(200, {'active': active_project(), 'projects': list_projects()})
        if path == '/api/export':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            fmt = (qs.get('format') or ['html'])[0]
            spec = read_json(os.path.join(ROOT, 'scene.json'), {})
            stamp = datetime.date.today().isoformat()
            base = slugify((spec.get('meta') or {}).get('name') or 'scene') + '-' + stamp
            if fmt == 'bom':
                import io as _io, csv as _csv
                rows = [['id', 'nama', 'tipe', 'induk', 'dimensi', 'warna', 'roughness', 'metalness', 'emissive', 'fisika']]
                def walk(o, parent=''):
                    g = o.get('params') or o.get('geometry') or {}
                    dims = 'x'.join(str(g[k]) for k in ('radius', 'width', 'height', 'depth', 'radiusTop', 'radiusBottom', 'tube', 'size', 'length') if k in g) or '-'
                    sc = o.get('scale')
                    if sc and any(abs(v - 1) > 1e-6 for v in sc):
                        dims += ' @scale ' + 'x'.join(str(v) for v in sc)
                    m = o.get('material') or {}
                    rows.append([o.get('id', ''), o.get('name', ''), o.get('type', ''), parent, dims,
                                 m.get('color', ''), m.get('roughness', ''), m.get('metalness', ''),
                                 m.get('emissive', ''), (o.get('physics') or {}).get('body', '')])
                    for c in o.get('children') or []:
                        walk(c, o.get('id', ''))
                for o in spec.get('objects', []):
                    walk(o)
                buf = _io.StringIO()
                _csv.writer(buf).writerows(rows)
                body, ctype, ext = buf.getvalue().encode('utf-8'), 'text/csv; charset=utf-8', 'csv'
            elif fmt == 'json':
                body, ctype, ext = json.dumps(spec, ensure_ascii=False, indent=2).encode(), 'application/json', 'json'
            elif fmt == 'zip':
                body, ctype, ext = export_zip(spec), 'application/zip', 'zip'
            else:
                body, ctype, ext = standalone_html(spec).encode(), 'text/html', 'html'
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Disposition', f'attachment; filename="{base}.{ext}"')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == '/rekaman':
            self.path = '/rekaman.html'
        return super().do_GET()

    def do_POST(self):
        path = self.path.split('?')[0]
        try:
            length = int(self.headers.get('Content-Length', 0))
            payload = json.loads(self.rfile.read(length) or b'{}')
        except Exception as e:
            return self._send(400, {'ok': False, 'error': str(e)})
        if path == '/api/design/propose':
            text = (payload.get('brief') or '').strip()
            if not text:
                return self._send(400, {'ok': False, 'error': 'brief kosong'})
            model = payload.get('model') or CHAT.get('model') or DEFAULT_MODEL
            with LOCK:
                CHAT['design_proposal_only'] = True
            jid = start_job('[USUL DESAIN — JANGAN bangun scene penuh, tulis kontrak + daftar komponen + assembly saja] ' + text, model)
            if not jid:
                with LOCK:
                    CHAT['design_proposal_only'] = False
                return self._send(409, {'ok': False, 'error': 'agent masih sibuk'})
            return self._send(200, {'ok': True, 'job': jid})
        if path == '/api/design/proposal':
            return self._send(200, {'ok': True, 'proposal': read_json(os.path.join(ROOT, 'design-proposal.json'), None)})
        if path == '/api/design/approve':
            fp = os.path.join(ROOT, 'design-proposal.json')
            if not os.path.isfile(fp):
                return self._send(400, {'ok': False, 'error': 'belum ada usul desain'})
            prop = read_json(fp, {})
            contract = prop.get('contract') or ''
            if contract:
                with open(os.path.join(ROOT, 'contract.md'), 'w') as f:
                    f.write(contract)
            os.remove(fp)
            brief = ('Bangun scene lengkap sesuai KONTRAK YANG SUDAH DISETUJUI di contract.md. '
                     'Ikuti setiap komponen dalam daftar objek wajib, sertakan bagian dalam & assembly bila disebut. '
                     'Brief awal user: ' + str(prop.get('brief') or '')[:500])
            model = payload.get('model') or prop.get('model') or CHAT.get('model') or DEFAULT_MODEL
            jid = start_job(brief, model)
            status('usul desain DISETUJUI — agent mulai membangun scene sesuai kontrak')
            return self._send(200, {'ok': bool(jid), 'job': jid, 'parts': len(prop.get('parts') or [])})
        if path == '/api/direct/propose':
            text = (payload.get('brief') or '').strip()
            if not text:
                return self._send(400, {'ok': False, 'error': 'brief kosong'})
            model = payload.get('model') or CHAT.get('model') or DEFAULT_MODEL
            with LOCK:
                CHAT['proposal_only'] = True
            jid = start_job('[USUL SUTRADARA — jangan terapkan ke scene] ' + text, model)
            if not jid:
                with LOCK:
                    CHAT['proposal_only'] = False
                return self._send(409, {'ok': False, 'error': 'agent masih sibuk'})
            return self._send(200, {'ok': True, 'job': jid})
        if path == '/api/direct/approve':
            fp = os.path.join(ROOT, 'direct-proposal.json')
            if not os.path.isfile(fp):
                return self._send(400, {'ok': False, 'error': 'belum ada usul storyboard'})
            prop = read_json(fp, {})
            cp = prop.get('cameraPath') or {}
            if not cp.get('shots'):
                return self._send(400, {'ok': False, 'error': 'usulan tidak memuat shot'})
            spec = read_json(os.path.join(ROOT, 'scene.json'), {})
            spec['cameraPath'] = {k: v for k, v in cp.items() if k in ('shots', 'keyframes', 'duration', 'loop', 'autoplay', 'effects', 'shake', 'dof')}
            write_json(os.path.join(ROOT, 'scene.json'), spec)
            os.remove(fp)
            status(f'usul sutradara DISETUJUI — {len(cp["shots"])} shot diterapkan ke tur')
            return self._send(200, {'ok': True, 'shots': len(cp['shots'])})
        if path == '/api/knowledge/research':
            topic = (payload.get('topic') or '').strip()
            if not topic:
                return self._send(400, {'ok': False, 'error': 'topik kosong'})
            jid = 'kb-' + uuid.uuid4().hex[:10]
            threading.Thread(target=kb_research, args=(jid, topic), daemon=True).start()
            return self._send(200, {'ok': True, 'job': jid})
        if path == '/api/clip/imitate':
            data = payload.get('data', '')
            if ',' in data:
                data = data.split(',', 1)[1]
            ext = 'gif' if 'gif' in payload.get('type', '') else 'mp4'
            job = 'clip-' + datetime.datetime.now().strftime('%H%M%S')
            src = os.path.join(ROOT, f'clip-upload-{job}.{ext}')
            try:
                open(src, 'wb').write(base64.b64decode(data))
            except Exception:
                return self._send(400, {'ok': False, 'error': 'data clip tidak valid'})
            with CLIP_LOCK:
                CLIP[job] = {'status': 'analyzing'}
            __import__('threading').Thread(target=clip_imitate, args=(job, src), daemon=True).start()
            return self._send(200, {'ok': True, 'job': job})
        if path == '/api/storyboard/generate':
            cp = read_json(os.path.join(ROOT, 'scene.json'), {}).get('cameraPath') or {}
            shots = cp.get('shots') or []
            if not shots:
                return self._send(400, {'ok': False, 'error': 'tur belum ada — pilih preset dulu'})
            job = 'board-' + datetime.datetime.now().strftime('%H%M%S')
            with STORY_LOCK:
                STORY[job] = {'status': 'generating', 'shots': len(shots)}
            __import__('threading').Thread(target=story_generate, args=(job, shots), daemon=True).start()
            return self._send(200, {'ok': True, 'job': job, 'shots': len(shots)})
        if path == '/api/tts/generate':
            spec = read_json(os.path.join(ROOT, 'scene.json'), {})
            cp = spec.get('cameraPath') or {}
            shots = payload.get('shots') if isinstance(payload.get('shots'), list) else (cp.get('shots') or [])
            if not shots:
                return self._send(400, {'ok': False, 'error': 'tidak ada shot untuk dinarasikan'})
            job = 'voice-' + datetime.datetime.now().strftime('%H%M%S')
            with TTS_LOCK:
                TTS[job] = {'status': 'generating', 'shots': len(shots)}
            __import__('threading').Thread(target=tts_generate, args=(job, shots, payload.get('voice') or 'en-US-BrianMultilingualNeural'), daemon=True).start()
            return self._send(200, {'ok': True, 'job': job, 'shots': len(shots)})
        if path == '/api/tts/apply':
            job = re.sub(r'[^a-zA-Z0-9-]', '', payload.get('job', ''))
            fp = os.path.join(VOICE_DIR, job, 'timeline.json')
            if not os.path.isfile(fp):
                return self._send(400, {'ok': False, 'error': 'timeline narasi tidak ada'})
            tl = read_json(fp, {})
            spec = read_json(os.path.join(ROOT, 'scene.json'), {})
            cp = spec.get('cameraPath') or {}
            for b in tl.get('boundaries', []):
                i = b['index']
                if i < len(cp.get('shots', [])):
                    cp['shots'][i]['duration'] = b['suggestedShotDuration']
            spec['cameraPath'] = cp
            write_json(os.path.join(ROOT, 'scene.json'), spec)
            status(f'durasi shot disesuaikan ke narasi ({job}) — {len(tl.get("boundaries", []))} shot')
            return self._send(200, {'ok': True, 'boundaries': tl.get('boundaries', [])})
        if path == '/api/camerapath':
            cp = payload.get('cameraPath')
            if not isinstance(cp, dict):
                return self._send(400, {'ok': False, 'error': 'cameraPath harus objek'})
            spec = read_json(os.path.join(ROOT, 'scene.json'), {})
            # hanya tulis kunci produksi — sisa spec tidak berubah
            cp = {k: v for k, v in cp.items() if k in ('shots', 'keyframes', 'duration', 'loop', 'autoplay', 'shake', 'dof', 'effects')}
            spec['cameraPath'] = cp
            write_json(os.path.join(ROOT, 'scene.json'), spec)
            status(f'tur kamera disimpan dari Studio Rekaman ({len(cp.get("shots") or [])} shot)')
            return self._send(200, {'ok': True, 'shots': len(cp.get('shots') or [])})
        if path == '/api/vision/check':
            it = payload.get('iter') or ''
            if not it:
                ds = [d for d in os.listdir(os.path.join(ROOT, 'iterations')) if os.path.isdir(os.path.join(ROOT, 'iterations', d))]
                it = sorted(ds)[-1] if ds else ''
            v = vision_gate(it)
            if v:
                with open(os.path.join(ROOT, 'vision-final.json'), 'w') as f:
                    json.dump({'iteration': it, **v}, f, ensure_ascii=False, indent=2)
            return self._send(200, {'ok': bool(v), 'iteration': it, 'vision': v})
        if path == '/api/reference':
            data = payload.get('data', '')
            if ',' in data:
                data = data.split(',', 1)[1]
            try:
                raw = base64.b64decode(data)
            except Exception:
                return self._send(400, {'ok': False, 'error': 'base64 tidak valid'})
            with open(os.path.join(ROOT, 'reference.jpg'), 'wb') as f:
                f.write(raw)
            q = ('Kamu analis rekonstruksi 3D. Foto ini akan dibangun ulang sebagai scene Three.js oleh agent builder. '
               'Deskripsikan SANGAT konkret dalam bahasa Indonesia: '
               '(1) objek utama & fungsinya; (2) daftar komponen dengan bentuk primitif (box/sphere/cylinder/cone/torus/group) '
               'dan dimensi relatif dalam meter; (3) warna hex & material (metal/plastik/kaca/kain); '
               '(4) tata letak posisi antar komponen (koordinat perkiraan, objek utama di origin); '
               '(5) bagian yang bergerak & cara geraknya (putar/osilasi/engsel). '
               'Jangan basa-basi — langsung daftar terstruktur yang bisa dieksekusi agent 3D.')
            analysis = None
            for vm in VISION_MODELS:
                try:
                    r = http_json(ROUTER_URL, {
                        'model': vm, 'max_tokens': 1200, 'temperature': 0.2,
                        'messages': [{'role': 'user', 'content': [
                            {'type': 'text', 'text': q},
                            {'type': 'image_url', 'image_url': {'url': 'data:image/jpeg;base64,' + data}},
                        ]}],
                    }, timeout=120)
                    t = _message_text((r.get('choices') or [{}])[0].get('message'))
                    if t and len(t) > 80:
                        analysis = t
                        break
                except Exception:
                    continue
            if analysis:
                with open(os.path.join(ROOT, 'reference-analysis.md'), 'w') as f:
                    f.write(analysis)
            return self._send(200, {'ok': True, 'analyzed': bool(analysis), 'analysis': (analysis or '')[:800]})
        if path == '/api/reference/clear':
            for fn in ('reference.jpg', 'reference-analysis.md'):
                try:
                    os.remove(os.path.join(ROOT, fn))
                except OSError:
                    pass
            return self._send(200, {'ok': True})
        if path == '/api/video/start':
            job = 'vid-' + datetime.datetime.now().strftime('%H%M%S')
            fps = max(6, min(30, int(payload.get('fps', 24))))
            w = max(320, min(1920, int(payload.get('w', 960))))
            h = max(180, min(1080, int(payload.get('h', 540))))
            spec = read_json(os.path.join(ROOT, 'scene.json'), {})
            cp = spec.get('cameraPath') or {}
            dur = float(payload.get('duration') or 0)
            if not dur:
                shots = cp.get('shots') or []
                dur = sum(s.get('duration', 4) for s in shots) if shots else float(cp.get('duration') or 10)
            dur = max(2, min(60, dur))
            os.makedirs(os.path.join(ROOT, 'videos', 'frames', job), exist_ok=True)
            with VIDEO_LOCK:
                VIDEO[job] = {'status': 'rendering', 'frames': 0, 'total': int(dur * fps), 'fps': fps, 'w': w, 'h': h, 'duration': dur}
            return self._send(200, {'ok': True, 'job': job, 'url': f'/render-video.html?job={job}&fps={fps}&w={w}&h={h}&duration={dur}', 'total': int(dur * fps)})
        if path == '/api/video/frame':
            job = re.sub(r'[^a-z0-9-]', '', payload.get('job', ''))
            i = int(payload.get('i', 0))
            data = payload.get('data', '')
            if ',' in data:
                data = data.split(',', 1)[1]
            fp = os.path.join(ROOT, 'videos', 'frames', job, f'{i:05d}.jpg')
            os.makedirs(os.path.dirname(fp), exist_ok=True)
            with open(fp, 'wb') as f:
                f.write(base64.b64decode(data))
            with VIDEO_LOCK:
                if job in VIDEO:
                    VIDEO[job]['frames'] = i + 1
            return self._send(200, {'ok': True})
        if path == '/api/video/done':
            job = re.sub(r'[^a-z0-9-]', '', payload.get('job', ''))
            if payload.get('error'):
                with VIDEO_LOCK:
                    VIDEO[job] = {**VIDEO.get(job, {}), 'status': 'error', 'error': payload['error']}
                return self._send(200, {'ok': True})
            frames = int(payload.get('frames', 0))
            fps = int(payload.get('fps', 24))
            with VIDEO_LOCK:
                VIDEO[job] = {**VIDEO.get(job, {}), 'status': 'encoding', 'frames': frames, 'fps': fps}
            def encode():
                out = os.path.join(ROOT, 'videos', job + '.mp4')
                cmd = ['ffmpeg', '-y', '-framerate', str(fps), '-i', os.path.join(ROOT, 'videos', 'frames', job, '%05d.jpg')]
                with VIDEO_LOCK:
                    vo = VIDEO.get('voice')
                if not vo:
                    vo = read_json(os.path.join(VOICE_DIR, 'current.json'), None)
                cp_now = read_json(os.path.join(ROOT, 'scene.json'), {}).get('cameraPath') or {}
                if vo and vo.get('signature') == tts_signature(cp_now) and os.path.isfile(vo['audio']):
                    cmd += ['-i', vo['audio'], '-c:a', 'aac', '-b:a', '160k', '-shortest']
                    status('narasi TTS disertakan dalam MP4')
                cmd += ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]
                try:
                    r = subprocess.run(cmd, capture_output=True, timeout=600)
                    with VIDEO_LOCK:
                        if r.returncode == 0 and os.path.isfile(out):
                            VIDEO[job] = {**VIDEO[job], 'status': 'done', 'path': out, 'size': os.path.getsize(out)}
                        else:
                            VIDEO[job] = {**VIDEO[job], 'status': 'error', 'error': r.stderr.decode()[-300:]}
                except Exception as e:
                    with VIDEO_LOCK:
                        VIDEO[job] = {**VIDEO[job], 'status': 'error', 'error': str(e)}
            __import__('threading').Thread(target=encode, daemon=True).start()
            return self._send(200, {'ok': True, 'status': 'encoding'})
        if path == '/api/chat/cancel':
            with LOCK:
                was = bool(CHAT.get('running'))
                if was:
                    CHAT['running'] = False
                    CHAT['job_id'] = None
                    CHAT['error'] = 'dibatalkan user'
            if was:
                status('job dibatalkan oleh user')
                append_chat_message({'role': 'agent', 'at': time.time(), 'iteration': None,
                                     'model': CHAT.get('model'), 'error': True,
                                     'text': 'Job dibatalkan oleh user. Kirim prompt baru untuk memulai lagi.'})
            return self._send(200, {'ok': True, 'cancelled': was})
        if path in ('/api/project/new', '/api/project/save', '/api/project/load'):
            with LOCK:
                if CHAT.get('running'):
                    return self._send(409, {'ok': False, 'error': 'agent sedang berjalan — batalkan/tunggu dulu sebelum ganti projek'})
            name = slugify(payload.get('name') or '')
            if path == '/api/project/new':
                if not name:
                    return self._send(400, {'ok': False, 'error': 'nama projek wajib'})
                cur = read_json(os.path.join(ROOT, 'scene.json'), {})
                if cur.get('objects'):
                    snapshot_current(active_project())
                reset_workspace(payload.get('name') or name)
                set_active(name)
                return self._send(200, {'ok': True, 'project': name})
            if path == '/api/project/save':
                if not name:
                    name = active_project()
                dst = snapshot_current(name)
                set_active(name)
                return self._send(200, {'ok': True, 'project': name, 'path': dst})
            if path == '/api/project/load':
                cur = read_json(os.path.join(ROOT, 'scene.json'), {})
                if cur.get('objects'):
                    snapshot_current(active_project())
                try:
                    load_project_dir(name)
                except Exception as e:
                    return self._send(404, {'ok': False, 'error': str(e)})
                set_active(name)
                return self._send(200, {'ok': True, 'project': name})
        with LOCK:
            if path == '/api/scene':
                spec = payload.get('scene')
                if not isinstance(spec, dict) or 'objects' not in spec:
                    return self._send(400, {'ok': False, 'error': 'spec tidak valid'})
                spec.setdefault('meta', {})['last_edit'] = 'user'
                spec['meta']['saved_at'] = time.time()
                write_json(os.path.join(ROOT, 'scene.json'), spec)
                return self._send(200, {'ok': True, 'saved': 'scene.json'})
            if path == '/api/feedback':
                text = (payload.get('text') or '').strip()
                if not text:
                    return self._send(400, {'ok': False, 'error': 'feedback kosong'})
                fb = read_json(os.path.join(ROOT, 'feedback.json'), [])
                fb.append({'text': text, 'at': time.time(), 'iteration': payload.get('iteration'), 'status': 'open'})
                write_json(os.path.join(ROOT, 'feedback.json'), fb)
                return self._send(200, {'ok': True, 'count': len(fb)})
            if path == '/api/feedback/resolve':
                fb = read_json(os.path.join(ROOT, 'feedback.json'), [])
                idx = payload.get('index')
                if isinstance(idx, int) and 0 <= idx < len(fb):
                    fb[idx]['status'] = 'resolved'
                    write_json(os.path.join(ROOT, 'feedback.json'), fb)
                    return self._send(200, {'ok': True})
                return self._send(400, {'ok': False, 'error': 'index tidak valid'})
        if path == '/api/chat':
            text = (payload.get('text') or '').strip()
            model = (payload.get('model') or '').strip() or DEFAULT_MODEL
            selection = (payload.get('selection') or '').strip() or None
            if not text:
                return self._send(400, {'ok': False, 'error': 'teks permintaan kosong'})
            if len(text) > 4000:
                return self._send(400, {'ok': False, 'error': 'teks terlalu panjang (maks 4000)'})
            CHAT['scope'] = payload.get('scope') or 'design'
            job_id = start_job(text, model, selection, CHAT['scope'])
            if job_id is None:
                return self._send(409, {'ok': False, 'error': 'masih ada job agent berjalan'})
            return self._send(200, {'ok': True, 'job_id': job_id, 'model': model})
        return self._send(404, {'ok': False, 'error': 'endpoint tidak dikenal'})


def recover_interrupted_job():
    j = read_json(os.path.join(ROOT, 'job.json'))
    if j:
        append_chat_message({'role': 'agent', 'at': time.time(), 'iteration': None,
                             'model': j.get('model'), 'error': True,
                             'text': f"Job terputus karena server restart saat sedang berjalan. Prompt terakhir: \"{j.get('text','')[:120]}\" — kirim ulang untuk melanjutkan."})
        try: os.remove(os.path.join(ROOT, 'job.json'))
        except OSError: pass
        print('[startup] job terputus terdeteksi — pesan pemulihan ditulis ke chat', flush=True)


if __name__ == '__main__':
    recover_interrupted_job()
    print(f'Three.js Studio serving {ROOT} on 0.0.0.0:{PORT}', flush=True)
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
