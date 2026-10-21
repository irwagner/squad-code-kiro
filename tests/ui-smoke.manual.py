"""UI smoke (Playwright + system Chrome): loads the built index.html in demo mode and checks it boots without
JS errors, exposes window.SquadCode.getSnapshot, and that the new-operation template picker renders.
Run with: npm run test:ui  (requires: pip install playwright; a Chrome/Edge install or `playwright install chromium`)."""
import pathlib, sys
from playwright.sync_api import sync_playwright

idx = pathlib.Path('index.html').resolve().as_uri()
errors = []
with sync_playwright() as p:
    try:
        b = p.chromium.launch(channel='chrome', headless=True)
    except Exception:
        try:
            b = p.chromium.launch(channel='msedge', headless=True)
        except Exception:
            b = p.chromium.launch(headless=True)
    pg = b.new_page()
    pg.on('console', lambda m: errors.append('console.error: ' + m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    pg.goto(idx, wait_until='load')
    pg.wait_for_timeout(1500)
    api = pg.evaluate("() => !!(window.SquadCode && typeof window.SquadCode.getSnapshot === 'function')")
    opts = pg.evaluate("() => { openOpNew('UI Smoke'); const el = document.querySelector('#opNewTpl'); return el ? Array.from(el.options).map(o=>o.value) : []; }")
    b.close()

ok = True
def check(cond, msg):
    global ok
    print(('ok - ' if cond else 'FAIL: ') + msg)
    ok = ok and cond

check(api, 'app bootou e expõe window.SquadCode.getSnapshot')
check(set(['system','saas','lab','pentest']).issubset(set(opts)), 'seletor de templates com system/saas/lab/pentest, got ' + str(opts))
check(len(errors) == 0, 'sem erros de console/página (%d)' % len(errors))
for e in errors[:10]:
    print('  -', e[:160])
print('\nUI SMOKE ' + ('PASSED' if ok else 'FAILED'))
sys.exit(0 if ok else 1)
