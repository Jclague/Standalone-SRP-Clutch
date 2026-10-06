export const VENDOR_ID = 0xFA57;
export const CMD_GET_STATUS = 0x01;
export const CMD_START_CAL = 0x02;
export const CMD_STOP_CAL = 0x03;
export const CMD_SET_CURVE = 0x04;
export const CMD_GET_CURVE = 0x05;
export const CMD_SAVE_CURVE = 0x06;
export const CMD_RESET_CURVE = 0x07;
export const CMD_SET_CAL = 0x08;

export const PACKET_ID_STATUS = 0x81;
export const PACKET_ID_CAL_STATUS = 0x82;
export const PACKET_ID_ACK = 0x83;
export const PACKET_ID_CURVE = 0x85;

export const STATUS_PACKET_LENGTH = 19;
export const CURVE_PACKET_LENGTH = 34;
export const CURVE_PACKET_LENGTH_6PT = 50;
export const CAL_STATUS_PACKET_LENGTH = 2;
export const ACK_PACKET_LENGTH = 2;

export const MIN_FIRMWARE_VERSION = '2.1.0';

export function isFirmwareOutdated(versionStr, minVersion = MIN_FIRMWARE_VERSION) {
  if (!versionStr || versionStr === '0.0.0') return false;
  const parseParts = (v) => v.split('.').map(n => parseInt(n, 10) || 0);
  const cur = parseParts(versionStr);
  const min = parseParts(minVersion);
  for (let i = 0; i < 3; i++) {
    const c = cur[i] ?? 0;
    const m = min[i] ?? 0;
    if (c < m) return true;
    if (c > m) return false;
  }
  return false;
}

export const INITIAL_STATUS = Object.freeze({
  rawAngle: 0,
  normalized: 0,
  axisValue: 0,
  calMin: 0,
  calMax: 0,
  pollingRate: 0,
  isCalibrating: 0,
  fwVersion: '0.0.0'
});

