import type { Element } from '../data/types';
import { ELEMENT_NAMES_RU } from './elementNames';
import { en } from './en';
import { ru, type MessageKey } from './ru';

export type Lang = 'ru' | 'en';
export type { MessageKey };

const DICTS: Record<Lang, Record<MessageKey, string>> = { ru, en };

export function translate(lang: Lang, key: MessageKey, params?: Record<string, string | number>): string {
  let s = DICTS[lang][key];
  if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
  return s;
}

export function hasKey(key: string): key is MessageKey {
  return key in ru;
}

export function elementName(lang: Lang, el: Element): string {
  return lang === 'ru' ? ELEMENT_NAMES_RU[el.z - 1] : el.name;
}

const YEAR_S = 365.2422 * 86400;

export function formatDuration(lang: Lang, seconds: number): string {
  const steps: [number, MessageKey][] = [
    [YEAR_S, 'unit.y'], [86400, 'unit.d'], [3600, 'unit.h'], [60, 'unit.min'],
    [1, 'unit.s'], [1e-3, 'unit.ms'], [1e-6, 'unit.us'], [1e-9, 'unit.ns'],
  ];
  const [div, key] = steps.find(([d]) => seconds >= d) ?? steps[steps.length - 1];
  return `${formatNumber(lang, seconds / div)} ${translate(lang, key)}`;
}

/** 3 significant digits; scientific notation (with ·10ⁿ) outside 1e-3..1e6. */
export function formatNumber(lang: Lang, v: number, digits = 3): string {
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e6 || abs < 1e-3)) {
    const exp = Math.floor(Math.log10(abs));
    const mant = v / 10 ** exp;
    return `${trim(mant.toPrecision(digits), lang)}·10${superscript(exp)}`;
  }
  return trim(Number(v.toPrecision(digits)).toString(), lang);
}

function trim(s: string, lang: Lang): string {
  if (s.includes('.') && !s.includes('e')) s = s.replace(/\.?0+$/, '');
  return lang === 'ru' ? s.replace('.', ',') : s;
}

const SUP: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
function superscript(n: number): string {
  return String(n).split('').map((c) => SUP[c]).join('');
}

/** NUBASE decay code → physics notation: "B-n" → "β⁻n", "A" → "α". */
export function prettyDecay(mode: string): string {
  return mode
    .replace(/B-/g, 'β⁻')
    .replace(/B\+/g, 'β⁺')
    .replace(/e\+/g, 'e⁺')
    .replace(/(^|[^A-Za-z])A(?![a-z])/g, '$1α');
}
