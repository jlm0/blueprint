import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CONTRACT_RULES, type ContractRule } from '../src/core/contract-rules';
import { loadProjectFromFs } from '../src/core/load';
import { migrateProjectFiles } from '../src/core/migrate';
import type { ValidationResult } from '../src/core/types';
import { validateProject } from '../src/prototype/validate-project';
import { withProjectCopy } from './support/project-copies';

const STARTER = 'starter/design/blueprint';
const MERIDIAN = 'fixtures/valid/meridian-finance/design/blueprint';
const LEDGER_CANDIDATE_CSS = 'prototype/screens/transactions.exploration-ledger-density-comfortable.css';
const TRANSACTIONS_ROOT = '[data-blueprint-screen="transactions"]';
const GLYPH = '<svg viewBox="0 0 1 1"></svg>';
const ROOT = '[data-blueprint-screen="home"]';
const HOME_HTML = 'prototype/screens/home.html';
const HOME_CSS = 'prototype/screens/home.css';

type JsonEdit = (value: any) => void;

class Project {
  constructor(private readonly root: string) {}

  async css(rules: string, file = HOME_CSS): Promise<void> {
    const target = path.join(this.root, file);
    await writeFile(target, `${await readFile(target, 'utf8')}\n${rules}\n`);
  }

  async home(inner: string, attributes = ''): Promise<void> {
    await this.write(HOME_HTML, `<main data-blueprint-screen="home" data-blueprint-state="default"${attributes}>${inner}</main>\n`);
  }

  async write(file: string, text: string): Promise<void> {
    await mkdir(path.dirname(path.join(this.root, file)), { recursive: true });
    await writeFile(path.join(this.root, file), text);
  }

  async json(file: string, edit: JsonEdit): Promise<void> {
    const target = path.join(this.root, file);
    const value = JSON.parse(await readFile(target, 'utf8'));
    edit(value);
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  }

  async homeScreen(edit: JsonEdit): Promise<void> {
    await this.json('screens.json', value => edit(value.screens.find((screen: { id: string }) => screen.id === 'home')));
  }

  async token(id: string, edit: JsonEdit): Promise<void> {
    await this.json('tokens.json', value => {
      edit(value.tokenGroups.flatMap((group: { tokens: unknown[] }) => group.tokens).find((token: { id: string }) => token.id === id));
    });
  }

  async addPage(id: string, name = 'Extra page'): Promise<void> {
    await this.json('screens.json', value => {
      value.pages.push({ id, name, description: 'Holds the screens of one extra surface.' });
    });
  }

  /** Copies the starter component, so the new one fits each other rule. */
  async addComponent(id: string, options: { name?: string; source?: string; rootId?: string } = {}): Promise<void> {
    const source = options.source ?? `prototype/components/${id}.html`;
    const styles = `prototype/components/${id}.css`;
    await this.write(source, (await readFile(path.join(this.root, 'prototype/components/action-cluster.html'), 'utf8'))
      .replaceAll('action-cluster', id)
      .replace(`data-blueprint-component="${id}"`, `data-blueprint-component="${options.rootId ?? id}"`));
    await this.write(styles, (await readFile(path.join(this.root, 'prototype/components/action-cluster.css'), 'utf8')).replaceAll('action-cluster', id));
    await this.json('components.json', value => {
      const copy = structuredClone(value.components.find((component: { id: string }) => component.id === 'action-cluster'));
      Object.assign(copy, { id, name: options.name ?? 'Extra cluster' });
      copy.prototype = { ...copy.prototype, source, styles: [styles] };
      value.components.push(copy);
    });
  }

  async addColorToken(id: string, styleRef: string): Promise<void> {
    await this.json('tokens.json', value => {
      value.tokenGroups.find((group: { id: string }) => group.id === 'color').tokens.push({ id, name: 'Extra', type: 'color', value: '#123456', description: 'One more color for the rule test.', styleRef });
    });
  }

  async addColorGroup(id: string, styleRef: string): Promise<void> {
    await this.json('tokens.json', value => {
      value.tokenGroups.push({
        id: 'campaign',
        name: 'Campaign',
        description: 'Colors of one campaign.',
        styleRefs: [],
        notes: [],
        tokens: [{ id, name: 'Campaign color', type: 'color', value: '#123456', description: 'One more color for the rule test.', styleRef }]
      });
    });
  }

  async useIconInHome(glyph: string, attributes = ''): Promise<void> {
    await this.home(`<section data-blueprint-section="art"><blueprint-use kind="primitive" ref="icon"${attributes}>${glyph}</blueprint-use></section>`);
    await this.homeScreen(screen => {
      screen.sections.push({
        id: 'art',
        name: 'Art',
        description: 'One glyph for the rule test.',
        styleRefs: [],
        styleEvidence: [],
        uses: [{ kind: 'primitive', id: 'icon', reason: 'Holds one glyph.' }],
        prototypeOnly: false,
        notes: [],
        implementationHints: [],
        implementationTargets: []
      });
      screen.prototype.renderedUses.push({ kind: 'primitive', id: 'icon' });
    });
  }

  async declareFont(family: string, asset: string): Promise<void> {
    await this.write(asset, 'font');
    await this.json('brand.json', brand => {
      brand.fonts.push({ family, source: 'asset', assets: [asset] });
    });
    await this.homeScreen(screen => {
      screen.prototype.assetRefs.push(asset);
    });
  }
}

interface RuleCase {
  rule: ContractRule;
  /** The small edit that this rule must refuse. */
  mustFail: (project: Project) => Promise<void>;
  /** The exact error text. */
  error: string;
  /** The nearest edit that stays legal. */
  control: (project: Project) => Promise<void>;
  /** The project to copy, when the starter cannot show this rule. */
  fixture?: string;
  /** The error breaks a file contract or a render, so it stops the canvas and `inspo`. */
  stopsCanvas?: true;
  /** Blueprint owns the name of a primitive, so the must-fail case also gets the contract error of the locked name. */
  lockedName?: true;
}

async function baselineResult(edit: (project: Project) => Promise<void>, fixture = STARTER): Promise<ValidationResult> {
  return withProjectCopy(async root => {
    await edit(new Project(root));
    return validateProject(await loadProjectFromFs(root));
  }, fixture);
}

async function baselineErrors(edit: (project: Project) => Promise<void>, fixture = STARTER): Promise<string[]> {
  return (await baselineResult(edit, fixture)).errors;
}

