import { converter, parse } from 'culori';

const toRgb = converter('rgb');

/** @returns The sRGB channels from 0 to 255 of a CSS color with no transparency, because contrast has no answer for a translucent color. */
export function parseOpaqueColor(value: string): [number, number, number] | undefined {
  const parsed = parse(value.trim());
  if (!parsed || (parsed.alpha ?? 1) !== 1) return undefined;
  const { r, g, b } = toRgb(parsed);
  return [channel(r), channel(g), channel(b)];
}

function channel(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

export function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
