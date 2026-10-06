export const NOTCHES = [
  { hz: 125, pct: 0, label: '125' },
  { hz: 250, pct: 15, label: '250' },
  { hz: 500, pct: 30, label: '500' },
  { hz: 750, pct: 45, label: '750' },
  { hz: 1000, pct: 60, label: '1000', badge: 'Default', isRedStart: true },
  { hz: 2000, pct: 74, label: '2000' },
  { hz: 4000, pct: 87, label: '4000' },
  { hz: 5000, pct: 100, label: 'Uncapped', isUncapped: true }
];

export function isRedZone(hz) {
  return hz > 1000;
}

export function hzToPct(hz) {
  if (hz <= 125) return 0;
  if (hz > 4000) return 100;
  for (let i = 0; i < NOTCHES.length - 1; i++) {
    const h1 = NOTCHES[i].hz;
    const h2 = NOTCHES[i + 1].hz;
    const p1 = NOTCHES[i].pct;
    const p2 = NOTCHES[i + 1].pct;
    if (hz >= h1 && hz <= h2) {
      const frac = (hz - h1) / (h2 - h1);
      return p1 + frac * (p2 - p1);
    }
  }
  return 60;
}

export function pctToHz(pct) {
  if (pct <= 0) return 125;
  if (pct >= 95) return 5000;
  
  // Magnetic snapping within 2% of any notch
  for (const notch of NOTCHES) {
    if (Math.abs(pct - notch.pct) <= 2.0) {
      return notch.hz;
    }
  }

  // Small uncapped section after 4000 (pct > 89%)
  if (pct > 89) {
    return 5000;
  }

  for (let i = 0; i < NOTCHES.length - 1; i++) {
    const p1 = NOTCHES[i].pct;
    const p2 = NOTCHES[i + 1].pct;
    const h1 = NOTCHES[i].hz;
    const h2 = NOTCHES[i + 1].hz;
    if (pct >= p1 && pct <= p2) {
      const frac = (pct - p1) / (p2 - p1);
      const raw = h1 + frac * (h2 - h1);
      // Round smoothly
      const step = raw > 1000 ? 50 : 25;
      return Math.round(raw / step) * step;
    }
  }
  return 1000;
}