const RULE_CASES: readonly RuleCase[] = [
  {
    rule: 'literal-color',
    mustFail: project => project.css(`${ROOT} { color: #123456; }`),
    error: 'screen.home prototype/screens/home.css color: "#123456" uses a literal color; use a token custom property or declare the literal in prototype.localValueExceptions. Fix: replace "#123456" with var() of a color token in prototype/screens/home.css. Or add { "property": "color", "value": "#123456", "reason": "<why>" } to prototype.localValueExceptions.',
    control: project => project.css(`${ROOT} { color: var(--app-color-foreground); }`)
  },
  {
    rule: 'named-color',
    mustFail: project => project.css(`${ROOT} { color: rebeccapurple; }`),
    error: 'screen.home prototype/screens/home.css color: "rebeccapurple" uses the named color "rebeccapurple". Fix: replace "rebeccapurple" with var() of a color token in prototype/screens/home.css. Or add { "property": "color", "value": "rebeccapurple", "reason": "<why>" } to prototype.localValueExceptions.',
    control: project => project.css(`${ROOT} { color: currentColor; background: transparent; border-color: inherit; outline-color: CanvasText; }`)
  },
  {
    rule: 'restated-token',
    mustFail: project => project.css(`${ROOT} { padding: 16px; }`),
    error: 'screen.home prototype/screens/home.css padding: "16px" restates token --app-space-4; use var(--app-space-4) or declare the literal in prototype.localValueExceptions. Fix: replace "16px" with var(--app-space-4) in prototype/screens/home.css. Or add { "property": "padding", "value": "16px", "reason": "<why>" } to prototype.localValueExceptions.',
    control: project => project.css(`${ROOT} { padding: 17px; }`)
  },
  {
    rule: 'raw-font-family',
    mustFail: project => project.css(`${ROOT} { font-family: Arial, sans-serif; }`),
    error: 'screen.home prototype/screens/home.css font-family: "Arial, sans-serif" names a font family directly. Fix: replace "Arial, sans-serif" with var() of a typography token, or with inherit, in prototype/screens/home.css. Add the token to tokens.json when none has this family.',
    control: project => project.css(`${ROOT} { font-family: var(--app-font-sans); } ${ROOT} p { font-family: inherit; }`)
  },
  {
    rule: 'raw-font-size',
    mustFail: project => project.css(`${ROOT} { font-size: 17px; }`),
    error: 'screen.home prototype/screens/home.css font-size: "17px" sets a raw font size. Fix: replace "17px" with var() of a typography token, or with inherit, in prototype/screens/home.css. Add the token to tokens.json when none has this value.',
    control: project => project.css(`${ROOT} { font: var(--app-type-body); } ${ROOT} p { font-size: inherit; }`)
  },
  {
    rule: 'native-control',
    mustFail: project => project.home('<button>Go</button>'),
    error: 'screen.home prototype/screens/home.html:1 hand-builds a native <button>; use <blueprint-use kind="primitive" ref="button"> or mark a deliberate native control with data-blueprint-native="<reason>". Fix: replace this <button> at line 1 of prototype/screens/home.html with that primitive, or add data-blueprint-native="<reason>" to it.',
    control: project => project.home('<p>Go</p>')
  },
  {
    rule: 'contrast',
    mustFail: project => project.token('foreground', token => {
      token.value = '#f0f0f0';
    }),
    error: 'token-group.color --app-color-foreground (#f0f0f0) on --app-color-background (#fafafa) has contrast 1.09:1; text needs at least 4.5:1. Fix: change the value of --app-color-foreground or --app-color-background in tokens.json until the pair reaches 4.5:1.',
    control: project => project.token('foreground', token => {
      token.value = '#000000';
    })
  },
  {
    rule: 'primitive-set',
    mustFail: project => project.json('primitives.json', value => {
      const text = value.primitives.find((primitive: { id: string }) => primitive.id === 'text');
      value.primitives.push({ ...structuredClone(text), id: 'flash', name: 'Flash' });
    }),
    error: 'primitive "flash" is not in the Blueprint primitive set; rebuild it as a component from primitives. The Blueprint primitive set is closed: it is themed through tokens, and app-specific pieces are components built from primitives. Fix: move "flash" from primitives.json to components.json, and build it from base primitives.',
    control: project => project.json('primitives.json', value => {
      value.primitives.find((primitive: { id: string }) => primitive.id === 'icon').variants.values.push({ id: 'quiet', name: 'Quiet', description: 'One more variant for the rule test.' });
    })
  },
  {
    rule: 'inline-style',
    mustFail: project => project.home('', ' style="color: var(--app-color-foreground)"'),
    error: 'screen.home prototype/screens/home.html:1 has a style attribute on <main>. Fix: delete this style attribute, and set its declarations in a rule of prototype/screens/home.css.',
    control: project => project.home('', ' class="home__body"')
  },
  {
    rule: 'style-element',
    mustFail: project => project.home('<style>p { margin: 0; }</style>'),
    error: 'screen.home prototype/screens/home.html:1 has a <style> element. Fix: delete this <style> element, and move its rules to prototype/screens/home.css.',
    control: project => project.home('<!-- A rule belongs in the stylesheet. -->')
  },
  {
    rule: 'undeclared-variable',
    mustFail: project => project.css(`${ROOT} { margin: var(--missing); }`),
    error: 'screen.home prototype/screens/home.css margin: "var(--missing)" reads --missing, which no token declares. Fix: replace var(--missing) with var() of a token in prototype/screens/home.css, or add a token with styleRef "--missing" to tokens.json.',
    control: project => project.css(`${ROOT} { margin: var(--blueprint-safe-area-top) var(--app-space-2); }`)
  },
  {
    rule: 'local-custom-property',
    mustFail: project => project.css(`${ROOT} { --gutter: 4px; }`),
    error: 'screen.home prototype/screens/home.css declares the custom property --gutter. Fix: delete this declaration from prototype/screens/home.css, and use var() of a token in tokens.json where the stylesheet reads --gutter.',
    control: project => project.css(`${ROOT} { margin: calc(var(--app-space-2) * 2); }`)
  },
  {
    rule: 'whole-value-exception',
    mustFail: async project => {
      await project.css(`${ROOT} { color: #123456; }`);
      await project.homeScreen(screen => {
        screen.prototype.localValueExceptions = [{ property: 'color', value: '#', reason: 'A partial value must not hide the color.' }];
      });
    },
    error: 'screen.home prototype/screens/home.css color: "#123456" uses a literal color; use a token custom property or declare the literal in prototype.localValueExceptions. Fix: replace "#123456" with var() of a color token in prototype/screens/home.css. Or add { "property": "color", "value": "#123456", "reason": "<why>" } to prototype.localValueExceptions.',
    control: async project => {
      await project.css(`${ROOT} { color: #123456; }`);
      await project.homeScreen(screen => {
        screen.prototype.localValueExceptions = [{ property: 'color', value: '#123456', reason: 'The whole value names this one color.' }];
      });
    }
  },
  {
    rule: 'unmatched-exception',
    mustFail: project => project.homeScreen(screen => {
      screen.prototype.localValueExceptions = [{ property: 'color', value: '#123456', reason: 'No declaration in the sheet has this value.' }];
    }),
    error: 'screen.home prototype.localValueExceptions entry { "property": "color", "value": "#123456" } matches no whole declaration in the stylesheets of this boundary. Fix: set value to the whole declaration value as a stylesheet writes it, or delete this entry.',
    control: async project => {
      await project.css(`${ROOT} { transform: rotate(-1.6deg); }`);
      await project.homeScreen(screen => {
        screen.prototype.localValueExceptions = [{ property: 'transform', value: 'rotate(-1.6deg)', reason: 'The sheet has this whole value.' }];
      });
    }
  },
  {
    rule: 'inline-svg',
    mustFail: project => project.home('<svg viewBox="0 0 1 1"></svg>'),
    error: 'screen.home prototype/screens/home.html:1 has an inline <svg> outside a reusable and outside a slot. Fix: put this <svg> in <blueprint-use kind="primitive" ref="icon">, or replace it with a <blueprint-use kind="brand-mark"> of a mark in brand.json when it is a logo.',
    control: project => project.useIconInHome('<svg viewBox="0 0 1 1"></svg>')
  },
  {
    rule: 'parallel-palette',
    mustFail: project => project.addColorGroup('background', '--app-campaign-background'),
    error: 'tokenGroup.campaign tokens.json color token "background" restates the role "color.background". Fix: delete this token from tokens.json, and change the value of "color.background", or give this token an id that names its new meaning.',
    control: project => project.addColorGroup('campaign-background', '--app-campaign-background')
  },
  {
    rule: 'token-prefix',
    mustFail: project => project.addColorToken('extra', '--brand-extra'),
    error: 'tokenGroup.color tokens.json token "extra" has styleRef "--brand-extra", which starts a second namespace. Fix: set styleRef of this token to "--app-color-extra".',
    control: project => project.addColorToken('extra', '--app-color-extra')
  },
  {
    rule: 'placeholder-text',
    mustFail: project => project.homeScreen(screen => {
      screen.notes = ['Write <why> here.'];
    }),
    error: 'screens.json screens[0].notes[0] holds the placeholder "<why>". Fix: replace "<why>" at screens[0].notes[0] in screens.json with the real text or path.',
    control: project => project.homeScreen(screen => {
      screen.notes = ['Names each step as <hue>-<n> for the palette.'];
    })
  },
  {
    rule: 'asset-attribute',
    stopsCanvas: true,
    mustFail: project => project.home('<img srcset="x.png 2x" alt="">'),
    error: 'Prototype source graph starter-app/screen/home state "default" cannot compile: Prototype source "prototype/screens/home.html" has srcset="x.png 2x" on <img>, which loads a file without an asset declaration. Fix: delete srcset from this tag, and show the file through src on an <img> with the file in prototype.assetRefs.',
    control: project => project.write('prototype/primitives/icon.html', '<span data-blueprint-primitive="icon" aria-hidden="true"><slot><svg viewBox="0 0 1 1"><symbol id="dot"></symbol><use href="#dot"></use></svg></slot></span>\n')
  },
  {
    rule: 'class-attribute-selector',
    mustFail: project => project.css(`${ROOT} [class~="button__label"] { opacity: 0.5; }`),
    error: `screen.home prototype/screens/home.css selector "${ROOT} [class~="button__label"]" reads the class attribute, so the reach rules cannot read this class. Fix: select this class with a dot, as ".name", in prototype/screens/home.css.`,
    control: project => project.css(`${ROOT} .home__label { opacity: 0.5; }`)
  },
  {
    rule: 'presentational-markup',
    mustFail: project => project.home('<table bgcolor="#123456"></table>'),
    error: 'screen.home prototype/screens/home.html:1 has bgcolor="#123456" on <table>. Fix: delete bgcolor from this tag, and set this color with a token in prototype/screens/home.css.',
    control: project => project.home('<table></table>')
  },
  {
    rule: 'unparsed-stylesheet',
    mustFail: project => project.css(`${ROOT} { color: var(--app-color-foreground);`),
    error: 'screen.home prototype/screens/home.css cannot be parsed, so Blueprint cannot check its rules. Fix: close each block and each string in prototype/screens/home.css.',
    control: project => project.css(`${ROOT} { color: var(--app-color-foreground); }`)
  },
  {
    rule: 'selector-root',
    mustFail: project => project.css('.stray { margin: 0; }'),
    error: 'screen.home prototype/screens/home.css selector ".stray" does not start at the root of screen "home". Fix: start this selector with [data-blueprint-screen="home"] in prototype/screens/home.css, or move this rule to the stylesheet of the boundary that it styles.',
    control: project => project.css(`${ROOT} .stray { margin: 0; } .home__part { margin: 0; } :where(${ROOT}) .other { margin: 0; }`)
  },
  {
    rule: 'reach-root',
    mustFail: project => project.css(`${ROOT} [data-blueprint-primitive="button"] { color: var(--app-color-foreground); }`),
    error: 'screen.home prototype/screens/home.css selector "[data-blueprint-screen="home"] [data-blueprint-primitive="button"]" reaches the root of primitive "button" and sets color. Fix: delete color from this rule in prototype/screens/home.css, and add a variant with them to that reusable. A rule on another root sets only margin, size, flex and grid placement, order, self alignment, and display: none.',
    control: project => project.css(`${ROOT} [data-blueprint-primitive="button"] { margin-top: var(--app-space-2); align-self: end; order: 1; }`)
  },
  {
    rule: 'reach-through',
    mustFail: project => project.css(`${ROOT} [data-blueprint-primitive="button"] span { margin: 0; }`),
    error: 'screen.home prototype/screens/home.css selector "[data-blueprint-screen="home"] [data-blueprint-primitive="button"] span" reaches inside primitive "button". Fix: delete this rule from prototype/screens/home.css, and add a variant to that reusable in its own stylesheet.',
    control: project => project.css(`${ROOT} .home__action span { margin: 0; }`)
  },
  {
    rule: 'reach-forwarded',
    mustFail: async project => {
      await project.useIconInHome(GLYPH, ' class="home__glyph"');
      await project.css(`${ROOT} .home__glyph { color: var(--app-color-foreground); }`);
    },
    error: 'screen.home prototype/screens/home.css selector "[data-blueprint-screen="home"] .home__glyph" reaches the root that <blueprint-use class="home__glyph"> places, and sets color. Fix: delete color from this rule in prototype/screens/home.css, and add a variant with them to that reusable in its own stylesheet.',
    control: async project => {
      await project.useIconInHome(GLYPH, ' class="home__glyph"');
      await project.css(`${ROOT} .home__glyph { margin-top: var(--app-space-2); align-self: end; }`);
    }
  },
  {
    rule: 'reach-foreign-part',
    mustFail: project => project.css(`${ROOT} .button__label { margin: 0; }`),
    error: 'screen.home prototype/screens/home.css selector "[data-blueprint-screen="home"] .button__label" selects the class "button__label" in the namespace of primitive "button". Fix: delete this rule from prototype/screens/home.css, and add a variant to that reusable in its own stylesheet.',
    control: project => project.css(`${ROOT} .home__label { margin: 0; }`)
  },
  {
    rule: 'reach-descendant',
    mustFail: async project => {
      await project.useIconInHome(GLYPH);
      await project.css(`${ROOT} svg { display: block; }`);
    },
    error: 'screen.home prototype/screens/home.css selector "[data-blueprint-screen="home"] svg" has a type or universal subject, and its descendant combinator can cross into a reusable that this boundary places. Fix: select a class of this boundary in prototype/screens/home.css, or use a child combinator from an element that this boundary owns.',
    control: async project => {
      await project.useIconInHome(GLYPH);
      await project.css(`${ROOT} > section { display: block; }`);
    }
  },
  {
    rule: 'svg-paint-attribute',
    mustFail: project => project.useIconInHome('<svg viewBox="0 0 1 1"><path d="M0 0" fill="#123456"></path></svg>'),
    error: 'screen.home prototype/screens/home.html:1 has fill="#123456" on <path>. Fix: set fill to "none", "currentColor", or var() of a token in tokens.json.',
    control: project => project.useIconInHome('<svg viewBox="0 0 1 1"><path d="M0 0" fill="currentColor" stroke="none" color="var(--app-color-foreground)"></path></svg>')
  },
  {
    rule: 'exploration-candidate',
    fixture: MERIDIAN,
    mustFail: project => project.css(`${TRANSACTIONS_ROOT} { margin: 0 !important; }`, LEDGER_CANDIDATE_CSS),
    error: `exploration.ledger-density candidate.comfortable: screen.transactions ${LEDGER_CANDIDATE_CSS} margin: "0 !important" uses !important. Fix: delete !important from this declaration in ${LEDGER_CANDIDATE_CSS}.`,
    control: project => project.css('[data-blueprint-screen="home"] { margin: 0 !important; }', 'prototype/screens/home.history-home-v1.css')
  },
  {
    rule: 'important',
    mustFail: project => project.css(`${ROOT} { color: var(--app-color-foreground) !important; }`),
    error: 'screen.home prototype/screens/home.css color: "var(--app-color-foreground) !important" uses !important. Fix: delete !important from this declaration in prototype/screens/home.css.',
    control: project => project.css(`${ROOT} { color: var(--app-color-foreground); }`)
  },
  {
    rule: 'token-value-type',
    stopsCanvas: true,
    mustFail: project => project.token('space-1', token => {
      token.value = 'wide';
    }),
    error: 'tokenGroup.space.token.space-1.value "wide" is not a length, a percentage, 0, or a math function, so it does not fit type "space". Fix: set value to a length, a percentage, 0, or a math function, such as "8px", or set type to the type that this value has.',
    control: project => project.token('space-1', token => {
      token.value = 'calc(2px + 2px)';
    })
  },
  {
    rule: 'brand-font-list',
    stopsCanvas: true,
    mustFail: project => project.json('brand.json', brand => {
      brand.fonts.push({ family: 'Georgia', source: 'system', assets: ['brand/georgia.woff2'] });
    }),
    error: 'brand.fonts[3].assets must be empty for a system font. Fix: set assets to [], or set source to "asset".',
    control: project => project.json('brand.json', brand => {
      brand.fonts.push({ family: 'Georgia', source: 'system', assets: [] });
    })
  },
  {
    rule: 'id-length',
    mustFail: project => project.addPage('word-word-word-word-word-word-word-wo'),
    error: 'page.word-word-word-word-word-word-word-wo id is 37 characters, over the limit of 36. Fix: rename it to 36 characters or fewer.',
    control: project => project.addPage('word-word-word-word-word-word-word-w')
  },
  {
    rule: 'id-placeholder',
    mustFail: project => project.addPage('temp-page'),
    error: 'page.temp-page id holds the placeholder word "temp". Fix: rename it with a word that says what it is.',
    control: project => project.addPage('temperature-page')
  },
  {
    rule: 'id-trailing-number',
    mustFail: project => project.addPage('section-2'),
    error: 'page.section-2 id ends in a number. Fix: rename it with a word that says how it differs.',
    control: project => project.addPage('section-second')
  },
  {
    rule: 'id-version-word',
    mustFail: project => project.addPage('web-old'),
    error: 'page.web-old id holds the version word "old". Fix: remove the word. A numbered screen version ends in -v<version>, with the same number, 2 or greater, in its version field.',
    control: project => project.addPage('web-older')
  },
  {
    rule: 'id-generated',
    mustFail: project => project.addComponent('card-a1b2c3d4'),
    error: 'component.card-a1b2c3d4 id holds the generated part "a1b2c3d4". Fix: rename it with words that say what it is.',
    control: project => project.addComponent('card-facade')
  },
  {
    rule: 'screen-name-word',
    lockedName: true,
    mustFail: project => project.homeScreen(screen => {
      screen.name = 'Home v2';
    }),
    error: 'screen.home has the name "Home v2", which holds the version word "v2". Fix: remove the word from the name, and write the number in the version field of screen.home.',
    control: project => project.homeScreen(screen => {
      screen.name = 'Home overview';
    })
  },
  {
    rule: 'screen-name-version',
    mustFail: project => project.json('screens.json', value => {
      value.screens[1].name = value.screens[0].name;
    }),
    error: 'screen.web-home has the name "Mobile base", and version 1, which screen.home has too. Fix: give screen.web-home another name. Only numbered versions of one route keep a shared name, each with its own version.',
    control: project => project.json('screens.json', value => {
      value.screens[1].name = 'Front door';
    })
  },
  {
    rule: 'primitive-name',
    lockedName: true,
    mustFail: project => project.json('primitives.json', value => {
      value.primitives[1].name = value.primitives[0].name;
    }),
    error: 'primitive.input has the name "Button", which primitive.button has too. Fix: give primitive.input another name.',
    control: () => Promise.resolve()
  },
  {
    rule: 'component-name',
    mustFail: project => project.addComponent('extra-cluster', { name: 'Action cluster' }),
    error: 'component.extra-cluster has the name "Action cluster", which component.action-cluster has too. Fix: give component.extra-cluster another name.',
    control: project => project.addComponent('extra-cluster', { name: 'Extra cluster' })
  },
  {
    rule: 'page-name',
    mustFail: project => project.addPage('other-web', 'Web'),
    error: 'page.other-web has the name "Web", which page.web has too. Fix: give page.other-web another name.',
    control: project => project.addPage('other-web', 'Other web')
  },
  {
    rule: 'component-id-shared',
    mustFail: project => project.addComponent('button'),
    error: 'component.button has the id of a primitive. Fix: rename the component with a word that says how it differs from primitive.button.',
    control: project => project.addComponent('button-cluster')
  },
  {
    rule: 'reusable-source-path',
    mustFail: project => project.addComponent('extra-cluster', { source: 'prototype/shared/extra-cluster.html' }),
    error: 'component.extra-cluster.prototype.source is "prototype/shared/extra-cluster.html". Fix: move the file to "prototype/components/extra-cluster.html", and set source to that path.',
    control: project => project.addComponent('extra-cluster', { source: 'prototype/components/extra-cluster.html' })
  },
  {
    rule: 'reusable-root-id',
    mustFail: project => project.addComponent('extra-cluster', { rootId: 'other-cluster' }),
    error: 'component.extra-cluster root element in prototype/components/extra-cluster.html has data-blueprint-component="other-cluster". Fix: set data-blueprint-component="extra-cluster" on the root element.',
    control: project => project.addComponent('extra-cluster', { rootId: 'extra-cluster' })
  },
  {
    rule: 'id-kebab-case',
    mustFail: project => project.json('manifest.json', value => {
      value.framePresets.push({ ...value.framePresets[0], id: 'Wide_Frame' });
    }),
    error: 'framePreset.Wide_Frame id "Wide_Frame" is not kebab-case. Fix: rename it to "wide-frame", in its declaration and in each place that names it.',
    control: project => project.json('manifest.json', value => {
      value.framePresets.push({ ...value.framePresets[0], id: 'wide-frame' });
    })
  },
  {
    rule: 'single-value-axis',
    mustFail: project => project.json('components.json', value => {
      value.components[0].states = { default: 'normal', values: [{ id: 'normal', name: 'Normal', description: 'At rest.' }] };
    }),
    error: 'component.action-cluster.states has one value, "normal". Fix: run the migrate tool, which renames the value to "default" and rewrites its placements and selectors. If the value stays, rename it to "default" by hand in the declaration, in each placement, and in each selector.',
    control: project => project.json('components.json', value => {
      value.components[0].states = { default: 'default', values: [{ id: 'default', name: 'Default', description: 'At rest.' }] };
    })
  },
  {
    rule: 'font-family-declared',
    mustFail: project => project.token('font-sans', token => {
      token.value = '"Comic Neue", sans-serif';
    }),
    error: 'tokenGroup.typography.token.font-sans.value names the font family "Comic Neue", which brand.json does not declare. Fix: add { "family": "Comic Neue", "source": "system", "assets": [] } to fonts in brand.json, with source "asset" and its files when the project holds the font.',
    control: project => project.token('font-sans', token => {
      token.value = 'ui-sans-serif, sans-serif';
    })
  },
  {
    rule: 'font-face-asset',
    stopsCanvas: true,
    mustFail: project => project.css('@font-face { font-family: "Inter"; src: url("../assets/inter.woff2"); }'),
    error: 'prototype/screens/home.css @font-face "Inter" loads "prototype/assets/inter.woff2", which brand.fonts does not declare. Fix: add "prototype/assets/inter.woff2" to the assets of the "Inter" entry in fonts of brand.json, with source "asset".',
    control: async project => {
      await project.declareFont('Inter', 'prototype/assets/inter.woff2');
      await project.css('@font-face { font-family: "Inter"; src: url("../assets/inter.woff2"); }');
    }
  }
];

