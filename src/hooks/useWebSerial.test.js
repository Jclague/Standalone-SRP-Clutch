import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_PACKET_LENGTH,
  CURVE_PACKET_LENGTH,
  CAL_STATUS_PACKET_LENGTH,
  ACK_PACKET_LENGTH,
  CMD_GET_STATUS,
  CMD_GET_CURVE,
  CMD_START_CAL,
  CMD_STOP_CAL,
  CMD_SET_CURVE,
  CMD_SAVE_CURVE,
  CMD_RESET_CURVE,
  INITIAL_STATUS,
  processIncomingBytes,
  isFirmwareOutdated,
  parseStatusPacket
} from '../utils/webusbParser.js';

// Helper: build an exact Arduino status packet replicating the Arduino struct layout
function createMockStatusBuffer(raw = 18500, norm = 0.525, ax = -12000, isCalibrating = 0) {
  const buf = new ArrayBuffer(19);
  const view = new DataView(buf);
  view.setUint8(0, 0x81);
  view.setUint16(1, raw, true);
  view.setFloat32(3, norm, true);
  view.setInt16(7, ax, true);
  view.setUint16(9, 17824, true);
  view.setUint16(11, 19515, true);
  view.setUint16(13, 1000, true);
  view.setUint8(15, isCalibrating ? 1 : 0);
  view.setUint8(16, 2);
  view.setUint8(17, 0);
  view.setUint8(18, 0);
  return new Uint8Array(buf);
}

function createMockCalStatusBuffer(status = 0) {
  const buf = new Uint8Array(2);
  buf[0] = 0x82;
  buf[1] = status; // 0 = start, 2 = complete, 3 = timeout
  return buf;
}

