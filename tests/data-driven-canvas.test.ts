import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { boundaryId } from '../src/core/address';
import { loadProjectFromFs } from '../src/core/load';
import { validateVisibleBoundaryRecords, type VisibleBoundaryRecord } from '../src/core/review';
import type { BlueprintProjectBundle, PrimitiveDefinition, ScreenDefinition } from '../src/core/types';

const starterRoot = 'starter/design/blueprint';
const novaRoot = 'fixtures/app-owned/nova-care/design/blueprint';
const atlasRoot = 'fixtures/app-owned/atlas-pay/design/blueprint';
const blankSlateRoot = 'fixtures/app-owned/blank-slate/design/blueprint';

let server: ViteDevServer;
let browser: Browser;
let baseUrl: string;

describe('Blueprint data-driven primitives canvas', () => {
  before(async () => {
    server = await createServer({
      logLevel: 'error',
      server: {
        host: '127.0.0.1',
        port: 0
      }
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address !== 'object') {
      throw new Error('Vite test server did not expose a port.');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    await server?.close();
  });

  it('renders primitive and state-set records from the loaded bundle with a generic unknown-family fallback', async () => {
    const bundle = withUnknownPrimitive(await loadProjectFromFs(novaRoot));
    const page = await openPrimitiveBoard(bundle);

    try {
      const records = await collectPrimitiveRecords(page);
      const sync = validateVisibleBoundaryRecords(bundle, records);
      assert.equal(sync.ok, true, sync.errors.join('\n'));

      assertTokenGroupsVisible(bundle, records);
      for (const primitive of bundle.primitives.primitives) {
        assert.ok(
          records.some(record => record.id === boundaryId(bundle.manifest.project.id, 'primitive', primitive.id)),
          `missing visible primitive boundary for ${primitive.id}`
        );
        for (const stateSet of primitive.stateSets) {
          const localId = `${primitive.id}/${stateSet.id}`;
          assert.ok(
            records.some(record => record.id === boundaryId(bundle.manifest.project.id, 'state-set', localId)),
            `missing visible state-set boundary for ${localId}`
          );
          for (const state of stateSet.states) {
            assert.equal(
              await page
                .locator(`${boundarySelector(boundaryId(bundle.manifest.project.id, 'state-set', localId))} [data-primitive-state-id="${escapeAttribute(state.id)}"]`)
                .count(),
              1,
              `missing visible state sample for ${localId}/${state.id}`
            );
          }
        }
      }

      for (const primitiveId of ['timeline-band', 'feedback-banner', 'arrow-toggle', 'cardholder-field']) {
        const fallback = page.locator(boundarySelector(`nova-care/primitive/${primitiveId}`));
        assert.equal(await fallback.count(), 1, `${primitiveId} should still render one generic card`);
        assert.equal(await fallback.getAttribute('data-primitive-family'), 'generic', `${primitiveId} should not match family names by substring`);
        assert.ok((await fallback.locator('[data-primitive-sample="generic"]').count()) >= 1);
        assert.equal(await fallback.locator('.token-probe, .generated-card-head, .primitive-meta-row').count(), 0);
      }
      assert.equal(await page.locator(boundarySelector('nova-care/primitive/action-button')).getAttribute('data-primitive-family'), 'button');
    } finally {
      await page.close();
    }
  });

  it('renders distinct primitive canvases for starter, Nova Care, and Atlas Pay without source edits', async () => {
    const fixtures = [
      { name: 'starter', bundle: await loadProjectFromFs(starterRoot) },
      { name: 'nova-care', bundle: await loadProjectFromFs(novaRoot) },
      { name: 'atlas-pay', bundle: await loadProjectFromFs(atlasRoot) }
    ];

    for (const fixture of fixtures) {
      const page = await openPrimitiveBoard(fixture.bundle);
      try {
        const records = await collectPrimitiveRecords(page);
        assertTokenGroupsVisible(fixture.bundle, records);
        const primitiveLocalIds = localIdsForKind(records, 'primitive');
        const expectedPrimitiveIds = fixture.bundle.primitives.primitives.map(primitive => primitive.id).sort();
        assert.deepEqual(primitiveLocalIds, expectedPrimitiveIds, `${fixture.name} primitive records should match its structured file`);

        const staleStarterIds = ['button', 'input', 'card'].filter(
          id => !expectedPrimitiveIds.includes(id) && primitiveLocalIds.includes(id)
        );
        assert.deepEqual(staleStarterIds, [], `${fixture.name} should not inherit stale starter-only primitive boundaries`);

        const chipLabels = await page.locator('.board-primitives .spec-chip').evaluateAll(elements =>
          elements.map(element => element.textContent?.trim()).filter(Boolean)
        );
        for (const primitive of fixture.bundle.primitives.primitives) {
          assert.ok(
            chipLabels.some(label => label?.includes(primitive.name)),
            `${fixture.name} should visibly label ${primitive.name}`
          );
        }
        await assertFamilyCoverage(page, fixture.bundle);
      } finally {
        await page.close();
      }
    }
  });

  it('renders known primitive families as human-facing visual specimens rather than token probe cards', async () => {
    const bundle = await loadProjectFromFs(starterRoot);
    const page = await openPrimitiveBoard(bundle);

    try {
      const canonicalExpectations = [
        'button',
        'input',
        'checkbox',
        'switch',
        'otp-input',
        'slider',
        'surface',
        'card',
        'nav-bar',
        'back-button',
        'separator',
        'list',
        'pressable-row',
        'row-layout',
        'loading-mark',
        'badge',
        'icon',
        'skeleton',
        'alert-dialog',
        'context-menu',
        'bottom-sheet',
        'text',
        'radio',
        'select',
        'tabs',
        'toast',
        'textarea',
        'avatar',
        'progress',
        'tooltip',
        'inline-alert',
        'segmented-control',
        'table-row'
      ];

      for (const primitiveId of canonicalExpectations) {
        const primitive = bundle.primitives.primitives.find(candidate => candidate.id === primitiveId);
        assert.ok(primitive?.prototype, `${primitiveId} should declare a canonical starter prototype source`);
        const card = page.locator(boundarySelector(boundaryId(bundle.manifest.project.id, 'primitive', primitiveId)));
        assert.equal(await card.count(), 1, `${primitiveId} primitive card should render once`);
        assert.equal(
          await card.locator('.generated-card-head, .primitive-meta-row, .token-probe').count(),
          0,
          `${primitiveId} should not show metadata headers or token probe chips in the human canvas`
        );
        assert.equal(
          await card.locator('[data-prototype-render-mode="canonical-app-owned"]').count(),
          1,
          `${primitiveId} should render its canonical app-owned specimen`
        );
        assert.equal(
          await card.locator('.canonical-primitive-iframe').count(),
          primitive.prototype.states.length * (Math.max(primitive.prototype.variants.length, 1) + (primitive.prototype.sizes?.length ?? 0)),
          `${primitiveId} should render one canonical iframe per declared variant or size × state combination`
        );
        const specimen = page
          .frameLocator(`${boundarySelector(boundaryId(bundle.manifest.project.id, 'primitive', primitiveId))} .canonical-primitive-iframe`)
          .first();
        assert.equal(
          await specimen.locator(`[data-blueprint-primitive="${primitiveId}"]`).count(),
          1,
          `${primitiveId} canonical specimen should render its governed primitive root`
        );
        const text = await card.innerText();
        assert.doesNotMatch(text, /\b(?:RADIUS|SHADOW|state set)\b/i, `${primitiveId} should not foreground token/debug labels`);
      }

      const backText = await page.locator(boundarySelector(boundaryId(bundle.manifest.project.id, 'primitive', 'back-button'))).innerText();
      assert.doesNotMatch(
        backText,
        /Navigation back command primitive/i,
        'Back button card should show back-button states, not the primitive schema description'
      );
    } finally {
      await page.close();
    }
  });

  it('keeps shipped primitive boards free of generic metadata/probe renderers', async () => {
    const fixtures = [
      await loadProjectFromFs(starterRoot),
      await loadProjectFromFs(novaRoot),
      await loadProjectFromFs(atlasRoot)
    ];

    for (const bundle of fixtures) {
      const page = await openPrimitiveBoard(bundle);
      try {
        assert.equal(
          await page.locator('.board-primitives [data-boundary-kind="primitive"] .token-probe').count(),
          0,
          `${bundle.manifest.project.id} should not show visible token probe chips on primitive cards`
        );
        assert.equal(
          await page.locator('.board-primitives [data-boundary-kind="primitive"] .generated-card-head, .board-primitives [data-boundary-kind="primitive"] .primitive-meta-row').count(),
          0,
          `${bundle.manifest.project.id} should not show primitive metadata headers as human canvas content`
        );
        assert.equal(
          await page.locator('.board-primitives [data-boundary-kind="primitive"][data-primitive-family="generic"]').count(),
          0,
          `${bundle.manifest.project.id} should not send shipped primitives through the generic fallback`
        );
      } finally {
        await page.close();
      }
    }
  });

  it('preserves human-facing primitive semantics for matrices, slots, surfaces, cards, and compact controls', async () => {
    const bundle = await loadProjectFromFs(starterRoot);
    const page = await openPrimitiveBoard(bundle);
    const projectId = bundle.manifest.project.id;

    try {
      const buttonSpecimen = page
        .frameLocator(`${boundarySelector(boundaryId(projectId, 'primitive', 'button'))} .canonical-primitive-iframe`)
        .nth(0);
      const buttonStyles = await buttonSpecimen.locator('[data-blueprint-primitive="button"]').evaluate(element => {
        const style = window.getComputedStyle(element);
        return {
          fontSize: style.fontSize,
          borderRadius: style.borderTopLeftRadius,
          minHeight: style.minHeight,
          background: style.backgroundColor
        };
      });
      assert.equal(buttonStyles.fontSize, '14px', 'canonical button should use the default typography.body size');
      assert.equal(buttonStyles.borderRadius, '6px', 'canonical button should use the default shape.radius-md radius');
      assert.equal(buttonStyles.minHeight, '40px', 'canonical button should keep its control height');
      assert.equal(buttonStyles.background, 'rgb(24, 24, 27)', 'canonical button should use the default color.primary background');

      const inputSpecimen = page
        .frameLocator(`${boundarySelector(boundaryId(projectId, 'primitive', 'input'))} .canonical-primitive-iframe`)
        .nth(2);
      const focusedInputStyles = await inputSpecimen.locator('.input__control').evaluate(element => {
        const style = window.getComputedStyle(element);
        return { borderColor: style.borderTopColor, boxShadow: style.boxShadow };
      });
      assert.equal(focusedInputStyles.borderColor, 'rgb(37, 99, 235)', 'focused input should use the default color.focus-ring');
      assert.notEqual(focusedInputStyles.boxShadow, 'none', 'focused input should render a visible focus halo');

      const backButtonFrames = page.frameLocator(
        `${boundarySelector(boundaryId(projectId, 'primitive', 'back-button'))} .canonical-primitive-iframe`
      );
      const backButtons: Array<{ text: string; width: number; height: number; borderRadius: string; overflowX: number; overflowY: number }> = [];
      for (let index = 0; index < 3; index += 1) {
        backButtons.push(
          await backButtonFrames.nth(index).locator('[data-blueprint-primitive="back-button"]').evaluate(element => {
            const node = element as HTMLElement;
            return {
              text: node.textContent?.trim() ?? '',
              width: node.clientWidth,
              height: node.clientHeight,
              borderRadius: window.getComputedStyle(node).borderTopLeftRadius,
              overflowX: node.scrollWidth - node.clientWidth,
              overflowY: node.scrollHeight - node.clientHeight
            };
          })
        );
      }
      assert.equal(backButtons.length, 3, 'back button should show medium, small, and disabled icon controls');
      assert.ok(backButtons.every(button => button.text.length === 0), 'back buttons should be icon-only visual controls');
      assert.ok(backButtons.every(button => Math.abs(button.width - button.height) <= 1), 'back buttons should stay square');
      assert.ok(backButtons.every(button => button.overflowX <= 1 && button.overflowY <= 1), 'back buttons should not overflow');
      assert.ok(backButtons[0] && backButtons[1] && backButtons[1].width < backButtons[0].width, 'small back button should be visibly smaller than medium');
      assert.equal(backButtons[0]?.borderRadius, '8px', 'medium back button should use the default shape.radius-lg radius');
      assert.equal(backButtons[1]?.borderRadius, '6px', 'small back button should use the default shape.radius-md radius');

      const navBarFrames = page.frameLocator(
        `${boundarySelector(boundaryId(projectId, 'primitive', 'nav-bar'))} .canonical-primitive-iframe`
      );
      const navigationSlots: Array<{ slots: string[]; visibleActions: number }> = [];
      for (let index = 0; index < 3; index += 1) {
        navigationSlots.push(
          await navBarFrames.nth(index).locator('[data-blueprint-primitive="nav-bar"]').evaluate(element => ({
            slots: [...element.children].map(child => (child as HTMLElement).className),
            visibleActions: [...element.querySelectorAll<HTMLElement>('.nav-bar__action')].filter(
              action => window.getComputedStyle(action).visibility !== 'hidden'
            ).length
          }))
        );
      }
      assert.equal(navigationSlots.length, 3, 'navigation should render every declared slot composition');
      assert.ok(
        navigationSlots.every(
          nav =>
            nav.slots.length === 3 &&
            nav.slots[0] === 'nav-bar__side' &&
            nav.slots[1] === 'nav-bar__center' &&
            nav.slots[2] === 'nav-bar__side nav-bar__side--right'
        ),
        `navigation bars should keep left, center, and right slots: ${JSON.stringify(navigationSlots)}`
      );
      assert.deepEqual(
        navigationSlots.map(nav => nav.visibleActions),
        [2, 1, 1],
        'navigation slot compositions should toggle the back and right actions'
      );

      const surfaceFrames = page.frameLocator(
        `${boundarySelector(boundaryId(projectId, 'primitive', 'surface'))} .canonical-primitive-iframe`
      );
      const ladder = ['rgb(255, 255, 255)', 'rgb(247, 247, 248)', 'rgb(240, 240, 242)', 'rgb(233, 233, 236)', 'rgb(226, 226, 230)', 'rgb(219, 219, 224)'];
      for (let level = 1; level <= 5; level += 1) {
        const evidence = await surfaceFrames.nth(level - 1).locator('[data-blueprint-primitive="surface"]').evaluate(element => {
          const tile = element.querySelector<HTMLElement>('.surface__nested');
          const card = document.createElement('article');
          card.setAttribute('data-blueprint-surface', '');
          tile?.append(card);
          return {
            label: `Surface ${window.getComputedStyle(element.querySelector('.surface__level') as Element, '::after').content.replace(/"/g, '')}`,
            surface: window.getComputedStyle(element).backgroundColor,
            tile: tile ? window.getComputedStyle(tile).backgroundColor : '',
            nestedCard: window.getComputedStyle(card).backgroundColor
          };
        });
        assert.equal(evidence.label, `Surface ${level}`, 'each surface specimen should name its own level');
        assert.deepEqual(
          [evidence.surface, evidence.tile, evidence.nestedCard],
          [ladder[level - 1], ladder[level], ladder[Math.min(level + 1, 5)]],
          `surface ${level} and its nested surfaces should each step one level deeper`
        );
      }

      const cardSpecimen = page
        .frameLocator(`${boundarySelector(boundaryId(projectId, 'primitive', 'card'))} .canonical-primitive-iframe`)
        .first();
      const cardStyles = await cardSpecimen.locator('[data-blueprint-primitive="card"]').evaluate(element => {
        const style = window.getComputedStyle(element);
        return { background: style.backgroundColor, borderRadius: style.borderTopLeftRadius };
      });
      assert.equal(cardStyles.background, 'rgb(255, 255, 255)', 'a top-level card should sit on surface level 1');
      assert.equal(cardStyles.borderRadius, '8px', 'canonical card should use the default shape.radius-lg radius');

      const badgeSpecimen = page
        .frameLocator(`${boundarySelector(boundaryId(projectId, 'primitive', 'badge'))} .canonical-primitive-iframe`)
        .first();
      const badgeEvidence = await badgeSpecimen.locator('[data-blueprint-primitive="badge"]').evaluate(element => {
        const node = element as HTMLElement;
        return {
          label: node.textContent?.trim() ?? '',
          overflowX: node.scrollWidth - node.clientWidth,
          overflowY: node.scrollHeight - node.clientHeight,
          borderRadius: window.getComputedStyle(node).borderTopLeftRadius
        };
      });
      assert.ok(badgeEvidence.label.length > 0, 'canonical badge should render a text-backed label');
      assert.notEqual(badgeEvidence.borderRadius, '0px', 'canonical badge should keep its default shape.radius-sm radius');
      assert.ok(badgeEvidence.overflowX <= 1 && badgeEvidence.overflowY <= 1, 'canonical badge should remain a non-overflowing pill label');

      const checkboxOnSpecimen = page
        .frameLocator(`${boundarySelector(boundaryId(projectId, 'primitive', 'checkbox'))} .canonical-primitive-iframe`)
        .nth(1);
      const checkboxOnStyles = await checkboxOnSpecimen.locator('.checkbox__box').evaluate(element => {
        const style = window.getComputedStyle(element);
        return { background: style.backgroundColor, borderColor: style.borderTopColor };
      });
      assert.equal(checkboxOnStyles.background, 'rgb(24, 24, 27)', 'checked checkbox should use the default color.primary fill');
      assert.equal(checkboxOnStyles.borderColor, 'rgb(24, 24, 27)', 'checked checkbox should keep its color.primary frame');

      const switchOnSpecimen = page
        .frameLocator(`${boundarySelector(boundaryId(projectId, 'primitive', 'switch'))} .canonical-primitive-iframe`)
        .nth(1);
      const switchOnStyles = await switchOnSpecimen.locator('.switch__track').evaluate(element => {
        const style = window.getComputedStyle(element);
        return { background: style.backgroundColor };
      });
      assert.equal(switchOnStyles.background, 'rgb(24, 24, 27)', 'on switch should use the default color.primary track');

      const sliderFrames = page.frameLocator(
        `${boundarySelector(boundaryId(projectId, 'primitive', 'slider'))} .canonical-primitive-iframe`
      );
      const sliderFills: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        sliderFills.push(await sliderFrames.nth(index).locator('.slider__fill').evaluate(element => window.getComputedStyle(element).backgroundColor));
      }
      assert.equal(sliderFills[0], 'rgb(24, 24, 27)', 'primary slider should use the default color.primary fill');
      assert.equal(sliderFills[1], 'rgb(113, 113, 122)', 'secondary slider should use the default color.muted fill');
      assert.equal(sliderFills[2], 'rgb(24, 24, 27)', 'contrast slider should use the default color.foreground fill');
      assert.equal(
        await sliderFrames.nth(3).locator('[data-blueprint-primitive="slider"]').evaluate(element => window.getComputedStyle(element).opacity),
        '0.5',
        'disabled slider should dim the whole control'
      );

      const destructiveDialog = page
        .frameLocator(`${boundarySelector(boundaryId(projectId, 'primitive', 'alert-dialog'))} .canonical-primitive-iframe`)
        .nth(1);
      const confirmStyles = await destructiveDialog.locator('.alert-dialog__action--confirm').evaluate(element => {
        const style = window.getComputedStyle(element);
        return { background: style.backgroundColor, color: style.color };
      });
      assert.equal(confirmStyles.background, 'rgb(220, 38, 38)', 'destructive dialog confirm should use the default color.destructive action');
      assert.equal(confirmStyles.color, 'rgb(255, 255, 255)', 'destructive dialog confirm should use color.on-destructive text');
    } finally {
      await page.close();
    }
  });

  it('uses app-owned foreground tokens when card surfaces resolve to light app colors', async () => {
    const bundle = await loadProjectFromFs(novaRoot);
    const page = await openPrimitiveBoard(bundle);

    try {
      const infoCardText = await page
        .locator(`${boundarySelector(boundaryId(bundle.manifest.project.id, 'primitive', 'info-card'))} .card[data-primitive-state-id="compact"] strong`)
        .evaluate(element => {
          const style = window.getComputedStyle(element);
          return {
            color: style.color,
            background: window.getComputedStyle(element.closest('.card') as Element).backgroundColor
          };
        });
      assert.equal(infoCardText.background, 'rgb(251, 252, 248)', 'Nova info card should use its app-owned light surface token');
      assert.equal(infoCardText.color, 'rgb(25, 33, 29)', 'Nova info card text should use the app-owned ink token on light surfaces');
    } finally {
      await page.close();
    }
  });

  it('maps token mutations into primitive samples through named token roles and template hooks', async () => {
    const cases = [
      {
        root: novaRoot,
        boundary: 'nova-care/primitive/action-button',
        tokenRef: 'color.accent',
        groupId: 'color',
        tokenId: 'accent',
        mutatedValue: '#ff00aa',
        cssProperty: 'background-color',
        baseExpected: 'rgb(62, 124, 97)',
        mutatedExpected: 'rgb(255, 0, 170)',
        visibleSelector: '.btn[data-primitive-state-id="primary"]',
        visibleCssProperty: 'background-color'
      },
      {
        root: novaRoot,
        boundary: 'nova-care/primitive/action-button',
        tokenRef: 'space.cluster',
        groupId: 'space',
        tokenId: 'cluster',
        mutatedValue: '32px',
        cssProperty: 'padding-left',
        baseExpected: '12px',
        mutatedExpected: '32px'
      },
      {
        root: novaRoot,
        boundary: 'nova-care/primitive/action-button',
        tokenRef: 'shape.radius-control',
        groupId: 'shape',
        tokenId: 'radius-control',
        mutatedValue: '21px',
        cssProperty: 'border-top-left-radius',
        baseExpected: '8px',
        mutatedExpected: '21px'
      },
      {
        root: starterRoot,
        boundary: 'starter-app/primitive/button',
        tokenRef: 'typography.body',
        groupId: 'typography',
        tokenId: 'body',
        mutatedValue: '700 22px/1.1 system-ui',
        cssProperty: 'font-size',
        baseExpected: '14px',
        mutatedExpected: '22px',
        iframeSelector: '[data-blueprint-primitive="button"]'
      },
      {
        root: novaRoot,
        boundary: 'nova-care/primitive/info-card',
        tokenRef: 'shape.shadow-panel',
        groupId: 'shape',
        tokenId: 'shadow-panel',
        mutatedValue: '0 4px 12px rgba(255, 0, 170, 0.35)',
        cssProperty: 'box-shadow',
        baseExpected: 'rgba(25, 33, 29, 0.1) 0px 12px 28px 0px',
        mutatedExpected: 'rgba(255, 0, 170, 0.35) 0px 4px 12px 0px'
      },
      {
        root: starterRoot,
        boundary: 'starter-app/primitive/button',
        tokenRef: 'motion.state',
        groupId: 'motion',
        tokenId: 'state',
        mutatedValue: '240ms linear',
        cssProperty: 'transition-duration',
        baseExpected: '0.16s, 0.16s, 0.16s, 0.16s',
        mutatedExpected: '0.24s, 0.24s, 0.24s, 0.24s',
        iframeSelector: '[data-blueprint-primitive="button"]'
      }
    ];

    for (const item of cases) {
      const baseBundle = await loadProjectFromFs(item.root);
      const mutatedBundle = mutateToken(baseBundle, item.groupId, item.tokenId, item.mutatedValue);
      const basePage = await openPrimitiveBoard(baseBundle);
      const mutatedPage = await openPrimitiveBoard(mutatedBundle);

      try {
        if ('iframeSelector' in item && item.iframeSelector) {
          const readCanonicalStyle = async (page: Page): Promise<string> => {
            const specimen = page
              .frameLocator(`${boundarySelector(item.boundary)} .canonical-primitive-iframe`)
              .nth(0);
            const value = await specimen
              .locator(item.iframeSelector as string)
              .evaluate((element, property) => window.getComputedStyle(element).getPropertyValue(property as string), item.cssProperty);
            assert.ok(value.trim().length > 0, `canonical ${item.iframeSelector} should expose computed ${item.cssProperty}`);
            return value;
          };
          const baseStyle = await readCanonicalStyle(basePage);
          const mutatedStyle = await readCanonicalStyle(mutatedPage);
          assert.equal(baseStyle, item.baseExpected, `${item.tokenRef} should drive canonical ${item.cssProperty} before mutation`);
          assert.equal(mutatedStyle, item.mutatedExpected, `${item.tokenRef} should drive canonical ${item.cssProperty} after mutation`);
          assert.notEqual(mutatedStyle, baseStyle, `${item.tokenRef} should change ${item.cssProperty} through the canonical specimen`);
          continue;
        }

        const baseStyle = await readTokenHookStyle(basePage, item.boundary, item.tokenRef, item.cssProperty);
        const mutatedStyle = await readTokenHookStyle(mutatedPage, item.boundary, item.tokenRef, item.cssProperty);
        assert.equal(baseStyle.value, item.baseExpected, `${item.tokenRef} base style should match fixture token value`);
        assert.equal(mutatedStyle.value, item.mutatedExpected, `${item.tokenRef} mutated style should match edited token value`);
        assert.equal(mutatedStyle.tokenRole, item.tokenRef);
        assert.ok(mutatedStyle.templateHook.length > 0, `${item.tokenRef} should name the template hook it drives`);
        assert.notEqual(
          mutatedStyle.value,
          baseStyle.value,
          `${item.tokenRef} should change ${item.cssProperty} through ${mutatedStyle.templateHook}`
        );
        if ('visibleSelector' in item && item.visibleSelector && 'visibleCssProperty' in item && item.visibleCssProperty) {
          const baseVisibleStyle = await readVisibleStyle(basePage, item.boundary, item.visibleSelector, item.visibleCssProperty);
          const mutatedVisibleStyle = await readVisibleStyle(mutatedPage, item.boundary, item.visibleSelector, item.visibleCssProperty);
          assert.equal(baseVisibleStyle, item.baseExpected, `${item.tokenRef} should drive visible ${item.visibleCssProperty} before mutation`);
          assert.equal(mutatedVisibleStyle, item.mutatedExpected, `${item.tokenRef} should drive visible ${item.visibleCssProperty} after mutation`);
        }
      } finally {
        await basePage.close();
        await mutatedPage.close();
      }
    }
  });

  it('keeps generated primitive cards collision-free for all proof fixtures', async () => {
    for (const root of [starterRoot, novaRoot, atlasRoot]) {
      const bundle = await loadProjectFromFs(root);
      const page = await openPrimitiveBoard(bundle);

      try {
        const records = await collectPrimitiveRecords(page);
        const primitiveLocalIds = localIdsForKind(records, 'primitive');
        const expectedPrimitiveIds = bundle.primitives.primitives.map(primitive => primitive.id).sort();
        assert.deepEqual(primitiveLocalIds, expectedPrimitiveIds, `${bundle.manifest.project.id} must render every primitive before layout can be trusted`);

        const collisions = await page.locator('.board-primitives').evaluate(rootElement => {
          const elements = [...rootElement.querySelectorAll<HTMLElement>('.group-head, .spec')];
          const boxes = elements.map(element => {
            const left = parseFloat(element.style.left || '0');
            const top = parseFloat(element.style.top || '0');
            const chip = element.querySelector<HTMLElement>('.spec-chip');
            const chipTop = chip ? top + chip.offsetTop : top;
            const chipLeft = chip ? left + chip.offsetLeft : left;
            return {
              label: element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) || element.className,
              left: Math.min(left, chipLeft),
              right: Math.max(left + element.offsetWidth, chipLeft + (chip?.offsetWidth ?? 0)),
              top: Math.min(top, chipTop),
              bottom: Math.max(top + element.offsetHeight, chipTop + (chip?.offsetHeight ?? 0))
            };
          });

          const overlaps: string[] = [];
          for (let a = 0; a < boxes.length; a += 1) {
            for (let b = a + 1; b < boxes.length; b += 1) {
              const one = boxes[a];
              const two = boxes[b];
              if (one.left < two.right && one.right > two.left && one.top < two.bottom && one.bottom > two.top) {
                overlaps.push(`${one.label} overlaps ${two.label}`);
              }
            }
          }
          return overlaps;
        });

        assert.deepEqual(collisions, [], `${bundle.manifest.project.id} primitive cards should not overlap`);
      } finally {
        await page.close();
      }
    }
  });

  it('fits every canonical primitive specimen inside its review cell and root', async () => {
    for (const root of [starterRoot, blankSlateRoot]) {
      const bundle = await loadProjectFromFs(root);
      const page = await openPrimitiveBoard(bundle);

      try {
        await page.waitForFunction(() =>
          [...document.querySelectorAll<HTMLIFrameElement>('iframe.canonical-primitive-iframe')].every(frame => frame.style.height !== '')
        );
        const problems: string[] = [];
        for (const handle of await page.locator('iframe.canonical-primitive-iframe').elementHandles()) {
          const title = await handle.getAttribute('title');
          const frame = await handle.contentFrame();
          assert.ok(frame, `${title} should expose its document`);
          await frame.waitForLoadState();
          const issues = await frame.evaluate(() => {
            const found: string[] = [];
            const doc = document.documentElement;
            if (doc.scrollWidth > innerWidth + 1 || doc.scrollHeight > innerHeight + 1) {
              found.push(`document ${doc.scrollWidth}x${doc.scrollHeight} exceeds cell ${innerWidth}x${innerHeight}`);
            }
            const primitive = document.querySelector('[data-blueprint-primitive]');
            if (!primitive) {
              return found;
            }
            const bounds = primitive.getBoundingClientRect();
            for (const element of primitive.querySelectorAll('*')) {
              let clipped = false;
              for (let ancestor = element.parentElement; ancestor && ancestor !== primitive.parentElement; ancestor = ancestor.parentElement) {
                if (getComputedStyle(ancestor).overflowX !== 'visible') {
                  clipped = true;
                }
              }
              const rect = element.getBoundingClientRect();
              if (!clipped && rect.width > 0 && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1)) {
                found.push(`${element.tagName.toLowerCase()}.${element.className} spills ${Math.round(Math.max(bounds.left - rect.left, rect.right - bounds.right))}px past the root`);
              }
            }
            return found;
          });
          problems.push(...issues.map(issue => `${title}: ${issue}`));
        }
        assert.deepEqual(problems, [], `${bundle.manifest.project.id} primitive specimens should not overflow`);
      } finally {
        await page.close();
      }
    }
  });

  it('groups platform-tagged primitives into shared, mobile, and web zones', async () => {
    const bundle = await loadProjectFromFs(starterRoot);
    const page = await openPrimitiveBoard(bundle);

    try {
      const zones = await page.locator('.board-primitives').evaluate(rootElement => {
        const headings = [...rootElement.querySelectorAll<HTMLElement>('.group-head[data-primitive-platform]')].map(heading => ({
          zone: heading.dataset.primitivePlatform ?? '',
          title: heading.querySelector('h1')?.textContent ?? '',
          subtitle: heading.querySelector('.sub')?.textContent ?? '',
          left: parseFloat(heading.style.left)
        }));
        const cards = [...rootElement.querySelectorAll<HTMLElement>('.spec[data-primitive-platform]')].map(card => ({
          zone: card.dataset.primitivePlatform ?? '',
          left: parseFloat(card.style.left),
          right: parseFloat(card.style.left) + card.offsetWidth
        }));
        return { headings, cards };
      });

      const tagged = (platform: 'mobile' | 'desktop') =>
        bundle.primitives.primitives.filter(primitive => primitive.platforms?.length === 1 && primitive.platforms[0] === platform).length;
      const shared = bundle.primitives.primitives.length - tagged('mobile') - tagged('desktop');
      assert.deepEqual(
        zones.headings.map(heading => [heading.zone, heading.title, heading.subtitle]),
        [
          ['shared', 'Shared', `${shared} primitives`],
          ['mobile', 'Mobile', `${tagged('mobile')} primitives`],
          ['desktop', 'Web', `${tagged('desktop')} primitives`]
        ]
      );
      for (const [index, heading] of zones.headings.entries()) {
        const next = zones.headings[index + 1];
        const cards = zones.cards.filter(card => card.zone === heading.zone);
        assert.ok(cards.length > 0, `${heading.zone} zone should render cards`);
        assert.ok(cards.every(card => card.left >= heading.left), `${heading.zone} cards should start at their heading`);
        if (next) {
          assert.ok(cards.every(card => card.right < next.left), `${heading.zone} cards should end before the ${next.zone} zone`);
        }
      }
    } finally {
      await page.close();
    }
  });

  it('renders every screen frame and section boundary from structured screen composition', async () => {
    const bundle = withAdditionalScreen(await loadProjectFromFs(novaRoot));
    const page = await openScreensBoard(bundle);

    try {
      const records = await collectScreenRecords(page);
      const sync = validateVisibleBoundaryRecords(bundle, records);
      assert.equal(sync.ok, true, sync.errors.join('\n'));

      const expectedScreenBoundaries = bundle.screens.screens
        .map(screen => boundaryId(bundle.manifest.project.id, 'screen', screen.id))
        .sort();
      const visibleScreenBoundaries = records.filter(record => record.kind === 'screen').map(record => record.id).sort();
      assert.deepEqual(visibleScreenBoundaries, expectedScreenBoundaries, 'Screens board should render every screen in the loaded bundle');

      const expectedSectionBoundaries = bundle.screens.screens
        .flatMap(screen => screen.sections.map(section => boundaryId(bundle.manifest.project.id, 'section', `${screen.id}/${section.id}`)))
        .sort();
      const visibleSectionBoundaries = records.filter(record => record.kind === 'section').map(record => record.id).sort();
      assert.deepEqual(visibleSectionBoundaries, expectedSectionBoundaries, 'Screens board should render every section boundary inside its owning frame');

      const missingScreenContext = records.filter(record => record.kind === 'section' && !record.screenId);
      assert.deepEqual(missingScreenContext, [], 'Section review records should include screenId context');

      const collisions = await frameCollisions(page);
      assert.deepEqual(collisions, [], `Screen frames should not overlap:\n${collisions.join('\n')}`);

      const manifest = await page.evaluate(() => window.__BLUEPRINT_REVIEW__?.manifest);
      assert.ok(manifest, 'Screens board should expose a review manifest');
      assert.equal(manifest.screenId, undefined, 'All-screens board review manifest should not claim one top-level screenId');
      const manifestSections = manifest.boundaries.filter(boundary => boundary.kind === 'section');
      assert.equal(manifestSections.length, expectedSectionBoundaries.length);
      assert.ok(
        manifestSections.every(boundary => boundary.screenId
          && boundary.packet.status === 'available'
          && boundary.packet.tool?.name === 'extract'
          && boundary.packet.tool.arguments.boundary.startsWith('section:')),
        'Section manifest entries should include screenId and extraction packet commands'
      );

      const styleEvidence = await page.evaluate(() => window.__BLUEPRINT_REVIEW__?.styleEvidence);
      assert.ok(styleEvidence, 'Screens board should expose style evidence');
      const styleSectionIds = styleEvidence.boundaries.filter(boundary => boundary.kind === 'section').map(boundary => boundary.boundaryId).sort();
      assert.deepEqual(styleSectionIds, expectedSectionBoundaries);
    } finally {
      await page.close();
    }
  });

  it('renders desktop web frames and mobile frames from frame presets on the same canvas', async () => {
    const bundle = withDesktopScreen(await loadProjectFromFs(novaRoot));
    const page = await openScreensBoard(bundle);

    try {
      const mobileFrame = page.locator(boundarySelector('nova-care/screen/home'));
      const desktopFrame = page.locator(boundarySelector('nova-care/screen/web-dashboard'));
      await mobileFrame.waitFor({ state: 'visible', timeout: 5000 });
      await desktopFrame.waitFor({ state: 'visible', timeout: 5000 });

      assert.equal(await mobileFrame.getAttribute('data-frame-type'), 'mobile');
      assert.equal(await mobileFrame.getAttribute('data-frame-preset-id'), 'phone-ios');
      assert.equal(await desktopFrame.getAttribute('data-frame-type'), 'desktop');
      assert.equal(await desktopFrame.getAttribute('data-frame-preset-id'), 'desktop-web');

      const mobileSize = await mobileFrame.locator('.screen').evaluate(element => {
        const computed = window.getComputedStyle(element);
        return {
          width: parseFloat(computed.width),
          height: parseFloat(computed.height)
        };
      });
      const desktopSize = await desktopFrame.locator('.screen').evaluate(element => {
        const computed = window.getComputedStyle(element);
        return {
          width: parseFloat(computed.width),
          height: parseFloat(computed.height)
        };
      });
      assert.deepEqual(mobileSize, { width: 393, height: 852 });
      assert.deepEqual(desktopSize, { width: 1440, height: 900 });

      assert.equal(await mobileFrame.locator('.status-bar').count(), 1, 'mobile frame should keep phone status chrome');
      assert.equal(await mobileFrame.locator('.home-indicator').count(), 1, 'mobile frame should keep phone home indicator');
      assert.equal(await mobileFrame.locator('.browser-bar').count(), 0, 'mobile frame should not render browser chrome');
      assert.equal(await desktopFrame.locator('.status-bar').count(), 0, 'desktop frame should not render phone status chrome');
      assert.equal(await desktopFrame.locator('.home-indicator').count(), 0, 'desktop frame should not render phone home indicator');
      assert.equal(await desktopFrame.locator('.browser-bar').count(), 1, 'desktop frame should render browser chrome');
      assert.equal((await desktopFrame.locator('.browser-address').textContent())?.trim(), '/web-dashboard');

      const collisions = await frameCollisions(page);
      assert.deepEqual(collisions, [], `Mixed mobile and desktop screen frames should not overlap:\n${collisions.join('\n')}`);
    } finally {
      await page.close();
    }
  });

  it('splits the screens board into flow subpages that deep links bypass', async () => {
    const bundle = await loadProjectFromFs(blankSlateRoot);
    // Synthetic flow declarations: the page rail groups whatever flows screens declare.
    const flowByScreen: Record<string, string> = { home: 'marketing', pricing: 'marketing', platform: 'product' };
    for (const screen of bundle.screens.screens) {
      screen.flow = flowByScreen[screen.id];
    }
    const page = await openScreensBoard(bundle);

    try {
      const switcher = page.locator('.bp-chrome-flow-switcher');
      assert.equal(await switcher.isVisible(), true, 'Flow subpage switcher should render on the screens board');
      assert.deepEqual(
        (await switcher.locator('button').allTextContents()).map(text => text.trim()),
        ['marketing', 'product'],
        'Flow pills should be the declared flows in first-seen order'
      );
      assert.equal(
        await switcher.locator('button[data-flow="marketing"]').getAttribute('aria-pressed'),
        'true',
        'First declared flow should be the default canvas'
      );
      assert.equal(await page.locator('.board-screens .frame[data-boundary-kind="screen"]').count(), 2);

      await switcher.locator('button[data-flow="product"]').click();
      await page.waitForFunction(
        () => document.querySelectorAll('.board-screens .frame[data-boundary-kind="screen"]').length === 1,
        undefined,
        { timeout: 5000 }
      );
      const productFrames = await page.locator('.board-screens .frame[data-boundary-kind="screen"]').evaluateAll(elements =>
        elements.map(element => (element as HTMLElement).dataset.boundaryId)
      );
      assert.deepEqual(
        productFrames,
        ['blank-slate-proof/screen/platform'],
        'Product subpage should mount only the product-flow frames'
      );
      assert.equal(await switcher.locator('button[data-flow="product"]').getAttribute('aria-pressed'), 'true');
      assert.match(page.url(), /flow=product/);

      await switcher.locator('button[data-flow="marketing"]').click();
      await page.waitForFunction(
        () => document.querySelectorAll('.board-screens .frame[data-boundary-kind="screen"]').length === 2,
        undefined,
        { timeout: 5000 }
      );
      assert.equal(await page.locator('.board-screens .frame[data-boundary-kind="screen"]').count(), 2);

      // Deep links (state/viewport, used by capture) resolve every screen regardless of the active subpage.
      await page.goto(`${baseUrl}?board=screens&flow=product&state=initial&viewport=desktop-web-tall`);
      await page.waitForSelector('.board-screens [data-boundary-id="blank-slate-proof/screen/home"]', { timeout: 5000 });
    } finally {
      await page.close();
    }
  });

  it('keeps the starter screens board at two empty base frames', async () => {
    const bundle = await loadProjectFromFs(starterRoot);
    const page = await openScreensBoard(bundle);

    try {
      assert.deepEqual(
        bundle.screens.screens.map(screen => ({ id: screen.id, preset: screen.framePresetId, sections: screen.sections.length })),
        [
          { id: 'home', preset: 'phone', sections: 0 },
          { id: 'web-home', preset: 'desktop-web', sections: 0 }
        ]
      );

      const frames = page.locator('.board-screens .frame');
      assert.equal(await frames.count(), 2);
      assert.equal(await frames.nth(0).getAttribute('data-frame-type'), 'mobile');
      assert.equal(await frames.nth(1).getAttribute('data-frame-type'), 'desktop');
      assert.equal(await frames.locator('[data-boundary-kind="section"]').count(), 0);
      assert.equal((await frames.nth(0).locator('.screen-template-body').innerText()).trim(), '');
      assert.equal((await frames.nth(1).locator('.screen-template-body').innerText()).trim(), '');
    } finally {
      await page.close();
    }
  });

  it('keeps all-screens review evidence tied to rendered section boundaries without a false top-level screen context', async () => {
    const bundle = await loadProjectFromFs(novaRoot);
    const page = await openScreensBoard(bundle);

    try {
      const expectedSectionBoundaries = bundle.screens.screens
        .flatMap(screen => screen.sections.map(section => boundaryId(bundle.manifest.project.id, 'section', `${screen.id}/${section.id}`)))
        .sort();
      const manifest = await page.evaluate(() => window.__BLUEPRINT_REVIEW__?.manifest);
      assert.ok(manifest, 'Screens board should expose a review manifest');
      assert.equal(manifest.screenId, undefined, 'All-screens board review manifest should not claim one top-level screenId');
      const manifestSections = manifest.boundaries.filter(boundary => boundary.kind === 'section');
      assert.deepEqual(manifestSections.map(boundary => boundary.boundaryId).sort(), expectedSectionBoundaries);
      assert.ok(
        manifestSections.every(boundary => boundary.screenId && boundary.screenshot.status === 'capture-ready' && boundary.packet.status === 'available'),
        'Section manifest entries should carry screen context, screenshot status, and packet commands'
      );

      const styleEvidence = await page.evaluate(() => window.__BLUEPRINT_REVIEW__?.styleEvidence);
      assert.ok(styleEvidence, 'Screens board should expose style evidence');
      const styleSections = styleEvidence.boundaries.filter(boundary => boundary.kind === 'section');
      assert.deepEqual(styleSections.map(boundary => boundary.boundaryId).sort(), expectedSectionBoundaries);
      assert.ok(styleSections.every(boundary => boundary.status === 'captured'), 'Section style evidence should be DOM-captured');
    } finally {
      await page.close();
    }
  });

  it('does not restore the rejected metadata-card section projection pattern', async () => {
    const bundle = await loadProjectFromFs(novaRoot);
    const page = await openScreensBoard(bundle);

    try {
      const rejectedProjectionCount = await page.locator('.board-screens .screen-section-projection').count();
      assert.equal(rejectedProjectionCount, 0, 'Screens board must not reintroduce rejected metadata-card section projections');
    } finally {
      await page.close();
    }
  });

  it('renders screen composition as prototype content rather than primary metadata labels', async () => {
    const novaBundle = await loadProjectFromFs(novaRoot);
    const novaPage = await openScreensBoard(novaBundle);

    try {
      const novaText = await novaPage.locator('.board-screens .screen-template-body').first().innerText();
      assert.match(novaText, /Today summary headline and care-plan details/);
      assert.match(novaText, /Next care task call-to-action/);
      assert.doesNotMatch(
        novaText,
        /\b(?:Info Card|Action Button|Status Pill|compact|primary|ready)\b/i,
        'Phone body should not foreground primitive implementation names or variant chips as primary prototype content'
      );

    } finally {
      await novaPage.close();
    }
  });

  it('composes screen frames from the same visual primitive vocabulary used on the primitives canvas', async () => {
    const novaBundle = await loadProjectFromFs(novaRoot);
    const novaPage = await openScreensBoard(novaBundle);
    const starterBundle = await loadProjectFromFs(starterRoot);
    const interactionPage = await openScreensBoard(withStarterInteractionProof(starterBundle));

    try {
      assert.ok(
        (await novaPage.locator('.screen-dependency-button .btn').count()) >= 1,
        'Nova screen button dependencies should render as actual button specimens'
      );
      assert.ok(
        (await novaPage.locator('.screen-dependency-card .card').count()) >= 1,
        'Nova screen card dependencies should render as actual card specimens'
      );
      assert.ok(
        (await novaPage.locator('.screen-dependency-badge .badge').count()) >= 1,
        'Nova screen badge dependencies should render as actual badge specimens'
      );
      assert.equal(
        await novaPage.locator('.screen-dependency-button .screen-prototype-button-label').count(),
        0,
        'Screens should not fall back to generic button label spans when a visual button renderer exists'
      );
      assert.ok(
        (await interactionPage.locator('.screen-dependency-switch .sw').count()) >= 1,
        'Switch screen dependencies should render as actual switch specimens'
      );
      assert.ok(
        (await interactionPage.locator('.screen-dependency-slider .slider').count()) >= 1,
        'Slider screen dependencies should render as actual slider specimens'
      );
    } finally {
      await novaPage.close();
      await interactionPage.close();
    }
  });

  it('changes visible screen output when section composition binding changes', async () => {
    const baseBundle = await loadProjectFromFs(novaRoot);
    const mutatedBundle = mutateSectionBindingCopy(baseBundle, 'home', 'next-action', 'primaryContent', 'Schedule the care check-in now');
    const basePage = await openScreensBoard(baseBundle);
    const mutatedPage = await openScreensBoard(mutatedBundle);

    try {
      const sectionBoundary = boundaryId(baseBundle.manifest.project.id, 'section', 'home/next-action');
      const baseText = await boundaryText(basePage, sectionBoundary);
      const mutatedText = await boundaryText(mutatedPage, sectionBoundary);

      assert.match(baseText, /Next care task call-to-action/);
      assert.match(mutatedText, /Schedule the care check-in now/);
      assert.notEqual(mutatedText, baseText, 'Changing binding copy should visibly change the rendered section output');
    } finally {
      await basePage.close();
      await mutatedPage.close();
    }
  });

  it('changes visible screen output when section dependency identity changes', async () => {
    const baseBundle = await loadProjectFromFs(novaRoot);
    const mutatedBundle = mutateSectionDependency(baseBundle, 'home', 'next-action', 0, 'info-card');
    const basePage = await openScreensBoard(baseBundle);
    const mutatedPage = await openScreensBoard(mutatedBundle);

    try {
      const sectionBoundary = boundaryId(baseBundle.manifest.project.id, 'section', 'home/next-action');
      const baseSignature = await boundaryPrototypeSignature(basePage, sectionBoundary);
      const mutatedSignature = await boundaryPrototypeSignature(mutatedPage, sectionBoundary);

      assert.deepEqual(baseSignature.families, ['button', 'button']);
      assert.deepEqual(mutatedSignature.families, ['card', 'button']);
      assert.match(baseSignature.text, /Next care task call-to-action/);
      assert.match(mutatedSignature.text, /Next care task call-to-action/);
      assert.notDeepEqual(mutatedSignature, baseSignature, 'Changing the section dependency identity should visibly change the rendered section output');
    } finally {
      await basePage.close();
      await mutatedPage.close();
    }
  });

  it('keeps smoke and extraction artifact defaults out of closed June workstream paths', async () => {
    const { readFile } = await import('node:fs/promises');
    const browserSmoke = await readFile('src/scripts/browser-smoke.ts', 'utf8');
    const extractionArtifacts = await readFile('src/scripts/create-extraction-artifacts.ts', 'utf8');

    assert.doesNotMatch(browserSmoke, /2026-06-23-04-blueprint-canvas-contract-review-loop\/artifacts/);
    assert.doesNotMatch(extractionArtifacts, /2026-06-23-01-blueprint-platform-foundation\/artifacts/);
    assert.doesNotMatch(browserSmoke, /\.agent-workstream\/2026-\d{2}-\d{2}/);
    assert.doesNotMatch(extractionArtifacts, /\.agent-workstream\/2026-\d{2}-\d{2}/);
    assert.match(browserSmoke, /BLUEPRINT_ARTIFACT_ROOT/);
    assert.match(extractionArtifacts, /BLUEPRINT_ARTIFACT_ROOT/);
  });
});