describe('contract rule table', () => {
  it('holds one must-fail case and one control case for each rule id', () => {
    assert.deepEqual(RULE_CASES.map(item => item.rule).sort(), [...CONTRACT_RULES].sort());
  });

  for (const item of RULE_CASES) {
    it(`${item.rule} refuses its must-fail case with the exact error`, async () => {
      const result = await baselineResult(item.mustFail, item.fixture);
      assert.ok(result.errors.includes(item.error), result.errors.join('\n'));
      assert.match(item.error, /Fix: /);
      assert.equal(result.ok, false);
      assert.deepEqual(result.errors, [...result.contractErrors, ...result.styleErrors]);
      if (item.stopsCanvas) {
        assert.ok(result.contractErrors.includes(item.error), `${item.rule} must stop the canvas`);
      } else if (!item.lockedName) {
        assert.deepEqual(result.contractErrors, [], `${item.rule} must leave the canvas open`);
      }
    });

    it(`${item.rule} passes its control case`, async () => {
      assert.deepEqual(await baselineErrors(item.control, item.fixture), []);
    });
  }
});

interface ExtraCase {
  name: string;
  edit: (project: Project) => Promise<void>;
  /** The text that one error must hold, or nothing when the edit is legal. */
  error?: string;
}

const svgIcon = (inner: string): string => `<span data-blueprint-primitive="icon" aria-hidden="true"><slot><svg viewBox="0 0 1 1">${inner}</svg></slot></span>\n`;

