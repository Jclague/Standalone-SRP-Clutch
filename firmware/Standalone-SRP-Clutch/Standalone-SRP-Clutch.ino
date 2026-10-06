#include <Arduino.h>
#include <EEPROM.h>
#include <Adafruit_TinyUSB.h>

#define CS_PIN 26
#define SCK_PIN 27
#define DATA_PIN 28

#define MIN_POLLING_HZ 1
#define MAX_POLLING_HZ 7400

// standard calibration
#define MIN_ANGLE 17824
#define MAX_ANGLE 19515
#define INIT_POLLING_HZ 1000

#define FILTER_GAIN 0.1f

#define BANG_WAIT_US 1

unsigned long next_loop_us = 0;
long polling_delay_us = (1000000UL / INIT_POLLING_HZ);

const int ReadSpiCMD[16] = {
  1, // read mode
  0, 0, 0, 0, // lock value - default access
  0, // update register access
  0, 0, 0, 0, 1, 0, // 6-bit address - AVAL stored at register 0x02
  0, 0, 0, 1 // number of data words 
};

#define EEPROM_MAGIC_OLD 0x0B0057ED
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

Adafruit_USBD_HID hid;

uint8_t hid_desc[] = {
  0x05,0x01,0x09,0x05,0xA1,0x01,0x85,0x01,
  0x09,0x30,0x16,0x00,0x80,0x26,0xFF,0x7F,
  0x75,0x10,0x95,0x01,0x81,0x02,0xC0
};

struct axis_t { int16_t x;} axis;

// Spline data
float spline_x[6];
float spline_y[6];
float spline_d[6]; // Fritsch-Carlson tangents

// Calibration mode
bool calibrating = false;
uint16_t cal_observed_min = 65535;
uint16_t cal_observed_max = 0;
unsigned long cal_start_time = 0;
#define CAL_TIMEOUT_MS 15000

void writeReadCMDWord();
uint16_t readAngle();
void saveCalibration();

void updateSplineCoefficients() {
  for (int i = 0; i < 6; i++) {
    spline_x[i] = cal.curve_x[i];
    spline_y[i] = cal.curve_y[i];
  }

  if (cal.curve_type != 0) return; // Only Monotone Cubic Spline needs tangents

  float h[5];
  float delta[5];
  for (int i = 0; i < 5; i++) {
    h[i] = spline_x[i+1] - spline_x[i];
    delta[i] = (h[i] > 0.00001f) ? (spline_y[i+1] - spline_y[i]) / h[i] : 0.0f;
  }

  spline_d[0] = delta[0];
  spline_d[5] = delta[4];
  for (int i = 1; i <= 4; i++) {
    spline_d[i] = (delta[i-1] + delta[i]) * 0.5f;
  }

  // Fritsch-Carlson condition to guarantee monotonicity and flat plateaus
  for (int i = 0; i < 5; i++) {
    if (fabsf(delta[i]) < 0.00001f) {
      spline_d[i] = 0.0f;
      spline_d[i+1] = 0.0f;
    } else {
      float alpha = spline_d[i] / delta[i];
      float beta = spline_d[i+1] / delta[i];
      if (alpha < 0.0f) spline_d[i] = 0.0f;
      if (beta < 0.0f) spline_d[i+1] = 0.0f;
      float mag2 = alpha * alpha + beta * beta;
      if (mag2 > 9.0f) {
        float tau = 3.0f / sqrtf(mag2);
        spline_d[i] = tau * alpha * delta[i];
        spline_d[i+1] = tau * beta * delta[i];
      }
    }
  }
}

float applyInputCurve(float normalized) {
  int i = 0;
  for (i = 0; i < 5; i++) {
    if (normalized <= spline_x[i+1]) break;
  }
  if (i >= 5) i = 4;
  
  float h = spline_x[i+1] - spline_x[i];
  if (h < 0.0001f) return spline_y[i];
  
  float t = normalized - spline_x[i];
  float t_norm = t / h;

  if (cal.curve_type == 1) { // Linear
    float ratio = t_norm;
    return constrain(spline_y[i] + ratio * (spline_y[i+1] - spline_y[i]), 0.0f, 1.0f);
  }

  // Monotone Cubic Hermite Spline (curveType == 0)
  float t2 = t_norm * t_norm;
  float t3 = t2 * t_norm;

  float h00 = 2.0f * t3 - 3.0f * t2 + 1.0f;
  float h10 = t3 - 2.0f * t2 + t_norm;
  float h01 = -2.0f * t3 + 3.0f * t2;
  float h11 = t3 - t2;

  float result = spline_y[i] * h00 + h * spline_d[i] * h10 + spline_y[i+1] * h01 + h * spline_d[i+1] * h11;
  return constrain(result, 0.0f, 1.0f);
}