async function openPrimitiveBoard(bundle: BlueprintProjectBundle): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(projectBundle => {
    Object.defineProperty(window, '__BLUEPRINT_PROJECT_BUNDLE__', {
      configurable: true,
      value: projectBundle
    });
  }, bundle);
  await page.goto(`${baseUrl}?board=primitives`);
  await page.waitForSelector('[data-board-root="primitives"]:not([hidden])', { timeout: 5000 });
  await page.waitForSelector('.board-primitives [data-boundary-id][data-boundary-kind]', { timeout: 5000 });
  return page;
}

async function openScreensBoard(bundle: BlueprintProjectBundle): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(projectBundle => {
    Object.defineProperty(window, '__BLUEPRINT_PROJECT_BUNDLE__', {
      configurable: true,
      value: projectBundle
    });
  }, bundle);
  await page.goto(`${baseUrl}?board=screens`);
  await page.waitForSelector('[data-board-root="screens"]:not([hidden])', { timeout: 5000 });
  await page.waitForSelector('.board-screens .frame[data-boundary-kind="screen"]', { timeout: 5000 });
  return page;
}

async function collectPrimitiveRecords(page: Page): Promise<VisibleBoundaryRecord[]> {
  return page.locator('.board-primitives [data-boundary-id][data-boundary-kind]').evaluateAll(elements =>
    elements.map(element => {
      const node = element as HTMLElement;
      return {
        id: node.dataset.boundaryId ?? '',
        kind: node.dataset.boundaryKind ?? 'project',
        board: 'primitives',
        label: node.dataset.boundaryLabel ?? node.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) ?? ''
      };
    })
  ) as Promise<VisibleBoundaryRecord[]>;
}

