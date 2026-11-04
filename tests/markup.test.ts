import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  appendSlot,
  collectInvocationSlots,
  escapeRegExp,
  findElementEnd,
  findFirstUseElement,
  findSectionMarkers,
  findTagEnd,
  listUsePlacements,
  parseUseAttributes,
  sourceSlotContents,
  slotContentAccepts,
  stripSlotAttribute
} from '../src/core/markup';

describe('listUsePlacements', () => {
  it('lists outer placements before the ones nested in their slots', () => {
    const markup = [
      '<div>',
      '<blueprint-use kind="component" ref="card" variant="flat">',
      '<span slot="title">Hi</span>',
      '<blueprint-use kind="primitive" ref="text" size="label"></blueprint-use>',
      '</blueprint-use>',
      '<blueprint-use kind="primitive" ref="badge"/>',
      '</div>'
    ].join('');

    const placements = listUsePlacements(markup);

    assert.deepEqual(placements.map(placement => `${placement.kind}:${placement.ref}`), ['component:card', 'primitive:text', 'primitive:badge']);
    assert.equal(placements[0].attributes.get('variant'), 'flat');
    assert.equal(placements[1].attributes.get('size'), 'label');
    assert.equal(placements[0].slots.get('title'), '<span>Hi</span>');
    assert.equal(placements[0].slots.get('default'), '<blueprint-use kind="primitive" ref="text" size="label"></blueprint-use>');
    assert.equal(placements[2].slots.size, 0);
  });

  it('gives a slot inside a nested use to that use', () => {
    const [outer, inner] = listUsePlacements(
      '<blueprint-use kind="component" ref="outer"><blueprint-use kind="component" ref="inner"><span slot="label">Text</span></blueprint-use></blueprint-use>'
    );

    assert.equal(outer.slots.has('label'), false);
    assert.equal(inner.slots.get('label'), '<span>Text</span>');
  });

  it('handles markup without a use, a use without a kind or ref, and a malformed use', () => {
    assert.deepEqual(listUsePlacements('<div>No uses</div>'), []);
    const [placement] = listUsePlacements('<blueprint-use variant="flat"></blueprint-use>');
    assert.equal(placement.kind, '');
    assert.equal(placement.ref, '');
    assert.throws(() => listUsePlacements('<blueprint-use kind="a">'), /unclosed <blueprint-use> element/);
    assert.throws(() => listUsePlacements('<blueprint-use kind=a></blueprint-use>'), /^Error: markup contains a malformed or unquoted <blueprint-use> attribute\.$/);
  });
});

describe('sourceSlotContents', () => {
  it('reads the inner markup of each data-blueprint-slot element', () => {
    const slots = sourceSlotContents([
      '<div>',
      '<p data-blueprint-slot="title">Hello <b>there</b></p>',
      '<div class="a" data-blueprint-slot=\'body\'><div>inner</div>tail</div>',
      '<img data-blueprint-slot="picture" src="a.png">',
      '<span data-blueprint-slot="empty"/>',
      '<i data-blueprint-slot="twice">1</i><i data-blueprint-slot="twice">2</i>',
      '</div>'
    ].join(''));

    assert.deepEqual(Object.fromEntries(slots), {
      title: 'Hello <b>there</b>',
      body: '<div>inner</div>tail',
      picture: '',
      empty: '',
      twice: '12'
    });
  });

  it('reads a bare slot as default and a named slot by its name, and finds nothing without a slot', () => {
    const slots = sourceSlotContents('<div><slot>Fallback</slot><slot name="icon"><svg></svg></slot></div><slot name=\'close\'/>');

    assert.deepEqual(Object.fromEntries(slots), { default: 'Fallback', icon: '<svg></svg>', close: '' });
    assert.equal(sourceSlotContents('<div class="slot">slot</div>').size, 0);
  });
});

describe('slotContentAccepts', () => {
  it('classifies text, graphics, and empty content', () => {
    assert.deepEqual(slotContentAccepts('Hello'), ['text']);
    assert.deepEqual(slotContentAccepts('<span>Hello</span>'), ['text']);
    assert.deepEqual(slotContentAccepts('<svg><text>Inside a graphic</text></svg>'), ['graphic']);
    assert.deepEqual(slotContentAccepts('<img src="a.png">'), ['graphic']);
    assert.deepEqual(slotContentAccepts('<picture><source srcset="a.png"></picture>'), ['graphic']);
    assert.deepEqual(slotContentAccepts('<span></span> &nbsp; '), []);
    assert.deepEqual(slotContentAccepts(''), []);
  });

  it('names each placed reusable, ignores the text inside its slots, and throws on a malformed use', () => {
    assert.deepEqual(slotContentAccepts('<blueprint-use kind="primitive" ref="text"><span slot="text">Copy</span></blueprint-use>'), ['primitive:text']);
    assert.deepEqual(slotContentAccepts('<blueprint-use kind="brand-mark" ref="logo"/>'), ['brand-mark']);
    assert.deepEqual(
      slotContentAccepts('Go <svg></svg><blueprint-use kind="primitive" ref="text"></blueprint-use><blueprint-use kind="component" ref="chip"></blueprint-use><blueprint-use kind="component" ref="chip"></blueprint-use>'),
      ['component:chip', 'graphic', 'primitive:text', 'text']
    );
    assert.throws(() => slotContentAccepts('<blueprint-use kind=a></blueprint-use>'), /^Error: slot content contains a malformed or unquoted <blueprint-use> attribute\.$/);
  });
});

