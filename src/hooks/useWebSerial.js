import { useState, useEffect, useRef, useCallback } from 'react';
import { 
  parseStatusPacket, isValidStatusPacketCandidate, PACKET_ID_STATUS,
  parseCurvePacket, isValidCurvePacketCandidate, PACKET_ID_CURVE,
  CURVE_PACKET_LENGTH,
  processIncomingBytes,
  parseAckPacket, PACKET_ID_ACK,
  parseCalStatusPacket, PACKET_ID_CAL_STATUS,
  isFirmwareOutdated
} from '../utils/webusbParser.js';

export const CMD_GET_STATUS = 0x01;
export const CMD_START_CAL = 0x02;
export const CMD_STOP_CAL = 0x03;
export const CMD_SET_CURVE = 0x04;
export const CMD_GET_CURVE = 0x05;
export const CMD_SAVE_CURVE = 0x06;
export const CMD_RESET_CURVE = 0x07;
export const CMD_SET_CAL = 0x08;
export const CMD_SET_POLLING_RATE = 0x09;

export const DEFAULT_CURVE_POINTS = [
  { x: 0.0, y: 0.0 },
  { x: 0.2, y: 0.2 },
  { x: 0.4, y: 0.4 },
  { x: 0.6, y: 0.6 },
  { x: 0.8, y: 0.8 },
  { x: 1.0, y: 1.0 }
];

const INITIAL_STATUS = {
  rawAngle: 0,
  normalized: 0,
  axisValue: 0,
  calMin: 0,
  calMax: 65535,
  pollingRate: 0,
  pollingRateHz: 0,
  isCalibrating: 0,
  firmwareVersion: '',
  fwVersion: '0.0.0'
};

export const delayNextTick = (ms = 16) => new Promise(resolve => setTimeout(resolve, ms));