function localIdsForKind(records: VisibleBoundaryRecord[], kind: string): string[] {
  return records.filter(record => record.kind === kind).map(record => record.id.split('/').slice(2).join('/')).sort();
}

async function collectScreenRecords(page: Page): Promise<VisibleBoundaryRecord[]> {
  return page.locator('.board-screens [data-boundary-id][data-boundary-kind]').evaluateAll(elements =>
    elements.map(element => {
      const node = element as HTMLElement;
      return {
        id: node.dataset.boundaryId ?? '',
        kind: node.dataset.boundaryKind ?? 'project',
        board: 'screens',
        label: node.dataset.boundaryLabel ?? node.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) ?? '',
        screenId: node.dataset.screenId,
        renderedSnippet: node.outerHTML.slice(0, 900)
      };
    })
  ) as Promise<VisibleBoundaryRecord[]>;
}

function assertTokenGroupsVisible(bundle: BlueprintProjectBundle, records: VisibleBoundaryRecord[]): void {
  for (const group of bundle.tokens.tokenGroups) {
    assert.ok(
      records.some(record => record.id === boundaryId(bundle.manifest.project.id, 'token-group', group.id)),
      `missing visible token-group boundary for ${bundle.manifest.project.id}/${group.id}`
    );
  }
}

async function assertFamilyCoverage(page: Page, bundle: BlueprintProjectBundle): Promise<void> {
  const canonicalIds = new Set(
    bundle.primitives.primitives.filter(primitive => primitive.prototype).map(primitive => primitive.id)
  );
  const families = await page.locator('.board-primitives [data-boundary-kind="primitive"]').evaluateAll(elements =>
    elements.map(element => ({
      id: (element as HTMLElement).dataset.boundaryId ?? '',
      family: (element as HTMLElement).dataset.primitiveFamily ?? '',
      renderer: (element as HTMLElement).querySelector<HTMLElement>('.primitive-visual')?.dataset.primitiveRenderer ?? '',
      renderMode: (element as HTMLElement).querySelector<HTMLElement>('[data-prototype-render-mode]')?.dataset.prototypeRenderMode ?? ''
    }))
  );
  const missingFamily = families.filter(item => item.family.length === 0);
  assert.deepEqual(missingFamily, [], `${bundle.manifest.project.id} primitive cards should name their renderer family`);
  const missingRenderer = families.filter(item => {
    const localId = item.id.split('/').pop() ?? '';
    if (canonicalIds.has(localId)) {
      return item.renderMode !== 'canonical-app-owned';
    }
    return item.family !== 'generic' && item.renderer !== item.family;
  });
  assert.deepEqual(missingRenderer, [], `${bundle.manifest.project.id} known primitive cards should use their canonical source or visual family renderer`);

  const distinctFamilies = new Set(families.map(item => item.family));
  const minimumFamilies = Math.min(2, bundle.primitives.primitives.length);
  assert.ok(
    distinctFamilies.size >= minimumFamilies,
    `${bundle.manifest.project.id} should use bounded family templates instead of one generic renderer for every primitive`
  );
  assert.ok(
    [...distinctFamilies].some(family => family !== 'generic'),
    `${bundle.manifest.project.id} should render known primitives with non-generic families`
  );
}

