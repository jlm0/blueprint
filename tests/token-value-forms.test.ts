import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isCssColorTokenValue, isCssLengthValue, isCssSizeValue } from '../src/core/css';

const LEGAL_SIZES = [
  '44px',
  '0',
  '100%',
  '1.8',
  '1fr',
  'auto 1fr',
  'calc(100% - 8px)',
  'clamp(1rem, 2vw, 2rem)',
  'min(100%, 40rem)',
  '112px minmax(0, 1fr)',
  'repeat(3, max-content)',
  'minmax(0, 1280px)',
  'repeat(auto-fill, minmax(168px, 1fr))',
  'fit-content(40rem) 1fr',
  '[full-start] 1fr [full-end]'
];
const ILLEGAL_SIZES = ['auto', 'wide', '#fff', '12px wide', 'minmax(0)', 'repeat(3)', 'repeat(three, 1fr)', 'url(a.png)', '1.8 wide'];
const LEGAL_COLORS = [
  '#fff',
  'rgba(0, 0, 0, 0.5)',
  'linear-gradient(90deg, #000, #fff)',
  'radial-gradient(circle, #000, transparent)',
  'conic-gradient(#000, #fff)',
  'repeating-linear-gradient(45deg, #000 0 2px, #fff 2px 4px)'
];
const ILLEGAL_COLORS = ['wide', '12px', 'url(a.png)', 'linear-gradient()', 'linear-gradient(#000)', 'wavy-gradient(#000, #fff)', '#000 linear-gradient(#000, #fff)'];

describe('token value forms', () => {
  for (const value of LEGAL_SIZES) it(`a size token holds ${value}`, () => assert.equal(isCssSizeValue(value), true));
  for (const value of ILLEGAL_SIZES) it(`a size token refuses ${value}`, () => assert.equal(isCssSizeValue(value), false));
  for (const value of LEGAL_COLORS) it(`a color token holds ${value}`, () => assert.equal(isCssColorTokenValue(value), true));
  for (const value of ILLEGAL_COLORS) it(`a color token refuses ${value}`, () => assert.equal(isCssColorTokenValue(value), false));

  it('a space or radius token holds one length and refuses a track list or a plain number', () => {
    assert.equal(isCssLengthValue('clamp(1rem, 2vw, 2rem)'), true);
    assert.equal(isCssLengthValue('1fr 1fr'), false);
    assert.equal(isCssLengthValue('1.8'), false);
  });
});
