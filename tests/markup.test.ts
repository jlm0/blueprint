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
  listPossibleOpenTags,
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
    assert.throws(() => listUsePlacements('<blueprint-use kind=a></blueprint-use>'), /^Error: markup contains a malformed or unquoted <blueprint-use> attribute\. Fix: write each attribute of this <blueprint-use> as name="value"\.$/);
  });
});

describe('markup that a regex misread', () => {
  it('does not count a commented-out use as a placement', () => {
    const commented = '<!-- <blueprint-use kind="component" ref="ghost"></blueprint-use> --><p></p>';

    assert.deepEqual(listUsePlacements(commented), []);
    assert.equal(findFirstUseElement(commented), undefined);
    assert.deepEqual(listUsePlacements(`${commented}<blueprint-use kind="primitive" ref="real"/>`).map(placement => placement.ref), ['real']);
  });

  it('does not count a commented-out slot as a slot', () => {
    assert.equal(sourceSlotContents('<!-- <slot name="ghost"></slot> --><!-- <slot></slot> --><!-- <i data-blueprint-slot="gone">x</i> -->').size, 0);
  });

  it('keeps a closing tag inside an attribute value in slot content', () => {
    const content = '<span title="</div>">x</span>';

    assert.deepEqual(Object.fromEntries(sourceSlotContents(`<div data-blueprint-slot="a">${content}</div>`)), { a: content });
    assert.deepEqual(Object.fromEntries(sourceSlotContents(`<slot name="a"><a title="</slot>">x</a></slot>`)), { a: '<a title="</slot>">x</a>' });
    assert.deepEqual(Object.fromEntries(collectInvocationSlots(`<div slot="a">${content}</div>`)), { a: `<div>${content}</div>` });
  });

  it('does not count a commented-out image as a graphic', () => {
    assert.deepEqual(slotContentAccepts('<!-- <img src="a.png"> -->'), []);
    assert.deepEqual(slotContentAccepts('<!-- <svg></svg> --><!-- a > b -->'), []);
    assert.deepEqual(slotContentAccepts('<!-- <blueprint-use kind="primitive" ref="text"></blueprint-use> -->'), []);
  });

  it('keeps the next slot after a self-closing slot', () => {
    assert.deepEqual(Object.fromEntries(sourceSlotContents('<slot name="a"/><slot name="b">B</slot>')), { a: '', b: 'B' });
    assert.deepEqual(Object.fromEntries(sourceSlotContents('<slot/><slot name="b">B</slot>')), { default: '', b: 'B' });
  });

  it('reads a self-closing use with a space after its slash', () => {
    const [placement] = listUsePlacements('<blueprint-use kind="a"/ >');

    assert.equal(placement.kind, 'a');
    assert.deepEqual(findFirstUseElement('<blueprint-use kind="a"/ >tail'), { start: 0, end: 26, attributes: ' kind="a"', children: '' });
    assert.deepEqual(Object.fromEntries(parseUseAttributes(findFirstUseElement('<blueprint-use kind="a"/ >')!.attributes, 'test')), { kind: 'a' });
  });

  it('reads the real attribute, not a longer name or text inside a value', () => {
    assert.deepEqual(Object.fromEntries(sourceSlotContents('<slot data-name="x" title="name=\'y\'">z</slot>')), { default: 'z' });
    assert.deepEqual(findSectionMarkers('<div x-data-blueprint-section="a" title=" data-blueprint-section=\'b\'"></div><!-- <p data-blueprint-section="c"> -->'), []);
    assert.deepEqual(findSectionMarkers('<div title="a>b" data-blueprint-section="real"></div>'), ['real']);
  });

  it('reads an element name exactly', () => {
    assert.equal(sourceSlotContents('<slotted>x</slotted>').size, 0);
    assert.deepEqual(slotContentAccepts('<imgx></imgx>'), []);
  });

  it('treats the inside of a raw text element as text, and keeps it as such inside svg only where a browser does', () => {
    assert.equal(listUsePlacements('<textarea><blueprint-use kind="a"></textarea>').length, 0);
    assert.equal(sourceSlotContents('<style>/* <slot> */</style>').size, 0);
    assert.deepEqual(Object.fromEntries(sourceSlotContents('<svg><title><slot name="a">x</slot></title></svg>')), { a: 'x' });
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
    assert.throws(() => slotContentAccepts('<blueprint-use kind=a></blueprint-use>'), /^Error: slot content contains a malformed or unquoted <blueprint-use> attribute\. Fix: write each attribute of this <blueprint-use> as name="value"\.$/);
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

    const malformed = /^Error: demo\/screen contains a malformed or unquoted <blueprint-use> attribute\. Fix: write each attribute of this <blueprint-use> as name="value"\.$/;
    assert.throws(() => parseUseAttributes('kind=primitive', 'demo/screen'), malformed);
    assert.throws(() => parseUseAttributes('hidden kind="a"', 'demo/screen'), malformed);
    assert.throws(() => parseUseAttributes('kind="a" trailing', 'demo/screen'), malformed);
    assert.throws(
      () => parseUseAttributes('kind="a" KIND="b"', 'demo/screen'),
      /^Error: demo\/screen contains duplicate <blueprint-use> attribute "kind"\. Fix: keep one "kind" attribute on this <blueprint-use>\.$/
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

    assert.throws(() => findFirstUseElement('<blueprint-use kind="a"><p></p>'), /^Error: Prototype source contains an unclosed <blueprint-use> element\. Fix: add the matching <\/blueprint-use> tag\.$/);
    assert.throws(() => findFirstUseElement('<blueprint-use kind="a"'), /^Error: Prototype source contains an unclosed HTML tag\. Fix: close the cut-off tag with ">", or remove it\.$/);
  });
});

describe('listPossibleOpenTags', () => {
  const names = (markup: string): string[] => [...new Set(listPossibleOpenTags(markup).map(tag => tag.name))].sort();

  it('reads tags a browser could see where this tokenizer sees a comment, raw text, or an attribute value', () => {
    assert.ok(names('<!-- <script></script> -->').includes('script'));
    assert.ok(names('<style>a{}</style><title><iframe></title>').includes('iframe'));
    assert.ok(names('</div a="><!-- "><script></script><!-- -->').includes('script'));
    assert.ok(names('</div a="><style>"><script></script></style>').includes('script'));
    assert.ok(names('</div a="><p b=\'"><script></script>\'>').includes('script'));
    assert.ok(names('<noscript><p title="</noscript><script></script>"></noscript>').includes('script'));
    assert.ok(names('<![CDATA[ > <script></script> ]]>').includes('script'));
    assert.ok(names('<svg><p><style><!-- </style><script></script> --></style>').includes('script'));
    assert.ok(names('<svg><style><script></script></style></svg>').includes('script'));
  });

  it('reads a tag at each less-than sign, because a quote or a span can hide that tag', () => {
    assert.ok(names(`</x a="><p a='">'<script>alert(1)</script>`).includes('script'));
    assert.ok(names(`<![CDATA[<p a='>'<object></object>`).includes('object'));
    const handler = listPossibleOpenTags('<![CDATA[><img x="]]><b title=" onerror=alert(1) y="z">').find(tag => tag.name === 'img');
    assert.deepEqual(handler?.attributes.map(attribute => attribute.name), ['x', 'onerror', 'y']);
  });

  it('reads a tag at the end of raw text that stays open', () => {
    assert.ok(names('<title><script src="a.js">').includes('script'));
    const image = listPossibleOpenTags('<title> x <img src="a.png">').find(tag => tag.name === 'img');
    assert.deepEqual(image?.attributes.map(attribute => [attribute.name, attribute.value]), [['src', 'a.png']]);
  });

  it('reports offsets in the whole text for a tag that the tokenizer does not read as a tag', () => {
    const markup = '<p></p><!-- <img src="a.png"> -->';
    const image = listPossibleOpenTags(markup).find(tag => tag.name === 'img');
    assert.ok(image);
    assert.equal(markup.slice(image.start, image.end), '<img src="a.png">');
    const source = image.attributes[0];
    assert.equal(markup.slice(source.nameStart, source.nameEnd), 'src');
    assert.equal(markup.slice(source.valueStart, source.valueEnd), 'a.png');
  });

  it('refuses text with too many unclosed tags and names the fix', () => {
    assert.throws(() => listPossibleOpenTags(`${'<a '.repeat(200_000)}>`), /too many unclosed tags.*Fix: close each tag/s);
    assert.doesNotThrow(() => listPossibleOpenTags(`<!-- ${'<a> '.repeat(50_000)} -->`));
  });

  it('reads a tag that the end of the text cuts off', () => {
    assert.ok(names('<p></p><script').includes('script'));
    assert.ok(names('<p></p><script src="a.js"').includes('script'));
    assert.deepEqual(listPossibleOpenTags('<div onclick="a').map(tag => tag.attributes.map(attribute => attribute.name)), [['onclick']]);
  });

  it('stops on text that only holds a less-than sign', () => {
    assert.deepEqual(names('a < b and c <= d <'), []);
    assert.deepEqual(names('<style><</style>'), ['style']);
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
    assert.throws(() => findTagEnd('<a title="x>y"', 0), /^Error: Prototype source contains an unclosed HTML tag\. Fix: close the cut-off tag with ">", or remove it\.$/);

    const pattern = new RegExp(`^${escapeRegExp('a.b*c[d]')}$`);
    assert.equal(pattern.test('a.b*c[d]'), true);
    assert.equal(pattern.test('axb*c[d]'), false);
  });
});
