import React, { useEffect, useState, useRef } from 'react';
import { useWebSerial, delayNextTick } from '../hooks/useWebSerial';
import CurveEditor from './CurveEditor';
import PollingRateSlider from './PollingRateSlider';
import { computeSplineCoefficients, evaluateSpline } from '../utils/cubicSpline';
import { MIN_FIRMWARE_VERSION, isFirmwareOutdated } from '../utils/webusbParser';
import './WebUSBPage.css';

export default function WebUSBPage() {
  const {
    isConnected,
    isConnecting,
    isSupported,
    status,
    telemetryHealth,
    curvePoints,
    connect,
    disconnect,
    startCalibration,
    stopCalibration,
    setCurve,
    sendCurveToDevice,
    saveCurve,
    resetCurve,
    curveType,
    setCurveType,
    setCalRange,
    setPollingRate
  } = useWebSerial();

  const isOutdated = isConnected && isFirmwareOutdated(status?.fwVersion);
  const [outdatedModal, setOutdatedModal] = useState({ isOpen: false, version: '' });

  // Outdated firmware listener from serial hook: immediately displays fixed overlay covering interactable elements
  useEffect(() => {
    const handleOutdated = (e) => {
      const ver = e.detail?.version || '2.0.0';
      setOutdatedModal({ isOpen: true, version: ver });
    };
    window.addEventListener('microclutch-outdated-firmware', handleOutdated);
    return () => window.removeEventListener('microclutch-outdated-firmware', handleOutdated);
  }, []);

  // Outdated firmware safety fallback guard: immediately disconnect and display fixed overlay covering interactable elements
  useEffect(() => {
    if (isConnected && isFirmwareOutdated(status?.fwVersion)) {
      const ver = status.fwVersion;
      setOutdatedModal({ isOpen: true, version: ver });
      disconnect();
    }
  }, [isConnected, status?.fwVersion, disconnect]);

  const [diagOpen, setDiagOpen] = useState(false);
  const [dragHandle, setDragHandle] = useState(null);
  const [calRange, setCalRangeState] = useState({ min: 17758, max: 19484 });
  const [workingHz, setWorkingHz] = useState(1000);
  const [isDirty, setIsDirty] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const saveTimerRef = useRef(null);
  const calRangeRef = useRef(calRange);
  useEffect(() => {
    calRangeRef.current = calRange;
  }, [calRange]);

  const markDirty = () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setJustSaved(false);
    setIsDirty(true);
  };

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  const updateCalRange = (updater, shouldMarkDirty = true) => {
    setCalRangeState(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      calRangeRef.current = next;
      const currentRaw = typeof status?.rawAngle === 'number' ? status.rawAngle : 0;
      const liveNorm = next.max > next.min ? Math.max(0, Math.min(1, (currentRaw - next.min) / (next.max - next.min))) : 0;
      window.dispatchEvent(new CustomEvent('microclutch-calibrated-norm', { detail: { normalized: liveNorm } }));
      return next;
    });
    if (shouldMarkDirty) markDirty();
  };

  const draggingRef = useRef(null);
  const trackRef = useRef(null);
  const endpoints = {};

  const validPoints = Array.isArray(curvePoints) && curvePoints.length === 6
    ? curvePoints
    : Array.isArray(curvePoints) && curvePoints.length === 4
      ? [{ x: 0.0, y: 0.0 }, ...curvePoints, { x: 1.0, y: 1.0 }]
      : [
          { x: 0.0, y: 0.0 },
          { x: 0.2, y: 0.2 },
          { x: 0.4, y: 0.4 },
          { x: 0.6, y: 0.6 },
          { x: 0.8, y: 0.8 },
          { x: 1.0, y: 1.0 }
        ];
  const allPoints = validPoints;
  const sigma = curveType === 0 ? computeSplineCoefficients(allPoints) : [];

  // Calibration bar range from around (17758 - 150) to (19484 + 150)
  const CAL_BAR_MIN = 17758 - 150; // 17608
  const CAL_BAR_MAX = 19484 + 150; // 19634

  // Initial sync from connected device EEPROM calibration
  const syncedCalRef = useRef(false);
  const syncedHzRef = useRef(false);
  useEffect(() => {
    if (isConnected) {
      if (!syncedCalRef.current && status?.calMin > 0 && status?.calMax > status?.calMin) {
        updateCalRange({ min: status.calMin, max: status.calMax }, false);
        syncedCalRef.current = true;
        setIsDirty(false);
      }
      const hwHz = status?.pollingRate ?? status?.pollingRateHz;
      if (!syncedHzRef.current && hwHz && hwHz >= 100 && hwHz <= 7400) {
        setWorkingHz(hwHz);
        syncedHzRef.current = true;
        setIsDirty(false);
      }
    } else {
      syncedCalRef.current = false;
      syncedHzRef.current = false;
      setIsDirty(false);
      setJustSaved(false);
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    }
  }, [isConnected, status?.calMin, status?.calMax, status?.pollingRate, status?.pollingRateHz]);

  // Auto-calibration tracking state
  const preCalRangeRef = useRef(null);
  const calStartAngleRef = useRef(null);
  const calExceededRef = useRef(false);
  const calSettledTimeRef = useRef(0);
  const calLastAngleRef = useRef(null);
  const calCancelledRef = useRef(false);
  const calEndingRef = useRef(false);
  const isCalibratingRef = useRef(false);

  useEffect(() => {
    isCalibratingRef.current = Boolean(status?.isCalibrating);
    if (!status?.isCalibrating) {
      calStartAngleRef.current = null;
      calExceededRef.current = false;
      calSettledTimeRef.current = 0;
      calLastAngleRef.current = null;
      calEndingRef.current = false;
    }
  }, [status?.isCalibrating]);

  // Sync new values if user runs hardware auto-calibration and it finishes
  const prevCalibratingRef = useRef(0);
  useEffect(() => {
    if (prevCalibratingRef.current === 1 && status?.isCalibrating === 0) {
      if (!calCancelledRef.current && status?.calMin > 0 && status?.calMax > status?.calMin) {
        updateCalRange({ min: status.calMin, max: status.calMax }, true);
      }
      calCancelledRef.current = false;
    }
    prevCalibratingRef.current = status?.isCalibrating;
  }, [status?.isCalibrating, status?.calMin, status?.calMax]);

  const handleStartAutoCal = async () => {
    preCalRangeRef.current = { ...calRangeRef.current };
    calCancelledRef.current = false;
    calEndingRef.current = false;
    const currentAngle = typeof status?.rawAngle === 'number' && status.rawAngle > 0 ? status.rawAngle : null;
    calStartAngleRef.current = currentAngle;
    calLastAngleRef.current = currentAngle;
    calExceededRef.current = false;
    calSettledTimeRef.current = 0;
    await startCalibration();
  };

  const handleCancelCalibration = async () => {
    calCancelledRef.current = true;
    calEndingRef.current = true;
    calStartAngleRef.current = null;
    calExceededRef.current = false;
    calSettledTimeRef.current = 0;
    calLastAngleRef.current = null;
    await stopCalibration();
    if (preCalRangeRef.current) {
      const prev = preCalRangeRef.current;
      updateCalRange(prev, false);
      if (isConnected) {
        await setCalRange(prev.min, prev.max);
      }
    }
  };

  useEffect(() => {
    let animFrame = null;
    const handleTelemetry = (e) => {
      const pkt = e.detail;
      const rAngle = pkt.rawAngle || 0;
      const cMin = calRangeRef.current.min;
      const cMax = calRangeRef.current.max;

      // Auto-calibration threshold detection and auto-finish
      const isCalibrating = (isCalibratingRef.current || Boolean(pkt.isCalibrating)) && !calEndingRef.current;
      if (isCalibrating) {
        if (calStartAngleRef.current === null && rAngle > 0) {
          calStartAngleRef.current = rAngle;
          calLastAngleRef.current = rAngle;
        }

        if (calStartAngleRef.current !== null) {
          const deltaFromStart = Math.abs(rAngle - calStartAngleRef.current);
          if (!calExceededRef.current) {
            // Watch if the angle exceeds a certain threshold (250 ticks, ~15% stroke)
            if (deltaFromStart >= 250) {
              calExceededRef.current = true;
            }
          } else {
            // Once threshold exceeded, watch for pedal returning within threshold of start angle (~65 ticks)
            // and remaining stationary (change <= 12 ticks) for 0.7 seconds (700ms)
            const isNearStart = deltaFromStart <= 65;
            const isStationary = Math.abs(rAngle - (calLastAngleRef.current ?? rAngle)) <= 12;
            if (isNearStart && isStationary) {
              if (calSettledTimeRef.current === 0) {
                calSettledTimeRef.current = Date.now();
              } else if (Date.now() - calSettledTimeRef.current >= 700) {
                // Automatically end the calibration process after 0.7s!
                calEndingRef.current = true;
                calStartAngleRef.current = null;
                calExceededRef.current = false;
                calSettledTimeRef.current = 0;
                calLastAngleRef.current = null;
                stopCalibration();
              }
            } else {
              calSettledTimeRef.current = 0;
            }
          }
          calLastAngleRef.current = rAngle;
        }
      }

      // Live normalization in webpage using active working calibration
      const workingNorm = cMax > cMin ? Math.max(0, Math.min(1, (rAngle - cMin) / (cMax - cMin))) : 0;
      const cNorm = evaluateSpline(workingNorm, allPoints, sigma, curveType);

      if (!animFrame) {
        animFrame = requestAnimationFrame(() => {
          const outEl = document.getElementById('val-output');
          if (outEl) outEl.textContent = (Math.abs(cNorm) < 0.0005 ? 0 : cNorm).toFixed(3);
          
          const inEl = document.getElementById('val-input');
          if (inEl) inEl.textContent = (Math.abs(workingNorm) < 0.0005 ? 0 : workingNorm).toFixed(3);
          
          const rawEls = [document.getElementById('val-raw'), document.getElementById('gauge-raw-label')];
          rawEls.forEach(el => { if(el) el.textContent = rAngle; });

          // Calibration bar spans around (17758 - 150) to (19484 + 150)
          const bMin = Math.min(CAL_BAR_MIN, cMin);
          const bMax = Math.max(CAL_BAR_MAX, cMax);
          const bRange = bMax - bMin;
          const needlePct = Math.max(0, Math.min(100, ((rAngle - bMin) / bRange) * 100));

          let clampState = 'ok';
          let clampLabel = 'In Active Range';

          if (rAngle < cMin) {
            clampState = 'low';
            clampLabel = 'Min Clamped (0%)';
          } else if (rAngle > cMax) {
            clampState = 'high';
            clampLabel = 'Max Clamped (100%)';
          }
          
          const needleEl = document.getElementById('gauge-needle');
          if (needleEl) {
            needleEl.style.left = `${needlePct}%`;
            needleEl.title = `Current Raw Angle: ${rAngle}`;
            needleEl.className = `gauge-needle gauge-needle-${clampState}`;
            
            const clampBadge = document.getElementById('clamp-badge');
            if (clampBadge) {
              clampBadge.className = `clamp-badge clamp-${clampState}`;
              clampBadge.textContent = clampLabel;
            }
          }
          
          animFrame = null;
        });
      }

      window.dispatchEvent(new CustomEvent('microclutch-calibrated-norm', { detail: { normalized: workingNorm } }));
    };

    window.addEventListener('microclutch-telemetry', handleTelemetry);
    return () => {
      window.removeEventListener('microclutch-telemetry', handleTelemetry);
      if (animFrame) cancelAnimationFrame(animFrame);
    };
  }, [allPoints, sigma, curveType]);

  const rawAngle = typeof status?.rawAngle === 'number' ? status.rawAngle : 0;
  
  // Visual Calibration Gauge Calculations
  const effectiveMin = calRange.min;
  const effectiveMax = calRange.max;
  const calMin = effectiveMin;
  const calMax = effectiveMax;

  const barMin = Math.min(CAL_BAR_MIN, effectiveMin);
  const barMax = Math.max(CAL_BAR_MAX, effectiveMax);
  const barRange = barMax - barMin;

  let clampState = 'ok';
  let clampLabel = 'In Active Range';
  const activeLeftPct = ((effectiveMin - barMin) / barRange) * 100;
  const activeWidthPct = ((effectiveMax - effectiveMin) / barRange) * 100;
  const needlePct = Math.max(0, Math.min(100, ((rawAngle - barMin) / barRange) * 100));

  if (rawAngle < effectiveMin) {
    clampState = 'low';
    clampLabel = 'Min Clamped (0%)';
  } else if (rawAngle > effectiveMax) {
    clampState = 'high';
    clampLabel = 'Max Clamped (100%)';
  }

  // Active normalized calculations
  const rawNorm = effectiveMax > effectiveMin ? Math.max(0, Math.min(1, (rawAngle - effectiveMin) / (effectiveMax - effectiveMin))) : 0;
  const curvedNorm = evaluateSpline(rawNorm, allPoints, sigma, curveType);

  const formattedInput = (Math.abs(rawNorm) < 0.0005 ? 0 : rawNorm).toFixed(3);
  const formattedOutput = (Math.abs(curvedNorm) < 0.0005 ? 0 : curvedNorm).toFixed(3);

  // Telemetry Health State & Badge Mapping
  const health = telemetryHealth?.health || (isConnected ? 'waiting' : 'disconnected');
  const rxPackets = telemetryHealth?.rxPackets || 0;
  const rxRateHz = telemetryHealth?.rxRateHz || 0;

  let statusDotClass = 'disconnected';
  let statusText = 'Disconnected';

  if (!isConnected || health === 'disconnected') {
    statusDotClass = 'disconnected';
    statusText = 'Disconnected';
  } else if (health === 'connecting') {
    statusDotClass = 'waiting';
    statusText = 'Connecting...';
  } else if (health === 'waiting' || rxPackets === 0) {
    statusDotClass = 'waiting';
    statusText = 'Connected — Waiting for Telemetry...';
  } else if (health === 'stale') {
    statusDotClass = 'stale';
    statusText = 'Telemetry Stale (no data > 1.5s)';
  } else if (health === 'streaming') {
    statusDotClass = 'streaming';
    statusText = `Live Telemetry (${rxRateHz} RX/s • ${rxPackets.toLocaleString()} pkts)`;
  }

  const handlePointerDown = (handleType, e) => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = handleType;
    setDragHandle(handleType);
  };

  useEffect(() => {
    if (!dragHandle) return;

    const onPointerMove = (e) => {
      if (!draggingRef.current || !trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const rawVal = Math.round(barMin + ratio * barRange);

      if (draggingRef.current === 'min') {
        const clampedMin = Math.max(barMin, Math.min(calRangeRef.current.max - 20, rawVal));
        updateCalRange(prev => ({ ...prev, min: clampedMin }));
      } else if (draggingRef.current === 'max') {
        const clampedMax = Math.min(barMax, Math.max(calRangeRef.current.min + 20, rawVal));
        updateCalRange(prev => ({ ...prev, max: clampedMax }));
      }
    };

    const onPointerUp = () => {
      draggingRef.current = null;
      setDragHandle(null);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [dragHandle, barMin, barRange]);

  const handleSaveProfile = async () => {
    if (!isConnected) return;
    // 1. Commit calibration range to pedal hardware (RAM)
    await setCalRange(calRangeRef.current.min, calRangeRef.current.max);
    await delayNextTick(30);
    // 2. Commit polling rate to pedal hardware (RAM)
    await setPollingRate(workingHz);
    await delayNextTick(30);
    // 3. Commit curve to pedal hardware and persist to EEPROM
    await saveCurve(curvePoints, curveType);

    setIsDirty(false);
    setJustSaved(true);

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      setJustSaved(false);
      saveTimerRef.current = null;
    }, 3000);
  };

  return (
    <div className="webusb-page">
      {!isSupported && (
        <div className="unsupported-banner" style={{
          backgroundColor: 'rgba(239, 68, 68, 0.15)',
          border: '1px solid var(--danger)',
          color: 'var(--danger)',
          padding: '10px 16px',
          borderRadius: '8px',
          fontSize: '14px',
          fontWeight: '500',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          maxWidth: '600px',
          width: '100%'
        }}>
          <i className="fa-solid fa-triangle-exclamation"></i>
          WebSerial is not supported in this browser. Please use Chrome, Edge, or Opera.
        </div>
      )}

      {outdatedModal.isOpen && (
        <div 
          className="outdated-fw-overlay" 
          role="dialog" 
          aria-modal="true" 
          aria-labelledby="outdated-fw-title"
        >
          <div className="outdated-fw-modal">
            <button 
              className="outdated-modal-close" 
              onClick={() => setOutdatedModal({ isOpen: false, version: '' })}
              aria-label="Close modal"
              title="Close modal"
            >
              <i className="fa-solid fa-xmark"></i>
            </button>

            <div className="outdated-modal-header">
              <div className="outdated-modal-icon-badge">
                <i className="fa-solid fa-triangle-exclamation"></i>
              </div>
              <div>
                <h2 id="outdated-fw-title" className="outdated-modal-title">Firmware Update Required</h2>
                <div className="outdated-version-tags">
                  <span className="outdated-tag-current">Detected: v{outdatedModal.version || '2.0.0'}</span>
                  <i className="fa-solid fa-arrow-right"></i>
                  <span className="outdated-tag-required">Required: v{MIN_FIRMWARE_VERSION}+</span>
                </div>
              </div>
            </div>

            <div className="outdated-modal-body">
              <p>
                MicroClutch has <strong>disconnected automatically</strong> because your RP2040 microcontroller is running an older firmware build.
              </p>
              <div className="outdated-modal-reason">
                <p>
                  Firmware <strong>v{MIN_FIRMWARE_VERSION}</strong> is required for non-blocking USB communication, autonomous telemetry streaming, and to eliminate communication freezes during calibration and curve saving.
                </p>
              </div>

              <div className="outdated-modal-steps">
                <div className="steps-title">
                  <i className="fa-solid fa-cloud-arrow-down"></i>
                  <span>How to Update:</span>
                </div>
                <ol>
                  <li>Download the new firmware file from GitHub.</li>
                  <li>Flash the new firmware to the RP2040.</li>
                  <li>Reconnect the RP2040 to the MicroClutch configurator.</li>
                </ol>
              </div>
            </div>

            <div className="outdated-modal-footer">
              <button 
                type="button" 
                className="btn-modal-dismiss"
                onClick={() => setOutdatedModal({ isOpen: false, version: '' })}
              >
                <i className="fa-solid fa-check"></i>
                <span>Understood (Dismiss)</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="status-bar">
        <div className={`status-item status-${statusDotClass}`}>
          <div className={`status-dot ${statusDotClass}`}></div>
          <span className="status-text">{statusText}</span>
        </div>
        <div 
          className="status-item"
          title={`Firmware v${status?.fwVersion || status?.firmwareVersion || '0.0.0'}`}
        >
          <i className="fa-solid fa-microchip"></i>
          <span>FW {status?.fwVersion || status?.firmwareVersion || '0.0.0'}</span>
        </div>
        <div className="status-item">{workingHz > 4000 ? 'Uncapped' : `${workingHz}Hz`}</div>
      </div>

      <div className="main-card">
        <div className="card-header">
          <div className="telemetry-readouts">
            <div className="normalised-value" title="Curved Output" id="val-output">
              {formattedOutput}
            </div>
            <div className="raw-angle-indicator" style={{ display: 'flex', gap: '15px' }}>
              <span title="Normalized Input">Input: <strong className="mono" id="val-input">{formattedInput}</strong></span>
              <span title="Live Sensor Angle">Raw: <strong className="mono" id="val-raw">{rawAngle}</strong></span>
            </div>
          </div>
          <button 
            className={`btn-connect ${isConnected ? 'disconnect' : ''}`}
            onClick={isConnected ? disconnect : connect}
            disabled={!isSupported || isConnecting}
          >
            <i className={`fa-solid ${isConnecting ? 'fa-spinner fa-spin' : isConnected ? 'fa-plug-circle-xmark' : 'fa-plug'}`}></i>
            {isConnecting ? 'Connecting...' : isConnected ? 'Disconnect' : 'Connect Device'}
          </button>
        </div>

        <CurveEditor 
          curvePoints={curvePoints} 
          curveType={curveType}
          onCurveChange={(pts) => {
            setCurve(pts);
            markDirty();
          }}
          onCurveSave={handleSaveProfile}
          currentValue={Math.max(0, Math.min(1, rawNorm))}
        />

        <div className="curve-controls-row">
          <div className="curve-algorithm-selector">
            <button 
              className={`btn-alg ${curveType === 0 ? 'active' : ''}`}
              onClick={() => {
                if (curveType !== 0) {
                  setCurveType(0);
                  markDirty();
                }
              }}
              title="Spline Algorithm"
            >
              <i className="fa-solid fa-bezier-curve"></i> Spline
            </button>
            <button 
              className={`btn-alg ${curveType === 1 ? 'active' : ''}`}
              onClick={() => {
                if (curveType !== 1) {
                  setCurveType(1);
                  markDirty();
                }
              }}
              title="Linear Interpolation"
            >
              <i className="fa-solid fa-chart-line"></i> Solid Lines
            </button>
          </div>

          <div className="curve-reset-section">
            <button 
              className="btn-reset-curve" 
              onClick={async () => {
                await resetCurve();
                markDirty();
                const btn = document.getElementById('reset-btn-icon');
                if (btn) {
                  btn.className = 'fa-solid fa-check';
                  setTimeout(() => { btn.className = 'fa-solid fa-rotate-left'; }, 1500);
                }
              }}
              title="Reset curve to linear default"
            >
              <i id="reset-btn-icon" className="fa-solid fa-rotate-left"></i> Reset Curve
            </button>
          </div>
        </div>

        {/* Visual Calibration Gauge (above polling rate bar, below graph) */}
        <div className="calibration-gauge-card">
          <div className="gauge-header">
            <span className="gauge-title">
              <i className="fa-solid fa-gauge-high"></i> Sensor Calibration
              <span className="gauge-range-hint mono">({barMin} – {barMax})</span>
            </span>
            <span id="clamp-badge" className={`clamp-badge clamp-${clampState}`}>
              {clampLabel}
            </span>
          </div>
          <div className="gauge-track-container">
            <div 
              ref={trackRef}
              className={`gauge-track ${dragHandle ? 'dragging' : ''}`}
              id="gauge-track"
            >
              {effectiveMax > effectiveMin && (
                <div 
                  id="gauge-active-zone"
                  className="gauge-active-zone"
                  style={{ left: `${activeLeftPct}%`, width: `${activeWidthPct}%` }}
                  title={`Active Calibrated Range (${effectiveMin} - ${effectiveMax})`}
                >
                  <div 
                    className={`cal-handle cal-handle-min ${dragHandle === 'min' ? 'dragging' : ''}`}
                    onPointerDown={(e) => !isOutdated && handlePointerDown('min', e)}
                    title={isOutdated ? "Firmware update required" : "Drag left edge to adjust Min calibration"}
                  >
                    <div className="cal-handle-grip"></div>
                  </div>

                  <div 
                    className={`cal-handle cal-handle-max ${dragHandle === 'max' ? 'dragging' : ''}`}
                    onPointerDown={(e) => !isOutdated && handlePointerDown('max', e)}
                    title={isOutdated ? "Firmware update required" : "Drag right edge to adjust Max calibration"}
                  >
                    <div className="cal-handle-grip"></div>
                  </div>
                </div>
              )}
              <div 
                id="gauge-needle"
                className={`gauge-needle gauge-needle-${clampState}`}
                style={{ left: `${needlePct}%` }}
                title={`Current Raw Angle: ${rawAngle}`}
              >
                <div className="needle-pointer"></div>
                <div className="needle-line"></div>
              </div>
            </div>
            <div className="gauge-labels">
              <span className="gauge-label min-label">Min: <strong id="gauge-min-label" className="mono">{effectiveMin}</strong></span>
              <span className="gauge-label raw-label">Raw Angle: <strong id="gauge-raw-label" className="mono">{rawAngle}</strong></span>
              <span className="gauge-label max-label">Max: <strong id="gauge-max-label" className="mono">{effectiveMax}</strong></span>
            </div>
          </div>

          <div className="cal-button-group">
            <button 
              className={`btn-action btn-cal ${status?.isCalibrating ? 'calibrating' : ''}`}
              onClick={status?.isCalibrating ? stopCalibration : handleStartAutoCal}
              disabled={!isConnected}
              title={!isConnected ? "Connect device to calibrate" : ""}
            >
              {Boolean(status?.isCalibrating) && <i className="fa-solid fa-spinner fa-spin"></i>}
              <span>{status?.isCalibrating ? 'press and release pedal fully...' : 'Auto Calibrate'}</span>
            </button>
            <button 
              className={`btn-action btn-cal-cancel ${status?.isCalibrating ? 'visible' : ''}`}
              onClick={handleCancelCalibration}
              title="Cancel calibration"
              type="button"
              tabIndex={status?.isCalibrating ? 0 : -1}
              aria-hidden={!status?.isCalibrating}
            >
              <i className="fa-solid fa-xmark"></i>
              <span>Cancel</span>
            </button>
          </div>
        </div>

        <PollingRateSlider 
          value={workingHz} 
          disabled={!isConnected}
          onChange={(hz) => {
            setWorkingHz(hz);
            markDirty();
          }} 
        />

        {/* Full-width dynamic Save Profile button */}
        <button 
          className={`btn-save-profile ${isDirty ? 'dirty' : justSaved ? 'saved' : 'default'}`}
          onClick={handleSaveProfile}
          disabled={!isConnected}
          title={!isConnected ? "Connect device to save profile" : isDirty ? "Save changes to MCU EEPROM" : justSaved ? "Profile saved to MCU" : "Save Profile"}
        >
          <i className={`fa-solid ${justSaved ? 'fa-check' : 'fa-floppy-disk'}`}></i>
          <span>{justSaved ? 'Profile Saved' : 'Save Profile'}</span>
        </button>

        {/* Hardware Diagnostics Section */}
        <div className="diagnostics-section">
          <button className="diag-toggle" onClick={() => setDiagOpen(!diagOpen)}>
            <i className="fa-solid fa-microchip"></i>
            <span>Hardware Diagnostics & Telemetry</span>
            <i className="fa-solid fa-chevron-down toggle-chevron" style={{ transform: diagOpen ? 'rotate(0)' : 'rotate(-90deg)' }}></i>
          </button>
          <div className={`diag-content ${diagOpen ? 'open' : ''}`}>
            {/* Hardware & Endpoint Metrics Grid */}
            <div className="diag-grid">
              <div className="diag-stat">
                <span className="diag-label">USB Endpoints</span>
                <span className="diag-val mono">
                  IN: {endpoints?.inEp !== null && endpoints?.inEp !== undefined ? `0x${endpoints.inEp.toString(16).padStart(2, '0')}` : (isConnected ? '0x83' : '—')} | 
                  OUT: {endpoints?.outEp !== null && endpoints?.outEp !== undefined ? `0x${endpoints.outEp.toString(16).padStart(2, '0')}` : (isConnected ? '0x03' : '—')}
                </span>
              </div>
              <div className="diag-stat">
                <span className="diag-label">USB Interface</span>
                <span className="diag-val mono">
                  {endpoints?.ifaceNum !== null && endpoints?.ifaceNum !== undefined ? `Interface #${endpoints.ifaceNum}` : (isConnected ? 'Interface #2' : '—')} (Vendor 0xFF)
                </span>
              </div>
              <div className="diag-stat">
                <span className="diag-label">Total RX Packets</span>
                <span className="diag-val mono">{rxPackets.toLocaleString()}</span>
              </div>
              <div className="diag-stat">
                <span className="diag-label">Live RX Throughput</span>
                <span className="diag-val mono">{rxRateHz} packets/s</span>
              </div>
              <div className="diag-stat">
                <span className="diag-label">Data Ingested</span>
                <span className="diag-val mono">{((telemetryHealth?.rxBytes || 0) / 1024).toFixed(1)} KB</span>
              </div>
              <div className="diag-stat">
                <span className="diag-label">Telemetry Health</span>
                <span className={`diag-val health-val health-${health}`}>{health.toUpperCase()}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
