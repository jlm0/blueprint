/**
 * Simplified Technical English checks for the prose agents read on primitives and components.
 *
 * The rules port the structural checks of asd-ste100-skill's ste-lint.py (MIT, see
 * THIRD_PARTY_NOTICES.md). Errors break a rule that has one fix. Advisories are heuristics
 * that need a judgment call, so they never fail validation. Hedges such as "may" or "could"
 * are never flagged: they carry the author's confidence.
 */

export type ProseErrorRule =
  | 'semicolon'
  | 'phrasal-verb'
  | 'marketing-adjective'
  | 'nominalization'
  | 'long-sentence'
  | 'dangling-conjunction'
  | 'line-break'
  | 'sentence-form';

export type ProseAdvisoryRule = 'passive-voice' | 'present-perfect' | 'synonym-rotation';

export type ProseRule = ProseErrorRule | ProseAdvisoryRule;

export interface ProseIssue {
  rule: ProseRule;
  level: 'error' | 'advisory';
  match: string;
  message: string;
}

export const MAX_SENTENCE_WORDS = 25;

const IRREGULAR_PARTICIPLES = 'given|taken|made|done|found|seen|known|shown|written|built|sent|set|run|read|kept|held|left|put|cut|hit|let|shut|split|spread|begun|become|come|gone|got|gotten|lost|met|paid|said|sold|told|thought|brought|bought|caught|taught|won|worn|torn|born|drawn|grown|thrown|flown|driven|risen|chosen|broken|spoken|frozen|hidden|ridden|forgotten|fallen|eaten|beaten|understood|stood|struck|stuck|swung|hung|led|fed|bled|fled|sped|bound|wound|dug|spun|slid|bit|lit|quit';
const PASSIVE_PARTICIPLES = 'given|taken|made|done|found|seen|known|shown|written|built|sent|set|run|read|kept|held|left|put';
const MODAL_PERFECT_PREFIX = /\b(?:may|might|could|should|would|must|can|will|shall)(?:\s+not|n['’]t)?\s+$/i;

const PATTERN_RULES: ReadonlyArray<{ rule: ProseRule; pattern: RegExp; message: (match: string) => string }> = [
  {
    rule: 'semicolon',
    pattern: /;/g,
    message: () => 'has a semicolon. Fix: split it into two sentences.'
  },
  {
    rule: 'phrasal-verb',
    pattern: /\b(spin(?:ning|s)? up|spun up|reach(?:ing|es|ed)? out|div(?:e|es|ing|ed) into|dove into|kick(?:ing|s|ed)? off|circl(?:e|es|ing|ed) back|touch(?:ing|es|ed)? base)\b/gi,
    message: match => `uses the phrasal verb "${match}". Fix: use one plain verb, such as start, contact, read, or begin.`
  },
  {
    rule: 'marketing-adjective',
    pattern: /\b(seamless(?:ly)?|robust(?:ly)?|cutting-edge|effortless(?:ly)?|blazing[- ]fast|world-class|state-of-the-art|game-chang(?:ing|er))\b/gi,
    message: match => `uses the marketing word "${match}". Fix: delete it, or state the fact that earns it.`
  },
  {
    rule: 'nominalization',
    pattern: /\b(perform|performs|performed|conduct|conducts|conducted|carry out|carries out|carried out)\s+(?:a|an|the)\s+\w+(?:tion|sion|ment|ance|ence|ysis)\b/gi,
    message: match => `freezes an action into a noun: "${match}". Fix: use the verb, such as "analyze" for "perform an analysis".`
  },
  {
    rule: 'passive-voice',
    pattern: new RegExp(`\\b(is|are|was|were|been|being)\\s+(\\w+ed|${PASSIVE_PARTICIPLES})\\b(?!\\s+(?:to|for|by)\\s+\\w+ing)`, 'gi'),
    message: match => `may be passive: "${match}". Name who acts, unless the actor is unknown or does not matter.`
  },
  {
    rule: 'present-perfect',
    pattern: new RegExp(`\\b(has|have|had)\\s+(?:been\\s+)?(?:\\w+(?:ed|en)|${IRREGULAR_PARTICIPLES})\\b`, 'gi'),
    message: match => `uses a compound tense: "${match}". Use the simple present or past, unless the current result is the point.`
  }
];

const SYNONYM_GROUPS: ReadonlyArray<readonly string[]> = [
  ['check', 'verify', 'confirm', 'validate'],
  ['delete', 'remove', 'erase'],
  ['start', 'launch', 'begin', 'initiate'],
  ['stop', 'halt', 'terminate'],
  ['show', 'display'],
  ['use', 'utilize', 'employ'],
  ['fix', 'repair', 'correct'],
  ['send', 'transmit'],
  ['get', 'retrieve', 'fetch', 'obtain'],
  ['change', 'modify', 'alter']
];

const INLINE_CODE = /`[^`]*`/g;
const SENTENCE_END = /[.!?]["'”’)\]*_]*$/;
const OPENERS = /^["'“‘([*_]+/;
const ABBREVIATIONS = new Set(['vs.', 'cf.', 'approx.', 'mr.', 'mrs.', 'ms.', 'dr.', 'fig.', 'no.']);
const DOTTED_ABBREVIATION = /^(?:[a-z]\.){2,}$/i;

/** Checks one prose field; synonym rotation spans several fields, so it is checked by lintProseSet. */
export function lintProse(text: string): ProseIssue[] {
  const issues: ProseIssue[] = [];
  if (/[\r\n]/.test(text)) {
    issues.push(error('line-break', '', 'spans more than one line. Fix: write it as one line of sentences.'));
  }
  const trimmed = text.trim();
  if (trimmed && (!/^[A-Z0-9`"“]/.test(trimmed) || !/[.!?]["'”’)\]]*$/.test(trimmed))) {
    issues.push(error('sentence-form', trimmed.slice(0, 40), 'is not written as sentences. Fix: start with a capital letter and end with a period.'));
  }
  const prose = maskInlineCode(text);
  for (const { rule, pattern, message } of PATTERN_RULES) {
    for (const match of prose.matchAll(pattern)) {
      if (rule === 'present-perfect' && MODAL_PERFECT_PREFIX.test(prose.slice(0, match.index))) continue;
      issues.push({ rule, level: isAdvisory(rule) ? 'advisory' : 'error', match: match[0], message: message(match[0]) });
    }
  }
  for (const sentence of sentences(prose)) {
    const words = sentence.split(/\s+/).filter(Boolean).length;
    if (words > MAX_SENTENCE_WORDS) {
      issues.push(error('long-sentence', `${words} words`, `has a sentence of ${words} words, over the ${MAX_SENTENCE_WORDS}-word limit. Fix: split it.`));
    }
  }
  const conjunction = /\b(and|or)\s*$/i.exec(text.replace(INLINE_CODE, ' CODE ').trim());
  if (conjunction) {
    issues.push(error('dangling-conjunction', conjunction[1], `ends with "${conjunction[1]}". Fix: finish the sentence.`));
  }
  return issues;
}