async function readTokenHookStyle(
  page: Page,
  primitiveBoundaryId: string,
  tokenRole: string,
  cssProperty: string
): Promise<{ tokenRole: string; templateHook: string; value: string }> {
  const hooks = await page
    .locator(`${boundarySelector(primitiveBoundaryId)} [data-token-role="${escapeAttribute(tokenRole)}"][data-template-hook]`)
    .evaluateAll((elements, property) =>
      elements.map(element => {
        const node = element as HTMLElement;
        const computed = window.getComputedStyle(node);
        return {
          tokenRole: node.dataset.tokenRole ?? '',
          templateHook: node.dataset.templateHook ?? '',
          value: computed.getPropertyValue(property as string)
        };
      }), cssProperty
    );

  assert.ok(hooks.length > 0, `missing rendered token hook for ${tokenRole} on ${primitiveBoundaryId}`);
  const hook = hooks.find(item => item.value.trim().length > 0);
  assert.ok(hook, `token hook for ${tokenRole} should expose computed ${cssProperty}`);
  return hook;
}

async function readVisibleStyle(page: Page, primitiveBoundaryId: string, selector: string, cssProperty: string): Promise<string> {
  const value = await page
    .locator(`${boundarySelector(primitiveBoundaryId)} ${selector}`)
    .evaluate((element, property) => window.getComputedStyle(element).getPropertyValue(property as string), cssProperty);
  assert.ok(value.trim().length > 0, `visible ${selector} should expose computed ${cssProperty}`);
  return value;
}