float processInput(uint16_t signal){
  static float filteredSignal = 0.0f;
  static bool filterInit = false;
  if (!filterInit) {
    filteredSignal = (float)signal;
    filterInit = true;
  }

  float diff = (float)signal - filteredSignal;
  float absDiff = fabsf(diff);

  // Asymmetric filtering:
  // Fast attack (instant disengage, sub-millisecond bite) on pedal press
  // Smooth modulated decay (tremor and noise rejection) on pedal release
  float baseAlpha;
  if (cal.max >= cal.min) {
    baseAlpha = (diff >= 0.0f) ? 0.85f : 0.25f;
  } else {
    baseAlpha = (diff <= 0.0f) ? 0.85f : 0.25f;
  }

  // Dynamic velocity boost: large stomps/dumps bypass filter completely (latency -> 0ms)
  float velocityBoost = constrain(absDiff / 20.0f, 0.0f, 1.0f);
  float alpha = baseAlpha + (1.0f - baseAlpha) * (velocityBoost * velocityBoost);

  filteredSignal += alpha * diff;

  if (cal.max <= cal.min) return 0.0f;
  float rawNorm = (filteredSignal - (float)cal.min) / (float)(cal.max - cal.min);
  rawNorm = constrain(rawNorm, 0.0f, 1.0f);

  // Smart Deadzones & Hard Limit Snapping:
  // Top Deadzone: 4% (resting foot immunity against accidental slip)
  // Bottom Deadzone: 6% (guarantees 100% full disengagement under rig flex)
  const float TOP_DEADZONE = 0.04f;
  const float BOTTOM_DEADZONE = 0.06f;

  float effectiveNorm;
  if (rawNorm <= TOP_DEADZONE) {
    effectiveNorm = 0.0f;
  } else if (rawNorm >= (1.0f - BOTTOM_DEADZONE)) {
    effectiveNorm = 1.0f;
  } else {
    effectiveNorm = (rawNorm - TOP_DEADZONE) / (1.0f - TOP_DEADZONE - BOTTOM_DEADZONE);
  }

  return constrain(effectiveNorm, 0.0f, 1.0f);
}

int16_t mapInputToAxis(float normSignal){
  // Firm limit snapping: silence USB HID report at boundaries
  if (normSignal <= 0.0001f) return -32767;
  if (normSignal >= 0.9999f) return 32767;
  return ((float)(normSignal * 2.0f) - 1.0f) * 32767;
}

uint16_t readAngle() {
  uint16_t word = 0;
  digitalWrite(CS_PIN, LOW);
  writeReadCMDWord();
  pinMode(DATA_PIN, INPUT);
  for (int8_t i = 15; i >= 0; i--) {
    digitalWrite(SCK_PIN, HIGH);
    delayMicroseconds(BANG_WAIT_US);
    word = (word << 1) | digitalRead(DATA_PIN); 
    digitalWrite(SCK_PIN, LOW);
    delayMicroseconds(BANG_WAIT_US);
  }
  digitalWrite(CS_PIN, HIGH);
  word = word & 0x7FFF;
  return word;
}

void writeReadCMDWord(){
  pinMode(DATA_PIN, OUTPUT);
  for (int i = 0; i < 16; i++){
    digitalWrite(DATA_PIN, ReadSpiCMD[i]);
    delayMicroseconds(BANG_WAIT_US);
    digitalWrite(SCK_PIN, HIGH);
    delayMicroseconds(BANG_WAIT_US);
    digitalWrite(SCK_PIN, LOW);
    delayMicroseconds(BANG_WAIT_US);
  };
}

void saveCalibration() {
  cal.magic = CAL_MAGIC;
  EEPROM.put(0, cal);
  EEPROM.commit();
}

