import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type FrameLocator, type Locator, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { boundaryId } from '../src/core/address';
import { loadProjectFromFs } from '../src/core/load';
import { validateVisibleBoundaryRecords, type VisibleBoundaryRecord } from '../src/core/review';
import type { BlueprintProjectBundle } from '../src/core/types';

const starterRoot = 'starter/design/blueprint';
const miraRoot = 'fixtures/valid/mira-ai/design/blueprint';
const umbraRoot = 'fixtures/valid/umbra-gaming/design/blueprint';
const meridianRoot = 'fixtures/valid/meridian-finance/design/blueprint';

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

  it('renders distinct primitive canvases for starter, Umbra, and Meridian without source edits', async () => {
    const fixtures = [
      { name: 'starter', bundle: await loadProjectFromFs(starterRoot) },
      { name: 'umbra-gaming', bundle: await loadProjectFromFs(umbraRoot) },
      { name: 'meridian-finance', bundle: await loadProjectFromFs(meridianRoot) }
    ];
    const allPrimitiveIds = new Set(fixtures.flatMap(fixture => fixture.bundle.primitives.primitives.map(primitive => primitive.id)));

    for (const fixture of fixtures) {
      const page = await openPrimitiveBoard(fixture.bundle);
      try {
        const records = await collectPrimitiveRecords(page);
        const sync = validateVisibleBoundaryRecords(fixture.bundle, records);
        assert.equal(sync.ok, true, sync.errors.join('\n'));
        assertTokenGroupsVisible(fixture.bundle, records);
        const primitiveLocalIds = localIdsForKind(records, 'primitive');
        const expectedPrimitiveIds = fixture.bundle.primitives.primitives.map(primitive => primitive.id).sort();
        assert.deepEqual(primitiveLocalIds, expectedPrimitiveIds, `${fixture.name} primitive records should match its structured file`);

        const staleIds = [...allPrimitiveIds].filter(
          id => !expectedPrimitiveIds.includes(id) && primitiveLocalIds.includes(id)
        );
        assert.deepEqual(staleIds, [], `${fixture.name} should not inherit primitive boundaries from another project`);

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

  it('renders every shipped primitive card as a compiled canonical specimen', async () => {
    const fixtures = [
      await loadProjectFromFs(starterRoot),
      await loadProjectFromFs(miraRoot),
      await loadProjectFromFs(umbraRoot),
      await loadProjectFromFs(meridianRoot)
    ];

    for (const bundle of fixtures) {
      const page = await openPrimitiveBoard(bundle);
      try {
        const cards = await page.locator('.board-primitives [data-boundary-kind="primitive"]').evaluateAll(elements =>
          elements.map(element => ({
            id: (element as HTMLElement).dataset.boundaryLocalId ?? '',
            renderModes: [...element.querySelectorAll<HTMLElement>('[data-prototype-render-mode]')].map(node => node.dataset.prototypeRenderMode),
            specimens: element.querySelectorAll('.canonical-primitive-specimen').length,
            iframes: element.querySelectorAll('.canonical-primitive-iframe').length,
            compileErrors: element.querySelectorAll('.prototype-compile-error').length
          }))
        );
        assert.equal(cards.length, bundle.primitives.primitives.length);
        for (const primitive of bundle.primitives.primitives) {
          const card = cards.find(candidate => candidate.id === primitive.id);
          const label = `${bundle.manifest.project.id}/${primitive.id}`;
          assert.ok(card, `${label} should render a primitive card`);
          assert.deepEqual(card.renderModes, ['canonical-app-owned'], `${label} should render only its canonical app-owned specimen`);
          assert.equal(card.specimens, 1, `${label} should render one canonical specimen`);
          assert.equal(card.compileErrors, 0, `${label} canonical specimen should compile`);
          assert.equal(
            card.iframes,
            primitive.prototype.states.length * (Math.max(primitive.prototype.variants.length, 1) + (primitive.prototype.sizes?.length ?? 0)),
            `${label} should render one canonical iframe per declared variant or size × state combination`
          );
        }
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

  it('maps token mutations into canonical primitive specimens through their app token variables', async () => {
    const cases: Array<{
      primitiveId: string;
      frameTitle?: string;
      tokenRef: string;
      groupId: string;
      tokenId: string;
      mutatedValue: string;
      cssProperty: string;
      baseExpected: string;
      mutatedExpected: string;
    }> = [
      {
        primitiveId: 'button',
        tokenRef: 'color.primary',
        groupId: 'color',
        tokenId: 'primary',
        mutatedValue: '#ff00aa',
        cssProperty: 'background-color',
        baseExpected: 'rgb(24, 24, 27)',
        mutatedExpected: 'rgb(255, 0, 170)'
      },
      {
        primitiveId: 'button',
        tokenRef: 'space.control-x',
        groupId: 'space',
        tokenId: 'control-x',
        mutatedValue: '32px',
        cssProperty: 'padding-left',
        baseExpected: '16px',
        mutatedExpected: '32px'
      },
      {
        primitiveId: 'button',
        tokenRef: 'shape.radius-md',
        groupId: 'shape',
        tokenId: 'radius-md',
        mutatedValue: '21px',
        cssProperty: 'border-top-left-radius',
        baseExpected: '6px',
        mutatedExpected: '21px'
      },
      {
        primitiveId: 'button',
        tokenRef: 'typography.body',
        groupId: 'typography',
        tokenId: 'body',
        mutatedValue: '700 22px/1.1 system-ui',
        cssProperty: 'font-size',
        baseExpected: '14px',
        mutatedExpected: '22px'
      },
      {
        primitiveId: 'card',
        frameTitle: 'Card · elevated · default',
        tokenRef: 'shape.shadow-md',
        groupId: 'shape',
        tokenId: 'shadow-md',
        mutatedValue: '0 4px 12px rgba(255, 0, 170, 0.35)',
        cssProperty: 'box-shadow',
        baseExpected: 'rgba(9, 9, 11, 0.08) 0px 4px 12px 0px, rgba(9, 9, 11, 0.06) 0px 1px 3px 0px',
        mutatedExpected: 'rgba(255, 0, 170, 0.35) 0px 4px 12px 0px'
      },
      {
        primitiveId: 'button',
        tokenRef: 'motion.state',
        groupId: 'motion',
        tokenId: 'state',
        mutatedValue: '240ms linear',
        cssProperty: 'transition-duration',
        baseExpected: '0.16s, 0.16s, 0.16s, 0.16s',
        mutatedExpected: '0.24s, 0.24s, 0.24s, 0.24s'
      }
    ];

    const baseBundle = await loadProjectFromFs(starterRoot);
    const basePage = await openPrimitiveBoard(baseBundle);
    try {
      for (const item of cases) {
        const mutatedPage = await openPrimitiveBoard(mutateToken(baseBundle, item.groupId, item.tokenId, item.mutatedValue));
        try {
          const readCanonicalStyle = async (page: Page): Promise<string> => {
            const frameSelector = `${boundarySelector(boundaryId(baseBundle.manifest.project.id, 'primitive', item.primitiveId))} .canonical-primitive-iframe${
              item.frameTitle ? `[title="${escapeAttribute(item.frameTitle)}"]` : ''
            }`;
            const value = await page
              .frameLocator(frameSelector)
              .first()
              .locator(`[data-blueprint-primitive="${item.primitiveId}"]`)
              .evaluate((element, property) => window.getComputedStyle(element).getPropertyValue(property), item.cssProperty);
            assert.ok(value.trim().length > 0, `canonical ${item.primitiveId} should expose computed ${item.cssProperty}`);
            return value;
          };
          const baseStyle = await readCanonicalStyle(basePage);
          const mutatedStyle = await readCanonicalStyle(mutatedPage);
          assert.equal(baseStyle, item.baseExpected, `${item.tokenRef} should drive canonical ${item.cssProperty} before mutation`);
          assert.equal(mutatedStyle, item.mutatedExpected, `${item.tokenRef} should drive canonical ${item.cssProperty} after mutation`);
          assert.notEqual(mutatedStyle, baseStyle, `${item.tokenRef} should change ${item.cssProperty} through the canonical specimen`);
        } finally {
          await mutatedPage.close();
        }
      }
    } finally {
      await basePage.close();
    }
  });

  it('keeps generated primitive cards collision-free for all proof fixtures', async () => {
    for (const root of [starterRoot, umbraRoot, meridianRoot]) {
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
    for (const root of [starterRoot, umbraRoot, meridianRoot]) {
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
    const bundle = await loadProjectFromFs(miraRoot);
    const page = await openScreensBoard(bundle);
    const projectId = bundle.manifest.project.id;

    try {
      const records = await collectScreenRecords(page);
      const sync = validateVisibleBoundaryRecords(bundle, records);
      assert.equal(sync.ok, true, sync.errors.join('\n'));

      const expectedScreenBoundaries = bundle.screens.screens
        .flatMap(screen => screen.prototype.reviewConditions.map(() => boundaryId(projectId, 'screen', screen.id)))
        .sort();
      const screenRecords = records.filter(record => record.kind === 'screen');
      assert.deepEqual(screenRecords.map(record => record.id).sort(), expectedScreenBoundaries, 'Screens board should render every screen review condition in the loaded bundle');
      assert.ok(
        screenRecords.every(record => record.id === boundaryId(projectId, 'screen', record.screenId ?? '')),
        'Screen review records should carry their own screenId context'
      );

      for (const screen of bundle.screens.screens) {
        for (const condition of screen.prototype.reviewConditions) {
          const label = `${screen.id} ${condition.state}`;
          const frame = page.locator(screenFrameSelector(boundaryId(projectId, 'screen', screen.id), condition.state));
          assert.equal(
            await frame.locator('.canonical-prototype-screen[data-prototype-render-mode="canonical-app-owned"] .canonical-prototype-iframe').count(),
            1,
            `${label} should render one canonical sandboxed prototype`
          );
          assert.equal(await frame.locator('.prototype-compile-error').count(), 0, `${label} prototype should compile`);
          const prototype = await screenPrototype(page, boundaryId(projectId, 'screen', screen.id), condition.state);
          assert.equal(await prototype.locator(`[data-blueprint-screen="${escapeAttribute(screen.id)}"]`).count(), 1, `${label} prototype should render its own screen root`);
          const sectionBoundaries = await prototype.locator('[data-blueprint-section-boundary-id]').evaluateAll(elements =>
            elements.map(element => (element as HTMLElement).dataset.blueprintSectionBoundaryId ?? '')
          );
          assert.deepEqual(
            sectionBoundaries.sort(),
            screen.sections.map(section => boundaryId(projectId, 'section', `${screen.id}/${section.id}`)).sort(),
            `${label} prototype should mark every declared section boundary inside its owning frame`
          );
        }
      }

      const collisions = await frameCollisions(page);
      assert.deepEqual(collisions, [], `Screen frames should not overlap:\n${collisions.join('\n')}`);
    } finally {
      await page.close();
    }
  });

  it('renders desktop web frames and mobile frames from frame presets on the same canvas', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    const page = await openScreensBoard(bundle);

    try {
      const mobileFrame = page.locator(screenFrameSelector('mira-ai/screen/chat'));
      const desktopFrame = page.locator(screenFrameSelector('mira-ai/screen/workspace'));
      await mobileFrame.waitFor({ state: 'visible', timeout: 5000 });
      await desktopFrame.waitFor({ state: 'visible', timeout: 5000 });

      assert.equal(await mobileFrame.getAttribute('data-frame-type'), 'mobile');
      assert.equal(await mobileFrame.getAttribute('data-frame-preset-id'), 'phone');
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
      assert.equal((await desktopFrame.locator('.browser-address').textContent())?.trim(), '/threads/:threadId', 'desktop frame should show its production route in the address bar');

      const collisions = await frameCollisions(page);
      assert.deepEqual(collisions, [], `Mixed mobile and desktop screen frames should not overlap:\n${collisions.join('\n')}`);
    } finally {
      await page.close();
    }
  });

  it('splits the screens board into flow subpages that deep links bypass', async () => {
    const bundle = await loadProjectFromFs(meridianRoot);
    const page = await openScreensBoard(bundle);

    try {
      const switcher = page.locator('.bp-chrome-flow-switcher');
      assert.equal(await switcher.isVisible(), true, 'Flow subpage switcher should render on the screens board');
      assert.deepEqual(
        (await switcher.locator('button').allTextContents()).map(text => text.trim()),
        ['Overview', 'Ledger', 'Send payment', 'Phone'],
        'Flow pills should be the declared flows in first-seen order'
      );
      assert.equal(
        await switcher.locator('button[data-flow="Overview"]').getAttribute('aria-pressed'),
        'true',
        'First declared flow should be the default canvas'
      );
      assert.equal(await page.locator('.board-screens .frame[data-boundary-kind="screen"]').count(), 2);

      await switcher.locator('button[data-flow="Ledger"]').click();
      await page.waitForFunction(
        () => document.querySelectorAll('.board-screens .frame[data-boundary-kind="screen"]').length === 1,
        undefined,
        { timeout: 5000 }
      );
      const ledgerFrames = await page.locator('.board-screens .frame[data-boundary-kind="screen"]').evaluateAll(elements =>
        elements.map(element => (element as HTMLElement).dataset.boundaryId)
      );
      assert.deepEqual(
        ledgerFrames,
        ['meridian-finance/screen/transactions'],
        'Ledger subpage should mount only the ledger-flow frames'
      );
      assert.equal(await switcher.locator('button[data-flow="Ledger"]').getAttribute('aria-pressed'), 'true');
      assert.match(page.url(), /flow=Ledger/);

      await switcher.locator('button[data-flow="Overview"]').click();
      await page.waitForFunction(
        () => document.querySelectorAll('.board-screens .frame[data-boundary-kind="screen"]').length === 2,
        undefined,
        { timeout: 5000 }
      );
      assert.equal(await page.locator('.board-screens .frame[data-boundary-kind="screen"]').count(), 2);

      // Deep links (state/viewport, used by capture) resolve every screen regardless of the active subpage.
      await page.goto(`${baseUrl}?board=screens&flow=Ledger&state=review&viewport=phone`);
      await page.waitForSelector('.board-screens [data-boundary-id="meridian-finance/screen/transfer-mobile"]', { timeout: 5000 });
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
      assert.deepEqual(
        [await frames.nth(0).getAttribute('data-review-condition-id'), await frames.nth(1).getAttribute('data-review-condition-id')],
        ['phone-default', 'desktop-web-default']
      );
      assert.equal(await frames.locator('[data-boundary-kind="section"]').count(), 0);
      assert.equal(await frames.locator('.prototype-compile-error').count(), 0);
      for (const screenId of ['home', 'web-home']) {
        const prototype = await screenPrototype(page, boundaryId(bundle.manifest.project.id, 'screen', screenId));
        assert.equal(await prototype.locator('[data-blueprint-section-boundary-id]').count(), 0, `${screenId} should mark no sections`);
        assert.equal(
          (await prototype.locator(`[data-blueprint-screen="${screenId}"]`).evaluate(element => element.innerHTML)).trim(),
          '',
          `${screenId} should render an empty base prototype`
        );
      }
    } finally {
      await page.close();
    }
  });

  it('keeps all-screens review evidence tied to rendered screen frames without a false top-level screen context', async () => {
    const bundle = cloneBundle(await loadProjectFromFs(meridianRoot));
    for (const screen of bundle.screens.screens) {
      delete screen.flow;
    }
    const page = await openScreensBoard(bundle);

    try {
      const expectedScreenBoundaries = bundle.screens.screens
        .flatMap(screen => screen.prototype.reviewConditions.map(() => boundaryId(bundle.manifest.project.id, 'screen', screen.id)))
        .sort();
      const manifest = await page.evaluate(() => window.__BLUEPRINT_REVIEW__?.manifest);
      assert.ok(manifest, 'Screens board should expose a review manifest');
      assert.equal(manifest.screenId, undefined, 'All-screens board review manifest should not claim one top-level screenId');
      const manifestScreens = manifest.boundaries.filter(boundary => boundary.kind === 'screen');
      assert.deepEqual(manifestScreens.map(boundary => boundary.boundaryId).sort(), expectedScreenBoundaries);
      assert.ok(
        manifestScreens.every(boundary => boundary.screenId === boundary.localId
          && boundary.screenshot.status === 'capture-ready'
          && boundary.packet.status === 'available'
          && boundary.packet.tool?.name === 'extract'
          && boundary.packet.tool.arguments.boundary === `screen:${boundary.localId}`),
        'Screen manifest entries should carry screen context, screenshot status, and extraction packet commands'
      );

      const styleEvidence = await page.evaluate(() => window.__BLUEPRINT_REVIEW__?.styleEvidence);
      assert.ok(styleEvidence, 'Screens board should expose style evidence');
      const styleScreens = styleEvidence.boundaries.filter(boundary => boundary.kind === 'screen');
      assert.deepEqual(styleScreens.map(boundary => boundary.boundaryId).sort(), expectedScreenBoundaries);
      assert.ok(styleScreens.every(boundary => boundary.status === 'captured'), 'Screen style evidence should be DOM-captured');
    } finally {
      await page.close();
    }
  });

  it('renders screen composition as prototype content rather than primary metadata labels', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    const page = await openScreensBoard(bundle);

    try {
      assert.equal(
        await page.locator('.board-screens .frame .screen:not(.canonical-prototype-screen)').count(),
        0,
        'Every screen frame should render its canonical prototype rather than a projected section template'
      );
      const frame = page.locator(screenFrameSelector('mira-ai/screen/chat'));
      const prototypeText = await (await screenPrototype(page, 'mira-ai/screen/chat')).locator('body').innerText();
      assert.match(prototypeText, /Why did churn jump in Q3\?/);
      assert.match(prototypeText, /Three drivers explain 71% of the Q3 increase\./);
      assert.match(prototypeText, /Retention export/);
      const primaryMetadata = /\b(?:Conversation|Composer|Insight Chart|Badge|Button|outline|compact|normal)\b/;
      assert.doesNotMatch(
        prototypeText,
        primaryMetadata,
        'Phone body should not foreground section names, primitive implementation names, or variant chips as primary prototype content'
      );
      assert.doesNotMatch(
        await frame.innerText(),
        primaryMetadata,
        'Frame chrome should not overlay section or primitive metadata on the prototype'
      );
    } finally {
      await page.close();
    }
  });

  it('composes screen frames from the same visual primitive vocabulary used on the primitives canvas', async () => {
    const bundle = mutatePrototypeSource(await loadProjectFromFs(miraRoot), 'prototype/screens/workspace.html', ' class="artifact__open"', '');
    const screensPage = await openScreensBoard(bundle);
    const primitivesPage = await openPrimitiveBoard(bundle);
    const projectId = bundle.manifest.project.id;

    try {
      const prototype = await screenPrototype(screensPage, boundaryId(projectId, 'screen', 'workspace'));
      const featured = prototype.locator(`[data-blueprint-section-boundary-id="${boundaryId(projectId, 'section', 'workspace/sources')}"]`);
      for (const use of [
        { primitiveId: 'badge', variant: 'tonal', state: 'default' },
        { primitiveId: 'button', variant: 'primary', state: 'normal' }
      ]) {
        const primitive = bundle.primitives.primitives.find(candidate => candidate.id === use.primitiveId);
        assert.ok(primitive, `${use.primitiveId} should be declared`);
        const screenSignature = await primitiveSignature(featured.locator(`[data-blueprint-primitive="${use.primitiveId}"]`));
        const boardSignature = await primitiveSignature(
          primitivesPage
            .frameLocator(
              `${boundarySelector(boundaryId(projectId, 'primitive', use.primitiveId))} .canonical-primitive-iframe[title="${escapeAttribute(`${primitive.name} · ${use.variant} · ${use.state}`)}"]`
            )
            .locator(`[data-blueprint-primitive="${use.primitiveId}"]`)
        );
        assert.equal(screenSignature.boundaryId, boundaryId(projectId, 'primitive', use.primitiveId), `screen ${use.primitiveId} should be the governed primitive boundary`);
        assert.deepEqual(
          { variant: screenSignature.variant, state: screenSignature.state },
          { variant: use.variant, state: use.state },
          `screen ${use.primitiveId} should render the invoked variant and state`
        );
        assert.deepEqual(screenSignature, boardSignature, `screen ${use.primitiveId} should render the same compiled specimen shown on the primitives canvas`);
      }
    } finally {
      await screensPage.close();
      await primitivesPage.close();
    }
  });

  it('changes visible screen output when a section prototype source changes', async () => {
    const baseBundle = await loadProjectFromFs(miraRoot);
    const mutatedBundle = mutatePrototypeSource(baseBundle, 'prototype/screens/chat.html', 'Three drivers explain 71% of the Q3 increase.', 'Two drivers explain most of the Q3 increase.');
    const basePage = await openScreensBoard(baseBundle);
    const mutatedPage = await openScreensBoard(mutatedBundle);

    try {
      const screenBoundary = boundaryId(baseBundle.manifest.project.id, 'screen', 'chat');
      const sectionSelector = `[data-blueprint-section-boundary-id="${boundaryId(baseBundle.manifest.project.id, 'section', 'chat/conversation')}"]`;
      const baseText = await (await screenPrototype(basePage, screenBoundary)).locator(sectionSelector).innerText();
      const mutatedText = await (await screenPrototype(mutatedPage, screenBoundary)).locator(sectionSelector).innerText();

      assert.match(baseText, /Three drivers explain 71%/);
      assert.match(mutatedText, /Two drivers explain most/);
      assert.notEqual(mutatedText, baseText, 'Changing the prototype source should visibly change the rendered section output');
    } finally {
      await basePage.close();
      await mutatedPage.close();
    }
  });

  it('changes visible screen output when a section renders a different primitive', async () => {
    const baseBundle = await loadProjectFromFs(miraRoot);
    const mutatedBundle = mutatePrototypeSource(
      baseBundle,
      'prototype/screens/chat.html',
      '<blueprint-use kind="primitive" ref="badge" state="default" variant="outline"><span slot="label">+4</span></blueprint-use>',
      '<blueprint-use kind="primitive" ref="button" state="normal" variant="secondary"><span slot="label">+4</span></blueprint-use>'
    );
    const mutatedChat = mutatedBundle.screens.screens.find(screen => screen.id === 'chat');
    const mutatedSection = mutatedChat?.sections.find(section => section.id === 'conversation');
    assert.ok(mutatedChat && mutatedSection, 'Mira chat should declare the conversation section');
    mutatedChat.prototype.renderedUses = [...(mutatedChat.prototype.renderedUses ?? []), { kind: 'primitive', id: 'button' }];
    mutatedSection.uses = [...mutatedSection.uses, { ...mutatedSection.uses.find(use => use.id === 'badge')!, id: 'button' }];
    const basePage = await openScreensBoard(baseBundle);
    const mutatedPage = await openScreensBoard(mutatedBundle);

    try {
      const screenBoundary = boundaryId(baseBundle.manifest.project.id, 'screen', 'chat');
      const sectionSelector = `[data-blueprint-section-boundary-id="${boundaryId(baseBundle.manifest.project.id, 'section', 'chat/conversation')}"]`;
      const readRenderedPrimitives = async (page: Page) =>
        (await screenPrototype(page, screenBoundary)).locator(`${sectionSelector} [data-blueprint-primitive]`).evaluateAll(elements =>
          elements.map(element => `${(element as HTMLElement).dataset.blueprintPrimitive}:${(element as HTMLElement).dataset.blueprintVariant}`)
        );

      assert.deepEqual(await readRenderedPrimitives(basePage), ['segmented-control:default', 'badge:outline', 'badge:outline', 'badge:outline']);
      assert.deepEqual(await readRenderedPrimitives(mutatedPage), ['segmented-control:default', 'badge:outline', 'badge:outline', 'button:secondary']);
    } finally {
      await basePage.close();
      await mutatedPage.close();
    }
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
  const families = await page.locator('.board-primitives [data-boundary-kind="primitive"]').evaluateAll(elements =>
    elements.map(element => ({
      id: (element as HTMLElement).dataset.boundaryId ?? '',
      family: (element as HTMLElement).dataset.primitiveFamily ?? ''
    }))
  );
  const missingFamily = families.filter(item => item.family.length === 0);
  assert.deepEqual(missingFamily, [], `${bundle.manifest.project.id} primitive cards should name their layout family`);

  const distinctFamilies = new Set(families.map(item => item.family));
  const minimumFamilies = Math.min(2, bundle.primitives.primitives.length);
  assert.ok(
    distinctFamilies.size >= minimumFamilies,
    `${bundle.manifest.project.id} should group primitives into bounded families instead of one generic column`
  );
  assert.ok(
    [...distinctFamilies].some(family => family !== 'generic'),
    `${bundle.manifest.project.id} should group known primitives under non-generic families`
  );
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

function mutatePrototypeSource(bundle: BlueprintProjectBundle, sourcePath: string, search: string, replacement: string): BlueprintProjectBundle {
  const cloned = cloneBundle(bundle);
  const source = cloned.prototypeSourceContents[sourcePath];
  if (!source?.includes(search)) {
    throw new Error(`Missing "${search}" in ${sourcePath}`);
  }
  cloned.prototypeSourceContents[sourcePath] = source.replace(search, replacement);
  return cloned;
}

async function screenPrototype(page: Page, screenBoundaryId: string, state = 'default'): Promise<FrameLocator> {
  const prototype = page.frameLocator(`${screenFrameSelector(screenBoundaryId, state)} .canonical-prototype-iframe`);
  await prototype.locator('[data-blueprint-screen]').waitFor({ state: 'attached', timeout: 5000 });
  return prototype;
}

async function primitiveSignature(locator: Locator): Promise<{ boundaryId: string; variant: string; state: string; structure: string[] }> {
  return locator.evaluate(element => {
    const root = element as HTMLElement;
    return {
      boundaryId: root.dataset.blueprintBoundaryId ?? '',
      variant: root.dataset.blueprintVariant ?? '',
      state: root.dataset.blueprintState ?? '',
      structure: [root, ...root.querySelectorAll<HTMLElement>('*')]
        .filter(node => {
          const slot = node.parentElement?.closest('[data-blueprint-slot]');
          return !slot || !root.contains(slot);
        })
        .map(node => [node.tagName.toLowerCase(), node.getAttribute('class') ?? '', node.dataset.blueprintSlot ?? ''].join('|'))
    };
  });
}

function cloneBundle(bundle: BlueprintProjectBundle): BlueprintProjectBundle {
  return JSON.parse(JSON.stringify(bundle)) as BlueprintProjectBundle;
}

function boundarySelector(id: string): string {
  return `[data-boundary-id="${escapeAttribute(id)}"]`;
}

function screenFrameSelector(id: string, state = 'default'): string {
  return `${boundarySelector(id)}[data-review-state="${escapeAttribute(state)}"]`;
}

function escapeAttribute(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