function mutateToken(bundle: BlueprintProjectBundle, groupId: string, tokenId: string, value: string): BlueprintProjectBundle {
  const cloned = cloneBundle(bundle);
  const token = cloned.tokens.tokenGroups.find(group => group.id === groupId)?.tokens.find(candidate => candidate.id === tokenId);
  if (!token) {
    throw new Error(`Missing token ${groupId}.${tokenId}`);
  }
  token.value = value;
  return cloned;
}

function mutateSectionBindingCopy(bundle: BlueprintProjectBundle, screenId: string, sectionId: string, slot: string, copy: string): BlueprintProjectBundle {
  const cloned = cloneBundle(bundle);
  const section = cloned.screens.screens.find(screen => screen.id === screenId)?.sections.find(candidate => candidate.id === sectionId);
  const dependency = section?.uses.find(item => item.binding?.slot === slot) ?? section?.uses[0];
  if (!dependency) {
    throw new Error(`Missing dependency for ${screenId}/${sectionId}`);
  }
  dependency.binding = {
    ...dependency.binding,
    slot,
    copy
  };
  return cloned;
}

function mutateSectionDependency(bundle: BlueprintProjectBundle, screenId: string, sectionId: string, index: number, primitiveId: string): BlueprintProjectBundle {
  const cloned = cloneBundle(bundle);
  const section = cloned.screens.screens.find(screen => screen.id === screenId)?.sections.find(candidate => candidate.id === sectionId);
  const dependency = section?.uses[index];
  if (!dependency) {
    throw new Error(`Missing dependency ${index} for ${screenId}/${sectionId}`);
  }
  dependency.kind = 'primitive';
  dependency.id = primitiveId;
  return cloned;
}

