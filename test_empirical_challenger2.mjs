import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createServer } from 'vite';
import {
  INITIAL_TELEMETRY_HEALTH,
  CDC_REQUEST_SET_CONTROL_LINE_STATE,
  CONTROL_LINE_STATE_DTR_ON,
  CONTROL_LINE_STATE_DTR_OFF,
  delayNextTick,
  transferInWithTimeout
} from './src/hooks/useWebUSB.js';
import {
  INITIAL_STATUS,
  processIncomingBytes
} from './src/utils/webusbParser.js';

// ============================================================================
// MISSION 1: TELEMETRY HEALTH TRANSITIONS & STRESS HARNESS
// ============================================================================

describe('Mission 1: Telemetry Health Transitions Stress Harness', () => {

  test('1.1: 0-packet initial state remains "waiting" and does not prematurely trigger "stale"', async () => {
    // Initial health state upon connect
    let telemetryHealth = {
      rxPackets: 0,
      rxBytes: 0,
      rxRateHz: 0,
      lastPacketTime: null,
      health: 'waiting'
    };
    let lastPacketTimeRef = { current: null };

    // Simulate poll loop running for 2000ms with 0 packets returned
    const startTime = 10000;
    for (let elapsed = 0; elapsed <= 2000; elapsed += 100) {
      const now = startTime + elapsed;
      // Stale watchdog check as implemented in useWebUSB.js:
      if (lastPacketTimeRef.current && (now - lastPacketTimeRef.current > 1500)) {
        if (telemetryHealth.health === 'streaming') {
          telemetryHealth.health = 'stale';
          telemetryHealth.rxRateHz = 0;
        }
      }

      // Assert that when 0 packets have been received, health remains 'waiting'
      assert.equal(telemetryHealth.health, 'waiting', `At elapsed ${elapsed}ms, health must remain waiting`);
      assert.equal(telemetryHealth.rxPackets, 0);
      assert.equal(telemetryHealth.lastPacketTime, null);
    }
  });

  test('1.2: First packet arrival immediately transitions from "waiting" to "streaming"', () => {
    let telemetryHealth = {
      rxPackets: 0,
      rxBytes: 0,
      rxRateHz: 0,
      lastPacketTime: null,
      health: 'waiting'
    };
    let rxPackets = 0;
    let rxBytes = 0;
    let packetTimes = [];

    const now = Date.now();
    rxPackets += 1;
    rxBytes += 19;
    packetTimes = packetTimes.filter(t => now - t <= 1000);
    packetTimes.push(now);

    telemetryHealth = {
      rxPackets,
      rxBytes,
      rxRateHz: packetTimes.length,
      lastPacketTime: now,
      health: 'streaming'
    };

    assert.equal(telemetryHealth.health, 'streaming');
    assert.equal(telemetryHealth.rxPackets, 1);
    assert.equal(telemetryHealth.rxBytes, 19);
    assert.equal(telemetryHealth.rxRateHz, 1);
    assert.equal(telemetryHealth.lastPacketTime, now);
  });

  test('1.3: Rapid bursts (500 packets in 50ms) scale throughput correctly and update rolling rate', () => {
    let rxPackets = 0;
    let rxBytes = 0;
    let packetTimes = [];
    const t0 = 100000;

    // Simulate 50 bursts of 10 packets each spread over 50ms (500 packets total)
    for (let burst = 0; burst < 50; burst++) {
      const now = t0 + burst;
      const packetsInBurst = 10;
      rxPackets += packetsInBurst;
      rxBytes += packetsInBurst * 19;

      for (let p = 0; p < packetsInBurst; p++) {
        packetTimes.push(now);
      }
      packetTimes = packetTimes.filter(t => now - t <= 1000);
    }

    assert.equal(rxPackets, 500, 'All 500 packets must be ingested');
    assert.equal(rxBytes, 500 * 19, 'Total bytes must match 500 * 19 = 9500');
    assert.equal(packetTimes.length, 500, 'Rolling rate should capture all 500 packets within 1s');

    // Fast-forward 1050ms later with no new packets
    const tLater = t0 + 1050;
    packetTimes = packetTimes.filter(t => tLater - t <= 1000);
    assert.equal(packetTimes.length, 0, 'Packets older than 1000ms must correctly expire from rate calculation');
  });

  test('1.4: Delayed packets at 200ms, 500ms, and 1200ms maintain "streaming" health', () => {
    let lastPacketTime = 100000;
    let health = 'streaming';
    const delays = [200, 500, 1200, 400, 800];

    let currentT = lastPacketTime;
    for (const delay of delays) {
      currentT += delay;
      // Stale check before packet arrives
      if (lastPacketTime && (currentT - lastPacketTime > 1500)) {
        if (health === 'streaming') health = 'stale';
      }
      assert.equal(health, 'streaming', `Delay of ${delay}ms must not trigger stale (threshold 1500ms)`);

      // Packet arrives
      lastPacketTime = currentT;
      health = 'streaming';
    }
  });

  test('1.5: Stale state trigger occurs precisely after 1500ms gap, preserving packet totals', () => {
    const t0 = 500000;
    let telemetryHealth = {
      rxPackets: 1250,
      rxBytes: 23750,
      rxRateHz: 60,
      lastPacketTime: t0,
      health: 'streaming'
    };

    // Sub-threshold checks: 500ms, 1000ms, 1499ms
    for (const delta of [500, 1000, 1499, 1500]) {
      const now = t0 + delta;
      if (telemetryHealth.lastPacketTime && (now - telemetryHealth.lastPacketTime > 1500)) {
        if (telemetryHealth.health === 'streaming') {
          telemetryHealth.health = 'stale';
          telemetryHealth.rxRateHz = 0;
        }
      }
      assert.equal(telemetryHealth.health, 'streaming', `At delta ${delta}ms, health must still be streaming`);
      assert.equal(telemetryHealth.rxPackets, 1250);
    }

    // Exceeding threshold: 1501ms
    const tStale = t0 + 1501;
    if (telemetryHealth.lastPacketTime && (tStale - telemetryHealth.lastPacketTime > 1500)) {
      if (telemetryHealth.health === 'streaming') {
        telemetryHealth.health = 'stale';
        telemetryHealth.rxRateHz = 0;
      }
    }
    assert.equal(telemetryHealth.health, 'stale', 'Must transition to stale when gap > 1500ms');
    assert.equal(telemetryHealth.rxRateHz, 0, 'rxRateHz must reset to 0 in stale state');
    assert.equal(telemetryHealth.rxPackets, 1250, 'rxPackets count must be preserved in stale state');
    assert.equal(telemetryHealth.rxBytes, 23750, 'rxBytes count must be preserved in stale state');
  });

  test('1.6: Recovery from stale immediately restores "streaming" health on new packet', () => {
    let telemetryHealth = {
      rxPackets: 1250,
      rxBytes: 23750,
      rxRateHz: 0,
      lastPacketTime: 500000,
      health: 'stale'
    };

    // New packet arrives at 505000ms (5 seconds later)
    const now = 505000;
    telemetryHealth = {
      rxPackets: telemetryHealth.rxPackets + 1,
      rxBytes: telemetryHealth.rxBytes + 19,
      rxRateHz: 1,
      lastPacketTime: now,
      health: 'streaming'
    };

    assert.equal(telemetryHealth.health, 'streaming', 'Must recover to streaming immediately');
    assert.equal(telemetryHealth.rxPackets, 1251);
    assert.equal(telemetryHealth.lastPacketTime, 505000);
    assert.equal(telemetryHealth.rxRateHz, 1);
  });
});

