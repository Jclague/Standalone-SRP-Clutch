import { useState, useRef, useEffect } from 'react';
import {
  VENDOR_ID,
  CMD_GET_STATUS,
  CMD_START_CAL,
  CMD_STOP_CAL,
  CMD_SET_CURVE,
  CMD_GET_CURVE,
  CMD_SAVE_CURVE,
  CMD_RESET_CURVE,
  INITIAL_STATUS,
  processIncomingBytes
} from '../utils/webusbParser.js';

export const INITIAL_TELEMETRY_HEALTH = Object.freeze({
  rxPackets: 0,
  rxBytes: 0,
  rxRateHz: 0,
  lastPacketTime: null,
  health: 'disconnected' // 'disconnected' | 'connecting' | 'waiting' | 'streaming' | 'stale'
});

export const CDC_REQUEST_SET_CONTROL_LINE_STATE = 0x22;
export const CONTROL_LINE_STATE_DTR_ON = 0x01;
export const CONTROL_LINE_STATE_DTR_OFF = 0x00;

export const delayNextTick = (ms = 16) => new Promise(resolve => setTimeout(resolve, ms));

export function transferInWithTimeout(dev, inEp, len, timeoutMs = 2000) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('USB transferIn timeout');
      err.name = 'TimeoutError';
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([
    dev.transferIn(inEp, len),
    timeoutPromise
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function useWebUSB() {
  const [device, setDevice] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [status, setStatus] = useState(INITIAL_STATUS);
  const [telemetryHealth, setTelemetryHealth] = useState(INITIAL_TELEMETRY_HEALTH);
  
  const [curvePoints, setCurvePoints] = useState([
    {x: 0.2, y: 0.2},
    {x: 0.4, y: 0.4},
    {x: 0.6, y: 0.6},
    {x: 0.8, y: 0.8}
  ]);
  const [curveType, setCurveType] = useState(0);

  const pollingRef = useRef(false);
  const connectingRef = useRef(false);
  const deviceRef = useRef(null);
  const endpointsRef = useRef({ inEp: null, outEp: null, ifaceNum: null });
  const leftoverRef = useRef(new Uint8Array(0));
  const outQueueRef = useRef(Promise.resolve());
  const isSavingRef = useRef(false);
  const rxPacketsRef = useRef(0);
  const rxBytesRef = useRef(0);
  const lastPacketTimeRef = useRef(null);
  const packetTimesRef = useRef([]);

  const getEndpointOut = () => {
    if (endpointsRef.current.outEp !== null) return endpointsRef.current.outEp;
    if (!deviceRef.current || !deviceRef.current.configuration) return null;
    for (const iface of deviceRef.current.configuration.interfaces) {
      const alt = iface.alternate || iface.alternates?.find(a => a.interfaceClass === 0xFF) || iface.alternates?.[0];
      if (alt && alt.interfaceClass === 0xFF) {
        const outEp = alt.endpoints.find(e => e.direction === 'out');
        if (outEp) return outEp.endpointNumber;
      }
    }
    return null;
  };

  const getEndpointIn = () => {
    if (endpointsRef.current.inEp !== null) return endpointsRef.current.inEp;
    if (!deviceRef.current || !deviceRef.current.configuration) return null;
    for (const iface of deviceRef.current.configuration.interfaces) {
      const alt = iface.alternate || iface.alternates?.find(a => a.interfaceClass === 0xFF) || iface.alternates?.[0];
      if (alt && alt.interfaceClass === 0xFF) {
        const inEp = alt.endpoints.find(e => e.direction === 'in');
        if (inEp) return inEp.endpointNumber;
      }
    }
    return null;
  };

  /**
   * Safely queues and transmits data across the USB OUT endpoint,
   * preventing concurrent transfer collisions on WinUSB/Chromium.
   */
  const transferOutSafe = (ep, data) => {
    if (ep === null) return Promise.resolve(null);
    const task = async () => {
      const dev = deviceRef.current;
      if (!dev || !dev.opened) return null;
      try {
        const res = await dev.transferOut(ep, data);
        if (res && res.status === 'stall') {
          await dev.clearHalt('out', ep);
        }
        return res;
      } catch (err) {
        console.warn('USB transferOut warning:', err);
        return null;
      }
    };
    outQueueRef.current = outQueueRef.current.then(task, task);
    return outQueueRef.current;
  };

  const connect = async () => {
    if (connectingRef.current || pollingRef.current || deviceRef.current) return;
    if (typeof navigator === 'undefined' || !navigator.usb) {
      console.error('WebUSB is not supported in this browser environment');
      return;
    }

    connectingRef.current = true;
    setTelemetryHealth(prev => ({ ...prev, health: 'connecting' }));
    let dev = null;
    try {
      dev = await navigator.usb.requestDevice({ filters: [{ vendorId: VENDOR_ID }] });
      await dev.open();
      if (dev.configuration === null) await dev.selectConfiguration(1);
      
      let vendorIface = null;
      for (const iface of dev.configuration.interfaces) {
        if (iface.alternate && iface.alternate.interfaceClass === 0xFF) {
          vendorIface = iface;
          break;
        } else if (iface.alternates) {
          const alt = iface.alternates.find(a => a.interfaceClass === 0xFF);
          if (alt) {
            vendorIface = iface;
            break;
          }
        }
      }

      if (!vendorIface) {
        console.error('Could not find vendor interface (class 0xFF)');
        await dev.close();
        return;
      }

      await dev.claimInterface(vendorIface.interfaceNumber);

      // Assert CDC control line state (DTR = 1) to enable Adafruit_USBD_WebUSB transmission
      await dev.controlTransferOut({
        requestType: 'class',
        recipient: 'interface',
        request: CDC_REQUEST_SET_CONTROL_LINE_STATE,
        value: CONTROL_LINE_STATE_DTR_ON,
        index: vendorIface.interfaceNumber
      });
      
      const altSetting = vendorIface.alternate || vendorIface.alternates?.find(a => a.interfaceClass === 0xFF) || vendorIface.alternates?.[0];
      const inEp = altSetting?.endpoints.find(e => e.direction === 'in');
      const outEp = altSetting?.endpoints.find(e => e.direction === 'out');
      
      if (!inEp || !outEp) {
        console.error('Could not find vendor endpoints');
        await dev.close();
        return;
      }
      
      endpointsRef.current = { 
        inEp: inEp.endpointNumber, 
        outEp: outEp.endpointNumber, 
        ifaceNum: vendorIface.interfaceNumber 
      };
      
      setDevice(dev);
      deviceRef.current = dev;
      setIsConnected(true);
      pollingRef.current = true;
      leftoverRef.current = new Uint8Array(0);
      outQueueRef.current = Promise.resolve();
      rxPacketsRef.current = 0;
      rxBytesRef.current = 0;
      lastPacketTimeRef.current = null;
      packetTimesRef.current = [];

      setTelemetryHealth({
        rxPackets: 0,
        rxBytes: 0,
        rxRateHz: 0,
        lastPacketTime: null,
        health: 'waiting'
      });
      
      await transferOutSafe(outEp.endpointNumber, new Uint8Array([CMD_GET_CURVE]));
      
      pollLoop(dev);
    } catch (err) {
      console.error(err);
      if (dev && dev.opened) {
        try { await dev.close(); } catch (_) {}
      }
      await disconnect();
    } finally {
      connectingRef.current = false;
    }
  };

  const disconnect = async () => {
    pollingRef.current = false;
    connectingRef.current = false;
    leftoverRef.current = new Uint8Array(0);
    outQueueRef.current = Promise.resolve();
    rxPacketsRef.current = 0;
    rxBytesRef.current = 0;
    lastPacketTimeRef.current = null;
    packetTimesRef.current = [];

    if (deviceRef.current) {
      try {
        if (deviceRef.current.opened && endpointsRef.current.ifaceNum !== null) {
          await deviceRef.current.controlTransferOut({
            requestType: 'class',
            recipient: 'interface',
            request: CDC_REQUEST_SET_CONTROL_LINE_STATE,
            value: CONTROL_LINE_STATE_DTR_OFF,
            index: endpointsRef.current.ifaceNum
          });
        }
      } catch (e) {
        console.warn('Error clearing control line state:', e);
      }
      try {
        await deviceRef.current.close();
      } catch (e) {
        console.warn('Error closing USB device:', e);
      }
    }
    setDevice(null);
    deviceRef.current = null;
    endpointsRef.current = { inEp: null, outEp: null, ifaceNum: null };
    setIsConnected(false);
    setStatus(INITIAL_STATUS);
    setTelemetryHealth(INITIAL_TELEMETRY_HEALTH);
  };

  const pollLoop = async (dev) => {
    leftoverRef.current = new Uint8Array(0);
    let consecutiveErrors = 0;

    while (pollingRef.current) {
      try {
        if (!isSavingRef.current) {
          const outEp = getEndpointOut();
          if (outEp !== null) {
            await transferOutSafe(outEp, new Uint8Array([CMD_GET_STATUS]));
          }
        }
        
        const inEp = getEndpointIn();
        if (inEp !== null && dev.opened) {
          const res = await transferInWithTimeout(dev, inEp, 64, 500);
          if (res && res.status === 'stall') {
            await dev.clearHalt('in', inEp);
          } else if (res && res.data && res.data.byteLength > 0) {
            const { packets, leftover } = processIncomingBytes(leftoverRef.current, res.data);
            leftoverRef.current = leftover;

            if (!pollingRef.current) break;

            if (packets.length > 0) {
              const now = Date.now();
              rxPacketsRef.current += packets.length;
              rxBytesRef.current += res.data.byteLength;
              lastPacketTimeRef.current = now;

              packetTimesRef.current = packetTimesRef.current.filter(t => now - t <= 1000);
              packetTimesRef.current.push(now);

              setTelemetryHealth({
                rxPackets: rxPacketsRef.current,
                rxBytes: rxBytesRef.current,
                rxRateHz: packetTimesRef.current.length,
                lastPacketTime: now,
                health: 'streaming'
              });
            }

            for (const pkt of packets) {
              if (!pollingRef.current) break;
              if (pkt.type === 'status') {
                setStatus(pkt.data);
              } else if (pkt.type === 'curve') {
                setCurvePoints(pkt.data.pts);
                setCurveType(pkt.data.curveType);
              } else if (pkt.type === 'cal_status') {
                if (pkt.data.status === 2 || pkt.data.status === 3) {
                  setStatus(prev => ({ ...prev, isCalibrating: 0 }));
                } else if (pkt.data.status === 0) {
                  setStatus(prev => ({ ...prev, isCalibrating: 1 }));
                }
              }
            }
          }
        }
        consecutiveErrors = 0;
      } catch (err) {
        if (!pollingRef.current) break;
        const isTimeout = err?.name === 'TimeoutError' || err?.message?.includes('timeout');
        if (!isTimeout) {
          consecutiveErrors++;
          console.warn(`Polling error (${consecutiveErrors}/5):`, err);
          // If device was closed or errors persist across 5 consecutive attempts, disconnect cleanly
          if (!dev.opened || consecutiveErrors >= 5) {
            disconnect();
            break;
          }
          await delayNextTick(50);
          continue;
        } else {
          // Timeout watchdog recovered without hanging loop
          const now = Date.now();
          if (lastPacketTimeRef.current && (now - lastPacketTimeRef.current > 1500)) {
            setTelemetryHealth(prev => ({
              ...prev,
              health: 'stale',
              rxRateHz: 0
            }));
          }
        }
      }

      // Check for stale telemetry if no packet arrived for > 1.5 seconds
      const now = Date.now();
      if (lastPacketTimeRef.current && (now - lastPacketTimeRef.current > 1500)) {
        setTelemetryHealth(prev => {
          if (prev.health === 'streaming') {
            return { ...prev, health: 'stale', rxRateHz: 0 };
          }
          return prev;
        });
      }

      await delayNextTick(16);
    }
  };

  useEffect(() => {
    const handleDisconnect = (event) => {
      if (deviceRef.current && event.device === deviceRef.current) {
        disconnect();
      }
    };
    if (typeof navigator !== 'undefined' && navigator.usb) {
      navigator.usb.addEventListener('disconnect', handleDisconnect);
      return () => {
        navigator.usb.removeEventListener('disconnect', handleDisconnect);
      };
    }
  }, []);

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, []);

  const startCalibration = async () => {
    const ep = getEndpointOut();
    if (ep !== null && deviceRef.current) {
      await transferOutSafe(ep, new Uint8Array([CMD_START_CAL]));
    }
  };

  const stopCalibration = async () => {
    const ep = getEndpointOut();
    if (ep !== null && deviceRef.current) {
      await transferOutSafe(ep, new Uint8Array([CMD_STOP_CAL]));
    }
  };

  const setCurve = async (points) => {
    if (!Array.isArray(points) || points.length !== 4) return;
    setCurvePoints(points); // Local state only
  };

  const updateCurveType = async (newType) => {
    setCurveType(newType); // Local state only
  };

  const getCurve = async () => {
    const ep = getEndpointOut();
    if (ep !== null && deviceRef.current) {
      await transferOutSafe(ep, new Uint8Array([CMD_GET_CURVE]));
    }
  };

  const saveCurve = async () => {
    const ep = getEndpointOut();
    if (ep !== null && deviceRef.current) {
      isSavingRef.current = true;
      try {
        // 1. Send the new curve to RAM
        const buf = new ArrayBuffer(34);
        const view = new DataView(buf);
        view.setUint8(0, CMD_SET_CURVE);
        for (let i = 0; i < 4; i++) {
          view.setFloat32(1 + i * 8, curvePoints[i]?.x ?? 0, true);
          view.setFloat32(5 + i * 8, curvePoints[i]?.y ?? 0, true);
        }
        view.setUint8(33, curveType);
        await transferOutSafe(ep, buf);
        await delayNextTick(30);
        
        // 2. Commit to EEPROM
        await transferOutSafe(ep, new Uint8Array([CMD_SAVE_CURVE]));
        await new Promise(r => setTimeout(r, 150));
      } finally {
        isSavingRef.current = false;
      }
    }
  };

  const resetCurve = async () => {
    const ep = getEndpointOut();
    if (ep !== null && deviceRef.current) {
      await transferOutSafe(ep, new Uint8Array([CMD_RESET_CURVE]));
    }
    setCurvePoints([
      {x: 0.2, y: 0.2},
      {x: 0.4, y: 0.4},
      {x: 0.6, y: 0.6},
      {x: 0.8, y: 0.8}
    ]);
    setCurveType(0);
  };

  const setCalRange = async (newMin, newMax) => {
    const validMin = Math.round(newMin);
    const validMax = Math.round(newMax);
    setStatus(prev => ({ ...prev, calMin: validMin, calMax: validMax }));
    const ep = getEndpointOut();
    if (ep !== null && deviceRef.current) {
      const buf = new ArrayBuffer(5);
      const view = new DataView(buf);
      view.setUint8(0, CMD_SET_CAL);
      view.setUint16(1, validMin, true);
      view.setUint16(3, validMax, true);
      return await transferOutSafe(ep, new Uint8Array(buf));
    }
    return true;
  };

  const setPollingRate = async (newHz) => {
    const validHz = Math.max(1, Math.min(7400, Math.round(newHz)));
    setStatus(prev => ({ ...prev, pollingRate: validHz }));
    const ep = getEndpointOut();
    if (ep !== null && deviceRef.current) {
      const buf = new ArrayBuffer(3);
      const view = new DataView(buf);
      view.setUint8(0, 0x09); // CMD_SET_POLLING_RATE
      view.setUint16(1, validHz, true);
      return await transferOutSafe(ep, new Uint8Array(buf));
    }
    return true;
  };

  return {
    device,
    isConnected,
    isSupported: typeof navigator !== 'undefined' && Boolean(navigator.usb),
    status,
    telemetryHealth,
    endpoints: endpointsRef.current,
    curvePoints,
    curveType,
    setCurveType: updateCurveType,
    connect,
    disconnect,
    startCalibration,
    stopCalibration,
    setCurve,
    saveCurve,
    resetCurve,
    setCalRange,
    setPollingRate,
    getCurve
  };
}
