#include <Arduino.h>
#include <EEPROM.h>
#include <Adafruit_TinyUSB.h>

#define CS_PIN 26
#define SCK_PIN 27
#define DATA_PIN 28

#define MIN_POLLING_HZ 1
#define MAX_POLLING_HZ 7400
#define INIT_POLLING_HZ 1000

#define MIN_ANGLE 17824
#define MAX_ANGLE 19515

#define BANG_WAIT_US 1
#define CAL_TIMEOUT_MS 15000

// Deadzone constants
static const float TOP_DEADZONE = 0.04f;
static const float BOTTOM_DEADZONE = 0.06f;
static const float INV_ACTIVE_RANGE = 1.0f / (1.0f - TOP_DEADZONE - BOTTOM_DEADZONE); // Precalculated reciprocal

unsigned long next_loop_us = 0;
long polling_delay_us = (1000000UL / INIT_POLLING_HZ);

#define CAL_MAGIC 0x4D435635

struct calibration_t {
  uint32_t magic;
  uint16_t min;
  uint16_t max;
  uint16_t polling_rate_hz;
  float curve_x[6];
  float curve_y[6];
  uint8_t curve_type; // 0 = Smooth (Cubic), 1 = Linear
} cal;

// Precalculated reciprocal span: 1.0f / (cal.max - cal.min) for division-free normalization
float cal_inv_span = 1.0f / (float)(MAX_ANGLE - MIN_ANGLE);

Adafruit_USBD_HID hid;

uint8_t hid_desc[] = {
  0x05,0x01,0x09,0x05,0xA1,0x01,0x85,0x01,
  0x09,0x30,0x16,0x00,0x80,0x26,0xFF,0x7F,
  0x75,0x10,0x95,0x01,0x81,0x02,0xC0
};

struct axis_t { int16_t x; } axis;

// Precomputed cubic polynomial coefficients for division-free Horner evaluation:
// S_i(t) = a[i] + t*(b[i] + t*(c[i] + t*d[i])) where t = (x - spline_x[i])
float spline_x[6];
float poly_a[5];
float poly_b[5];
float poly_c[5];
float poly_d[5];

// Calibration state
bool calibrating = false;
uint16_t cal_observed_min = 65535;
uint16_t cal_observed_max = 0;
unsigned long cal_start_time = 0;

void saveCalibration();
void sendCalStatus(uint8_t status);
void sendAck(uint8_t cmd_id);
void sendCurveData();

void updateCalSpan() {
  if (cal.max > cal.min) {
    cal_inv_span = 1.0f / (float)(cal.max - cal.min);
  } else {
    cal_inv_span = 0.0f;
  }
}

// Precomputes polynomial segments to allow ultra-fast Horner evaluation in applyInputCurve
void updateSplineCoefficients() {
  for (int i = 0; i < 6; i++) {
    spline_x[i] = cal.curve_x[i];
  }

  float h[5];
  float delta[5];
  for (int i = 0; i < 5; i++) {
    h[i] = spline_x[i + 1] - spline_x[i];
    delta[i] = (h[i] > 0.00001f) ? (cal.curve_y[i + 1] - cal.curve_y[i]) / h[i] : 0.0f;
  }

  if (cal.curve_type == 1) {
    // Linear mode: b[i] is the slope, c and d are 0
    for (int i = 0; i < 5; i++) {
      poly_a[i] = cal.curve_y[i];
      poly_b[i] = delta[i];
      poly_c[i] = 0.0f;
      poly_d[i] = 0.0f;
    }
    return;
  }

  // Monotone Cubic Hermite Spline (Fritsch-Carlson method)
  float d[6];
  d[0] = delta[0];
  d[5] = delta[4];
  for (int i = 1; i <= 4; i++) {
    d[i] = (delta[i - 1] + delta[i]) * 0.5f;
  }

  // Monotonicity enforcement
  for (int i = 0; i < 5; i++) {
    if (fabsf(delta[i]) < 0.00001f) {
      d[i] = 0.0f;
      d[i + 1] = 0.0f;
    } else {
      float alpha = d[i] / delta[i];
      float beta = d[i + 1] / delta[i];
      if (alpha < 0.0f) d[i] = 0.0f;
      if (beta < 0.0f) d[i + 1] = 0.0f;
      float mag2 = alpha * alpha + beta * beta;
      if (mag2 > 9.0f) {
        float tau = 3.0f / sqrtf(mag2);
        d[i] = tau * alpha * delta[i];
        d[i + 1] = tau * beta * delta[i];
      }
    }
  }

  // Convert Hermite basis to standard polynomial form for Horner evaluation:
  // S_i(t) = a + b*t + c*t^2 + d*t^3
  for (int i = 0; i < 5; i++) {
    poly_a[i] = cal.curve_y[i];
    poly_b[i] = d[i];
    if (h[i] > 0.00001f) {
      float inv_h = 1.0f / h[i];
      float inv_h2 = inv_h * inv_h;
      poly_c[i] = (3.0f * delta[i] - 2.0f * d[i] - d[i + 1]) * inv_h;
      poly_d[i] = (d[i] + d[i + 1] - 2.0f * delta[i]) * inv_h2;
    } else {
      poly_c[i] = 0.0f;
      poly_d[i] = 0.0f;
    }
  }
}