/** Synonym rotation across the prose of one reusable: each later word of a group is flagged against the first. */
export function lintSynonymRotation(texts: readonly string[]): Array<ProseIssue & { textIndex: number }> {
  const issues: Array<ProseIssue & { textIndex: number }> = [];
  for (const group of SYNONYM_GROUPS) {
    const present: Array<{ word: string; textIndex: number; offset: number; match: string }> = [];
    for (const word of group) {
      const pattern = new RegExp(`\\b${word}(?:s|es|ed|d|ing)?\\b`, 'i');
      for (const [textIndex, text] of texts.entries()) {
        const match = pattern.exec(maskInlineCode(text));
        if (match) {
          present.push({ word, textIndex, offset: match.index, match: match[0] });
          break;
        }
      }
    }
    if (present.length < 2) continue;
    present.sort((left, right) => left.textIndex - right.textIndex || left.offset - right.offset);
    const [first, ...rest] = present;
    for (const later of rest) {
      issues.push({
        rule: 'synonym-rotation',
        level: 'advisory',
        match: later.match,
        message: `uses "${later.word}" where other text on this reusable uses "${first.word}" for what may be the same action. Pick one word and use it every time.`,
        textIndex: later.textIndex
      });
    }
  }
  return issues;
}

function error(rule: ProseErrorRule, match: string, message: string): ProseIssue {
  return { rule, level: 'error', match, message };
}

function isAdvisory(rule: ProseRule): rule is ProseAdvisoryRule {
  return rule === 'passive-voice' || rule === 'present-perfect' || rule === 'synonym-rotation';
}

function maskInlineCode(text: string): string {
  return text.replace(INLINE_CODE, code => ' '.repeat(code.length));
}

function sentences(text: string): string[] {
  const words = [...text.matchAll(/\S+/g)];
  if (words.length === 0) return [];
  const starts = [words[0].index];
  for (let index = 0; index < words.length - 1; index += 1) {
    const word = words[index][0];
    const end = SENTENCE_END.exec(word);
    if (!end) continue;
    const core = word.slice(0, end.index + 1).replace(OPENERS, '');
    if (ABBREVIATIONS.has(core.toLowerCase())) continue;
    if (DOTTED_ABBREVIATION.test(core) && !/^[A-Z]/.test(words[index + 1][0].replace(OPENERS, ''))) continue;
    starts.push(words[index + 1].index);
  }
  return starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length));
}