const EXTRA_CASES: readonly ExtraCase[] = [
  { name: 'a class attribute prefix selector fails', edit: project => project.css(`${ROOT} [class^="button__"] { opacity: 0.5; }`), error: 'reads the class attribute' },
  { name: 'a class attribute selector in a branch fails', edit: project => project.css(`${ROOT} :is([CLASS*="button"]) { opacity: 0.5; }`), error: 'reads the class attribute' },
  { name: 'a class attribute selector before the subject fails', edit: project => project.css(`${ROOT} [class~="button__label"] span { opacity: 0.5; }`), error: 'reads the class attribute' },
  { name: 'a font element fails', edit: project => project.home('<font face="Georgia">Go</font>'), error: 'has a <font> element' },
  { name: 'a color attribute on a rule fails', edit: project => project.home('<hr color="#123456">'), error: 'has color="#123456" on <hr>' },
  { name: 'a border color attribute fails', edit: project => project.home('<table bordercolor="red"></table>'), error: 'has bordercolor="red" on <table>' },
  { name: 'a color attribute on an svg stays legal', edit: project => project.useIconInHome('<svg viewBox="0 0 1 1" color="currentColor"></svg>') },
  { name: 'a background attribute fails as an undeclared file', edit: project => project.home('<table><tr><td background="x.png"></td></tr></table>'), error: 'has background="x.png" on <td>, which loads a file without an asset declaration' },
  { name: 'a string in image-set fails as an undeclared file', edit: project => project.css(`${ROOT} { background-image: image-set("x.png" 1x); }`), error: 'Prototype resource "x.png"' },
  { name: 'a string in a prefixed image-set fails as an undeclared file', edit: project => project.css(`${ROOT} { background-image: -webkit-image-set("x.png" 1x); }`), error: 'Prototype resource "x.png"' },
  { name: 'a screen name with a spelled version fails', edit: project => project.homeScreen(screen => {
    screen.name = 'Home version 2';
  }), error: 'holds the version word "version 2"' },
  { name: 'a role of a control primitive fails', edit: project => project.home('<p role="button" tabindex="0">Go</p>'), error: 'hand-builds a native <p role="button">; use <blueprint-use kind="primitive" ref="button">' },
  { name: 'a role in upper case fails', edit: project => project.home('<p role="BUTTON" tabindex="0">Go</p>'), error: 'hand-builds a native <p role="BUTTON">' },
  { name: 'a role with a marked reason stays legal', edit: project => project.home('<p role="button" tabindex="0" data-blueprint-native="A rule test needs this.">Go</p>') },
  { name: 'a role in the slot of a reusable stays legal', edit: project => project.useIconInHome('<svg viewBox="0 0 1 1" role="radio"></svg>') },
  { name: 'a role with no control primitive stays legal', edit: project => project.home('<p role="note">Go</p>') },
  { name: 'a named color in a shorthand fails', edit: project => project.css(`${ROOT} { border: 1px solid tomato; }`), error: 'uses the named color "tomato"' },
  { name: 'a color() value in a sheet fails', edit: project => project.css(`${ROOT} { color: oklch(50% 0.1 200); }`), error: 'uses a literal color' },
  { name: 'a font shorthand with a raw size fails', edit: project => project.css(`${ROOT} { font: 600 17px/1.3 var(--app-font-sans); }`), error: 'sets a raw font size' },
  { name: 'a font shorthand with a raw family fails', edit: project => project.css(`${ROOT} { font: var(--app-type-body); font-family: "Georgia"; }`), error: 'names a font family directly' },
  { name: 'a raw font size stays an error with an exception', edit: async project => {
    await project.css(`${ROOT} { font-size: 17px; }`);
    await project.homeScreen(screen => {
      screen.prototype.localValueExceptions = [{ property: 'font-size', value: '17px', reason: 'An exception does not excuse a raw size.' }];
    });
  }, error: 'sets a raw font size' },
  { name: 'an exception value matches after whitespace collapse', edit: async project => {
    await project.css(`${ROOT} { padding: 16px   17px; }`);
    await project.homeScreen(screen => {
      screen.prototype.localValueExceptions = [{ property: 'padding', value: '16px 17px', reason: 'This whole value is local to the art.' }];
    });
  } },
  { name: 'a unique composition length stays legal', edit: project => project.css(`${ROOT} { width: 321px; gap: 13px; }`) },
  { name: '!important fails in a primitive sheet too', edit: project => project.css('[data-blueprint-primitive="icon"] { margin: 0 !important; }', 'prototype/primitives/icon.css'), error: 'uses !important' },
  { name: 'a selector of a primitive sheet starts at its root', edit: project => project.css('.stray { margin: 0; }', 'prototype/primitives/icon.css'), error: 'does not start at the root of primitive "icon"' },
  { name: 'a :where() branch outside the root fails', edit: project => project.css(`:where(${ROOT}, .stray) .part { margin: 0; }`), error: 'does not start at the root of screen "home"' },
  { name: 'display: none on another root stays legal', edit: project => project.css(`${ROOT} [data-blueprint-component="x"] { display: none; }`) },
  { name: 'a placeholder TODO in a ref fails', edit: project => project.homeScreen(screen => {
    screen.styleRefs = ['TODO'];
  }), error: 'holds the placeholder "TODO"' },
  { name: 'a placeholder that fills a whole field fails', edit: project => project.homeScreen(screen => {
    screen.description = '<why>';
  }), error: 'holds the placeholder "<why>"' },
  { name: 'a placeholder TBD fails', edit: project => project.homeScreen(screen => {
    screen.description = 'TBD';
  }), error: 'holds the placeholder "TBD"' },
  { name: 'a placeholder stylesheet path fails', edit: project => project.homeScreen(screen => {
    screen.notes = ['Move this rule to <stylesheet path>.'];
  }), error: 'holds the placeholder "<stylesheet path>"' },
  { name: 'lorem ipsum fails', edit: project => project.homeScreen(screen => {
    screen.description = 'Lorem ipsum dolor sit amet.';
  }), error: 'holds the placeholder "Lorem ipsum"' },
  { name: 'an <image href> fails', edit: project => project.write('prototype/primitives/icon.html', svgIcon('<image href="x.png"></image>')), error: 'has href="x.png" on <image>' },
  { name: 'an <image xlink:href> fails', edit: project => project.write('prototype/primitives/icon.html', svgIcon('<image xlink:href="x.png"></image>')), error: 'has xlink:href="x.png" on <image>' },
  { name: 'a <use href> to a file fails', edit: project => project.write('prototype/primitives/icon.html', svgIcon('<use href="sprite.svg#dot"></use>')), error: 'has href="sprite.svg#dot" on <use>' },
  { name: 'a <feImage href> fails', edit: project => project.write('prototype/primitives/icon.html', svgIcon('<filter id="f"><feImage href="x.png"></feImage></filter>')), error: 'on <feimage>' },
  { name: 'a subject with a class of no namespace fails through another root', edit: project => project.css(`${ROOT} [data-blueprint-primitive="button"] .stray { margin: 0; }`), error: 'reaches inside primitive "button"' },
  { name: 'a subject with a class of another boundary fails through another root', edit: project => project.css(`${ROOT} [data-blueprint-primitive="button"] .button__label { margin: 0; }`), error: 'in the namespace of primitive "button"' },
  { name: 'a subject with a class of this boundary stays legal through another root', edit: project => project.css(`${ROOT} [data-blueprint-primitive="button"] .home__label { margin: 0; }`) },
  { name: 'a type subject fails through a forwarded class', edit: async project => {
    await project.useIconInHome(GLYPH, ' class="home__glyph"');
    await project.css(`${ROOT} .home__glyph > svg { display: block; }`);
  }, error: 'reaches inside the root that <blueprint-use class="home__glyph"> places' },
  { name: 'a class of this boundary stays legal through a forwarded class', edit: async project => {
    await project.useIconInHome(GLYPH, ' class="home__glyph"');
    await project.css(`${ROOT} .home__glyph .home__art { display: block; }`);
  } },
  { name: 'a forwarded class in a branch of :is() sets only layout', edit: async project => {
    await project.useIconInHome(GLYPH, ' class="home__glyph"');
    await project.css(`${ROOT} :is(.home__glyph, .home__other) { color: var(--app-color-foreground); }`);
  }, error: 'reaches the root that <blueprint-use class="home__glyph"> places' },
  { name: 'display: none on a forwarded class stays legal', edit: async project => {
    await project.useIconInHome(GLYPH, ' class="home__glyph"');
    await project.css(`${ROOT} .home__glyph { display: none; }`);
  } },
  { name: 'each property fails on a part of another boundary', edit: project => project.css(`${ROOT} .button--wide { color: var(--app-color-foreground); }`), error: 'in the namespace of primitive "button"' },
  { name: 'a part of another boundary fails in a reusable sheet too', edit: project => project.css('[data-blueprint-primitive="icon"] .button__label { margin: 0; }', 'prototype/primitives/icon.css'), error: 'in the namespace of primitive "button"' },
  { name: 'a universal subject fails', edit: async project => {
    await project.useIconInHome(GLYPH);
    await project.css(`${ROOT} * { margin: 0; }`);
  }, error: 'has a type or universal subject' },
  { name: 'a universal box-sizing reset stays legal', edit: async project => {
    await project.useIconInHome(GLYPH);
    await project.css(`*:where(${ROOT}, ${ROOT} *) { box-sizing: border-box; }`);
  } },
  { name: 'a universal rule with one more declaration than box-sizing fails', edit: async project => {
    await project.useIconInHome(GLYPH);
    await project.css(`*:where(${ROOT}, ${ROOT} *) { box-sizing: border-box; margin: 0; }`);
  }, error: 'has a type or universal subject' },
  { name: 'a type subject fails with box-sizing alone', edit: async project => {
    await project.useIconInHome(GLYPH);
    await project.css(`${ROOT} svg { box-sizing: border-box; }`);
  }, error: 'has a type or universal subject' },
  { name: 'a type subject stays legal from a class that holds no reusable', edit: async project => {
    await project.home('<section data-blueprint-section="art"><div class="home__text"><p>Text</p></div><blueprint-use kind="primitive" ref="icon"><svg viewBox="0 0 1 1"></svg></blueprint-use></section>');
    await project.homeScreen(screen => {
      screen.sections.push({ id: 'art', name: 'Art', description: 'One glyph for the rule test.', styleRefs: [], styleEvidence: [], uses: [{ kind: 'primitive', id: 'icon', reason: 'Holds one glyph.' }], prototypeOnly: false, notes: [], implementationHints: [], implementationTargets: [] });
      screen.prototype.renderedUses.push({ kind: 'primitive', id: 'icon' });
    });
    await project.css(`${ROOT} .home__text p { margin: 0; }`);
  } },
  { name: 'a type subject fails from a class that holds a reusable', edit: async project => {
    await project.home('<section data-blueprint-section="art"><div class="home__text"><blueprint-use kind="primitive" ref="icon"><svg viewBox="0 0 1 1"></svg></blueprint-use></div></section>');
    await project.homeScreen(screen => {
      screen.sections.push({ id: 'art', name: 'Art', description: 'One glyph for the rule test.', styleRefs: [], styleEvidence: [], uses: [{ kind: 'primitive', id: 'icon', reason: 'Holds one glyph.' }], prototypeOnly: false, notes: [], implementationHints: [], implementationTargets: [] });
      screen.prototype.renderedUses.push({ kind: 'primitive', id: 'icon' });
    });
    await project.css(`${ROOT} .home__text svg { margin: 0; }`);
  }, error: 'has a type or universal subject' },
  { name: 'a type subject fails from a class on no element of this boundary', edit: async project => {
    await project.useIconInHome(GLYPH);
    await project.css(`${ROOT} .stray svg { margin: 0; }`);
  }, error: 'has a type or universal subject' },
  { name: 'a nested type subject fails', edit: async project => {
    await project.useIconInHome(GLYPH);
    await project.css(`${ROOT} { svg { display: block; } }`);
  }, error: 'has a type or universal subject' },
  { name: 'a nested child combinator stays legal', edit: async project => {
    await project.useIconInHome(GLYPH);
    await project.css(`${ROOT} { > section { display: block; } }`);
  } },
  { name: 'a subject with only a pseudo-class fails', edit: async project => {
    await project.useIconInHome(GLYPH);
    await project.css(`${ROOT} :first-child { margin: 0; }`);
  }, error: 'has a type or universal subject' },
  { name: 'a type subject anchored in :where() fails', edit: async project => {
    await project.useIconInHome(GLYPH);
    await project.css(`svg:where(${ROOT}, ${ROOT} *) { display: block; }`);
  }, error: 'has a type or universal subject' },
  { name: 'a child combinator from a type fails after a descendant combinator', edit: async project => {
    await project.useIconInHome(GLYPH);
    await project.css(`${ROOT} section > svg { display: block; }`);
  }, error: 'has a type or universal subject' },
  { name: 'a type branch of :is() fails', edit: async project => {
    await project.useIconInHome(GLYPH);
    await project.css(`${ROOT} :is(svg, .home__art) { display: block; }`);
  }, error: 'has a type or universal subject' },
  { name: 'a child combinator from a class of this boundary stays legal', edit: async project => {
    await project.useIconInHome(GLYPH);
    await project.css(`${ROOT} .home__art > svg { display: block; }`);
  } },
  { name: 'a type subject stays legal in a boundary that places no reusable', edit: project => project.css(`${ROOT} span { display: block; }`) },
  { name: 'a type subject stays legal in the sheet of a primitive that places no reusable', edit: project => project.css('[data-blueprint-primitive="icon"] svg { display: block; }', 'prototype/primitives/icon.css') },
  { name: 'a literal stroke fails', edit: project => project.useIconInHome('<svg viewBox="0 0 1 1"><path d="M0 0" stroke="red"></path></svg>'), error: 'has stroke="red" on <path>' },
  { name: 'a literal stop-color fails', edit: project => project.useIconInHome('<svg viewBox="0 0 1 1"><linearGradient id="g"><stop stop-color="rgb(1 2 3)"></stop></linearGradient></svg>'), error: 'has stop-color="rgb(1 2 3)" on <stop>' },
  { name: 'a literal flood-color fails', edit: project => project.useIconInHome('<svg viewBox="0 0 1 1"><filter id="f"><feFlood flood-color="#000"></feFlood></filter></svg>'), error: 'has flood-color="#000" on <feflood>' },
  { name: 'a literal lighting-color fails', edit: project => project.useIconInHome('<svg viewBox="0 0 1 1"><filter id="f"><feDiffuseLighting lighting-color="#fff"></feDiffuseLighting></filter></svg>'), error: 'has lighting-color="#fff" on <fediffuselighting>' },
  { name: 'a literal color attribute fails', edit: project => project.useIconInHome('<svg viewBox="0 0 1 1" color="tomato"></svg>'), error: 'has color="tomato" on <svg>' },
  { name: 'var() of an undeclared property in a paint attribute fails', edit: project => project.useIconInHome('<svg viewBox="0 0 1 1" fill="var(--nope)"></svg>'), error: 'has fill="var(--nope)" on <svg>' },
  { name: 'a literal paint attribute fails in a primitive source too', edit: project => project.write('prototype/primitives/icon.html', svgIcon('<path d="M0 0" fill="#000"></path>')), error: 'has fill="#000" on <path>' },
  { name: 'a gradient reference and the CSS color keywords stay legal in a paint attribute', edit: project => project.useIconInHome('<svg viewBox="0 0 1 1" fill="url(#g)" stroke="transparent" color="inherit"></svg>') },
  { name: 'a color attribute outside an svg is not a paint attribute', edit: project => project.home('<div color="tomato"></div>') },
  { name: 'a <source srcset> fails', edit: project => project.home('<picture><source srcset="x.png"><img src="" alt=""></picture>'), error: 'has srcset="x.png" on <source>' }
];