export function useWebSerial() {
  const [port, setPort] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [status, setStatus] = useState(INITIAL_STATUS);
  const [curvePoints, setCurvePoints] = useState(DEFAULT_CURVE_POINTS);
  const [curveType, setCurveType] = useState(0);
  const curvePointsRef = useRef(DEFAULT_CURVE_POINTS);
  const curveTypeRef = useRef(0);
  const hasReceivedCurveRef = useRef(false);
  const curveFetchAttemptsRef = useRef(0);

  const [telemetryHealth, setTelemetryHealth] = useState({
    rxRateHz: 0,
    rxPackets: 0,
    rxBytes: 0,
    health: 'disconnected'
  });

  const portRef = useRef(null);
  const readerRef = useRef(null);
  const writerRef = useRef(null);
  const pollingRef = useRef(false);
  const readLoopPromiseRef = useRef(null);
  const isDisconnectingRef = useRef(false);
  const leftoverRef = useRef(new Uint8Array(0));
  const metricsRef = useRef({ lastCount: 0, currentCount: 0, lastTime: Date.now(), rxBytes: 0 });
  const lastPacketTimeRef = useRef(0);
  const lastUiUpdateTimeRef = useRef(0);
  const outQueueRef = useRef(Promise.resolve());
  const isSavingRef = useRef(false);
  const isCommandInProgressRef = useRef(false);
  const isSupported = 'serial' in navigator;

  const transferOutSafe = (data, timeoutMs = 300) => {
    const task = async () => {
      let writer = writerRef.current;
      if (!writer) return false;
      try {
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Serial write timeout')), timeoutMs);
        });
        await Promise.race([
          writer.write(data),
          timeoutPromise
        ]);
        clearTimeout(timeoutId);
        return true;
      } catch (err) {
        console.warn('Serial write warning:', err);
        const p = portRef.current;
        if (p && p.writable && !isDisconnectingRef.current) {
          try {
            writer.releaseLock();
          } catch (_) {}
          try {
            writerRef.current = p.writable.getWriter();
          } catch (rwErr) {
            console.warn('Could not re-acquire serial writer:', rwErr);
          }
        }
        return false;
      }
    };
    outQueueRef.current = outQueueRef.current.then(task, task);
    return outQueueRef.current;
  };

  const executeCommandSafe = async (fn) => {
    isCommandInProgressRef.current = true;
    try {
      await delayNextTick(25); // allow any in-flight status ping to clear
      return await fn();
    } finally {
      await delayNextTick(25);
      isCommandInProgressRef.current = false;
    }
  };

  const connect = async () => {
    if (!isSupported) {
      alert('WebSerial is not supported in this browser.');
      return;
    }
    try {
      // 1. Request port from user
      let p;
      try {
        p = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0xFA57 }] });
      } catch (err) {
        if (err.name === 'NotFoundError') {
          // User closed/cancelled the port picker
          return;
        }
        throw err;
      }

      setIsConnecting(true);

      // 2. Open port if not already open
      if (!p.readable) {
        try {
          await p.open({ baudRate: 115200 });
        } catch (openErr) {
          // If port was already opened by the browser, verify it has a readable stream
          if (openErr.name !== 'InvalidStateError' || !p.readable) {
            throw openErr;
          }
        }
      }
      
      try {
        await p.setSignals({ dataTerminalReady: true, requestToSend: true });
      } catch (_) {}
      
      portRef.current = p;
      setPort(p);
      leftoverRef.current = new Uint8Array(0);
      outQueueRef.current = Promise.resolve();
      lastPacketTimeRef.current = Date.now();
      hasReceivedCurveRef.current = false;
      curveFetchAttemptsRef.current = 0;
      setTelemetryHealth(prev => ({ ...prev, health: 'connecting' }));

      writerRef.current = p.writable.getWriter();

      // Hardware unplug listener
      const handleDisconnect = () => {
        disconnect();
      };
      p.addEventListener('disconnect', handleDisconnect, { once: true });
      
      pollingRef.current = true;
      pollLoop(p);
    } catch (err) {
      setIsConnecting(false);
      console.error('Connection error:', err);
      alert('Failed to connect to MicroClutch via WebSerial.');
    }
  };

  const disconnect = useCallback(async () => {
    if (isDisconnectingRef.current) return;
    isDisconnectingRef.current = true;
    pollingRef.current = false;

    try {
      // 1. Cancel the reader so any pending read() promise resolves immediately
      if (readerRef.current) {
        try {
          await readerRef.current.cancel();
        } catch (_) {}
      }

      // 2. Wait for readLoop to finish reading and release its reader lock
      if (readLoopPromiseRef.current) {
        try {
          await readLoopPromiseRef.current;
        } catch (_) {}
        readLoopPromiseRef.current = null;
      }

      // 3. Fallback releaseLock if readerRef is somehow still retained
      if (readerRef.current) {
        try {
          readerRef.current.releaseLock();
        } catch (_) {}
        readerRef.current = null;
      }

      // 4. Wait for any queued write tasks to complete before closing writer
      try {
        await outQueueRef.current;
      } catch (_) {}
      outQueueRef.current = Promise.resolve();

      // 5. Close and release writer
      if (writerRef.current) {
        try {
          await writerRef.current.close();
        } catch (_) {}
        try {
          writerRef.current.releaseLock();
        } catch (_) {}
        writerRef.current = null;
      }

      // 6. Reset control signals and close serial port
      const p = portRef.current;
      if (p) {
        try {
          await p.setSignals({ dataTerminalReady: false, requestToSend: false });
        } catch (_) {}
        try {
          await p.close();
        } catch (err) {
          console.warn('Port close warning:', err);
        }
        portRef.current = null;
      }
    } catch (err) {
      console.warn('Disconnect error:', err);
    } finally {
      setPort(null);
      setIsConnected(false);
      setIsConnecting(false);
      setStatus(INITIAL_STATUS);
      setTelemetryHealth({ rxRateHz: 0, rxPackets: 0, rxBytes: 0, health: 'disconnected' });
      isDisconnectingRef.current = false;
    }
  }, []);

  const pollLoop = async (p) => {
    let consecutiveErrors = 0;
    
    // Start reading stream
    try {
      readerRef.current = p.readable.getReader();
    } catch (err) {
      console.error('Could not get reader:', err);
      if (pollingRef.current) disconnect();
      return;
    }

    hasReceivedCurveRef.current = false;
    curveFetchAttemptsRef.current = 0;

    // Send initial status request & curve request once stream reader is ready and listening
    setTimeout(async () => {
      if (pollingRef.current && writerRef.current) {
        await transferOutSafe(new Uint8Array([CMD_GET_STATUS]));
        await delayNextTick(30);
        await transferOutSafe(new Uint8Array([CMD_GET_CURVE]));
        curveFetchAttemptsRef.current++;
      }
    }, 50);

    // Metric loop
    const metricInterval = setInterval(() => {
      if (!pollingRef.current) {
        clearInterval(metricInterval);
        return;
      }
      const now = Date.now();
      const dt = (now - metricsRef.current.lastTime) / 1000;
      const hz = Math.round((metricsRef.current.currentCount - metricsRef.current.lastCount) / dt);
      
      const timeSinceLastPacket = now - lastPacketTimeRef.current;
      let newHealth = 'streaming';
      if (metricsRef.current.currentCount === 0) newHealth = 'waiting';
      else if (timeSinceLastPacket > 1500) newHealth = 'stale';

      setTelemetryHealth({
        rxRateHz: hz,
        rxPackets: metricsRef.current.currentCount,
        rxBytes: metricsRef.current.rxBytes,
        health: newHealth
      });

      metricsRef.current.lastCount = metricsRef.current.currentCount;
      metricsRef.current.lastTime = now;

      // Watchdog: If device is connected and streaming, but curve hasn't been received yet, retry up to 4 times
      if (pollingRef.current && metricsRef.current.currentCount > 5 && !hasReceivedCurveRef.current && curveFetchAttemptsRef.current < 4) {
        curveFetchAttemptsRef.current++;
        transferOutSafe(new Uint8Array([CMD_GET_CURVE]));
      }
    }, 1000);

    // Write loop (hybrid: autonomous stream detection + fallback ping for older firmware)
    const writeLoop = async () => {
      while (pollingRef.current) {
        if (!isSavingRef.current && !isCommandInProgressRef.current) {
          const now = Date.now();
          const msSinceLastPacket = now - lastPacketTimeRef.current;

          // Watchdog heartbeat recovery: if no packet received for > 1200ms, reset queue to unstick pipeline
          if (msSinceLastPacket > 1200 && metricsRef.current.currentCount > 0) {
            outQueueRef.current = Promise.resolve();
          }

          // If device is actively streaming autonomously (packet arrived < 80ms ago),
          // DO NOT write CMD_GET_STATUS! Keep the TX pipe completely idle to prevent collisions.
          // Only ping if packets have stopped or we are connected to older firmware that requires polling.
          if (msSinceLastPacket >= 80) {
            await transferOutSafe(new Uint8Array([CMD_GET_STATUS]));
          }
        }
        await delayNextTick(16);
      }
    };
    writeLoop();

    // Read loop
    readLoopPromiseRef.current = (async () => {
      while (pollingRef.current && p.readable) {
        try {
          const reader = readerRef.current;
          if (!reader) break;
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            metricsRef.current.rxBytes += value.byteLength;
            const { packets, leftover } = processIncomingBytes(leftoverRef.current, value);
            leftoverRef.current = leftover;

            if (packets.length > 0) {
              const now = Date.now();
              lastPacketTimeRef.current = now;
              metricsRef.current.currentCount += packets.length;
              consecutiveErrors = 0;

              let latestStatus = null;
              let calStatusOverride = null;
              for (const pkt of packets) {
                if (pkt.type === 'status') {
                  latestStatus = pkt.data;
                } else if (pkt.type === 'curve') {
                  hasReceivedCurveRef.current = true;
                  const pts = Array.isArray(pkt.data?.pts) ? pkt.data.pts : (Array.isArray(pkt.data) ? pkt.data : null);
                  if (pts && pts.length >= 4) {
                    const normPts = pts.length === 4 
                      ? [{ x: 0.0, y: 0.0 }, ...pts, { x: 1.0, y: 1.0 }]
                      : pts;
                    setCurvePoints(normPts);
                    curvePointsRef.current = normPts;
                  }
                  const t = typeof pkt.data?.curveType === 'number' ? (pkt.data.curveType === 1 ? 1 : 0) : 0;
                  setCurveType(t);
                  curveTypeRef.current = t;
                  console.log('[WebSerial] Curve loaded from MCU EEPROM:', curvePointsRef.current, 'type:', t);
                  window.dispatchEvent(new CustomEvent('microclutch-curve-loaded', { 
                    detail: { pts: curvePointsRef.current, curveType: t } 
                  }));
                } else if (pkt.type === 'cal_status') {
                  if (pkt.data.status === 0) {
                    calStatusOverride = 1;
                  } else if (pkt.data.status === 2 || pkt.data.status === 3) {
                    calStatusOverride = 0;
                  }
                }
              }

              if (calStatusOverride !== null) {
                setStatus(prev => ({ ...prev, isCalibrating: calStatusOverride }));
              }

              if (latestStatus) {
                // Outdated firmware safety guard: check immediately before setting connected state or dispatching telemetry
                if (isFirmwareOutdated(latestStatus.fwVersion)) {
                  console.warn(`Outdated firmware detected (v${latestStatus.fwVersion}). Disconnecting immediately.`);
                  window.dispatchEvent(new CustomEvent('microclutch-outdated-firmware', {
                    detail: { version: latestStatus.fwVersion }
                  }));
                  disconnect();
                  return;
                }

                // Initial handshake confirmed with compatible firmware!
                setIsConnected(true);
                setIsConnecting(false);

                // Prompt curve fetch if not yet received
                if (!hasReceivedCurveRef.current && curveFetchAttemptsRef.current < 4) {
                  curveFetchAttemptsRef.current++;
                  transferOutSafe(new Uint8Array([CMD_GET_CURVE]));
                }

                if (calStatusOverride !== null) {
                  latestStatus.isCalibrating = calStatusOverride;
                }
                window.dispatchEvent(new CustomEvent('microclutch-telemetry', { detail: latestStatus }));
                
                const nowTime = Date.now();
                if (nowTime - lastUiUpdateTimeRef.current > 200) { // low-freq react updates (5hz)
                  setStatus(latestStatus);
                  lastUiUpdateTimeRef.current = nowTime;
                }
              }
            }
          }
        } catch (err) {
          if (!pollingRef.current) break;
          console.warn('Serial read warning:', err);
          consecutiveErrors++;
          if (consecutiveErrors >= 5) {
            break;
          }
          await delayNextTick(50);
        }
      }

      if (readerRef.current) {
        try {
          readerRef.current.releaseLock();
        } catch (_) {}
        readerRef.current = null;
      }
    })();

    await readLoopPromiseRef.current;
    clearInterval(metricInterval);
    if (pollingRef.current && !isDisconnectingRef.current) {
      disconnect();
    }
  };

  const startCalibration = async () => {
    setStatus(prev => ({ ...prev, isCalibrating: 1 }));
    lastPacketTimeRef.current = Date.now();
    await executeCommandSafe(async () => {
      await transferOutSafe(new Uint8Array([CMD_START_CAL]));
    });
  };

  const stopCalibration = async () => {
    setStatus(prev => ({ ...prev, isCalibrating: 0 }));
    lastPacketTimeRef.current = Date.now();
    await executeCommandSafe(async () => {
      await transferOutSafe(new Uint8Array([CMD_STOP_CAL]));
    });
  };

  const requestCurve = useCallback(async () => {
    if (!writerRef.current || !portRef.current) return false;
    return await executeCommandSafe(async () => {
      return await transferOutSafe(new Uint8Array([CMD_GET_CURVE]));
    });
  }, []);

  const sendCurveToDevice = async (points, type) => {
    if (!writerRef.current) return false;
    const pts = points || curvePointsRef.current;
    const t = type !== undefined ? type : curveTypeRef.current;
    if (pts.length === 6) {
      const buf = new ArrayBuffer(50);
      const view = new DataView(buf);
      view.setUint8(0, CMD_SET_CURVE);
      for (let i = 0; i < 6; i++) {
        view.setFloat32(1 + i * 8, pts[i]?.x ?? 0, true);
        view.setFloat32(5 + i * 8, pts[i]?.y ?? 0, true);
      }
      view.setUint8(49, t);
      return await transferOutSafe(new Uint8Array(buf));
    } else {
      const buf = new ArrayBuffer(34);
      const view = new DataView(buf);
      view.setUint8(0, CMD_SET_CURVE);
      for (let i = 0; i < 4; i++) {
        view.setFloat32(1 + i * 8, pts[i]?.x ?? 0, true);
        view.setFloat32(5 + i * 8, pts[i]?.y ?? 0, true);
      }
      view.setUint8(33, t);
      return await transferOutSafe(new Uint8Array(buf));
    }
  };

  const saveCurve = async (overridePoints, overrideType) => {
    if (writerRef.current) {
      isSavingRef.current = true;
      try {
        const pts = overridePoints || curvePointsRef.current;
        const t = overrideType !== undefined ? overrideType : curveTypeRef.current;
        await sendCurveToDevice(pts, t);
        await delayNextTick(30);
        await transferOutSafe(new Uint8Array([CMD_SAVE_CURVE]));
        await new Promise(r => setTimeout(r, 150));
        // Verify persisted curve directly from MCU EEPROM
        await delayNextTick(20);
        await transferOutSafe(new Uint8Array([CMD_GET_CURVE]));
      } finally {
        isSavingRef.current = false;
      }
    }
  };

  const resetCurve = async () => {
    setCurvePoints(DEFAULT_CURVE_POINTS);
    curvePointsRef.current = DEFAULT_CURVE_POINTS;
    setCurveType(0);
    curveTypeRef.current = 0;
    if (writerRef.current) {
      await executeCommandSafe(async () => {
        await transferOutSafe(new Uint8Array([CMD_RESET_CURVE]));
      });
    }
  };

  const setCalRange = async (newMin, newMax) => {
    const validMin = Math.round(newMin);
    const validMax = Math.round(newMax);
    setStatus(prev => ({ ...prev, calMin: validMin, calMax: validMax }));
    if (writerRef.current) {
      const buf = new ArrayBuffer(5);
      const view = new DataView(buf);
      view.setUint8(0, CMD_SET_CAL);
      view.setUint16(1, validMin, true);
      view.setUint16(3, validMax, true);
      return await executeCommandSafe(async () => {
        return await transferOutSafe(new Uint8Array(buf));
      });
    }
    return true;
  };

  const setPollingRate = async (newHz) => {
    const validHz = Math.max(1, Math.min(7400, Math.round(newHz)));
    setStatus(prev => ({ ...prev, pollingRate: validHz, pollingRateHz: validHz }));
    if (writerRef.current) {
      const buf = new ArrayBuffer(3);
      const view = new DataView(buf);
      view.setUint8(0, CMD_SET_POLLING_RATE);
      view.setUint16(1, validHz, true);
      return await executeCommandSafe(async () => {
        return await transferOutSafe(new Uint8Array(buf));
      });
    }
    return true;
  };

  const setCurve = async (points) => {
    if (!Array.isArray(points) || (points.length !== 4 && points.length !== 6)) return;
    curvePointsRef.current = points;
    setCurvePoints(points); // Local state only
  };

  const updateCurveType = async (newType) => {
    const t = newType === 1 ? 1 : 0;
    curveTypeRef.current = t;
    setCurveType(t); // Local state only
  };

  useEffect(() => {
    return () => disconnect();
  }, [disconnect]);

  return {
    isConnected,
    isConnecting,
    isSupported,
    status,
    telemetryHealth,
    curvePoints,
    curveType,
    setCurveType: updateCurveType,
    connect,
    disconnect,
    startCalibration,
    stopCalibration,
    setCurve,
    getCurve: requestCurve,
    sendCurveToDevice,
    saveCurve,
    resetCurve,
    setCalRange,
    setPollingRate
  };
}
