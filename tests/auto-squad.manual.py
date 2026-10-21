"""Permanent headless check: a natural-language brief auto-assembles a complete squad (demo/heuristic mode).
Run with: npm run test:auto  (requires: pip install playwright; a Chrome/Edge install or `playwright install chromium`).

The live LLM path (bridge) uses the same flow; here we verify the offline heuristic end to end: brief -> spec -> squad."""
import pathlib
import sys


def main():
    idx = pathlib.Path(__file__).resolve().parent.parent.joinpath('index.html').as_uri()
    errors = []
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch(channel='chrome', headless=True, args=['--use-gl=swiftshader'])
        pg = b.new_page()
        pg.set_default_timeout(30000)
        pg.on('pageerror', lambda e: errors.append('pageerror:' + str(e)))
        pg.on('console', lambda m: errors.append('cerr:' + m.text) if m.type == 'error' else None)
        pg.goto(idx, wait_until='load')
        pg.wait_for_timeout(1200)
        assert pg.evaluate("()=>liveMode()") is False, "demo mode expected (no bridge)"
        spec = pg.evaluate("""async()=>{
          openAutoSquad();
          const ta=document.querySelector('#autoBrief');
          if(ta) ta.value='app de delivery com cardapio, carrinho, pagamento, em react e node';
          await autoSquadGo();
          const s=ui.autoSquad; return s&&s.spec?{ops:s.spec.operators,cmd:s.spec.commander,modal:ui.modal}:null;
        }""")
        assert spec and isinstance(spec.get('ops'), list) and len(spec['ops']) >= 2, f"spec invalido: {spec}"
        assert 'SENTINEL' in spec['ops'], "QA (SENTINEL) deveria entrar sempre"
        created = pg.evaluate("""()=>{
          const before=state.squads.length; autoSquadCreate();
          const q=state.squads[state.squads.length-1];
          return {grew:state.squads.length-before, missing:q?squadMissing(q):['sem squad'], members:(q&&q.agentIds||[]).length, view:ui.view, modal:ui.modal};
        }""")
        b.close()
    ok = (not errors) and created['grew'] == 1 and created['missing'] == [] and created['members'] >= 5 and created['view'] == 'squads'
    print(f"AUTO-SQUAD: {'OK' if ok else 'FAIL'} ops={spec.get('ops')} missing={created['missing']} members={created['members']} errors={errors[:3]}")
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