function withAdditionalScreen(bundle: BlueprintProjectBundle): BlueprintProjectBundle {
  const cloned = cloneBundle(bundle);
  const first = cloned.screens.screens[0];
  if (!first) {
    throw new Error('Expected at least one screen fixture.');
  }
  const second = JSON.parse(JSON.stringify(first)) as ScreenDefinition;
  second.id = 'settings';
  second.name = 'Settings';
  second.description = 'Second proof screen for placement and section rendering.';
  cloned.screens.screens = [first, second];
  return cloned;
}

function withStarterInteractionProof(bundle: BlueprintProjectBundle): BlueprintProjectBundle {
  const cloned = cloneBundle(bundle);
  const first = cloned.screens.screens[0];
  if (!first) {
    throw new Error('Expected at least one starter screen.');
  }
  first.sections = [
    {
      id: 'interaction-proof',
      name: 'Interaction Proof',
      description: 'Test-only composition for generic interactive primitive rendering.',
      styleRefs: [],
      uses: [
        { kind: 'primitive', id: 'switch', reason: 'Switch renderer coverage', binding: { copy: 'Enabled', layout: 'row' } },
        { kind: 'primitive', id: 'slider', reason: 'Slider renderer coverage', binding: { copy: 'Level', layout: 'row' } }
      ],
      prototypeOnly: true,
      notes: [],
      implementationHints: []
    }
  ];
  return cloned;
}

