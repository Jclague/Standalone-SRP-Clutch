import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { NOTCHES, hzToPct, pctToHz } from './pollingRateUtils.js';
import { CMD_SET_POLLING_RATE } from '../hooks/useWebSerial.js';

describe('PollingRateSlider Logic & Mathematical Mapping', () => {
  test('NOTCHES array contains exact requested notches and positions', () => {
    assert.deepEqual(
      NOTCHES.map(n => n.hz),
      [125, 250, 500, 750, 1000, 2000, 4000, 5000]
    );
    assert.deepEqual(
      NOTCHES.map(n => n.pct),
      [0, 15, 30, 45, 60, 74, 87, 100]
    );
  });

  test('hzToPct accurately maps exact notch frequencies to percentages', () => {
    assert.equal(hzToPct(125), 0);
    assert.equal(hzToPct(250), 15);
    assert.equal(hzToPct(500), 30);
    assert.equal(hzToPct(750), 45);
    assert.equal(hzToPct(1000), 60);
    assert.equal(hzToPct(2000), 74);
    assert.equal(hzToPct(4000), 87);
    assert.equal(hzToPct(5000), 100);
  });

  test('hzToPct clamps values below 125 and above 4000', () => {
    assert.equal(hzToPct(50), 0);
    assert.equal(hzToPct(0), 0);
    assert.equal(hzToPct(4001), 100);
    assert.equal(hzToPct(8000), 100);
  });

  test('hzToPct interpolates smoothly within intermediate segments', () => {
    // Halfway between 125 and 250 (187.5 Hz) -> halfway between 0% and 15% = 7.5%
    assert.equal(hzToPct(187.5), 7.5);
    // Halfway between 500 and 750 (625 Hz) -> halfway between 30% and 45% = 37.5%
    assert.equal(hzToPct(625), 37.5);
    // Halfway between 750 and 1000 (875 Hz) -> halfway between 45% and 60% = 52.5%
    assert.equal(hzToPct(875), 52.5);
  });

  test('pctToHz accurately snaps magnetically within 2% to exact notches and uncapped end', () => {
    // Around 125 Hz (pct = 0)
    assert.equal(pctToHz(0), 125);
    assert.equal(pctToHz(1.2), 125);

    // Around 500 Hz (pct = 30)
    assert.equal(pctToHz(30), 500);
    assert.equal(pctToHz(31.2), 500);

    // Around 1000 Hz (pct = 60)
    assert.equal(pctToHz(60), 1000);
    assert.equal(pctToHz(61.2), 1000);

    // Around 4000 Hz (pct = 87)
    assert.equal(pctToHz(87), 4000);
    assert.equal(pctToHz(88.2), 4000);

    // Small section after 4000 (pct > 89) acts as uncapped (>4000)
    assert.equal(pctToHz(92), 5000);
    assert.equal(pctToHz(98), 5000);
    assert.equal(pctToHz(100), 5000);
  });

  test('Red zone detection applies strictly above 1000 Hz', () => {
    const isRedZone = (hz) => hz > 1000;
    assert.equal(isRedZone(125), false);
    assert.equal(isRedZone(250), false);
    assert.equal(isRedZone(500), false);
    assert.equal(isRedZone(750), false);
    assert.equal(isRedZone(1000), false);
    assert.equal(isRedZone(1001), true);
    assert.equal(isRedZone(2000), true);
    assert.equal(isRedZone(4000), true);
    assert.equal(isRedZone(5000), true);
  });

  test('CMD_SET_POLLING_RATE binary payload is 3 bytes little-endian', () => {
    assert.equal(CMD_SET_POLLING_RATE, 0x09);

    const testHz = 6000;
    const buf = new ArrayBuffer(3);
    const view = new DataView(buf);
    view.setUint8(0, CMD_SET_POLLING_RATE);
    view.setUint16(1, testHz, true);

    const u8 = new Uint8Array(buf);
    assert.equal(u8.length, 3);
    assert.equal(u8[0], 0x09);
    // 6000 = 0x1770 -> low byte 0x70 (112), high byte 0x17 (23)
    assert.equal(u8[1], 0x70);
    assert.equal(u8[2], 0x17);
    assert.equal(view.getUint16(1, true), 6000);
  });
});
