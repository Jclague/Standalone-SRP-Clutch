import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_PACKET_LENGTH,
  CURVE_PACKET_LENGTH,
  CAL_STATUS_PACKET_LENGTH,
  ACK_PACKET_LENGTH,
  INITIAL_STATUS,
  MIN_FIRMWARE_VERSION,
  isFirmwareOutdated,
  parseStatusPacket,
  parseCurvePacket,
  parseCalStatusPacket,
  parseAckPacket,
  processIncomingBytes
} from './webusbParser.js';
import { computeSplineCoefficients, evaluateSpline } from './cubicSpline.js';

function createMockStatusBuffer(raw = 18500, norm = 0.525, ax = -12000, pollingRate = 1000) {
  const buf = new ArrayBuffer(19);
  const view = new DataView(buf);
  view.setUint8(0, 0x81);
  view.setUint16(1, raw, true);
  view.setFloat32(3, norm, true);
  view.setInt16(7, ax, true);
  view.setUint16(9, 17824, true);
  view.setUint16(11, 19515, true);
  view.setUint16(13, pollingRate, true);
  view.setUint8(15, 0);
  view.setUint8(16, 2);
  view.setUint8(17, 0);
  view.setUint8(18, 0);
  return new Uint8Array(buf);
}

function createMockCurveBuffer(points, curveType = 0) {
  const buf = new ArrayBuffer(34);
  const view = new DataView(buf);
  view.setUint8(0, 0x85);
  for (let i = 0; i < 4; i++) {
    view.setFloat32(1 + i * 8, points[i].x, true);
    view.setFloat32(5 + i * 8, points[i].y, true);
  }
  view.setUint8(33, curveType);
  return new Uint8Array(buf);
}

function createMockCurveBuffer6Pt(points, curveType = 0) {
  const buf = new ArrayBuffer(50);
  const view = new DataView(buf);
  view.setUint8(0, 0x85);
  for (let i = 0; i < 6; i++) {
    view.setFloat32(1 + i * 8, points[i].x, true);
    view.setFloat32(5 + i * 8, points[i].y, true);
  }
  view.setUint8(49, curveType);
  return new Uint8Array(buf);
}