describe('findSectionMarkers', () => {
  it('lists marked section ids in order, including one forwarded through a use, and ignores other attributes', () => {
    const source = '<main><section data-blueprint-section="hero"></section><blueprint-use kind="component" ref="x" data-blueprint-section=\'list\'></blueprint-use></main>';

    assert.deepEqual(findSectionMarkers(source), ['hero', 'list']);
    assert.deepEqual(findSectionMarkers(source), ['hero', 'list']);
    assert.deepEqual(findSectionMarkers('<div data-blueprint-section-boundary-id="hero"></div>'), []);
    assert.deepEqual(findSectionMarkers('<div>data-blueprint-section="hero"</div>'), []);
  });
});

describe('parseUseAttributes', () => {
  it('reads quoted attributes with lowercase names, and throws on an unquoted, bare, trailing, or duplicate attribute', () => {
    const attributes = parseUseAttributes(' kind="primitive" REF=\'Text\' class = "a b" ', 'test');

    assert.deepEqual(Object.fromEntries(attributes), { kind: 'primitive', ref: 'Text', class: 'a b' });
    assert.equal(parseUseAttributes('', 'test').size, 0);

    const malformed = /^Error: demo\/screen contains a malformed or unquoted <blueprint-use> attribute\.$/;
    assert.throws(() => parseUseAttributes('kind=primitive', 'demo/screen'), malformed);
    assert.throws(() => parseUseAttributes('hidden kind="a"', 'demo/screen'), malformed);
    assert.throws(() => parseUseAttributes('kind="a" trailing', 'demo/screen'), malformed);
    assert.throws(
      () => parseUseAttributes('kind="a" KIND="b"', 'demo/screen'),
      /^Error: demo\/screen contains duplicate <blueprint-use> attribute "kind"\.$/
    );
  });
});

describe('findFirstUseElement', () => {
  it('finds a self-closing use with its offsets, and nothing without a use', () => {
    const html = '<p></p><blueprint-use kind="a"/>after';

    assert.deepEqual(findFirstUseElement(html), { start: 7, end: 32, attributes: ' kind="a"', children: '' });
    assert.equal(findFirstUseElement('<div><blueprint-used></blueprint-used></div>'), undefined);
  });

  it('finds the matching close across nesting and quoted brackets, and throws when it never closes', () => {
    const inner = '<blueprint-use kind="b"><blueprint-use kind="c"/></blueprint-use>';
    const first = `<blueprint-use kind="a">${inner}</blueprint-use>`;
    const use = findFirstUseElement(`${first}<blueprint-use kind="d"></blueprint-use>`);

    assert.ok(use);
    assert.equal(use.start, 0);
    assert.equal(use.end, first.length);
    assert.equal(use.attributes, ' kind="a"');
    assert.equal(use.children, inner);

    const quoted = findFirstUseElement('<blueprint-use title="a > b" kind="x">Body</blueprint-use>');
    assert.ok(quoted);
    assert.equal(quoted.attributes, ' title="a > b" kind="x"');
    assert.equal(quoted.children, 'Body');

    assert.throws(() => findFirstUseElement('<blueprint-use kind="a"><p></p>'), /^Error: Prototype source contains an unclosed <blueprint-use> element\.$/);
    assert.throws(() => findFirstUseElement('<blueprint-use kind="a"'), /^Error: Prototype source contains an unclosed HTML tag\.$/);
  });
});

describe('markup helpers', () => {
  it('collects named slots with the remainder in default, joins repeats, and strips the slot attribute once', () => {
    const slots = collectInvocationSlots('<span slot="a">1</span> loose <span slot="a">2</span><img slot="picture" src="x.png">');

    assert.deepEqual(Object.fromEntries(slots), {
      a: '<span>1</span><span>2</span>',
      picture: '<img src="x.png">',
      default: 'loose'
    });
    assert.equal(collectInvocationSlots('  \n ').size, 0);

    const slotsToJoin = new Map([['a', '1']]);
    appendSlot(slotsToJoin, 'a', '2');
    appendSlot(slotsToJoin, 'b', '3');
    assert.deepEqual(Object.fromEntries(slotsToJoin), { a: '12', b: '3' });

    assert.equal(stripSlotAttribute('<span class="a" slot="x"><b slot="y"></b></span>'), '<span class="a"><b slot="y"></b></span>');
  });

  it('finds element and tag ends across nesting and quotes, and escapes regular expression text', () => {
    const nested = '<div><div>a</div></div>tail';
    assert.equal(findElementEnd(nested, 'div', 0, 4), nested.length - 'tail'.length);
    assert.equal(findElementEnd('<br></br>', 'br', 0, 3), 4);
    assert.equal(findElementEnd('<span/></span>', 'span', 0, 6), 7);
    assert.equal(findElementEnd('<div>open', 'div', 0, 4), 5);

    assert.equal(findTagEnd('<a title="x>y" b=\'>\'>tail', 0), 20);
    assert.throws(() => findTagEnd('<a title="x>y"', 0), /^Error: Prototype source contains an unclosed HTML tag\.$/);

    const pattern = new RegExp(`^${escapeRegExp('a.b*c[d]')}$`);
    assert.equal(pattern.test('a.b*c[d]'), true);
    assert.equal(pattern.test('axb*c[d]'), false);
  });
});
