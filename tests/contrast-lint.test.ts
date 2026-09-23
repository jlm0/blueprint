import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lintColorContrast } from '../src/core/contrast-lint';
import { collectDesignFindings } from '../src/core/findings';
import { loadProjectFromFs } from '../src/core/load';
import type { BlueprintProjectBundle } from '../src/core/types';
import { createReadinessReport, validateProject } from '../src/core/validate';

const starterRoot = 'starter/design/blueprint';

describe('color contrast lint', () => {
  it('accepts the neutral starter roles', async () => {
    assert.deepEqual(lintColorContrast(await loadProjectFromFs(starterRoot)), []);
  });

  it('reports text and focus role pairs below the WCAG minimum through strict, readiness, and canvas findings', async () => {
    const bundle = await loadProjectFromFs(starterRoot);
    setColor(bundle, 'muted', '#d4d4d8');
    setColor(bundle, 'focus-ring', 'rgb(228, 228, 231)');

    assert.deepEqual(
      lintColorContrast(bundle).map(issue => [issue.foreground.styleRef, issue.background.styleRef, issue.ratio, issue.minimum]),
      [
        ['--app-color-muted', '--app-color-surface', 1.47, 4.5],
        ['--app-color-focus-ring', '--app-color-background', 1.21, 3]
      ]
    );
    const strict = validateProject(bundle, { mode: 'strict' });
    assert.match(
      strict.errors.join('\n'),
      /token-group\.color --app-color-muted \(#d4d4d8\) on --app-color-surface \(#ffffff\) has contrast 1\.47:1; text needs at least 4\.5:1\./
    );
    assert.equal(validateProject(bundle).ok, true);
    assert.ok(createReadinessReport(bundle).blockers.some(item => item.path === 'tokenGroup.color.contrast.--app-color-muted.--app-color-surface'));
    const finding = collectDesignFindings(bundle).find(candidate => candidate.rule === 'contrast');
    assert.deepEqual(finding && [finding.boundaryId, finding.kind, finding.location], ['starter-app/token-group/color', 'token-group', 'tokens.json']);
  });

  it('skips translucent and computed colors and accepts short hex and rgb notation', async () => {
    const bundle = await loadProjectFromFs(starterRoot);
    setColor(bundle, 'on-primary', 'color-mix(in srgb, currentColor 50%, transparent)');
    setColor(bundle, 'on-secondary', 'rgba(24, 24, 27, 0.2)');
    setColor(bundle, 'on-destructive', '#fff0');
    assert.deepEqual(lintColorContrast(bundle), []);
    setColor(bundle, 'on-destructive', '#e33');
    setColor(bundle, 'foreground', 'rgb(250 250 250)');
    assert.deepEqual(
      lintColorContrast(bundle).map(issue => issue.foreground.styleRef),
      ['--app-color-foreground', '--app-color-foreground', '--app-color-on-destructive']
    );
  });
});

function setColor(bundle: BlueprintProjectBundle, id: string, value: string): void {
  const token = bundle.tokens.tokenGroups.find(group => group.id === 'color')?.tokens.find(candidate => candidate.id === id);
  assert.ok(token, `missing color.${id}`);
  token.value = value;
}