export function ensureDataView(input) {
  if (!input) throw new TypeError('Expected DataView, TypedArray, or ArrayBuffer, got null or undefined');
  if (input instanceof DataView) return input;
  if (input instanceof ArrayBuffer) return new DataView(input);
  if (ArrayBuffer.isView(input)) {
    return new DataView(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('Expected DataView, TypedArray, or ArrayBuffer');
}

export function toUint8Array(input) {
  if (!input) return new Uint8Array(0);
  if (input instanceof Uint8Array) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return new Uint8Array(input);
}

export function parseStatusPacket(view, offset = 0) {
  const dv = ensureDataView(view);
  if (offset + STATUS_PACKET_LENGTH > dv.byteLength) {
    throw new Error(
      `Insufficient bytes for status packet: need ${STATUS_PACKET_LENGTH}, have ${dv.byteLength - offset}`
    );
  }
  const id = dv.getUint8(offset);
  if (id !== PACKET_ID_STATUS) {
    throw new Error(
      `Invalid packet ID for status packet: expected 0x${PACKET_ID_STATUS.toString(16)}, got 0x${id.toString(16)}`
    );
  }
  return {
    rawAngle: dv.getUint16(offset + 1, true),
    normalized: dv.getFloat32(offset + 3, true),
    axisValue: dv.getInt16(offset + 7, true),
    calMin: dv.getUint16(offset + 9, true),
    calMax: dv.getUint16(offset + 11, true),
    pollingRate: dv.getUint16(offset + 13, true),
    isCalibrating: dv.getUint8(offset + 15),
    fwVersion: `${dv.getUint8(offset + 16)}.${dv.getUint8(offset + 17)}.${dv.getUint8(offset + 18)}`
  };
}

export function parseCurvePacket(view, offset = 0) {
  const dv = ensureDataView(view);
  const remaining = dv.byteLength - offset;
  if (remaining < CURVE_PACKET_LENGTH) {
    throw new Error(
      `Insufficient bytes for curve packet: need at least ${CURVE_PACKET_LENGTH}, have ${remaining}`
    );
  }
  const id = dv.getUint8(offset);
  if (id !== PACKET_ID_CURVE) {
    throw new Error(
      `Invalid packet ID for curve packet: expected 0x${PACKET_ID_CURVE.toString(16)}, got 0x${id.toString(16)}`
    );
  }
  const is6Pt = offset + CURVE_PACKET_LENGTH_6PT <= dv.byteLength;
  const pts = [];
  let curveType = 0;

  if (is6Pt) {
    // 6-point packet (including draggable 0% and 100% endpoints)
    for (let i = 0; i < 6; i++) {
      const rawX = dv.getFloat32(offset + 1 + i * 8, true);
      const rawY = dv.getFloat32(offset + 5 + i * 8, true);
      pts.push({
        x: isNaN(rawX) ? i * 0.2 : rawX,
        y: isNaN(rawY) ? i * 0.2 : rawY
      });
    }
    // If intermediate nodes collapsed onto (0,0) or endpoints, auto-heal them
    if (pts[1].x <= 0.02 && pts[4].x <= 0.02) {
      const startY = Math.max(0, Math.min(1, pts[0]?.y ?? 0));
      const endY = Math.max(0, Math.min(1, pts[5]?.y ?? 1));
      pts[1] = { x: 0.2, y: startY + 0.2 * (endY - startY) };
      pts[2] = { x: 0.4, y: startY + 0.4 * (endY - startY) };
      pts[3] = { x: 0.6, y: startY + 0.6 * (endY - startY) };
      pts[4] = { x: 0.8, y: startY + 0.8 * (endY - startY) };
    }
    const rawType = dv.getUint8(offset + 49);
    curveType = rawType === 1 ? 1 : 0;
  } else {
    // 4-point legacy packet -> pad endpoints (0,0) and (1,1)
    pts.push({ x: 0.0, y: 0.0 });
    for (let i = 0; i < 4; i++) {
      const rawX = dv.getFloat32(offset + 1 + i * 8, true);
      const rawY = dv.getFloat32(offset + 5 + i * 8, true);
      pts.push({
        x: isNaN(rawX) ? (i + 1) * 0.2 : rawX,
        y: isNaN(rawY) ? (i + 1) * 0.2 : rawY
      });
    }
    pts.push({ x: 1.0, y: 1.0 });
    const rawType = dv.getUint8(offset + 33);
    curveType = rawType === 1 ? 1 : 0;
  }

  pts.pts = pts;
  pts.curveType = curveType;
  return pts;
}

export function parseCalStatusPacket(view, offset = 0) {
  const dv = ensureDataView(view);
  if (offset + CAL_STATUS_PACKET_LENGTH > dv.byteLength) {
    throw new Error(
      `Insufficient bytes for cal status packet: need ${CAL_STATUS_PACKET_LENGTH}, have ${dv.byteLength - offset}`
    );
  }
  const id = dv.getUint8(offset);
  if (id !== PACKET_ID_CAL_STATUS) {
    throw new Error(
      `Invalid packet ID for cal status packet: expected 0x${PACKET_ID_CAL_STATUS.toString(16)}, got 0x${id.toString(16)}`
    );
  }
  return {
    status: dv.getUint8(offset + 1)
  };
}

export function parseAckPacket(view, offset = 0) {
  const dv = ensureDataView(view);
  if (offset + ACK_PACKET_LENGTH > dv.byteLength) {
    throw new Error(
      `Insufficient bytes for ack packet: need ${ACK_PACKET_LENGTH}, have ${dv.byteLength - offset}`
    );
  }
  const id = dv.getUint8(offset);
  if (id !== PACKET_ID_ACK) {
    throw new Error(
      `Invalid packet ID for ack packet: expected 0x${PACKET_ID_ACK.toString(16)}, got 0x${id.toString(16)}`
    );
  }
  return {
    cmdId: dv.getUint8(offset + 1)
  };
}

export function isValidStatusPacketCandidate(view, offset) {
  const isCal = view.getUint8(offset + 15);
  if (isCal > 1) return false;
  const norm = view.getFloat32(offset + 3, true);
  if (isNaN(norm) || norm < -0.1 || norm > 1.1) return false;
  const rate = view.getUint16(offset + 13, true);
  if (rate > 10000) return false;
  return true;
}

export function isValidCurvePacketCandidate6Pt(view, offset) {
  const remaining = view.byteLength - offset;
  if (remaining < CURVE_PACKET_LENGTH_6PT) return false;
  let prevX = -0.05;
  for (let i = 0; i < 6; i++) {
    const x = view.getFloat32(offset + 1 + i * 8, true);
    const y = view.getFloat32(offset + 5 + i * 8, true);
    if (isNaN(x) || isNaN(y)) return false;
    if (x < -0.05 || x > 1.05 || y < -0.05 || y > 1.05) return false;
    if (x < prevX - 0.005) return false;
    prevX = x;
  }
  return true;
}

export function isValidCurvePacketCandidate4Pt(view, offset) {
  const remaining = view.byteLength - offset;
  if (remaining < CURVE_PACKET_LENGTH) return false;
  let prevX = -0.05;
  for (let i = 0; i < 4; i++) {
    const x = view.getFloat32(offset + 1 + i * 8, true);
    const y = view.getFloat32(offset + 5 + i * 8, true);
    if (isNaN(x) || isNaN(y)) return false;
    if (x < -0.05 || x > 1.05 || y < -0.05 || y > 1.05) return false;
    if (x < prevX - 0.005) return false;
    prevX = x;
  }
  return true;
}

export function isValidCurvePacketCandidate(view, offset) {
  return isValidCurvePacketCandidate6Pt(view, offset) || isValidCurvePacketCandidate4Pt(view, offset);
}

export function isValidCalStatusPacketCandidate(view, offset) {
  const status = view.getUint8(offset + 1);
  return status <= 3; // 0: start, 1: progress, 2: complete, 3: timeout
}

export function isValidAckPacketCandidate(view, offset) {
  const cmd = view.getUint8(offset + 1);
  return cmd >= 0x01 && cmd <= 0x0A;
}

/**
 * Process incoming bytes from WebUSB stream, extracting all complete packets
 * (including back-to-back packets) and preserving any incomplete packet tail
 * for subsequent transfers.
 *
 * @param {Uint8Array|ArrayBuffer|DataView} leftoverBuffer - Residual bytes from previous transfer
 * @param {Uint8Array|ArrayBuffer|DataView} newChunk - Newly received bytes
 * @returns {{ packets: Array<{type: string, data: any}>, leftover: Uint8Array }}
 */
export function processIncomingBytes(leftoverBuffer, newChunk) {
  const prev = toUint8Array(leftoverBuffer);
  const chunk = toUint8Array(newChunk);

  const combined = new Uint8Array(prev.length + chunk.length);
  combined.set(prev, 0);
  combined.set(chunk, prev.length);

  const view = new DataView(combined.buffer, combined.byteOffset, combined.byteLength);
  const packets = [];
  let offset = 0;

  while (offset < combined.length) {
    const id = view.getUint8(offset);

    if (id === PACKET_ID_STATUS) {
      if (offset + STATUS_PACKET_LENGTH <= combined.length) {
        if (isValidStatusPacketCandidate(view, offset)) {
          packets.push({
            type: 'status',
            data: parseStatusPacket(view, offset)
          });
          offset += STATUS_PACKET_LENGTH;
        } else {
          // False header: advance by 1 to seek next valid header
          offset += 1;
        }
      } else {
        // Incomplete status packet, keep remainder in buffer
        break;
      }
    } else if (id === PACKET_ID_CURVE) {
      if (offset + CURVE_PACKET_LENGTH_6PT <= combined.length && isValidCurvePacketCandidate6Pt(view, offset)) {
        packets.push({
          type: 'curve',
          data: parseCurvePacket(view, offset)
        });
        offset += CURVE_PACKET_LENGTH_6PT;
      } else if (offset + CURVE_PACKET_LENGTH <= combined.length && isValidCurvePacketCandidate4Pt(view, offset)) {
        packets.push({
          type: 'curve',
          data: parseCurvePacket(view, offset)
        });
        offset += CURVE_PACKET_LENGTH;
      } else if (combined.length - offset < CURVE_PACKET_LENGTH_6PT) {
        // Incomplete curve packet, keep remainder in buffer
        break;
      } else {
        offset += 1;
      }
    } else if (id === PACKET_ID_CAL_STATUS) {
      if (offset + CAL_STATUS_PACKET_LENGTH <= combined.length) {
        if (isValidCalStatusPacketCandidate(view, offset)) {
          packets.push({
            type: 'cal_status',
            data: parseCalStatusPacket(view, offset)
          });
          offset += CAL_STATUS_PACKET_LENGTH;
        } else {
          offset += 1;
        }
      } else {
        // Incomplete cal status packet
        break;
      }
    } else if (id === PACKET_ID_ACK) {
      if (offset + ACK_PACKET_LENGTH <= combined.length) {
        if (isValidAckPacketCandidate(view, offset)) {
          packets.push({
            type: 'ack',
            data: parseAckPacket(view, offset)
          });
          offset += ACK_PACKET_LENGTH;
        } else {
          offset += 1;
        }
      } else {
        // Incomplete ack packet
        break;
      }
    } else {
      // Unrecognized byte: advance by 1 to seek next valid header
      offset += 1;
    }
  }

  let leftover = combined.slice(offset);
  // Cap leftover buffer to prevent unbounded memory growth on persistent noisy data
  if (leftover.length > 256) {
    leftover = new Uint8Array(0);
  }

  return { packets, leftover };
}