// Division-free Horner-form spline evaluation (only 3 multiply-adds, zero division)
inline float applyInputCurve(float normalized) {
  int i = 0;
  for (i = 0; i < 4; i++) {
    if (normalized <= spline_x[i + 1]) break;
  }
  float t = normalized - spline_x[i];
  float result = poly_a[i] + t * (poly_b[i] + t * (poly_c[i] + t * poly_d[i]));
  return constrain(result, 0.0f, 1.0f);
}

// Low-latency asymmetric input filter with dynamic velocity boost
inline float processInput(uint16_t signal) {
  static float filteredSignal = 0.0f;
  static bool filterInit = false;
  if (!filterInit) {
    filteredSignal = (float)signal;
    filterInit = true;
  }

  float diff = (float)signal - filteredSignal;
  float absDiff = fabsf(diff);

  // Fast attack on pedal press, smooth decay on pedal release
  float baseAlpha;
  if (cal.max >= cal.min) {
    baseAlpha = (diff >= 0.0f) ? 0.85f : 0.25f;
  } else {
    baseAlpha = (diff <= 0.0f) ? 0.85f : 0.25f;
  }

  // Dynamic velocity boost: stomps bypass filter completely
  float velocityBoost = constrain(absDiff * 0.05f, 0.0f, 1.0f); // * 0.05f == / 20.0f
  float alpha = baseAlpha + (1.0f - baseAlpha) * (velocityBoost * velocityBoost);

  filteredSignal += alpha * diff;

  if (cal_inv_span <= 0.0f) return 0.0f;

  // Multiply by reciprocal span (zero software division)
  float rawNorm = (filteredSignal - (float)cal.min) * cal_inv_span;
  rawNorm = constrain(rawNorm, 0.0f, 1.0f);

  if (rawNorm <= TOP_DEADZONE) {
    return 0.0f;
  } else if (rawNorm >= (1.0f - BOTTOM_DEADZONE)) {
    return 1.0f;
  } else {
    return constrain((rawNorm - TOP_DEADZONE) * INV_ACTIVE_RANGE, 0.0f, 1.0f);
  }
}

inline int16_t mapInputToAxis(float normSignal) {
  if (normSignal <= 0.0001f) return -32767;
  if (normSignal >= 0.9999f) return 32767;
  return (int16_t)(((normSignal * 2.0f) - 1.0f) * 32767.0f);
}

// Bitbang 16-bit command word to Infineon TLI5012B over half-duplex SPI
inline void writeReadCMDWord() {
  pinMode(DATA_PIN, OUTPUT);
  // Command word 0x8021: Read Mode (bit 15), Address 0x02 AVAL (bits 9..4), 1 data word (bits 3..0)
  uint16_t cmd = 0x8021;
  for (int8_t i = 15; i >= 0; i--) {
    digitalWrite(DATA_PIN, (cmd >> i) & 1);
    delayMicroseconds(BANG_WAIT_US);
    digitalWrite(SCK_PIN, HIGH);
    delayMicroseconds(BANG_WAIT_US);
    digitalWrite(SCK_PIN, LOW);
    delayMicroseconds(BANG_WAIT_US);
  }
}

