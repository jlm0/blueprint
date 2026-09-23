export function parseOpaqueColor(value: string): [number, number, number] | undefined {
  const color = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(color)?.[1];
  if (hex) {
    const digits = hex.length <= 4 ? [...hex].map(digit => digit + digit) : hex.match(/../g) ?? [];
    const [r, g, b, a] = digits.map(pair => Number.parseInt(pair, 16));
    return a === undefined || a === 255 ? [r, g, b] : undefined;
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(color);
  if (!rgb) return undefined;
  const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? Number.parseFloat(rgb[4]) / 100 : Number.parseFloat(rgb[4]);
  return alpha === 1 ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : undefined;
}

export function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
