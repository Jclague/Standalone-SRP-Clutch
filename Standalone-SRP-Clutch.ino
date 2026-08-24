#include <Arduino.h>
#include <EEPROM.h>
#include <Adafruit_TinyUSB.h>
#include <SPI.h>

#define CS_PIN 26
#define SCK_PIN 27
#define DATA_PIN 28

// standard calibration
#define MIN_ANGLE 17824
#define MAX_ANGLE 19515
#define INIT_POLLING_HZ 1000

#define MIN_POLLING_HZ 1
#define MAX_POLLING_HZ 5400

#define FILTER_GAIN 0.1f

unsigned long next_loop_us = 0;

long polling_delay_us (1000000UL / INIT_POLLING_HZ);

const int ReadSpiCMD[16] = {
  1, // read mode
  0, 0, 0, 0, // lock value - default access
  0, // update register access
  0, 0, 0, 0, 1, 0, // 6-bit address - AVAL stored at register 0x02
  0, 0, 0, 1 // number of data words 
};

struct calibration_t {
  uint32_t magic;
  uint16_t min;
  uint16_t max;
  uint16_t polling_rate_hz;
} cal;


#define EEPROM_MAGIC 0x0B0057ED
Adafruit_USBD_HID hid;

// represent self as a single 16 bit joystick axis
uint8_t hid_desc[] = {
  0x05,0x01,0x09,0x05,0xA1,0x01,0x85,0x01,
  0x09,0x30,0x16,0x00,0x80,0x26,0xFF,0x7F,
  0x75,0x10,0x95,0x01,0x81,0x02,0xC0
};

// variable reported as hid axis - potential for multiple axis
struct axis_t { int16_t x;} axis;

// filter and normalise input
float processInput(uint16_t signal){
  // leaky integrator filter
  static float filteredSignal = 0;
  filteredSignal = (signal * FILTER_GAIN) + (filteredSignal * (1 - FILTER_GAIN));

  // clamp to 0-1
  float normalised = (float)(filteredSignal - cal.min) / (float)(cal.max - cal.min);

  if (normalised < 0)
    normalised = 0;
  else if (normalised > 1)
    normalised = 1;

  return normalised;
}

int16_t mapInputToAxis(float normSignal){
  return ((float)(normSignal * 2.0f) - 1.0f) * 32767;
}

uint16_t readAngle() {
  uint16_t word = 0;

  // wake sensor
  digitalWrite(CS_PIN, LOW);

  writeReadCMDWord();

  // stop driving data pin
  pinMode(DATA_PIN, INPUT);
  for (int8_t i = 15; i >= 0; i--) {
    digitalWrite(SCK_PIN, HIGH);
    word = (word << 1) | digitalRead(DATA_PIN); 
    digitalWrite(SCK_PIN, LOW);
  }

  // sensor communication ended
  digitalWrite(CS_PIN, HIGH);
  
  // ignore first bit of 16 bit word
  word = word & 0x7FFF;

  return word;
}

void writeReadCMDWord(){
  pinMode(DATA_PIN, OUTPUT);

  for (int i = 0; i < 16; i++){
    digitalWrite(DATA_PIN, ReadSpiCMD[i]);
    digitalWrite(SCK_PIN, HIGH);
    digitalWrite(SCK_PIN, LOW);
  };
}


void saveCalibration() {
  cal.magic = EEPROM_MAGIC;
  EEPROM.put(0, cal);
  EEPROM.commit();
  Serial.println("Calibration saved!");
}

void loadCalibration() {
  EEPROM.get(0, cal);

  // was the calibration written from this software
  if (cal.magic != EEPROM_MAGIC) {
    cal.min = MIN_ANGLE;
    cal.max = MAX_ANGLE;
    cal.polling_rate_hz = INIT_POLLING_HZ;
  }

  polling_delay_us = 1000000UL / cal.polling_rate_hz;
}

void handleSerial() {
  if (!Serial.available()) return;
  String cmd = Serial.readStringUntil('\n');
  cmd.trim();
  uint32_t raw = readAngle();

  if (cmd == "min") { cal.min = raw + 10; Serial.print("MIN:"); Serial.println(cal.min); }
  else if (cmd == "max") { cal.max = raw - 10; Serial.print("MAX:"); Serial.println(cal.max); }
  else if (cmd == "save") saveCalibration();
  else if (cmd == "load") { loadCalibration(); Serial.println("Calibration loaded"); }
  else if (cmd.startsWith("hz ")) {
    long new_rate = cmd.substring(3).toInt();
      if (new_rate >= MIN_POLLING_HZ && new_rate <= MAX_POLLING_HZ) {
        cal.polling_rate_hz = new_rate;
        polling_delay_us = 1000000UL / cal.polling_rate_hz;
        next_loop_us = micros(); // resync scheduler so change takes effect immediately, not after a stale interval
        Serial.print("RATE:"); 
        Serial.print(cal.polling_rate_hz); 
        Serial.println(" Hz");
      } else 
        Serial.println("Polling rate must be between 1 and 5400 inclusive");
  }
  else if (cmd == "show") {
    Serial.print("Min: ");
    Serial.println(cal.min);
    Serial.print("Max: ");
    Serial.println(cal.max);
    Serial.print("Polling Rate: ");
    Serial.println(cal.polling_rate_hz); 
  }
  else if (cmd == "reset") { 
    cal.min = MIN_ANGLE; 
    cal.max = MAX_ANGLE; 
    cal.polling_rate_hz = INIT_POLLING_HZ; 
    Serial.println("Calibration reset"); 
    polling_delay_us = 1000000UL / cal.polling_rate_hz;
    next_loop_us = micros();
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

    EEPROM.begin(sizeof(cal));
    loadCalibration();

    // set descriptor of the mcu hid
    hid.setReportDescriptor(hid_desc, sizeof(hid_desc));
    // start mcu hid
    hid.begin();

}

void loop() {
  handleSerial();

  uint16_t angle_raw = readAngle();
  float norm = processInput(angle_raw);
  axis.x = mapInputToAxis(norm);

  if (!TinyUSBDevice.mounted()) {
    delay(10);
    return;
  }

  hid.sendReport(1, &axis, sizeof(axis));

  while ((long)(micros() - next_loop_us) < 0) {};
  next_loop_us += polling_delay_us;
  
  if ((long)(micros() - next_loop_us) > 0)
    next_loop_us = micros();
}