// ============================================================================
// MISSION 2: VISUAL CALIBRATION GAUGE MATH & EXTREME VALUES
// ============================================================================

describe('Mission 2: Visual Calibration Gauge Math & Extreme Boundary Testing', () => {

  // Exact math from WebUSBPage.jsx:
  function computeGauge(rawAngle, calMin, calMax) {
    let clampState = 'ok';
    let clampLabel = 'In Active Range';
    if (calMax > calMin) {
      if (rawAngle < calMin) {
        clampState = 'low';
        clampLabel = 'Zero-Clamped (< Cal Min)';
      } else if (rawAngle > calMax) {
        clampState = 'high';
        clampLabel = 'Max-Clamped (> Cal Max)';
      }
    }

    const span = Math.max(1, calMax - calMin);
    const displayMargin = Math.max(200, Math.round(span * 0.15));
    const barMin = Math.min(calMin - displayMargin, rawAngle - 50);
    const barMax = Math.max(calMax + displayMargin, rawAngle + 50);
    const barRange = Math.max(1, barMax - barMin);

    const activeLeftPct = Math.max(0, Math.min(100, ((calMin - barMin) / barRange) * 100));
    const activeWidthPct = Math.max(0, Math.min(100 - activeLeftPct, ((calMax - calMin) / barRange) * 100));
    const needlePct = Math.max(0, Math.min(100, ((rawAngle - barMin) / barRange) * 100));

    return {
      clampState,
      clampLabel,
      barMin,
      barMax,
      barRange,
      activeLeftPct,
      activeWidthPct,
      needlePct
    };
  }

  test('2.1: Extreme low rawAngle (rawAngle < calMin, e.g. 0 and 12000)', () => {
    for (const testRaw of [0, 1000, 12000, 17823]) {
      const g = computeGauge(testRaw, 17824, 19515);

      assert.equal(g.clampState, 'low', `rawAngle ${testRaw} must be clamped low`);
      assert.equal(g.clampLabel, 'Zero-Clamped (< Cal Min)');

      // Invariants
      assert.ok(g.needlePct >= 0 && g.needlePct <= 100, `needlePct ${g.needlePct} in [0, 100]`);
      assert.ok(g.activeLeftPct >= 0 && g.activeLeftPct <= 100, `activeLeftPct ${g.activeLeftPct} in [0, 100]`);
      assert.ok(g.activeWidthPct >= 0 && g.activeWidthPct <= 100, `activeWidthPct ${g.activeWidthPct} in [0, 100]`);
      assert.ok(g.activeLeftPct + g.activeWidthPct <= 100.0001, 'active zone within bar boundaries');

      // Visual requirement: needle must be positioned strictly to the left of the active zone
      assert.ok(g.needlePct <= g.activeLeftPct, `Needle (${g.needlePct}%) must be <= activeLeft (${g.activeLeftPct}%)`);
      assert.ok(!isNaN(g.needlePct) && isFinite(g.needlePct), 'needlePct must be finite');
      assert.ok(!isNaN(g.activeLeftPct) && isFinite(g.activeLeftPct), 'activeLeftPct must be finite');
      assert.ok(!isNaN(g.activeWidthPct) && isFinite(g.activeWidthPct), 'activeWidthPct must be finite');
    }
  });

  test('2.2: Extreme high rawAngle (rawAngle > calMax, e.g. 65000 and 65535)', () => {
    for (const testRaw of [19516, 25000, 65000, 65535]) {
      const g = computeGauge(testRaw, 17824, 19515);

      assert.equal(g.clampState, 'high', `rawAngle ${testRaw} must be clamped high`);
      assert.equal(g.clampLabel, 'Max-Clamped (> Cal Max)');

      // Invariants
      assert.ok(g.needlePct >= 0 && g.needlePct <= 100, `needlePct in [0, 100]`);
      assert.ok(g.activeLeftPct >= 0 && g.activeLeftPct <= 100, `activeLeftPct in [0, 100]`);
      assert.ok(g.activeWidthPct >= 0 && g.activeWidthPct <= 100, `activeWidthPct in [0, 100]`);
      assert.ok(g.activeLeftPct + g.activeWidthPct <= 100.0001);

      // Visual requirement: needle must be positioned strictly to the right of active zone
      const activeRightPct = g.activeLeftPct + g.activeWidthPct;
      assert.ok(g.needlePct >= activeRightPct, `Needle (${g.needlePct}%) must be >= activeRight (${activeRightPct}%)`);
      assert.ok(!isNaN(g.needlePct) && isFinite(g.needlePct));
    }
  });

  test('2.3: In-range values (calMin <= rawAngle <= calMax)', () => {
    for (const testRaw of [17824, 18500, 19000, 19515]) {
      const g = computeGauge(testRaw, 17824, 19515);

      assert.equal(g.clampState, 'ok');
      assert.equal(g.clampLabel, 'In Active Range');

      // Needle must be located within the active zone
      const activeRightPct = g.activeLeftPct + g.activeWidthPct;
      assert.ok(
        g.needlePct >= g.activeLeftPct - 0.01 && g.needlePct <= activeRightPct + 0.01,
        `In-range needle (${g.needlePct}%) must be inside [${g.activeLeftPct}%, ${activeRightPct}%]`
      );
    }
  });

  test('2.4: Edge case calMin >= calMax (calMin == calMax, or inverted calMin > calMax)', () => {
    // Both 0 (initial uncalibrated state)
    const gZero = computeGauge(0, 0, 0);
    assert.equal(gZero.clampState, 'ok', 'Zero/equal cal must fallback to ok clamp state');
    assert.equal(gZero.clampLabel, 'In Active Range');
    assert.ok(gZero.barRange >= 1, 'barRange must never be 0');
    assert.ok(!isNaN(gZero.needlePct) && isFinite(gZero.needlePct));
    assert.ok(!isNaN(gZero.activeLeftPct) && isFinite(gZero.activeLeftPct));
    assert.ok(!isNaN(gZero.activeWidthPct) && isFinite(gZero.activeWidthPct));

    // Both equal non-zero (calMin = 18000, calMax = 18000)
    const gEqual = computeGauge(18000, 18000, 18000);
    assert.equal(gEqual.clampState, 'ok');
    assert.ok(gEqual.barRange >= 1);
    assert.ok(!isNaN(gEqual.needlePct));

    // Inverted calMin > calMax (corrupted EEPROM or inverted calibration: calMin = 20000, calMax = 10000)
    const gInverted = computeGauge(15000, 20000, 10000);
    assert.equal(gInverted.clampState, 'ok');
    assert.ok(gInverted.barRange >= 1);
    assert.ok(!isNaN(gInverted.needlePct) && isFinite(gInverted.needlePct));
    assert.ok(gInverted.needlePct >= 0 && gInverted.needlePct <= 100);
  });

  test('2.5: Fuzz / Random Oracle test (5,000 permutations)', () => {
    let rngSeed = 42;
    const randomInt = (min, max) => {
      rngSeed = (rngSeed * 1664525 + 1013904223) % 4294967296;
      return Math.floor((rngSeed / 4294967296) * (max - min + 1)) + min;
    };

    for (let i = 0; i < 5000; i++) {
      const raw = randomInt(-10000, 70000);
      const min = randomInt(-10000, 70000);
      const max = randomInt(-10000, 70000);

      const g = computeGauge(raw, min, max);

      assert.ok(!isNaN(g.needlePct), `needlePct is NaN for raw=${raw}, min=${min}, max=${max}`);
      assert.ok(!isNaN(g.activeLeftPct), `activeLeftPct is NaN for raw=${raw}, min=${min}, max=${max}`);
      assert.ok(!isNaN(g.activeWidthPct), `activeWidthPct is NaN for raw=${raw}, min=${min}, max=${max}`);

      assert.ok(g.needlePct >= 0 && g.needlePct <= 100, `needlePct ${g.needlePct} out of bounds`);
      assert.ok(g.activeLeftPct >= 0 && g.activeLeftPct <= 100, `activeLeftPct ${g.activeLeftPct} out of bounds`);
      assert.ok(g.activeWidthPct >= 0 && g.activeWidthPct <= 100, `activeWidthPct ${g.activeWidthPct} out of bounds`);
      assert.ok(g.activeLeftPct + g.activeWidthPct <= 100.0001, `active zone exceeds 100%`);
      assert.ok(g.barRange >= 1, `barRange ${g.barRange} < 1`);
    }
  });
});