describe('contract rule forms', () => {
  for (const item of EXTRA_CASES) {
    it(item.name, async () => {
      const errors = await baselineErrors(item.edit);
      if (item.error) {
        assert.ok(errors.some(error => error.includes(item.error as string) && error.includes('Fix: ')), errors.join('\n'));
      } else {
        assert.deepEqual(errors, []);
      }
    });
  }
});

const TOKEN_VALUE_CASES: ReadonlyArray<{ id: string; type: string; bad: string; good: readonly string[] }> = [
  { id: 'background', type: 'color', bad: '12px', good: ['#fff', 'rgb(250 250 250)', 'hsl(0 0% 98%)', 'oklch(98% 0 0)', 'color(srgb 0.98 0.98 0.98)', 'color-mix(in srgb, white 98%, black)'] },
  { id: 'space-1', type: 'space', bad: 'red', good: ['4px', '0', '0.25rem', '50%', 'calc(2px + 2px)'] },
  { id: 'control-sm', type: 'size', bad: 'auto', good: ['32px', '2rem', 'calc(1rem * 2)'] },
  { id: 'radius-sm', type: 'radius', bad: 'round', good: ['4px', '50%', '0'] },
  { id: 'body', type: 'typography', bad: '#123456', good: ['400 14px/1.5 var(--app-font-sans)', '14px', '0.5em', 'ui-sans-serif, sans-serif'] },
  { id: 'press', type: 'motion', bad: '12px', good: ['120ms ease-out', '160ms', 'ease', 'cubic-bezier(0.2, 0, 0, 1)'] }
];

