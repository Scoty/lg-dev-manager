/**
 * LG model numbers → the series name people know the TV by: OLED55C46LA → "C4", 65QNED85TUA → "QNED85",
 * 55NANO816PA → "NANO81", 43UT80006LA → "UT80". Unknown formats give `undefined`, so the raw model is shown.
 */
const SERIES: [RegExp, (m: RegExpMatchArray) => string][] = [
  // OLED: size, series letter, year digit (6–9 = 2016–19, X = 2020, 1–5 = 2021–25) — OLED65C4, OLED77G4, OLED65CX
  [/^OLED\d{2,3}([A-Z])([0-9X])/, (m) => `${m[1]}${m[2]}`],
  // QNED / NanoCell: QNED85, NANO81
  [/^\d{2,3}(QNED\d{2}|NANO\d{2})/, (m) => m[1]!],
  // UHD and older NanoCell / Super UHD: two-letter year code + series — UT80, UQ75, UN73, SM86, SK85
  [/^\d{2,3}((?:U[A-Z]|S[KM])\d{2})/, (m) => m[1]!],
  // StanbyME: 27ART10…
  [/^\d{2}ART10/, () => 'StanbyME'],
];

export function modelSeries(modelName: string | undefined): string | undefined {
  const model = modelName?.trim().toUpperCase();
  if (!model) return undefined;
  for (const [re, name] of SERIES) {
    const m = model.match(re);
    if (m) return name(m);
  }
  return undefined;
}

/** "LG C4", or the raw model number when the format isn't known. */
export function modelLabel(modelName: string | undefined): string | undefined {
  const series = modelSeries(modelName);
  return series ? `LG ${series}` : modelName?.trim() || undefined;
}

/** "LG C4 · OLED55C46LA" — the series and the exact model. */
export function modelLine(modelName: string | undefined): string | undefined {
  const model = modelName?.trim();
  if (!model) return undefined;
  const series = modelSeries(model);
  return series ? `LG ${series} · ${model}` : model;
}