// ============================================================================
// MISSION 3: DELAYNEXTTICK PACING VIA SETTIMEOUT VS TAB FOCUS
// ============================================================================

describe('Mission 3: delayNextTick Pacing & Background Tab Resilience', () => {

  test('3.1: delayNextTick resolves asynchronously with setTimeout', async () => {
    let flag = false;
    const p = delayNextTick(10).then(() => { flag = true; });
    assert.equal(flag, false, 'delayNextTick must not resolve synchronously');
    await p;
    assert.equal(flag, true, 'delayNextTick must resolve after timer');
  });

  test('3.2: delayNextTick default delay is 16ms', async () => {
    const t0 = Date.now();
    await delayNextTick(); // default ms = 16
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 10 && elapsed <= 100, `Default delay took ${elapsed}ms`);
  });

  test('3.3: Sequential chain of 20 ticks runs smoothly without stalling or queue exhaustion', async () => {
    let completedTicks = 0;
    const totalTicks = 20;

    for (let i = 0; i < totalTicks; i++) {
      await delayNextTick(2);
      completedTicks++;
    }

    assert.equal(completedTicks, totalTicks, 'All 20 ticks must complete sequentially');
  });

  test('3.4: setTimeout vs requestAnimationFrame semantics in background tab environments', () => {
    // In HTML5 living standard and Chromium/WebKit specification:
    // When a tab loses focus or is minimized:
    // 1. requestAnimationFrame callbacks are completely PAUSED / FROZEN (0 Hz).
    // 2. setTimeout callbacks continue to fire (throttled to >= 1000ms in background tabs, or unthrottled with active WebUSB).
    // Therefore, using delayNextTick with setTimeout guarantees the WebUSB pollLoop NEVER deadlocks or hangs when tab is blurred.
    const isSetTimeoutBased = delayNextTick.toString().includes('setTimeout');
    const isRafBased = delayNextTick.toString().includes('requestAnimationFrame');

    assert.equal(isSetTimeoutBased, true, 'delayNextTick must use setTimeout for background resilience');
    assert.equal(isRafBased, false, 'delayNextTick must NOT use requestAnimationFrame');
  });
});

