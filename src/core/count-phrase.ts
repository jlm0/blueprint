const ENGLISH_PLURALS = new Intl.PluralRules('en-US');

export type Inflection = string | readonly [one: string, other: string];

export function inflect(count: number, word: Inflection): string {
  const [one, other] = typeof word === 'string' ? [word, `${word}s`] : word;
  return ENGLISH_PLURALS.select(count) === 'one' ? one : other;
}

export function countPhrase(count: number, noun: Inflection, verb?: readonly [one: string, other: string]): string {
  return verb === undefined ? `${count} ${inflect(count, noun)}` : `${count} ${inflect(count, noun)} ${inflect(count, verb)}`;
}
