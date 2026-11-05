import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { INHERITED_TEXT_PROPERTIES } from '../src/app/element-diff';

const properties = createRequire(import.meta.url)('mdn-data/css/properties.json') as Record<string, { inherited?: boolean }>;

describe('the inherited text properties of the element diff', () => {
  it('names only properties that inherit, because the diff ignores a named property on an element with no text', () => {
    const notInherited = INHERITED_TEXT_PROPERTIES.filter(property => properties[property]?.inherited === false);
    assert.deepEqual(notInherited, []);
  });

  it('reads MDN data for most names, so the check above can fail', () => {
    const known = INHERITED_TEXT_PROPERTIES.filter(property => properties[property]?.inherited === true);
    assert.ok(known.length > 30, `MDN data holds only ${known.length} names.`);
  });
});