function withDesktopScreen(bundle: BlueprintProjectBundle): BlueprintProjectBundle {
  const cloned = cloneBundle(bundle);
  const first = cloned.screens.screens[0];
  if (!first) {
    throw new Error('Expected at least one screen fixture.');
  }
  cloned.manifest.framePresets = [
    ...cloned.manifest.framePresets,
    {
      id: 'desktop-web',
      name: 'Desktop Web',
      type: 'desktop',
      width: 1440,
      height: 900,
      safeArea: {
        top: 48,
        right: 0,
        bottom: 0,
        left: 0
      }
    }
  ];
  const desktop = JSON.parse(JSON.stringify(first)) as ScreenDefinition;
  desktop.id = 'web-dashboard';
  desktop.name = 'Web Dashboard';
  desktop.description = 'Desktop web proof screen for browser-frame rendering.';
  desktop.framePresetId = 'desktop-web';
  desktop.productionRelationship = {
    kind: 'new-route',
    routePath: '/web-dashboard'
  };
  cloned.screens.screens = [first, desktop];
  return cloned;
}

async function frameCollisions(page: Page): Promise<string[]> {
  return page.locator('.board-screens .frame-slot').evaluateAll(elements => {
    const boxes = elements.map(element => {
      const node = element as HTMLElement;
      const frame = node.querySelector<HTMLElement>('.frame');
      const left = parseFloat(node.style.left || '0');
      const top = parseFloat(node.style.top || '0');
      return {
        label: frame?.dataset.boundaryId ?? node.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) ?? 'screen',
        left,
        right: left + node.offsetWidth,
        top,
        bottom: top + node.offsetHeight
      };
    });
    const collisions: string[] = [];
    for (let a = 0; a < boxes.length; a += 1) {
      for (let b = a + 1; b < boxes.length; b += 1) {
        const one = boxes[a];
        const two = boxes[b];
        if (one.left < two.right && one.right > two.left && one.top < two.bottom && one.bottom > two.top) {
          collisions.push(`${one.label} overlaps ${two.label}`);
        }
      }
    }
    return collisions;
  });
}

