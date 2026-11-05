import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cssHasImport, isCssLengthLiteral, listCssDeclarations, rewriteCssUrls } from '../src/core/css';

describe('CSS reader', () => {
  it('keeps offsets and the byte order mark when it rewrites a url', () => {
    const css = '﻿.a { background: url(a.png) }';
    assert.equal(rewriteCssUrls(css, value => `url("${value}!")`), '﻿.a { background: url("a.png!") }');
    assert.deepEqual(listCssDeclarations(css).map(declaration => declaration.value), ['url(a.png)']);
  });

  it('reads a url and a color that a character CSS does not treat as whitespace hides from postcss', () => {
    for (const space of ['\u00a0', '\u000b', '\u3000']) {
      for (const quote of ['"', "'"]) {
        const urls: string[] = [];
        rewriteCssUrls(`.bp { URL(${space}${quote}c) ; background-image: url(https://example.com/p1.png); d: ${quote}): x; }`, value => {
          urls.push(value);
          return '';
        });
        assert.ok(urls.includes('https://example.com/p1.png'), JSON.stringify(space + quote));
        const declarations = listCssDeclarations(`.bp { URL(${space}${quote}c) ; color: #123456; d: ${quote}): x; }`);
        assert.ok(declarations.some(declaration => declaration.hasColorLiteral), JSON.stringify(space + quote));
      }
    }
  });

  it('reads each declaration with its property, its important flag, and its literals', () => {
    assert.deepEqual(listCssDeclarations('.a { MARGIN : /* x */ -1.5rem  2px !important ; *zoom: 1; _gap: 3px; --x: #FFF; b: c }'), [
      { property: 'margin', value: '-1.5rem 2px !important', hasColorLiteral: false, namedColors: [], lengths: ['-1.5rem', '2px'], variables: [], important: true, inFontFace: false },
      { property: 'zoom', value: '1', hasColorLiteral: false, namedColors: [], lengths: [], variables: [], important: false, inFontFace: false },
      { property: '_gap', value: '3px', hasColorLiteral: false, namedColors: [], lengths: ['3px'], variables: [], important: false, inFontFace: false },
      { property: '--x', value: '#FFF', hasColorLiteral: true, namedColors: [], lengths: [], variables: [], important: false, inFontFace: false },
      { property: 'b', value: 'c', hasColorLiteral: false, namedColors: [], lengths: [], variables: [], important: false, inFontFace: false }
    ]);
  });

  it('counts a literal in a var() fallback only when a function in the fallback is not a reference', () => {
    const read = (value: string) => {
      const [declaration] = listCssDeclarations(`.a { b: ${value}; }`);
      return [declaration.hasColorLiteral, declaration.lengths];
    };
    assert.deepEqual(read('var(--a, #fff)'), [false, []]);
    assert.deepEqual(read('var(--a, var(--b, 1px))'), [false, []]);
    assert.deepEqual(read('var(--a, url(#fff))'), [false, []]);
    assert.deepEqual(read('var(--a, rgb(0, 0, 0))'), [true, []]);
    assert.deepEqual(read('var(--a, calc(1px + 2px))'), [false, ['1px', '2px']]);
    assert.deepEqual(read('min(2px*var(--a), 3px)'), [false, ['2px', '3px']]);
    assert.deepEqual(read('url(#fff) RGB(0 0 0)'), [true, []]);
    assert.deepEqual(read('"#fff" "rgb(0 0 0)" "1px"'), [false, []]);
  });

  it('skips an empty url, and reads a url in a selector and in an at-rule prelude', () => {
    const seen: string[] = [];
    rewriteCssUrls('.a { b: url(); c: url(""); d: url(e.png); } .f[g=url(h.png)] { i: j } @document url(k.png) { }', value => {
      seen.push(value);
      return value;
    });
    assert.deepEqual(seen, ['e.png', 'h.png', 'k.png']);
  });

  it('does not throw on any shape of CSS that postcss refuses or cannot walk', () => {
    const deep = 'a{'.repeat(50_000) + '}'.repeat(50_000);
    const deepValue = `.a { b: ${'('.repeat(50_000)}${')'.repeat(50_000)}; }`;
    for (const css of ['.a {', '.a }', '"', '/*', 'a b;', '.a { b: c d: e; }', 'url(', '@', deep, deepValue]) {
      assert.doesNotThrow(() => {
        listCssDeclarations(css);
        cssHasImport(css);
        rewriteCssUrls(css, value => value);
      }, css.slice(0, 40));
    }
  });

  it('reads a token length value', () => {
    for (const value of ['4px', '-1.5rem', '.5em']) assert.equal(isCssLengthLiteral(value), true, value);
    for (const value of ['4', '4vw', 'calc(4px)', '4px 2px']) assert.equal(isCssLengthLiteral(value), false, value);
  });
});

describe('image-set strings', () => {
  it('rewrites a string in image-set as a url, and leaves the resolution as written', () => {
    assert.equal(
      rewriteCssUrls('.a { background-image: image-set("a.png" 1x, url(b.png) 2x, -webkit-image-set("c.png" 3x)); }', value => `url("${value}!")`),
      '.a { background-image: image-set(url("a.png!") 1x, url("b.png!") 2x, -webkit-image-set(url("c.png!") 3x)); }'
    );
  });

  it('leaves an empty string in image-set as written', () => {
    assert.equal(rewriteCssUrls('.a { background-image: image-set("" 1x); }', value => `url("${value}!")`), '.a { background-image: image-set("" 1x); }');
  });
});