void loadCalibration() {
  EEPROM.get(0, cal);

  if (cal.magic == EEPROM_MAGIC_OLD || cal.magic == 0x4D435634) {
    cal.polling_rate_hz = (cal.polling_rate_hz >= MIN_POLLING_HZ && cal.polling_rate_hz <= MAX_POLLING_HZ) ? cal.polling_rate_hz : INIT_POLLING_HZ;
    cal.curve_x[0] = 0.0f; cal.curve_y[0] = 0.0f;
    cal.curve_x[1] = 0.2f; cal.curve_y[1] = 0.2f;
    cal.curve_x[2] = 0.4f; cal.curve_y[2] = 0.4f;
    cal.curve_x[3] = 0.6f; cal.curve_y[3] = 0.6f;
    cal.curve_x[4] = 0.8f; cal.curve_y[4] = 0.8f;
    cal.curve_x[5] = 1.0f; cal.curve_y[5] = 1.0f;
    cal.curve_type = 0;
    saveCalibration(); 
  } else if (cal.magic != CAL_MAGIC || cal.max <= cal.min || cal.polling_rate_hz < MIN_POLLING_HZ || cal.polling_rate_hz > MAX_POLLING_HZ) {
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

  if (cal.curve_type != 0 && cal.curve_type != 1) {
    cal.curve_type = 0;
  }

  // If intermediate curve points are collapsed/corrupted, heal them while preserving start/end Y
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
  for (int i=0; i<6; i++) {
    if (isnan(cal.curve_x[i]) || isnan(cal.curve_y[i])) hasNaN = true;
  }
  if (hasNaN) {
    cal.curve_x[0] = 0.0f; cal.curve_y[0] = 0.0f;
    cal.curve_x[1] = 0.2f; cal.curve_y[1] = 0.2f;
    cal.curve_x[2] = 0.4f; cal.curve_y[2] = 0.4f;
    cal.curve_x[3] = 0.6f; cal.curve_y[3] = 0.6f;
    cal.curve_x[4] = 0.8f; cal.curve_y[4] = 0.8f;
    cal.curve_x[5] = 1.0f; cal.curve_y[5] = 1.0f;
    saveCalibration();
  }

  polling_delay_us = (cal.polling_rate_hz > 4000) ? 0 : (1000000UL / cal.polling_rate_hz);
  updateSplineCoefficients();
}

void handleSerial(uint16_t angle_raw, float norm) {
  if (!Serial.available()) return;
  String cmd = Serial.readStringUntil('\n');
  cmd.trim();

  if (cmd == "min") { cal.min = angle_raw + 10; Serial.print("MIN:"); Serial.println(cal.min); }
  else if (cmd == "max") { cal.max = angle_raw - 10; Serial.print("MAX:"); Serial.println(cal.max); }
  else if (cmd == "save") saveCalibration();
  else if (cmd == "load") { loadCalibration(); Serial.println("Calibration loaded"); }
  else if (cmd.startsWith("hz ")) {
    long new_rate = cmd.substring(3).toInt();
    if (new_rate >= MIN_POLLING_HZ && new_rate <= MAX_POLLING_HZ) {
      cal.polling_rate_hz = new_rate;
      polling_delay_us = 1000000UL / cal.polling_rate_hz;
      next_loop_us = micros();
      Serial.print("RATE:"); 
      Serial.print(cal.polling_rate_hz); 
      Serial.println(" Hz");
    } else {
        Serial.print("Polling rate must be between ");
        Serial.print(MIN_POLLING_HZ);
        Serial.print(" and ");
        Serial.print(MAX_POLLING_HZ);
        Serial.println(" inclusive");
    }
  }
  else if (cmd == "show") {
    Serial.print("Min: "); Serial.println(cal.min);
    Serial.print("Max: "); Serial.println(cal.max);
    Serial.print("Normalised Angle: "); Serial.println(norm);
    Serial.print("Current Joystick Axis: "); Serial.println(axis.x);
    Serial.print("Polling Rate: "); Serial.println(cal.polling_rate_hz); 
  }
  else if (cmd == "reset") { 
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
    updateSplineCoefficients();
    Serial.println("Calibration reset"); 
    polling_delay_us = 1000000UL / cal.polling_rate_hz;
    next_loop_us = micros();
  }
}

void sendCalStatus(uint8_t status) {
  uint8_t buf[2];
  buf[0] = 0x82;
  buf[1] = status;
  Serial.write(buf, 2);
  Serial.flush();
}

void sendAck(uint8_t cmd_id) {
  uint8_t buf[2];
  buf[0] = 0x83;
  buf[1] = cmd_id;
  Serial.write(buf, 2);
  Serial.flush();
}

void sendCurveData() {
  uint8_t buf[50];
  buf[0] = 0x85;
  for (int i=0; i<6; i++) {
    memcpy(&buf[1 + i*8], &cal.curve_x[i], 4);
    memcpy(&buf[1 + i*8 + 4], &cal.curve_y[i], 4);
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

void sendStatus(uint16_t raw, float norm, int16_t ax) {
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
  pkt.fw_patch = 0;
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
    sendCalStatus(2); // complete - sent before flash write
    saveCalibration();
  } else {
    calibrating = false;
    sendCalStatus(3); // timeout
  }
}

void updateCalibration(uint16_t raw_angle) {
  if (!calibrating) return;
  if (raw_angle < cal_observed_min) cal_observed_min = raw_angle;
  if (raw_angle > cal_observed_max) cal_observed_max = raw_angle;
  
  if (millis() - cal_start_time > CAL_TIMEOUT_MS) {
    finishCalibration();
  }
}

void handleWebUSBCommand(uint8_t* buf, int count) {
  if (count < 1) return;
  uint8_t cmd = buf[0];
  switch (cmd) {
    case 0x02: // START_CAL
      startCalibration();
      break;
    case 0x03: // STOP_CAL
      if (calibrating) finishCalibration();
      break;
    case 0x04: // SET_CURVE
      if (count >= 50) {
        for (int i=0; i<6; i++) {
          memcpy(&cal.curve_x[i], &buf[1 + i*8], 4);
          memcpy(&cal.curve_y[i], &buf[1 + i*8 + 4], 4);
        }
        cal.curve_type = buf[49];
        updateSplineCoefficients();
        sendAck(cmd);
      } else if (count >= 34) {
        cal.curve_x[0] = 0.0f; cal.curve_y[0] = 0.0f;
        for (int i=0; i<4; i++) {
          memcpy(&cal.curve_x[i+1], &buf[1 + i*8], 4);
          memcpy(&cal.curve_y[i+1], &buf[1 + i*8 + 4], 4);
        }
        cal.curve_x[5] = 1.0f; cal.curve_y[5] = 1.0f;
        cal.curve_type = buf[33];
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
      cal.curve_x[0] = 0.0f; cal.curve_y[0] = 0.0f;
      cal.curve_x[1] = 0.2f; cal.curve_y[1] = 0.2f;
      cal.curve_x[2] = 0.4f; cal.curve_y[2] = 0.4f;
      cal.curve_x[3] = 0.6f; cal.curve_y[3] = 0.6f;
      cal.curve_x[4] = 0.8f; cal.curve_y[4] = 0.8f;
      cal.curve_x[5] = 1.0f; cal.curve_y[5] = 1.0f;
      cal.curve_type = 0;
      updateSplineCoefficients();
      saveCalibration();
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
        }
      }
      break;
  }
}

void setup() {
  Serial.begin(115200);

  TinyUSBDevice.setManufacturerDescriptor("Jclague");
  TinyUSBDevice.setProductDescriptor("Standalone SRP Clutch");
  TinyUSBDevice.setID(0xFA57, 0xFA57); // Changed PID to force Windows driver re-enumeration

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

  // Autonomous 60 Hz telemetry streaming when host is connected/listening
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
          handleWebUSBCommand(&web_buf[offset], web_count - offset);
          offset += 50;
        } else {
          // Wait for rest of 50-byte curve packet
          break;
        }
      } else if (cmd == 0x08) {
        if (web_count - offset >= 5) {
          handleWebUSBCommand(&web_buf[offset], web_count - offset);
          offset += 5;
        } else {
          // Wait for rest of 5-byte cal range packet
          break;
        }
      } else if (cmd == 0x09) {
        if (web_count - offset >= 3) {
          handleWebUSBCommand(&web_buf[offset], web_count - offset);
          offset += 3;
        } else {
          // Wait for rest of 3-byte polling rate packet
          break;
        }
      } else {
        handleWebUSBCommand(&web_buf[offset], web_count - offset);
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
      // Prevent overflow if buffer fills with unparseable data
      web_count = 0;
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
  
  if ((long)(micros() - next_loop_us) > 0)
    next_loop_us = micros();
}
