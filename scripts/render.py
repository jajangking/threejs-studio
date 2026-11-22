#!/usr/bin/env python3
"""Render headless satu iterasi: chromium swiftshader -> shot.png + checklist.json.
Satu kali jalan chromium menghasilkan screenshot (dataURL di DOM) DAN laporan smoke test.
Pemakaian: python3 scripts/render.py iter-01 --notes "catatan agent" [--w 1280 --h 720]
"""
import argparse, base64, json, os, re, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = os.environ.get('STUDIO_PORT', '8091')

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('iter_id')
    ap.add_argument('--scene', default='scene.json')
    ap.add_argument('--notes', default='')
    ap.add_argument('--w', type=int, default=1280)
    ap.add_argument('--h', type=int, default=720)
    ap.add_argument('--time', type=float, default=None, help='pose kamera sinematik pada detik t (cameraPath)')
    ap.add_argument('--explode', type=float, default=None, help='faktor exploded (0..1) untuk render bedah')
    ap.add_argument('--name', default='shot', help='nama file gambar & checklist (mis. bedah)')
    ap.add_argument('--focus', default='', help='module = closeup komponen internal')
    a = ap.parse_args()

    url = f'http://127.0.0.1:{PORT}/render.html?scene={a.scene}&w={a.w}&h={a.h}'
    if a.time is not None:
        url += f'&t={a.time}'
    if a.explode is not None:
        url += f'&explode={a.explode}'
    if a.focus:
        url += f'&focus={a.focus}'
    cmd = ['chromium', '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
           '--no-proxy-server', '--enable-unsafe-swiftshader', '--hide-scrollbars',
           f'--window-size={a.w},{a.h}', '--virtual-time-budget=15000',
           '--timeout=30000', '--dump-dom', url]
    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=150)
    dom = p.stdout
    if not dom:
        print('GAGAL: chromium tidak menghasilkan DOM\n' + p.stderr[-2000:], file=sys.stderr)
        sys.exit(1)

    m = re.search(r'<img id="shot"[^>]*src="data:image/png;base64,([^"]+)"', dom)
    r = re.search(r'<pre id="report">(.*?)</pre>', dom, re.S)
    outdir = os.path.join(ROOT, 'iterations', a.iter_id)
    os.makedirs(outdir, exist_ok=True)

    report = json.loads(r.group(1)) if r else {'ok': False, 'errors': ['report tidak ditemukan di DOM']}
    if m:
        with open(os.path.join(outdir, a.name + '.png'), 'wb') as f:
            f.write(base64.b64decode(m.group(1)))
    else:
        report.setdefault('errors', []).append('screenshot tidak ditemukan di DOM')

    with open(os.path.join(outdir, ('checklist' if a.name == 'shot' else a.name + '-checklist') + '.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    with open(os.path.join(outdir, 'notes.md'), 'w', encoding='utf-8') as f:
        f.write(a.notes + '\n')

    smoke = report.get('smoke', {})
    checks = smoke.get('checks', [])
    npass = sum(1 for c in checks if c.get('pass'))
    print(f"iter={a.iter_id} waktu={time.time()-t0:.1f}s ok={report.get('ok')} "
          f"smoke={npass}/{len(checks)} pass={smoke.get('pass')} "
          f"coverage={smoke.get('coverage', 0):.3f} lum={smoke.get('meanLum', 0):.1f}")
    for c in checks:
        if not c.get('pass'):
            print(f"  ✗ {c['id']}: {c.get('detail','')}")
    for e in report.get('errors', []):
        print(f"  ERROR: {e}")
    print(f"hasil: {outdir}/{a.name}.png")
    sys.exit(0 if report.get('ok') and smoke.get('pass') else 2)

if __name__ == '__main__':
    main()