async function boundaryText(page: Page, id: string): Promise<string> {
  const locator = page.locator(boundarySelector(id));
  await locator.waitFor({ state: 'visible', timeout: 5000 });
  return locator.innerText();
}

async function boundaryPrototypeSignature(page: Page, id: string): Promise<{ text: string; families: string[]; classes: string[] }> {
  const locator = page.locator(boundarySelector(id));
  await locator.waitFor({ state: 'visible', timeout: 5000 });
  const dependencies = await locator.locator('.screen-dependency').evaluateAll(elements =>
    elements.map(element => {
      const node = element as HTMLElement;
      return {
        family: node.dataset.prototypeFamily ?? '',
        className: node.className
      };
    })
  );
  return {
    text: await locator.innerText(),
    families: dependencies.map(dependency => dependency.family),
    classes: dependencies.map(dependency => dependency.className)
  };
}

function withUnknownPrimitive(bundle: BlueprintProjectBundle): BlueprintProjectBundle {
  const cloned = cloneBundle(bundle);
  const primitives: PrimitiveDefinition[] = [
    {
      id: 'timeline-band',
      name: 'Timeline Band',
      description: 'Unknown-family primitive used to prove the generic renderer fallback.',
      tokenGroupIds: ['color', 'space'],
      styleRefs: ['primitive.timeline-band'],
      notes: [],
      prototypeOnly: false,
      implementationHints: ['Render as a generic primitive sample when no family template exists.'],
      stateSets: [
        {
          id: 'density',
          name: 'Density States',
          description: 'Compact and expanded timeline density.',
          styleRefs: ['primitive.timeline-band.density'],
          states: [
            {
              id: 'compact',
              name: 'Compact',
              tokens: ['color.ink', 'space.cluster'],
              prototypeOnly: false,
              notes: [],
              implementationHints: []
            },
            {
              id: 'expanded',
              name: 'Expanded',
              tokens: ['color.accent', 'space.section'],
              prototypeOnly: false,
              notes: [],
              implementationHints: []
            }
          ]
        }
      ]
    },
    createUnknownPrimitive('feedback-banner', 'Feedback Banner'),
    createUnknownPrimitive('arrow-toggle', 'Arrow Toggle'),
    createUnknownPrimitive('cardholder-field', 'Cardholder Field')
  ];
  cloned.primitives.primitives = [...cloned.primitives.primitives, ...primitives];
  return cloned;
}

function createUnknownPrimitive(id: string, name: string): PrimitiveDefinition {
  return {
    id,
    name,
    description: 'Ambiguous unknown-family primitive used to prevent substring family matches.',
    tokenGroupIds: ['color', 'space'],
    styleRefs: [`primitive.${id}`],
    notes: [],
    prototypeOnly: false,
    implementationHints: ['Render through the generic fallback unless a neutral family term is explicit.'],
    stateSets: []
  };
}

function cloneBundle(bundle: BlueprintProjectBundle): BlueprintProjectBundle {
  return JSON.parse(JSON.stringify(bundle)) as BlueprintProjectBundle;
}

function boundarySelector(id: string): string {
  return `[data-boundary-id="${escapeAttribute(id)}"]`;
}

function escapeAttribute(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