// Read raw angle from TLI5012B
inline uint16_t readAngle() {
  digitalWrite(CS_PIN, LOW);
  writeReadCMDWord();
  pinMode(DATA_PIN, INPUT);
  uint16_t word = 0;
  for (int8_t i = 15; i >= 0; i--) {
    digitalWrite(SCK_PIN, HIGH);
    delayMicroseconds(BANG_WAIT_US);
    word = (word << 1) | digitalRead(DATA_PIN);
    digitalWrite(SCK_PIN, LOW);
    delayMicroseconds(BANG_WAIT_US);
  }
  digitalWrite(CS_PIN, HIGH);
  return word & 0x7FFF;
}

void saveCalibration() {
  cal.magic = CAL_MAGIC;
  EEPROM.put(0, cal);
  EEPROM.commit();
}

void resetCalibrationDefaults() {
  cal.magic = CAL_MAGIC;
  cal.min = MIN_ANGLE;
  cal.max = MAX_ANGLE;
  cal.polling_rate_hz = INIT_POLLING_HZ;
  cal.curve_x[0] = 0.0f; cal.curve_y[0] = 0.0f;
  cal.curve_x[1] = 0.2f; cal.curve_y[1] = 0.2f;
  cal.curve_x[2] = 0.4f; cal.curve_y[2] = 0.4f;
  cal.curve_x[3] = 0.6f; cal.curve_y[3] = 0.6f;
  cal.curve_x[4] = 0.8f; cal.curve_y[4] = 0.8f;
  cal.curve_x[5] = 1.0f; cal.curve_y[5] = 1.0f;
  cal.curve_type = 0;
  saveCalibration();
}

void loadCalibration() {
  EEPROM.get(0, cal);

  // Validate or reset
  if (cal.magic != CAL_MAGIC || cal.max <= cal.min ||
      cal.polling_rate_hz < MIN_POLLING_HZ || cal.polling_rate_hz > MAX_POLLING_HZ) {
    resetCalibrationDefaults();
  }

  if (cal.curve_type != 0 && cal.curve_type != 1) {
    cal.curve_type = 0;
  }

  // Self-heal corrupted intermediate points while preserving custom start/finish Y
  if (cal.curve_x[1] <= 0.02f && cal.curve_x[4] <= 0.02f) {
    float startY = cal.curve_y[0];
    float endY = cal.curve_y[5];
    if (isnan(startY) || startY < 0.0f || startY > 1.0f) startY = 0.0f;
    if (isnan(endY) || endY < 0.0f || endY > 1.0f) endY = 1.0f;
    cal.curve_x[0] = 0.0f; cal.curve_y[0] = startY;
    cal.curve_x[1] = 0.2f; cal.curve_y[1] = startY + 0.2f * (endY - startY);
    cal.curve_x[2] = 0.4f; cal.curve_y[2] = startY + 0.4f * (endY - startY);
    cal.curve_x[3] = 0.6f; cal.curve_y[3] = startY + 0.6f * (endY - startY);
    cal.curve_x[4] = 0.8f; cal.curve_y[4] = startY + 0.8f * (endY - startY);
    cal.curve_x[5] = 1.0f; cal.curve_y[5] = endY;
    saveCalibration();
  }

  bool hasNaN = false;
  for (int i = 0; i < 6; i++) {
    if (isnan(cal.curve_x[i]) || isnan(cal.curve_y[i])) hasNaN = true;
  }
  if (hasNaN) {
    resetCalibrationDefaults();
  }

  updateCalSpan();
  polling_delay_us = (cal.polling_rate_hz > 4000) ? 0 : (1000000UL / cal.polling_rate_hz);
  updateSplineCoefficients();
}

void sendCalStatus(uint8_t status) {
  uint8_t buf[2] = { 0x82, status };
  Serial.write(buf, 2);
  Serial.flush();
}

void sendAck(uint8_t cmd_id) {
  uint8_t buf[2] = { 0x83, cmd_id };
  Serial.write(buf, 2);
  Serial.flush();
}

