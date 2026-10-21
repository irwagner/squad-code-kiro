"""Permanent headless check: a sprint runs features in parallel lanes (demo mode).
Run with: npm run test:parallel  (requires: pip install playwright; a Chrome/Edge install or `playwright install chromium`).

Verifies the multi-lane orchestration: with concurrency=2, two independent features execute
at the same time (two distinct agents), lanes refill as routes close, and the whole batch
reaches human review with no console/page errors. Live mode (real kiro-cli) stays single-lane by design."""
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
        pg.wait_for_timeout(1500)
        setup = pg.evaluate("""()=>{
          state.settings.stepMs=60; state.settings.motion=false; runtime().concurrency=2;
          const p=project();
          const s=(typeof currentSprint==='function'?currentSprint(p):null)||p.sprints[0];
          const sf=p.features.filter(f=>f.sprintId===s.id);
          sf.slice(0,4).forEach(f=>{f.dependencies=[];f.route=[];f.step=0;f.currentAgentId=null;f.status='backlog';});
          p.glossary=p.glossary||'demo'; p.architecture=p.architecture||'demo';
          if(!p.adrs||!p.adrs.length)p.adrs=[{title:'ADR1',content:'ctx'}];
          if(typeof squadById==='function'&&!squadById(p.squadId))p.squadId=(state.squads[0]&&state.squads[0].id)||p.squadId;
          return {gaps:projectGaps(p), sprint:s.id, conc:runtime().concurrency, live:liveMode()};
        }""")
        assert setup['gaps'] == [], f"runGate gaps: {setup['gaps']}"
        assert setup['live'] is False, "demo mode expected (no bridge)"
        assert setup['conc'] == 2, f"concurrency expected 2, got {setup['conc']}"
        pg.evaluate("(s)=>{startRun({sprintId:s});}", setup['sprint'])
        pg.wait_for_function("()=> runner && runner.phase==='awaiting'", timeout=30000)
        pg.evaluate("()=>{roomApprove();}")
        pg.wait_for_timeout(300)
        after = pg.evaluate("""()=>{const p=project();const r=p.features.filter(f=>f.status==='running');
          return {lanes:(runner&&runner.lanes)?runner.lanes.length:0, running:r.length, agents:[...new Set(r.map(f=>f.currentAgentId))].length};}""")
        maxc = max(after['lanes'], after['running'])
        snap = after
        for _ in range(120):
            pg.wait_for_timeout(120)
            snap = pg.evaluate("""()=>{const p=project();return {lanes:(runner&&runner.lanes)?runner.lanes.length:0,
              running:p.features.filter(f=>f.status==='running').length, review:p.features.filter(f=>f.status==='review').length, runnerNull:!runner};}""")
            maxc = max(maxc, snap['lanes'], snap['running'])
            if snap['runnerNull'] or snap.get('review', 0) >= 2:
                break
        b.close()
    ok = (not errors) and maxc >= 2 and after['agents'] >= 2 and snap.get('review', 0) >= 2
    print(f"PARALLEL: {'OK' if ok else 'FAIL'} maxConcurrent={maxc} agents={after['agents']} review={snap.get('review')} errors={errors[:3]}")
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
