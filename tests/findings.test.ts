import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectDesignFindings, designFindingReference } from '../src/core/findings';
import { loadProjectFromFs } from '../src/core/load';

const miraRoot = 'fixtures/valid/mira-ai/design/blueprint';
const umbraRoot = 'fixtures/valid/umbra-gaming/design/blueprint';
const meridianRoot = 'fixtures/valid/meridian-finance/design/blueprint';
const brokenRoot = 'fixtures/invalid/broken/design/blueprint';

describe('design findings', () => {
  it('attributes every lint finding to the boundary whose source must change', async () => {
    const broken = collectDesignFindings(await loadProjectFromFs(brokenRoot));
    assert.deepEqual(broken.map(finding => [finding.rule, finding.boundaryId]).sort(), [
      ['contrast', 'broken-sidecar/token-group/color'],
      ['local-value', 'broken-sidecar/screen/literal-color'],
      ['native-control', 'broken-sidecar/screen/hand-built-control'],
      ['section-marker', 'broken-sidecar/screen/unmarked-section']
    ]);
    assert.deepEqual(broken.filter(finding => finding.rule === 'native-control').map(finding => finding.location), [
      'prototype/screens/hand-built-control.html:4'
    ]);
    const umbra = await loadProjectFromFs(umbraRoot);
    umbra.prototypeSourceContents['prototype/components/mode-tile.css'] += '\n[data-blueprint-component="mode-tile"] { color: #ff3d7f; }\n';
    assert.ok(collectDesignFindings(umbra).some(finding => finding.boundaryId === 'umbra-gaming/component/mode-tile' && finding.kind === 'component'));
    for (const root of [miraRoot, umbraRoot, meridianRoot]) {
      assert.deepEqual(collectDesignFindings(await loadProjectFromFs(root)), [], root);
    }
  });

  it('reports unmarked sections against their screen', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    const source = 'prototype/screens/workspace.html';
    bundle.prototypeSourceContents[source] = bundle.prototypeSourceContents[source].replace(' data-blueprint-section="welcome"', '');
    const marker = collectDesignFindings(bundle).find(finding => finding.rule === 'section-marker');
    assert.deepEqual(marker && { boundaryId: marker.boundaryId, location: marker.location }, {
      boundaryId: 'mira-ai/screen/workspace',
      location: source
    });
    assert.match(marker?.message ?? '', /section "welcome" has no data-blueprint-section="welcome" marker/);
  });

  it('formats a finding as a pasteable instruction for the agent', async () => {
    const [control] = collectDesignFindings(await loadProjectFromFs(brokenRoot)).filter(finding => finding.rule === 'native-control');
    assert.equal(
      designFindingReference(control),
      'screen:hand-built-control prototype/screens/hand-built-control.html:4 hand-builds a native <button>; use <blueprint-use kind="primitive" ref="button"> or mark a deliberate native control with data-blueprint-native="<reason>".'
    );
  });
});