void sendCurveData() {
  uint8_t buf[50];
  buf[0] = 0x85;
  for (int i = 0; i < 6; i++) {
    memcpy(&buf[1 + i * 8], &cal.curve_x[i], 4);
    memcpy(&buf[1 + i * 8 + 4], &cal.curve_y[i], 4);
  }
  buf[49] = (cal.curve_type == 1) ? 1 : 0;
  Serial.write(buf, 50);
  Serial.flush();
}

struct __attribute__((packed)) status_packet_t {
  uint8_t id;
  uint16_t raw;
  float norm;
  int16_t ax;
  uint16_t cal_min;
  uint16_t cal_max;
  uint16_t polling_rate_hz;
  uint8_t is_calibrating;
  uint8_t fw_major;
  uint8_t fw_minor;
  uint8_t fw_patch;
};

inline void sendStatus(uint16_t raw, float norm, int16_t ax) {
  status_packet_t pkt;
  pkt.id = 0x81;
  pkt.raw = raw;
  pkt.norm = norm;
  pkt.ax = ax;
  pkt.cal_min = cal.min;
  pkt.cal_max = cal.max;
  pkt.polling_rate_hz = cal.polling_rate_hz;
  pkt.is_calibrating = calibrating ? 1 : 0;
  pkt.fw_major = 2;
  pkt.fw_minor = 3;
  pkt.fw_patch = 1;
  Serial.write((uint8_t*)&pkt, sizeof(pkt));
}

void startCalibration() {
  calibrating = true;
  cal_observed_min = 65535;
  cal_observed_max = 0;
  cal_start_time = millis();
  sendCalStatus(0);
}

void finishCalibration() {
  if (cal_observed_max > cal_observed_min && (cal_observed_max - cal_observed_min > 100)) {
    cal.min = (cal_observed_min <= 65525) ? cal_observed_min + 10 : cal_observed_min;
    cal.max = (cal_observed_max >= 10) ? cal_observed_max - 10 : cal_observed_max;
    calibrating = false;
    updateCalSpan();
    sendCalStatus(2); // complete - sent before flash write
    saveCalibration();
  } else {
    calibrating = false;
    sendCalStatus(3); // timeout
  }
}

inline void updateCalibration(uint16_t raw_angle) {
  if (!calibrating) return;
  if (raw_angle < cal_observed_min) cal_observed_min = raw_angle;
  if (raw_angle > cal_observed_max) cal_observed_max = raw_angle;
  if (millis() - cal_start_time > CAL_TIMEOUT_MS) {
    finishCalibration();
  }
}

// Binary command dispatcher from WebSerial configurator
void handleCommand(uint8_t* buf, int count) {
  if (count < 1) return;
  uint8_t cmd = buf[0];
  switch (cmd) {
    case 0x02: // START_CAL
      startCalibration();
      break;
    case 0x03: // STOP_CAL
      if (calibrating) finishCalibration();
      break;
    case 0x04: // SET_CURVE (50 bytes: 1 cmd + 6*8 floats + 1 type)
      if (count >= 50) {
        for (int i = 0; i < 6; i++) {
          memcpy(&cal.curve_x[i], &buf[1 + i * 8], 4);
          memcpy(&cal.curve_y[i], &buf[1 + i * 8 + 4], 4);
        }
        cal.curve_type = buf[49];
        updateSplineCoefficients();
        sendAck(cmd);
      }
      break;
    case 0x05: // GET_CURVE
      sendCurveData();
      break;
    case 0x06: // SAVE_CURVE
      saveCalibration();
      sendAck(cmd);
      sendCurveData();
      break;
    case 0x07: // RESET_CURVE
      resetCalibrationDefaults();
      updateSplineCoefficients();
      sendAck(cmd);
      sendCurveData();
      break;
    case 0x08: // SET_CAL_RANGE (5 bytes: 0x08, min_l, min_h, max_l, max_h)
      if (count >= 5) {
        uint16_t new_min, new_max;
        memcpy(&new_min, &buf[1], 2);
        memcpy(&new_max, &buf[3], 2);
        if (new_max > new_min) {
          cal.min = new_min;
          cal.max = new_max;
          updateCalSpan();
          sendAck(cmd);
        }
      }
      break;
    case 0x09: // SET_POLLING_RATE (3 bytes: 0x09, hz_l, hz_h)
      if (count >= 3) {
        uint16_t new_hz;
        memcpy(&new_hz, &buf[1], 2);
        if (new_hz >= MIN_POLLING_HZ && new_hz <= MAX_POLLING_HZ) {
          cal.polling_rate_hz = new_hz;
          polling_delay_us = (new_hz > 4000) ? 0 : (1000000UL / cal.polling_rate_hz);
          next_loop_us = micros();
          sendAck(cmd);
        }
      }
      break;
  }
}