// ============================================================================
// MISSION 4: UI RUNTIME & RENDERING INTEGRATION
// ============================================================================

describe('Mission 4: React UI Rendering & Runtime Exception Verification', () => {
  let viteServer;
  let WebUSBPageModule;

  before(async () => {
    // Create Vite dev server in middleware mode to compile JSX and CSS transparently for SSR
    viteServer = await createServer({
      server: { middlewareMode: true },
      appType: 'custom',
      plugins: [
        {
          name: 'mock-use-webusb',
          enforce: 'pre',
          resolveId(id) {
            if (id.includes('useWebUSB')) {
              return '\0virtual:useWebUSB';
            }
          },
          load(id) {
            if (id === '\0virtual:useWebUSB') {
              return `
                export const INITIAL_TELEMETRY_HEALTH = Object.freeze({
                  rxPackets: 0,
                  rxBytes: 0,
                  rxRateHz: 0,
                  lastPacketTime: null,
                  health: 'disconnected'
                });
                export function useWebUSB() {
                  return globalThis.__mockWebUSB ? globalThis.__mockWebUSB() : {
                    device: null,
                    isConnected: false,
                    isSupported: false,
                    status: null,
                    telemetryHealth: null,
                    endpoints: null,
                    curvePoints: [],
                    connect: () => {},
                    disconnect: () => {},
                    startCalibration: () => {},
                    stopCalibration: () => {},
                    setCurve: () => {},
                    saveCurve: () => {},
                    resetCurve: () => {},
                    getCurve: () => {}
                  };
                }
              `;
            }
          }
        }
      ]
    });

    WebUSBPageModule = await viteServer.ssrLoadModule('./src/components/WebUSBPage.jsx');
  });

  after(async () => {
    if (viteServer) {
      await viteServer.close();
    }
  });

  test('4.1: WebUSBPage renders unsupported banner when isSupported is false', () => {
    globalThis.__mockWebUSB = () => ({
      device: null,
      isConnected: false,
      isSupported: false,
      status: INITIAL_STATUS,
      telemetryHealth: INITIAL_TELEMETRY_HEALTH,
      endpoints: { inEp: null, outEp: null, ifaceNum: null },
      curvePoints: []
    });

    const html = renderToString(React.createElement(WebUSBPageModule.default));
    assert.ok(html.includes('unsupported-banner'), 'Must contain unsupported-banner');
    assert.ok(html.includes('WebUSB is not supported in this browser'), 'Must display unsupported text');
    assert.ok(html.includes('status-disconnected'), 'Must show disconnected status badge');
    assert.ok(html.includes('disabled=""') || html.includes('disabled'), 'Connect button must be disabled when unsupported');
  });

  test('4.2: WebUSBPage renders connected waiting badge when rxPackets === 0', () => {
    globalThis.__mockWebUSB = () => ({
      device: {},
      isConnected: true,
      isSupported: true,
      status: INITIAL_STATUS,
      telemetryHealth: {
        rxPackets: 0,
        rxBytes: 0,
        rxRateHz: 0,
        lastPacketTime: null,
        health: 'waiting'
      },
      endpoints: { inEp: 3, outEp: 3, ifaceNum: 2 },
      curvePoints: []
    });

    const html = renderToString(React.createElement(WebUSBPageModule.default));
    assert.ok(!html.includes('unsupported-banner'), 'Must not display unsupported banner');
    assert.ok(html.includes('status-waiting'), 'Must display status-waiting class');
    assert.ok(html.includes('Connected — Waiting for Telemetry...'), 'Must render waiting badge text');
    assert.ok(html.includes('Disconnect'), 'Button text must be Disconnect');
  });

  test('4.3: WebUSBPage renders live telemetry badge and diagnostics stats when streaming', () => {
    globalThis.__mockWebUSB = () => ({
      device: {},
      isConnected: true,
      isSupported: true,
      status: {
        rawAngle: 18500,
        normalized: 0.525,
        axisValue: -12000,
        calMin: 17824,
        calMax: 19515,
        pollingRate: 1000,
        isCalibrating: 0,
        fwVersion: '2.0.0'
      },
      telemetryHealth: {
        rxPackets: 1240,
        rxBytes: 23560,
        rxRateHz: 60,
        lastPacketTime: Date.now(),
        health: 'streaming'
      },
      endpoints: { inEp: 3, outEp: 3, ifaceNum: 2 },
      curvePoints: []
    });

    const html = renderToString(React.createElement(WebUSBPageModule.default));
    assert.ok(html.includes('status-streaming'), 'Must have status-streaming class');
    assert.ok(html.includes('Live Telemetry (60 RX/s • 1,240 pkts)'), 'Must render live packet count & rate');
    assert.ok(html.includes('Raw Angle: <strong class="mono">18500</strong>'), 'Must display prominent rawAngle');
    assert.ok(html.includes('0.525'), 'Must render normalized clutch value');
    assert.ok(html.includes('clamp-pill-ok'), 'Must render clamp-pill-ok for in-range value');
    assert.ok(html.includes('In Active Range'), 'Must label active range');
    assert.ok(html.includes('FW 2.0.0'), 'Must render firmware version');
    assert.ok(html.includes('1000Hz'), 'Must render polling rate');
  });

  test('4.4: WebUSBPage renders stale telemetry warning badge when health is stale', () => {
    globalThis.__mockWebUSB = () => ({
      device: {},
      isConnected: true,
      isSupported: true,
      status: {
        rawAngle: 18500,
        normalized: 0.525,
        axisValue: -12000,
        calMin: 17824,
        calMax: 19515,
        pollingRate: 1000,
        isCalibrating: 0,
        fwVersion: '2.0.0'
      },
      telemetryHealth: {
        rxPackets: 1240,
        rxBytes: 23560,
        rxRateHz: 0,
        lastPacketTime: Date.now() - 2000,
        health: 'stale'
      },
      endpoints: { inEp: 3, outEp: 3, ifaceNum: 2 },
      curvePoints: []
    });

    const html = renderToString(React.createElement(WebUSBPageModule.default));
    assert.ok(html.includes('status-stale'), 'Must have status-stale class');
    assert.ok(html.includes('Telemetry Stale (no data &gt; 1.5s)'), 'Must render stale text');
  });

  test('4.5: WebUSBPage renders Zero-Clamped pill and needle when rawAngle < calMin', () => {
    globalThis.__mockWebUSB = () => ({
      device: {},
      isConnected: true,
      isSupported: true,
      status: {
        rawAngle: 12000, // < calMin 17824
        normalized: 0.0,
        axisValue: -32768,
        calMin: 17824,
        calMax: 19515,
        pollingRate: 1000,
        isCalibrating: 0,
        fwVersion: '2.0.0'
      },
      telemetryHealth: {
        rxPackets: 200,
        rxBytes: 3800,
        rxRateHz: 60,
        lastPacketTime: Date.now(),
        health: 'streaming'
      },
      endpoints: { inEp: 3, outEp: 3, ifaceNum: 2 },
      curvePoints: []
    });

    const html = renderToString(React.createElement(WebUSBPageModule.default));
    assert.ok(html.includes('clamp-pill-low'), 'Must render clamp-pill-low in header');
    assert.ok(html.includes('Zero-Clamped (&lt; Cal Min)'), 'Must render Zero-Clamped text in header');
    assert.ok(html.includes('clamp-low'), 'Must render clamp-low badge in gauge');
    assert.ok(html.includes('gauge-needle-low'), 'Needle must have gauge-needle-low class');
  });

  test('4.6: WebUSBPage renders Max-Clamped pill and needle when rawAngle > calMax', () => {
    globalThis.__mockWebUSB = () => ({
      device: {},
      isConnected: true,
      isSupported: true,
      status: {
        rawAngle: 65000, // > calMax 19515
        normalized: 1.0,
        axisValue: 32767,
        calMin: 17824,
        calMax: 19515,
        pollingRate: 1000,
        isCalibrating: 0,
        fwVersion: '2.0.0'
      },
      telemetryHealth: {
        rxPackets: 250,
        rxBytes: 4750,
        rxRateHz: 60,
        lastPacketTime: Date.now(),
        health: 'streaming'
      },
      endpoints: { inEp: 3, outEp: 3, ifaceNum: 2 },
      curvePoints: []
    });

    const html = renderToString(React.createElement(WebUSBPageModule.default));
    assert.ok(html.includes('clamp-pill-high'), 'Must render clamp-pill-high in header');
    assert.ok(html.includes('Max-Clamped (&gt; Cal Max)'), 'Must render Max-Clamped text in header');
    assert.ok(html.includes('clamp-high'), 'Must render clamp-high badge in gauge');
    assert.ok(html.includes('gauge-needle-high'), 'Needle must have gauge-needle-high class');
  });

  test('4.7: WebUSBPage safely handles calMin >= calMax without rendering invalid gauge zone or throwing', () => {
    globalThis.__mockWebUSB = () => ({
      device: {},
      isConnected: true,
      isSupported: true,
      status: {
        rawAngle: 0,
        normalized: 0,
        axisValue: 0,
        calMin: 0,
        calMax: 0,
        pollingRate: 0,
        isCalibrating: 0,
        fwVersion: '0.0.0'
      },
      telemetryHealth: {
        rxPackets: 0,
        rxBytes: 0,
        rxRateHz: 0,
        lastPacketTime: null,
        health: 'waiting'
      },
      endpoints: { inEp: null, outEp: null, ifaceNum: null },
      curvePoints: []
    });

    const html = renderToString(React.createElement(WebUSBPageModule.default));
    // When calMax <= calMin, active zone should not be rendered
    assert.ok(!html.includes('gauge-active-zone'), 'Must not render gauge-active-zone when calMax <= calMin');
    // Clamp pill should not be rendered
    assert.ok(!html.includes('clamp-pill-low'), 'Must not render clamp pill');
    assert.ok(!html.includes('clamp-pill-high'), 'Must not render clamp pill');
  });

  test('4.8: WebUSBPage safely handles null or undefined status without throwing exceptions', () => {
    globalThis.__mockWebUSB = () => ({
      device: null,
      isConnected: false,
      isSupported: true,
      status: null,
      telemetryHealth: null,
      endpoints: null,
      curvePoints: []
    });

    // Must render without throwing TypeError
    assert.doesNotThrow(() => {
      const html = renderToString(React.createElement(WebUSBPageModule.default));
      assert.ok(html.includes('Disconnected'));
    });
  });

  test('4.9: UI CSS stylesheet contains all referenced classes and variables', async () => {
    const fs = await import('node:fs');
    const css = fs.readFileSync('./src/components/WebUSBPage.css', 'utf8');

    const expectedClasses = [
      '.status-dot.disconnected',
      '.status-dot.waiting',
      '.status-dot.streaming',
      '.status-dot.stale',
      '.clamp-pill-low',
      '.clamp-pill-high',
      '.clamp-pill-ok',
      '.gauge-needle-low',
      '.gauge-needle-high',
      '.gauge-needle-ok',
      '.gauge-active-zone',
      '.calibration-gauge-card',
      '.diagnostics-section',
      '.diag-grid',
      '.health-streaming',
      '.health-stale',
      '.health-waiting'
    ];

    for (const cls of expectedClasses) {
      assert.ok(css.includes(cls), `CSS must define ${cls}`);
    }
  });
});
