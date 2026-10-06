import React, { useRef, useEffect, useState } from 'react';
import { computeSplineCoefficients, evaluateSpline } from '../utils/cubicSpline';
import './CurveEditor.css';

const GRAPH_PADDING = 52;

function normalizePoints(curvePoints) {
  if (Array.isArray(curvePoints) && curvePoints.length === 6) {
    const allValid = curvePoints.every((p) => 
      p && typeof p.x === 'number' && !isNaN(p.x) &&
      typeof p.y === 'number' && !isNaN(p.y) &&
      p.x >= -0.05 && p.x <= 1.05 &&
      p.y >= -0.05 && p.y <= 1.05
    );
    // If intermediate nodes collapsed onto (0,0) or endpoints, heal them
    const notCollapsed = curvePoints[1]?.x > 0.02 && curvePoints[4]?.x < 0.98;
    if (allValid && notCollapsed) {
      return curvePoints;
    }
    if (allValid) {
      const startY = Math.max(0, Math.min(1, curvePoints[0]?.y ?? 0));
      const endY = Math.max(0, Math.min(1, curvePoints[5]?.y ?? 1));
      return [
        { x: 0.0, y: startY },
        { x: 0.2, y: startY + 0.2 * (endY - startY) },
        { x: 0.4, y: startY + 0.4 * (endY - startY) },
        { x: 0.6, y: startY + 0.6 * (endY - startY) },
        { x: 0.8, y: startY + 0.8 * (endY - startY) },
        { x: 1.0, y: endY }
      ];
    }
  }
  if (Array.isArray(curvePoints) && curvePoints.length === 4) {
    const allValid = curvePoints.every(p => 
      p && typeof p.x === 'number' && !isNaN(p.x) &&
      typeof p.y === 'number' && !isNaN(p.y)
    );
    if (allValid) {
      return [
        { x: 0.0, y: 0.0 },
        ...curvePoints,
        { x: 1.0, y: 1.0 }
      ];
    }
  }
  return [
    { x: 0.0, y: 0.0 },
    { x: 0.2, y: 0.2 },
    { x: 0.4, y: 0.4 },
    { x: 0.6, y: 0.6 },
    { x: 0.8, y: 0.8 },
    { x: 1.0, y: 1.0 }
  ];
}