describe('WebUSB / Serial Protocol Parser', () => {
  test('parseStatusPacket correctly decodes all telemetry fields and byte offsets', () => {
    const rawBuffer = createMockStatusBuffer(18650, 0.45, 16000, 4000);
    const parsed = parseStatusPacket(rawBuffer, 0);

    assert.equal(parsed.rawAngle, 18650);
    assert.ok(Math.abs(parsed.normalized - 0.45) < 0.001);
    assert.equal(parsed.axisValue, 16000);
    assert.equal(parsed.calMin, 17824);
    assert.equal(parsed.calMax, 19515);
    assert.equal(parsed.pollingRate, 4000);
    assert.equal(parsed.isCalibrating, 0);
    assert.equal(parsed.fwVersion, '2.0.0');
  });

  test('parseCurvePacket correctly decodes legacy 4-point packets padded to 6 points', () => {
    const pts = [
      { x: 0.15, y: 0.25 },
      { x: 0.35, y: 0.50 },
      { x: 0.65, y: 0.75 },
      { x: 0.85, y: 0.90 }
    ];
    const curveBuffer = createMockCurveBuffer(pts, 1);
    const parsed = parseCurvePacket(curveBuffer, 0);

    assert.equal(parsed.curveType, 1);
    assert.equal(parsed.pts.length, 6);
    assert.equal(parsed.pts[0].x, 0.0);
    assert.equal(parsed.pts[0].y, 0.0);
    for (let i = 0; i < 4; i++) {
      assert.ok(Math.abs(parsed.pts[i + 1].x - pts[i].x) < 0.001);
      assert.ok(Math.abs(parsed.pts[i + 1].y - pts[i].y) < 0.001);
    }
    assert.equal(parsed.pts[5].x, 1.0);
    assert.equal(parsed.pts[5].y, 1.0);
  });

  test('parseCurvePacket correctly decodes 6-point packets with custom start/end points', () => {
    const pts = [
      { x: 0.0, y: 0.10 },
      { x: 0.2, y: 0.25 },
      { x: 0.4, y: 0.45 },
      { x: 0.6, y: 0.65 },
      { x: 0.8, y: 0.85 },
      { x: 1.0, y: 0.95 }
    ];
    const curveBuffer = createMockCurveBuffer6Pt(pts, 0);
    const parsed = parseCurvePacket(curveBuffer, 0);

    assert.equal(parsed.curveType, 0);
    assert.equal(parsed.pts.length, 6);
    for (let i = 0; i < 6; i++) {
      assert.ok(Math.abs(parsed.pts[i].x - pts[i].x) < 0.001);
      assert.ok(Math.abs(parsed.pts[i].y - pts[i].y) < 0.001);
    }
  });

  test('parseCalStatusPacket and parseAckPacket decode control acknowledgements', () => {
    const calBuf = new Uint8Array([0x82, 2]); // completed
    const calParsed = parseCalStatusPacket(calBuf, 0);
    assert.equal(calParsed.status, 2);

    const ackBuf = new Uint8Array([0x83, 0x06]); // ack CMD_SAVE_CURVE
    const ackParsed = parseAckPacket(ackBuf, 0);
    assert.equal(ackParsed.cmdId, 0x06);
  });

  test('processIncomingBytes processes multiple back-to-back packets in a single transfer', () => {
    const pts = [{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.4 }, { x: 0.6, y: 0.6 }, { x: 0.8, y: 0.8 }];
    const curveBytes = createMockCurveBuffer(pts, 0);
    const statusBytes = createMockStatusBuffer(18200);

    const combined = new Uint8Array(curveBytes.length + statusBytes.length);
    combined.set(curveBytes, 0);
    combined.set(statusBytes, curveBytes.length);

    const { packets, leftover } = processIncomingBytes(null, combined);
    assert.equal(packets.length, 2);
    assert.equal(packets[0].type, 'curve');
    assert.equal(packets[1].type, 'status');
    assert.equal(packets[1].data.rawAngle, 18200);
    assert.equal(leftover.length, 0);
  });

  test('processIncomingBytes reassembles packet fragmented across transfers', () => {
    const statusBytes = createMockStatusBuffer(18900);
    const chunk1 = statusBytes.slice(0, 10);
    const chunk2 = statusBytes.slice(10);

    const step1 = processIncomingBytes(null, chunk1);
    assert.equal(step1.packets.length, 0);
    assert.equal(step1.leftover.length, 10);

    const step2 = processIncomingBytes(step1.leftover, chunk2);
    assert.equal(step2.packets.length, 1);
    assert.equal(step2.packets[0].type, 'status');
    assert.equal(step2.packets[0].data.rawAngle, 18900);
    assert.equal(step2.leftover.length, 0);
  });

  test('processIncomingBytes skips noise bytes to recover and parse valid packets', () => {
    const noise = new Uint8Array([0xAA, 0xBB, 0xCC, 0x00]);
    const statusBytes = createMockStatusBuffer(18123);
    const chunk = new Uint8Array(noise.length + statusBytes.length);
    chunk.set(noise, 0);
    chunk.set(statusBytes, noise.length);

    const { packets, leftover } = processIncomingBytes(null, chunk);
    assert.equal(packets.length, 1);
    assert.equal(packets[0].type, 'status');
    assert.equal(packets[0].data.rawAngle, 18123);
    assert.equal(leftover.length, 0);
  });

  test('computeSplineCoefficients and evaluateSpline produce correct clamped monotonic curve', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 0.2, y: 0.2 },
      { x: 0.4, y: 0.4 },
      { x: 0.6, y: 0.6 },
      { x: 0.8, y: 0.8 },
      { x: 1, y: 1 }
    ];
    const sigma = computeSplineCoefficients(points);
    assert.equal(sigma.length, 6);

    const mid = evaluateSpline(0.5, points, sigma, 0);
    assert.ok(mid >= 0.45 && mid <= 0.55);

    // Clamping boundaries
    assert.equal(evaluateSpline(-0.2, points, sigma, 0), 0);
    assert.equal(evaluateSpline(1.2, points, sigma, 0), 1);
  });

  test('INITIAL_STATUS provides valid zeroed defaults', () => {
    assert.equal(INITIAL_STATUS.rawAngle, 0);
    assert.equal(INITIAL_STATUS.pollingRate, 0);
    assert.equal(INITIAL_STATUS.fwVersion, '0.0.0');
  });

  test('isFirmwareOutdated correctly identifies outdated and compatible firmware versions', () => {
    assert.equal(MIN_FIRMWARE_VERSION, '2.1.0');
    // Outdated versions
    assert.equal(isFirmwareOutdated('2.0.0'), true);
    assert.equal(isFirmwareOutdated('1.9.9'), true);
    assert.equal(isFirmwareOutdated('2.0.9'), true);
    // Up-to-date / compatible versions
    assert.equal(isFirmwareOutdated('2.1.0'), false);
    assert.equal(isFirmwareOutdated('2.1.1'), false);
    assert.equal(isFirmwareOutdated('2.2.0'), false);
    assert.equal(isFirmwareOutdated('3.0.0'), false);
    // Disconnected / empty / sentinel versions
    assert.equal(isFirmwareOutdated('0.0.0'), false);
    assert.equal(isFirmwareOutdated(''), false);
    assert.equal(isFirmwareOutdated(null), false);
  });

  test('parseCurvePacket normalizes uninitialized curveType (255) to 0 and parses valid points', () => {
    const pts = [
      { x: 0.0, y: 0.15 },
      { x: 0.2, y: 0.25 },
      { x: 0.4, y: 0.40 },
      { x: 0.6, y: 0.65 },
      { x: 0.8, y: 0.80 },
      { x: 1.0, y: 0.90 }
    ];
    const curveBuffer = createMockCurveBuffer6Pt(pts, 255);
    const parsed = parseCurvePacket(curveBuffer, 0);

    assert.equal(parsed.curveType, 0, 'Dirty curveType byte must normalize to 0');
    assert.equal(parsed.pts.length, 6);
    assert.ok(Math.abs(parsed.pts[0].y - 0.15) < 0.001, 'Custom start Y node must be preserved');
    assert.ok(Math.abs(parsed.pts[5].y - 0.90) < 0.001, 'Custom finish Y node must be preserved');
  });

  test('processIncomingBytes correctly extracts 50-byte 6-point curve packet amidst streaming status packets', () => {
    const pts = [
      { x: 0.0, y: 0.0 },
      { x: 0.2, y: 0.3 },
      { x: 0.4, y: 0.5 },
      { x: 0.6, y: 0.7 },
      { x: 0.8, y: 0.9 },
      { x: 1.0, y: 1.0 }
    ];
    const curveBytes = createMockCurveBuffer6Pt(pts, 1);
    const statusBytes1 = createMockStatusBuffer(18200);
    const statusBytes2 = createMockStatusBuffer(18350);

    const stream = new Uint8Array(statusBytes1.length + curveBytes.length + statusBytes2.length);
    stream.set(statusBytes1, 0);
    stream.set(curveBytes, statusBytes1.length);
    stream.set(statusBytes2, statusBytes1.length + curveBytes.length);

    const { packets, leftover } = processIncomingBytes(null, stream);
    assert.equal(packets.length, 3);
    assert.equal(packets[0].type, 'status');
    assert.equal(packets[0].data.rawAngle, 18200);
    assert.equal(packets[1].type, 'curve');
    assert.equal(packets[1].data.pts.length, 6);
    assert.equal(packets[1].data.curveType, 1);
    assert.equal(packets[2].type, 'status');
    assert.equal(packets[2].data.rawAngle, 18350);
    assert.equal(leftover.length, 0);
  });
});