void setup() {
  Serial.begin(115200);

  TinyUSBDevice.setManufacturerDescriptor("Jclague");
  TinyUSBDevice.setProductDescriptor("Standalone SRP Clutch");
  TinyUSBDevice.setID(0xFA57, 0xFA57);

  next_loop_us = micros();

  pinMode(DATA_PIN, OUTPUT);
  pinMode(SCK_PIN, OUTPUT);
  pinMode(CS_PIN, OUTPUT);

  EEPROM.begin(128);
  loadCalibration();

  hid.setReportDescriptor(hid_desc, sizeof(hid_desc));
  hid.begin();
}

void loop() {
  uint16_t angle_raw = readAngle();
  float norm = processInput(angle_raw);
  float curve_norm = applyInputCurve(norm);
  axis.x = mapInputToAxis(curve_norm);

  updateCalibration(angle_raw);

  static uint8_t web_buf[128];
  static int web_count = 0;
  static unsigned long last_client_activity_ms = 0;
  static unsigned long last_telemetry_tx_us = 0;

  while (Serial.available() && web_count < 128) {
    web_buf[web_count++] = Serial.read();
    last_client_activity_ms = millis();
  }

  // 60 Hz autonomous telemetry streaming when web configurator is connected
  unsigned long now_us = micros();
  bool host_listening = (Serial && Serial.dtr()) || (millis() - last_client_activity_ms < 3000);
  if (host_listening && ((unsigned long)(now_us - last_telemetry_tx_us) >= 16666UL)) {
    last_telemetry_tx_us = now_us;
    sendStatus(angle_raw, norm, axis.x);
  }

  if (web_count > 0) {
    int offset = 0;
    while (offset < web_count) {
      uint8_t cmd = web_buf[offset];
      if (cmd == 0x01) {
        sendStatus(angle_raw, norm, axis.x);
        last_telemetry_tx_us = micros();
        offset++;
      } else if (cmd == 0x04) {
        if (web_count - offset >= 50) {
          handleCommand(&web_buf[offset], web_count - offset);
          offset += 50;
        } else {
          break; // Wait for full 50-byte packet
        }
      } else if (cmd == 0x08) {
        if (web_count - offset >= 5) {
          handleCommand(&web_buf[offset], web_count - offset);
          offset += 5;
        } else {
          break; // Wait for full 5-byte packet
        }
      } else if (cmd == 0x09) {
        if (web_count - offset >= 3) {
          handleCommand(&web_buf[offset], web_count - offset);
          offset += 3;
        } else {
          break; // Wait for full 3-byte packet
        }
      } else {
        handleCommand(&web_buf[offset], web_count - offset);
        offset++;
      }
    }
    if (offset > 0) {
      if (offset < web_count) {
        memmove(web_buf, &web_buf[offset], web_count - offset);
        web_count -= offset;
      } else {
        web_count = 0;
      }
    } else if (web_count >= 128) {
      web_count = 0; // Guard against corrupted buffer
    }
  }

  if (!TinyUSBDevice.mounted()) {
    delay(10);
    return;
  }

  if (hid.ready()) {
    hid.sendReport(1, &axis, sizeof(axis));
  }

  while ((long)(micros() - next_loop_us) < 0) {
    yield();
  }
  next_loop_us += polling_delay_us;

  if ((long)(micros() - next_loop_us) > 0) {
    next_loop_us = micros();
  }
}