export default function CurveEditor({ curvePoints, curveType = 0, onCurveChange, onCurveSave, onCurveCommit, currentValue = 0 }) {
  const canvasRef = useRef(null);
  const currentValueRef = useRef(currentValue);
  const [draggingIdx, setDraggingIdx] = useState(-1);
  const [hoverIdx, setHoverIdx] = useState(-1);
  const pointsRef = useRef(normalizePoints(curvePoints));

  useEffect(() => {
    pointsRef.current = normalizePoints(curvePoints);
  }, [curvePoints]);
  
  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = canvas.width;
    const height = canvas.height;
    
    const padding = GRAPH_PADDING;
    if (width <= padding * 2 || height <= padding * 2) return;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);

    const style = getComputedStyle(document.documentElement);
    const gridColor = style.getPropertyValue('--curve-grid').trim();
    const mutedColor = style.getPropertyValue('--curve-muted').trim();
    const activeColor = style.getPropertyValue('--curve-active').trim();
    const brightColor = style.getPropertyValue('--curve-bright').trim();
    const handleColor = style.getPropertyValue('--curve-handle').trim();
    const handleStroke = style.getPropertyValue('--curve-handle-stroke').trim();
    const textColor = style.getPropertyValue('--text').trim();

    const graphWidth = width - padding * 2;
    const graphHeight = height - padding * 2;
    
    const toScreen = (x, y) => ({
      x: padding + x * graphWidth,
      y: height - padding - y * graphHeight
    });

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.fillStyle = textColor;
    ctx.font = '10px var(--font-sans)';
    ctx.textBaseline = 'middle';

    for (let i = 0; i <= 4; i++) {
      const p = i * 0.25;
      const x = padding + p * graphWidth;
      const y = height - padding - p * graphHeight;

      ctx.beginPath(); ctx.moveTo(x, padding); ctx.lineTo(x, height - padding); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(padding, y); ctx.lineTo(width - padding, y); ctx.stroke();

      // Bottom X-axis labels
      ctx.textAlign = 'center';
      ctx.fillText(`${p * 100}%`, x, height - padding + 16);

      // Left Y-axis labels (skip i === 0 so 0% is not drawn twice)
      if (i > 0) {
        ctx.textAlign = 'right';
        ctx.fillText(`${p * 100}%`, padding - 9, y);
      }
    }
    
    ctx.textAlign = 'center';
    ctx.font = '11px var(--font-sans)';
    ctx.fillText('Input', width / 2, height - 13);
    ctx.save();
    ctx.translate(14, height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Output', 0, 0);
    ctx.restore();

    const allPoints = normalizePoints(curvePoints);
    const sigma = curveType === 0 ? computeSplineCoefficients(allPoints) : [];

    // 1. Inactive full curve line (smooth, thicker)
    ctx.beginPath();
    for (let i = 0; i <= 100; i++) {
      const val = i / 100;
      const res = evaluateSpline(val, allPoints, sigma, curveType);
      const pt = toScreen(val, res);
      if (i === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = mutedColor;
    ctx.lineWidth = 3.5;
    ctx.stroke();

    const clampedVal = Math.max(0, Math.min(1, typeof currentValueRef.current === 'number' && !isNaN(currentValueRef.current) ? currentValueRef.current : 0));

    // 2. Active live pedal trace line (bolder, thicker)
    ctx.beginPath();
    for (let i = 0; i <= Math.floor(clampedVal * 100); i++) {
      const val = i / 100;
      const res = evaluateSpline(val, allPoints, sigma, curveType);
      const pt = toScreen(val, res);
      if (i === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    }
    const currRes = evaluateSpline(clampedVal, allPoints, sigma, curveType);
    const currScreen = toScreen(clampedVal, currRes);
    ctx.lineTo(currScreen.x, currScreen.y);
    
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = activeColor;
    ctx.lineWidth = 5;
    ctx.stroke();

    // Live pedal position indicator
    ctx.beginPath();
    ctx.arc(currScreen.x, currScreen.y, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = activeColor;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    // Refined draggable curve handles (including 0% start and 100% finish nodes)
    allPoints.forEach((p, idx) => {
      const scr = toScreen(p.x, p.y);
      const isHovered = hoverIdx === idx;
      const isDragging = draggingIdx === idx;
      const isEndpoint = idx === 0 || idx === allPoints.length - 1;
      const active = isHovered || isDragging;

      ctx.save();

      // 1. Subtle Outer Glow / Halo
      ctx.beginPath();
      ctx.arc(scr.x, scr.y, active ? 16 : 10, 0, Math.PI * 2);
      ctx.fillStyle = active
        ? (isEndpoint ? 'rgba(56, 189, 248, 0.22)' : 'rgba(103, 134, 235, 0.22)')
        : 'rgba(0, 0, 0, 0.05)';
      ctx.fill();

      // 2. Drop shadow for handle body
      ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
      ctx.shadowBlur = active ? 6 : 3;
      ctx.shadowOffsetY = 1;

      // 3. Handle outer circle
      const r = active ? 8.5 : 7;
      ctx.beginPath();
      ctx.arc(scr.x, scr.y, r, 0, Math.PI * 2);
      ctx.fillStyle = handleColor;
      ctx.fill();

      // Clear shadow before stroke to keep border sharp
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = active ? 2.5 : 2;
      ctx.strokeStyle = active ? activeColor : handleStroke;
      ctx.stroke();

      // 4. Center pip / core
      ctx.beginPath();
      ctx.arc(scr.x, scr.y, active ? 3.5 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = active ? activeColor : handleStroke;
      ctx.fill();

      // 5. Tooltip badge showing precise percentage when dragging or hovering
      if (active) {
        const text = isEndpoint
          ? (idx === 0 ? `Start: ${(p.y * 100).toFixed(0)}%` : `Finish: ${(p.y * 100).toFixed(0)}%`)
          : `${(p.x * 100).toFixed(0)}%, ${(p.y * 100).toFixed(0)}%`;
        
        ctx.font = '600 11px var(--font-sans)';
        const textWidth = ctx.measureText(text).width;
        const badgeW = textWidth + 14;
        const badgeH = 22;
        
        let badgeX = scr.x - badgeW / 2;
        if (idx === 0) badgeX = Math.max(padding + 2, scr.x - 4);
        else if (idx === allPoints.length - 1) badgeX = Math.min(width - padding - badgeW - 2, scr.x - badgeW + 4);
        else badgeX = Math.max(padding + 2, Math.min(width - padding - badgeW - 2, badgeX));

        let badgeY = scr.y - 28;
        if (badgeY < padding + 4) badgeY = scr.y + 14;

        ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 5);
        } else {
          ctx.rect(badgeX, badgeY, badgeW, badgeH);
        }
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, badgeX + badgeW / 2, badgeY + badgeH / 2);
      }

      ctx.restore();
    });
  };

  // Sync prop on initial load or if it changes externally
  useEffect(() => {
    currentValueRef.current = currentValue;
  }, [currentValue]);

  useEffect(() => {
    draw();
  }, [curvePoints, curveType, hoverIdx, draggingIdx]);

  useEffect(() => {
    let animFrame = null;
    const handleTelemetry = (e) => {
      const newNorm = e.detail?.normalized;
      const clamped = Math.max(0, Math.min(1, typeof newNorm === 'number' && !isNaN(newNorm) ? newNorm : 0));
      if (Math.abs(currentValueRef.current - clamped) > 0.0001) {
        currentValueRef.current = clamped;
        if (!animFrame) {
          animFrame = requestAnimationFrame(() => {
            draw();
            animFrame = null;
          });
        }
      }
    };
    window.addEventListener('microclutch-calibrated-norm', handleTelemetry);
    window.addEventListener('microclutch-telemetry', handleTelemetry);
    return () => {
      window.removeEventListener('microclutch-calibrated-norm', handleTelemetry);
      window.removeEventListener('microclutch-telemetry', handleTelemetry);
      if (animFrame) cancelAnimationFrame(animFrame);
    };
  }, [curvePoints, curveType, hoverIdx, draggingIdx]); // Depend on these so handleTelemetry captures the latest closure values for draw()

  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      for (let m of mutations) {
        if (m.attributeName === 'data-theme') {
          draw();
        }
      }
    });
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleResize = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.width;
        draw();
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const getMousePos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const hasTouches = Boolean(e.touches && e.touches.length > 0);
    const clientX = hasTouches ? e.touches[0].clientX : e.clientX;
    const clientY = hasTouches ? e.touches[0].clientY : e.clientY;
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  };

  const getLogicalPos = (sx, sy) => {
    const canvas = canvasRef.current;
    const padding = GRAPH_PADDING;
    const graphWidth = canvas.width - padding * 2;
    const graphHeight = canvas.height - padding * 2;
    let lx = (sx - padding) / graphWidth;
    let ly = (canvas.height - padding - sy) / graphHeight;
    lx = Math.max(0, Math.min(1, lx));
    ly = Math.max(0, Math.min(1, ly));
    return { x: lx, y: ly };
  };

  const handlePointerDown = (e) => {
    const pos = getMousePos(e);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const padding = GRAPH_PADDING;
    const graphWidth = canvas.width - padding * 2;
    const graphHeight = canvas.height - padding * 2;
    const points = normalizePoints(curvePoints);

    let hitIdx = -1;
    let minDist = 22; // generous hit zone for easy grabbing
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const scrX = padding + p.x * graphWidth;
      const scrY = canvas.height - padding - p.y * graphHeight;
      const dist = Math.hypot(pos.x - scrX, pos.y - scrY);
      if (dist <= minDist) {
        minDist = dist;
        hitIdx = i;
      }
    }

    if (hitIdx !== -1) {
      setDraggingIdx(hitIdx);
      if (e.pointerId && e.target.setPointerCapture) {
        try {
          e.target.setPointerCapture(e.pointerId);
        } catch (_) {}
      }
      if (e.cancelable) e.preventDefault();
    }
  };

  const handlePointerMove = (e) => {
    const pos = getMousePos(e);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const padding = GRAPH_PADDING;
    const graphWidth = canvas.width - padding * 2;
    const graphHeight = canvas.height - padding * 2;
    const points = normalizePoints(curvePoints);
    
    if (draggingIdx === -1) {
      let hIdx = -1;
      let minDist = 22;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const scrX = padding + p.x * graphWidth;
        const scrY = canvas.height - padding - p.y * graphHeight;
        const dist = Math.hypot(pos.x - scrX, pos.y - scrY);
        if (dist <= minDist) {
          minDist = dist;
          hIdx = i;
        }
      }
      if (hIdx !== hoverIdx) {
        setHoverIdx(hIdx);
        if (canvas) {
          if (hIdx === 0 || hIdx === points.length - 1) {
            canvas.style.cursor = 'ns-resize';
          } else if (hIdx !== -1) {
            canvas.style.cursor = 'grab';
          } else {
            canvas.style.cursor = 'crosshair';
          }
        }
      }
      return;
    }

    if (e.cancelable) e.preventDefault();

    const logical = getLogicalPos(pos.x, pos.y);
    const newPoints = points.map(pt => ({ ...pt }));
    
    if (draggingIdx === 0) {
      // 0% Start Node: Locked to X = 0, draggable in Y
      logical.x = 0.0;
      const maxY = newPoints[1].y; // maintain non-decreasing monotonicity
      logical.y = Math.max(0.0, Math.min(maxY, logical.y));
    } else if (draggingIdx === newPoints.length - 1) {
      // 100% Finish Node: Locked to X = 1, draggable in Y
      logical.x = 1.0;
      const minY = newPoints[newPoints.length - 2].y; // maintain non-decreasing monotonicity
      logical.y = Math.max(minY, Math.min(1.0, logical.y));
    } else {
      // Intermediate Nodes (indices 1 to 4): Draggable in both X and Y
      const minX = newPoints[draggingIdx - 1].x + 0.02;
      const maxX = newPoints[draggingIdx + 1].x - 0.02;
      
      const minY = newPoints[draggingIdx - 1].y;
      const maxY = newPoints[draggingIdx + 1].y;
      
      logical.x = Math.max(minX, Math.min(maxX, logical.x));
      logical.y = Math.max(minY, Math.min(maxY, logical.y));
    }
    
    newPoints[draggingIdx] = logical;
    pointsRef.current = newPoints;
    onCurveChange(newPoints);
  };

  const handlePointerUp = (e) => {
    if (e?.pointerId && e.target?.releasePointerCapture) {
      try {
        e.target.releasePointerCapture(e.pointerId);
      } catch (_) {}
    }
    if (draggingIdx !== -1 && onCurveCommit) {
      onCurveCommit(pointsRef.current);
    }
    setDraggingIdx(-1);
  };

  return (
    <div className="curve-editor-container">
      <canvas
        ref={canvasRef}
        className="curve-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
    </div>
  );
}