describe('token values parse by type', () => {
  for (const { id, type, bad, good } of TOKEN_VALUE_CASES) {
    it(`${type} refuses "${bad}"`, async () => {
      const errors = await baselineErrors(project => project.token(id, token => {
        token.value = bad;
      }));
      assert.ok(errors.some(error => error.includes(`value "${bad}" is not`) && error.includes(`does not fit type "${type}"`) && error.includes('Fix: ')), errors.join('\n'));
    });

    for (const value of good) {
      it(`${type} accepts "${value}"`, async () => {
        const errors = await baselineErrors(project => project.token(id, token => {
          token.value = value;
        }));
        assert.deepEqual(errors.filter(error => error.includes('does not fit type')), []);
      });
    }
  }

  it('shadow refuses a color alone and accepts a shadow', async () => {
    const edit = (value: string) => (project: Project) => project.json('tokens.json', tokens => {
      tokens.tokenGroups.find((group: { id: string }) => group.id === 'shape').tokens.push({ id: 'lift', name: 'Lift', type: 'shadow', value, description: 'One shadow for the rule test.', styleRef: '--app-shadow-lift' });
    });
    const refused = await baselineErrors(edit('#123456'));
    assert.ok(refused.some(error => error.includes('does not fit type "shadow"')), refused.join('\n'));
    assert.deepEqual((await baselineErrors(edit('0 1px 2px rgb(0 0 0 / 10%), inset 0 0 0 1px var(--app-color-border)'))).filter(error => error.includes('does not fit type')), []);
  });
});

