export function computeSplineCoefficients(points) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const n = points.length - 1;
  const x = points.map(p => p.x);
  const y = points.map(p => p.y);

  const h = new Array(n);
  const delta = new Array(n);
  for (let i = 0; i < n; i++) {
    h[i] = x[i + 1] - x[i];
    delta[i] = h[i] > 0.00001 ? (y[i + 1] - y[i]) / h[i] : 0;
  }

  // Initial tangents: average of adjacent secants
  const d = new Array(n + 1).fill(0);
  d[0] = delta[0];
  d[n] = delta[n - 1];
  for (let i = 1; i < n; i++) {
    d[i] = (delta[i - 1] + delta[i]) * 0.5;
  }

  // Fritsch-Carlson condition to guarantee monotonicity and flat plateaus
  for (let i = 0; i < n; i++) {
    if (Math.abs(delta[i]) < 0.00001) {
      d[i] = 0;
      d[i + 1] = 0;
    } else {
      const alpha = d[i] / delta[i];
      const beta = d[i + 1] / delta[i];
      if (alpha < 0) d[i] = 0;
      if (beta < 0) d[i + 1] = 0;
      const mag2 = alpha * alpha + beta * beta;
      if (mag2 > 9) {
        const tau = 3.0 / Math.sqrt(mag2);
        d[i] = tau * alpha * delta[i];
        d[i + 1] = tau * beta * delta[i];
      }
    }
  }

  return d;
}

export function evaluateSpline(val, points, sigma, curveType = 0) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  const n = points.length - 1;
  let i = 0;
  for (i = 0; i < n; i++) {
    if (val < points[i+1].x) break;
  }
  if (i >= n) i = n - 1;

  const h = points[i+1].x - points[i].x;
  if (h < 0.0001) return points[i].y;

  const t = val - points[i].x;
  const t_norm = t / h;

  if (curveType === 1) { // Linear
    const ratio = t_norm;
    return Math.max(0, Math.min(1, points[i].y + ratio * (points[i+1].y - points[i].y)));
  }

  // Monotone Cubic Hermite Spline (curveType === 0)
  if (!Array.isArray(sigma) || sigma.length < points.length) return 0;
  const t2 = t_norm * t_norm;
  const t3 = t2 * t_norm;

  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t_norm;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;

  const m0 = sigma[i];
  const m1 = sigma[i + 1];

  const result = h00 * points[i].y + h10 * h * m0 + h01 * points[i + 1].y + h11 * h * m1;
  return Math.max(0, Math.min(1, result));
}
