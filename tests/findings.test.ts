import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectDesignFindings, designFindingReference } from '../src/core/findings';
import { loadProjectFromFs } from '../src/core/load';

const stillRoot = 'fixtures/app-owned/still-meditation/design/blueprint';
const blankRoot = 'fixtures/app-owned/blank-slate/design/blueprint';
const denseRoot = 'fixtures/app-owned/dense-ops/design/blueprint';

describe('design findings', () => {
  it('attributes every lint finding to the boundary whose source must change', async () => {
    const still = collectDesignFindings(await loadProjectFromFs(stillRoot));
    assert.deepEqual([...new Set(still.map(finding => finding.boundaryId))], ['still-meditation/screen/home']);
    assert.deepEqual(still.filter(finding => finding.rule === 'native-control').map(finding => finding.location), [
      'prototype/screens/home.html:17',
      'prototype/screens/home.html:96'
    ]);
    const blank = collectDesignFindings(await loadProjectFromFs(blankRoot));
    assert.ok(blank.some(finding => finding.boundaryId === 'blank-slate-proof/component/site-footer' && finding.kind === 'component'));
    assert.deepEqual(collectDesignFindings(await loadProjectFromFs(denseRoot)), []);
  });

  it('reports unmarked sections against their screen', async () => {
    const bundle = await loadProjectFromFs(stillRoot);
    const source = 'prototype/screens/home.html';
    bundle.prototypeSourceContents[source] = bundle.prototypeSourceContents[source].replace(' data-blueprint-section="welcome"', '');
    const marker = collectDesignFindings(bundle).find(finding => finding.rule === 'section-marker');
    assert.deepEqual(marker && { boundaryId: marker.boundaryId, location: marker.location }, {
      boundaryId: 'still-meditation/screen/home',
      location: source
    });
    assert.match(marker?.message ?? '', /section "welcome" has no data-blueprint-section="welcome" marker/);
  });

  it('formats a finding as a pasteable instruction for the agent', async () => {
    const [control] = collectDesignFindings(await loadProjectFromFs(stillRoot)).filter(finding => finding.rule === 'native-control');
    assert.equal(
      designFindingReference(control),
      'screen:home prototype/screens/home.html:17 hand-builds a native <button>; use <blueprint-use kind="primitive" ref="button"> or mark a deliberate native control with data-blueprint-native="<reason>".'
    );
  });
});