async function readProjectFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(json|html|css|md)$/.test(entry.name)) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    files.set(path.relative(root, absolute).split(path.sep).join('/'), await readFile(absolute, 'utf8'));
  }
  return files;
}

async function migrateAfter(edit: (project: Project) => Promise<void>) {
  return withProjectCopy(async root => {
    await edit(new Project(root));
    const starterFiles = await readProjectFiles(STARTER);
    const files = await readProjectFiles(root);
    const output = migrateProjectFiles({ files, starterFiles });
    const again = migrateProjectFiles({ files: new Map([...files, ...output.writes]), starterFiles });
    return { output, secondRunIsUpToDate: again.upToDate };
  }, STARTER);
}

describe('migrate normalizers for the rules', () => {
  it('fills fonts in brand.json from the font tokens and the @font-face rules, once', async () => {
    const { output, secondRunIsUpToDate } = await migrateAfter(async project => {
      await project.json('brand.json', brand => {
        delete brand.fonts;
      });
      await project.css('@font-face { font-family: "Inter"; src: url("../assets/inter.woff2"); }');
    });
    const brand = JSON.parse(output.writes.get('brand.json') as string);
    assert.deepEqual(brand.fonts, [
      { family: '-apple-system', source: 'system', assets: [] },
      { family: 'SFMono-Regular', source: 'system', assets: [] },
      { family: 'Menlo', source: 'system', assets: [] },
      { family: 'Inter', source: 'asset', assets: ['prototype/assets/inter.woff2'] }
    ]);
    assert.ok(Object.keys(brand).indexOf('fonts') === Object.keys(brand).indexOf('marks') + 1);
    assert.equal(secondRunIsUpToDate, true);
  });

  it('keeps a font entry that migrate cannot derive', async () => {
    const { output } = await migrateAfter(project => project.json('brand.json', brand => {
      brand.fonts = [{ family: 'Georgia', source: 'system', assets: [] }];
    }));
    assert.deepEqual(JSON.parse(output.writes.get('brand.json') as string).fonts[0], { family: 'Georgia', source: 'system', assets: [] });
  });

  it('starts a selector of a screen at its root with :where(), and leaves each legal selector alone', async () => {
    const { output, secondRunIsUpToDate } = await migrateAfter(async project => {
      await project.home('<div class="panel"><kbd>K</kbd></div>', ' class="shell"');
      await project.css([
        '.panel { margin: 0; }',
        '.shell { margin: 0; }',
        '* { box-sizing: border-box; }',
        'kbd { margin: 0; }',
        '.panel kbd, .shell > .panel { margin: 0; }',
        `${ROOT} .kept { margin: 0; }`,
        '.home__part { margin: 0; }',
        'body { margin: 0; }'
      ].join('\n'));
    });
    const css = output.writes.get(HOME_CSS) as string;
    const inside = `:where(${ROOT}) `;
    const either = `:where(${ROOT}, ${ROOT} *)`;
    assert.ok(css.includes(`${inside}.panel { margin: 0; }`), css);
    assert.ok(css.includes(`${either}.shell { margin: 0; }`), css);
    assert.ok(css.includes(`*${either} { box-sizing: border-box; }`), css);
    assert.ok(css.includes(`kbd${either} { margin: 0; }`), css);
    assert.ok(css.includes(`${inside}.panel kbd, ${either}.shell > .panel { margin: 0; }`), css);
    assert.ok(css.includes(`\n${ROOT} .kept { margin: 0; }`), css);
    assert.ok(css.includes('\n.home__part { margin: 0; }'), css);
    assert.ok(css.includes('\nbody { margin: 0; }'), css);
    assert.equal(secondRunIsUpToDate, true);
  });

  it('starts a selector of an active candidate at the root of its screen, and leaves a promoted candidate', async () => {
    await withProjectCopy(async copy => {
      const project = new Project(copy);
      const promoted = 'prototype/screens/home.exploration-home-balance-treatment-ink-panel.css';
      await project.css('.stray { color: inherit }', LEDGER_CANDIDATE_CSS);
      await project.css('.stray { color: inherit }', promoted);
      const output = migrateProjectFiles({ files: await readProjectFiles(copy), starterFiles: await readProjectFiles(STARTER) });
      assert.match(output.writes.get(LEDGER_CANDIDATE_CSS) ?? '', /:where\(\[data-blueprint-screen="transactions"\]\) \.stray \{ color: inherit \}/);
      assert.equal(output.writes.get(promoted), undefined);
    }, MERIDIAN);
  });

  it('leaves a selector of a candidate sheet that replaces a sheet of other screens', async () => {
    await withProjectCopy(async copy => {
      const copyOfSharedSheet = 'prototype/styles/fonts.exploration-ledger-density-comfortable.css';
      await new Project(copy).css('.stray { color: inherit }', copyOfSharedSheet);
      const output = migrateProjectFiles({ files: await readProjectFiles(copy), starterFiles: await readProjectFiles(STARTER) });
      assert.equal(output.writes.get(copyOfSharedSheet), undefined);
    }, MERIDIAN);
  });

  it('leaves a selector of a reusable when another source uses its class', async () => {
    const { output } = await migrateAfter(async project => {
      await project.home('<div class="shared"></div>');
      await project.css('.shared { margin: 0; }', 'prototype/primitives/icon.css');
    });
    assert.equal(output.writes.has('prototype/primitives/icon.css'), false);
  });
});

describe('each shipped project passes each rule', () => {
  for (const root of [STARTER, 'fixtures/valid/meridian-finance/design/blueprint', 'fixtures/valid/mira-ai/design/blueprint', 'fixtures/valid/umbra-gaming/design/blueprint']) {
    it(root, async () => {
      assert.deepEqual(validateProject(await loadProjectFromFs(root)).errors, []);
    });
  }
});