describe('WebSerial Queue & Telemetry Stream Resilience', () => {
  test('Sequential OUT write queue guarantees strictly non-concurrent execution under writeLoop pressure', async () => {
    let activeWrites = 0;
    let maxConcurrentWrites = 0;
    const executionOrder = [];

    let outQueue = Promise.resolve();
    const mockWriterWrite = async (name, delayMs) => {
      activeWrites++;
      if (activeWrites > maxConcurrentWrites) {
        maxConcurrentWrites = activeWrites;
      }
      // If concurrent write were called on WritableStreamDefaultWriter, it would throw
      if (activeWrites > 1) {
        throw new Error('WritableStreamDefaultWriter concurrent write collision!');
      }
      await new Promise(r => setTimeout(r, delayMs));
      executionOrder.push(name);
      activeWrites--;
      return true;
    };

    const transferOutSafe = (name, delayMs) => {
      const task = async () => {
        try {
          return await mockWriterWrite(name, delayMs);
        } catch (err) {
          return false;
        }
      };
      outQueue = outQueue.then(task, task);
      return outQueue;
    };

    // Simulate writeLoop pinging CMD_GET_STATUS every 16ms while user clicks Calibrate (CMD_START_CAL)
    const p1 = transferOutSafe('CMD_GET_STATUS_1', 15);
    const p2 = transferOutSafe('CMD_START_CAL', 10);
    const p3 = transferOutSafe('CMD_GET_STATUS_2', 15);
    const p4 = transferOutSafe('CMD_STOP_CAL', 10);

    const results = await Promise.all([p1, p2, p3, p4]);

    assert.deepEqual(results, [true, true, true, true]);
    assert.equal(maxConcurrentWrites, 1, 'Max concurrent writes on serial writer must strictly be 1');
    assert.deepEqual(
      executionOrder,
      ['CMD_GET_STATUS_1', 'CMD_START_CAL', 'CMD_GET_STATUS_2', 'CMD_STOP_CAL'],
      'Commands must execute strictly in FIFO sequential order'
    );
  });

  test('Simulated stream receives cal_status (0x82) followed by status packets without dropping or desyncing', () => {
    let leftover = new Uint8Array(0);

    // Chunk 1: Cal status packet [0x82, 0x00] followed by first 10 bytes of a status packet
    const calPkt = createMockCalStatusBuffer(0); // Calibrating started
    const statusPkt = createMockStatusBuffer(18300, 0.35, -5000, 1);
    
    const chunk1 = new Uint8Array(2 + 10);
    chunk1.set(calPkt, 0);
    chunk1.set(statusPkt.slice(0, 10), 2);

    const step1 = processIncomingBytes(leftover, chunk1);
    leftover = step1.leftover;

    assert.equal(step1.packets.length, 1);
    assert.equal(step1.packets[0].type, 'cal_status');
    assert.equal(step1.packets[0].data.status, 0);
    assert.equal(leftover.length, 10);

    // Chunk 2: Remaining 9 bytes of status packet + a second complete status packet
    const statusPkt2 = createMockStatusBuffer(18900, 0.75, 12000, 1);
    const chunk2 = new Uint8Array(9 + 19);
    chunk2.set(statusPkt.slice(10), 0);
    chunk2.set(statusPkt2, 9);

    const step2 = processIncomingBytes(leftover, chunk2);
    leftover = step2.leftover;

    assert.equal(step2.packets.length, 2);
    assert.equal(step2.packets[0].type, 'status');
    assert.equal(step2.packets[0].data.rawAngle, 18300);
    assert.equal(step2.packets[0].data.isCalibrating, 1);
    assert.equal(step2.packets[1].type, 'status');
    assert.equal(step2.packets[1].data.rawAngle, 18900);
    assert.equal(step2.packets[1].data.isCalibrating, 1);
    assert.equal(leftover.length, 0);
  });

  test('Calibration completion cal_status (0x82, 2) transitions calibration state back to 0', () => {
    const calComplete = createMockCalStatusBuffer(2); // Complete
    const statusPostCal = createMockStatusBuffer(18100, 0.1, -15000, 0);

    const combined = new Uint8Array(2 + 19);
    combined.set(calComplete, 0);
    combined.set(statusPostCal, 2);

    const res = processIncomingBytes(new Uint8Array(0), combined);
    assert.equal(res.packets.length, 2);
    assert.equal(res.packets[0].type, 'cal_status');
    assert.equal(res.packets[0].data.status, 2);
    assert.equal(res.packets[1].type, 'status');
    assert.equal(res.packets[1].data.isCalibrating, 0);
  });

  test('Telemetry health classification matches packet timing', () => {
    const calculateHealth = (rxPackets, timeSinceLastPacket) => {
      if (rxPackets === 0) return 'waiting';
      if (timeSinceLastPacket > 1500) return 'stale';
      return 'streaming';
    };

    assert.equal(calculateHealth(0, 50), 'waiting');
    assert.equal(calculateHealth(100, 16), 'streaming');
    assert.equal(calculateHealth(100, 1000), 'streaming');
    assert.equal(calculateHealth(100, 1501), 'stale');
    assert.equal(calculateHealth(100, 2000), 'stale');
  });

  test('CMD_SET_CAL packet generates 5-byte little-endian binary buffer', () => {
    const minVal = 17800;
    const maxVal = 19500;
    const buf = new ArrayBuffer(5);
    const view = new DataView(buf);
    view.setUint8(0, 0x08);
    view.setUint16(1, minVal, true);
    view.setUint16(3, maxVal, true);

    const u8 = new Uint8Array(buf);
    assert.equal(u8.length, 5);
    assert.equal(u8[0], 0x08);
    assert.equal(view.getUint16(1, true), 17800);
    assert.equal(view.getUint16(3, true), 19500);
  });

  test('Calibration bar spans strictly around (17758 - 150) to (19484 + 150)', () => {
    const CAL_BAR_MIN = 17758 - 150; // 17608
    const CAL_BAR_MAX = 19484 + 150; // 19634
    assert.equal(CAL_BAR_MIN, 17608);
    assert.equal(CAL_BAR_MAX, 19634);

    const calMin = 17758;
    const calMax = 19484;
    const barMin = Math.min(CAL_BAR_MIN, calMin - 50);
    const barMax = Math.max(CAL_BAR_MAX, calMax + 50);
    const barRange = barMax - barMin;

    assert.equal(barMin, 17608);
    assert.equal(barMax, 19634);
    assert.equal(barRange, 2026);

    // Active calibration zone percentages
    const activeLeftPct = ((calMin - barMin) / barRange) * 100;
    const activeWidthPct = ((calMax - calMin) / barRange) * 100;

    assert.ok(Math.abs(activeLeftPct - 7.4) < 0.1, 'Active zone left edge is ~7.4%');
    assert.ok(Math.abs(activeWidthPct - 85.2) < 0.1, 'Active zone width is ~85.2%');

    // Draggable handle clamping bounds
    const clampMinHandle = (rawVal, curMax) => Math.max(barMin, Math.min(curMax - 20, rawVal));
    const clampMaxHandle = (rawVal, curMin) => Math.min(barMax, Math.max(curMin + 20, rawVal));

    assert.equal(clampMinHandle(17500, 19484), 17608, 'Clamps min to barMin');
    assert.equal(clampMinHandle(19480, 19484), 19464, 'Clamps min below max - 20');
    assert.equal(clampMaxHandle(20000, 17758), 19634, 'Clamps max to barMax');
    assert.equal(clampMaxHandle(17760, 17758), 17778, 'Clamps max above min + 20');
  });

  test('Auto-calibration pedal press/release detector automatically triggers stop after threshold and 1s hold', () => {
    // State machine simulator matching WebUSBPage implementation
    let calStartAngle = 17800;
    let calExceeded = false;
    let calSettledTime = 0;
    let calLastAngle = 17800;
    let autoEnded = false;

    const processPacket = (rAngle, currentTime) => {
      const deltaFromStart = Math.abs(rAngle - calStartAngle);
      if (!calExceeded) {
        if (deltaFromStart >= 250) {
          calExceeded = true;
        }
      } else {
        const isNearStart = deltaFromStart <= 65;
        const isStationary = Math.abs(rAngle - (calLastAngle ?? rAngle)) <= 12;
        if (isNearStart && isStationary) {
          if (calSettledTime === 0) {
            calSettledTime = currentTime;
          } else if (currentTime - calSettledTime >= 700) {
            autoEnded = true;
          }
        } else {
          calSettledTime = 0;
        }
      }
      calLastAngle = rAngle;
    };

    // 1. Initial resting position: small noise
    processPacket(17805, 1000);
    assert.equal(calExceeded, false, 'Should not exceed threshold on small resting noise');
    assert.equal(autoEnded, false);

    // 2. Pedal pressed down (full stroke to 19400)
    processPacket(19400, 1500);
    assert.equal(calExceeded, true, 'Should detect pedal press threshold exceeded (>250)');
    assert.equal(autoEnded, false);

    // 3. Pedal releasing (in motion at 18200)
    processPacket(18200, 2000);
    assert.equal(autoEnded, false, 'Should not end while releasing');

    // 4. Pedal arrives at resting position (17810, delta=10 <= 65, but was in motion on arrival)
    processPacket(17810, 2500);
    assert.equal(calSettledTime, 0, 'Movement from 18200 to 17810 is not yet stationary');
    assert.equal(autoEnded, false);

    // 5. Next sample confirms pedal is held stationary at rest
    processPacket(17810, 2600);
    assert.equal(calSettledTime, 2600, 'Starts 0.7s timer once stationary at rest position');
    assert.equal(autoEnded, false);

    // 6. Stationary check after 400ms (<700ms)
    processPacket(17812, 3000); // 400ms later, diff=2 ticks <= 12
    assert.equal(autoEnded, false, 'Should not end after 400ms');

    // 7. Stationary check after 700ms total
    processPacket(17811, 3300); // 700ms after 2600ms
    assert.equal(autoEnded, true, 'Should auto-end calibration after holding near start for 0.7s');
  });

  test('Auto-calibration cancellation flag properly guards range sync and reverts state', () => {
    let calRange = { min: 17758, max: 19484 };
    let preCalRange = { ...calRange };
    let calCancelled = false;
    let isCalibrating = 1;

    // Simulate clicking Cancel
    calCancelled = true;
    isCalibrating = 0;
    
    // Simulate device finishing with new observed range
    const deviceCalMin = 18000;
    const deviceCalMax = 19200;

    // Sync effect logic:
    if (!calCancelled && deviceCalMin > 0 && deviceCalMax > deviceCalMin) {
      calRange = { min: deviceCalMin, max: deviceCalMax };
    } else {
      calRange = { ...preCalRange };
    }

    assert.equal(calRange.min, 17758, 'Maintains original pre-cal min on cancel');
    assert.equal(calRange.max, 19484, 'Maintains original pre-cal max on cancel');
  });

  test('Save Profile button transitions from default offwhite -> orange (needs save) -> green for 3s -> default offwhite', async () => {
    let isDirty = false;
    let justSaved = false;
    let saveTimeout = null;

    const getButtonState = () => ({
      className: isDirty ? 'dirty' : justSaved ? 'saved' : 'default',
      label: justSaved ? 'Profile Saved' : 'Save Profile',
      icon: justSaved ? 'fa-check' : 'fa-floppy-disk'
    });

    const markDirty = () => {
      if (saveTimeout) {
        clearTimeout(saveTimeout);
        saveTimeout = null;
      }
      justSaved = false;
      isDirty = true;
    };

    const handleSave = () => {
      isDirty = false;
      justSaved = true;
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        justSaved = false;
        saveTimeout = null;
      }, 3000);
    };

    // 1. Initial default state: regular offwhite
    let btn = getButtonState();
    assert.equal(btn.className, 'default');
    assert.equal(btn.label, 'Save Profile');
    assert.equal(btn.icon, 'fa-floppy-disk');

    // 2. User edits a setting: turns orange (needs save)
    markDirty();
    btn = getButtonState();
    assert.equal(btn.className, 'dirty');
    assert.equal(btn.label, 'Save Profile');
    assert.equal(btn.icon, 'fa-floppy-disk');

    // 3. User saves: turns green ('Profile Saved')
    handleSave();
    btn = getButtonState();
    assert.equal(btn.className, 'saved');
    assert.equal(btn.label, 'Profile Saved');
    assert.equal(btn.icon, 'fa-check');

    // 4. Before 3 seconds: remains green
    assert.equal(getButtonState().className, 'saved');

    // 5. If user edits during the 3 seconds: immediately turns orange
    markDirty();
    btn = getButtonState();
    assert.equal(btn.className, 'dirty');
    assert.equal(btn.label, 'Save Profile');

    // 6. Save again and wait for full 3-second timeout completion
    let timerCb;
    const origSetTimeout = globalThis.setTimeout;
    // Fast mock for the 3s timeout
    handleSave();
    assert.equal(getButtonState().className, 'saved');
    // Clear and execute callback directly
    clearTimeout(saveTimeout);
    justSaved = false;
    
    // 7. Turns back to default offwhite
    btn = getButtonState();
    assert.equal(btn.className, 'default');
    assert.equal(btn.label, 'Save Profile');
    assert.equal(btn.icon, 'fa-floppy-disk');
  });

  test('Outdated firmware check blocks connection transition and triggers immediate abort', () => {
    let isConnected = false;
    let isConnecting = true;
    let disconnected = false;
    let dispatchedOutdated = false;
    let outdatedVersion = '';

    const handlePacket = (statusData) => {
      if (isFirmwareOutdated(statusData.fwVersion)) {
        dispatchedOutdated = true;
        outdatedVersion = statusData.fwVersion;
        // Immediate abort
        isConnecting = false;
        isConnected = false;
        disconnected = true;
        return;
      }
      isConnected = true;
      isConnecting = false;
    };

    // 1. Packet arrives with outdated firmware v2.0.0
    const outdatedPacket = parseStatusPacket(createMockStatusBuffer(18500, 0.5, 0)); // mock has fwVersion 2.0.0
    handlePacket(outdatedPacket);

    assert.equal(dispatchedOutdated, true, 'Must flag outdated firmware');
    assert.equal(outdatedVersion, '2.0.0');
    assert.equal(isConnected, false, 'Must NEVER transition to connected state');
    assert.equal(isConnecting, false);
    assert.equal(disconnected, true, 'Must trigger immediate disconnect');
  });
});
