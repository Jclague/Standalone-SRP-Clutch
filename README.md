# Standalone-SRP-Clutch

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![RP2040 TinyUSB](https://img.shields.io/badge/Microcontroller-RP2040--Zero-purple.svg)](https://www.waveshare.com/wiki/RP2040-Zero)
[![React 19](https://img.shields.io/badge/Frontend-React%2019%20+%20Vite-61dafb.svg)](web/)
[![WebSerial API](https://img.shields.io/badge/Interface-WebSerial%20API-orange.svg)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)

Convert a **Moza S-RP / S-RP2 Clutch Pedal** into a high-performance, standalone USB gaming controller axis with zero-install browser calibration and real-time cubic spline curve editing.

Inspired by Yok0-99's [SR-P-Lite-Plus project](https://github.com/Yok0-99/SR-P-Lite-Plus).

---

## 🌟 Key Features

- **High-Rate Polling:** 1–7400 Hz configurable polling rate (1000 Hz default stable gaming rate).
- **16-Bit Precision:** Smooth, low-noise single-axis pedal emulation (`-32767` to `32767`).
- **Interactive Web Configurator:** Modern React 19 + Vite browser tool communicating via **WebSerial** (zero software or drivers to install).
- **Monotonic Cubic Spline Response Curves:** 6-point draggable curve editor computed onboard in real-time, allowing customized bite points, deadzones, and output limits.
- **Onboard EEPROM Persistence:** Min/max calibration and curve profiles persist in non-volatile flash memory between restarts.
- **Dual-Interface USB Composite Device:** Simultaneous USB HID Gamepad and TinyUSB CDC Serial communication for uninterrupted gameplay during live telemetry tuning.

---

## 🏗️ System Architecture

```
┌─────────────────────────────────┐
│     Moza S-RP / S-RP2 Pedal     │
│  (TLI5012B-E1000 GMR Sensor)    │
└────────────────┬────────────────┘
                 │ 3-Pin Half-Duplex Bitbanged SPI
                 ▼
┌─────────────────────────────────────────────────────────────┐
│                 Waveshare RP2040-Zero MCU                   │
│                                                             │
│  • Signal Normalization & Exponential Moving Average Filter │
│  • 6-Node Monotonic Cubic Spline Evaluation (up to 7.4 kHz) │
│  • Non-Volatile Flash/EEPROM Settings Storage               │
└──────────────┬───────────────────────────────┬──────────────┘
               │ USB HID Gamepad               │ USB CDC Serial
               │ (Standard Axis)               │ (Binary Telemetry & Commands)
               ▼                               ▼
    ┌──────────────────────┐      ┌─────────────────────────────┐
    │  PC Game / Sim Rig   │      │  Web Configurator Tool      │
    │  (iRacing, AC, ACC)  │      │  (React 19 + WebSerial API) │
    └──────────────────────┘      └─────────────────────────────┘
```

---

## 📦 Repository Structure

```
Standalone-SRP-Clutch/
├── firmware/                        # Microcontroller source code
│   └── Standalone-SRP-Clutch.ino    # RP2040 Arduino C++ firmware (TinyUSB + SPI + Spline)
├── web/                             # Web Configurator web application
│   ├── src/                         # React components, hooks, WebSerial binary parser
│   ├── public/                      # Static assets & favicon
│   ├── index.html                   # HTML entry point
│   ├── package.json                 # Node.js dependencies (React 19, Vite)
│   └── vite.config.js               # Bundler configuration (portable relative base paths)
├── .gitignore                       # Clean Git configuration
└── README.md                        # Documentation & setup guide
```

---

## 🛠️ Hardware Requirements

- **Moza S-RP or Moza S-RP 2 clutch pedal**
- **Waveshare RP2040-Zero** (or compatible TinyUSB RP2040 board)
- **6p6c RJ11 Socket**
  - Ideally pre-wired (e.g. [Contactum Media Modular RJ11 Socket](https://www.screwfix.com/p/contactum-media-modular-rj11-telephone-data-socket-black/210rk))
  - If using a punch-down socket, standard hookup wire is required
- Soldering iron and solder
- USB-C data cable

---

## 🔌 Hardware Assembly & Pinout

The Moza clutch uses an Infineon TLI5012B-E1000 GMR angle sensor communicating over a 3-pin half-duplex SPI protocol (single bidirectional data line). The RP2040 bitbangs this bus on the following pins:

| RJ11 Wire | Signal | RP2040-Zero Pin | Notes |
|:---|:---|:---|:---|
| **Wire 1** | *UNUSED* | — | Not connected |
| **Wire 2 (Black)** | **CS** (Chip Select) | **GPIO 26** | |
| **Wire 3 (Red)** | **SCK** (Clock) | **GPIO 27** | |
| **Wire 4 (Green)** | **GND** (Ground) | **GND** | |
| **Wire 5 (Yellow)**| **DATA** (Half-Duplex) | **GPIO 28** | Bidirectional signal line |
| **Wire 6 (Blue)** | **3.3V** (Power) | **3.3V** | ⚠️ **DO NOT CONNECT TO 5V** |

> [!NOTE]
> Pin identifiers on the Waveshare RP2040-Zero are screen printed **above** each pin, not below.

<p align="center">
  <img width="50%" alt="Clutch Breakout Wiring" src="https://github.com/user-attachments/assets/1818e604-7bc5-4b26-b879-b148b8bb61f5" />
</p>

---

## ⚡ Firmware Installation

### Option 1: Drag-and-Drop Flash (Recommended)
1. Download the latest compiled `Standalone-SRP-Clutch.ino.uf2` from [Releases](https://github.com/Jclague/Standalone-SRP-Clutch/releases).
2. Unplug your RP2040-Zero.
3. Hold down the **BOOT** button on the RP2040-Zero and plug the USB-C cable into your PC.
4. The board will mount as a USB mass storage drive named `RPI-RP2`.
5. Drag and drop the `.uf2` file onto the `RPI-RP2` drive. The board will automatically reboot and initialize as a composite Gamepad + Serial controller.

### Option 2: Build from Source (Arduino IDE)
1. Install [Arduino IDE](https://www.arduino.cc/en/software).
2. Add the **Raspberry Pi Pico/RP2040 by Earle F. Philhower** board package:
   - In Preferences, add: `https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json`
   - Install **Raspberry Pi Pico/RP2040** via the Boards Manager.
3. Select Board: **Waveshare RP2040-Zero**.
4. Set USB Stack: **Adafruit TinyUSB** (`Tools -> USB Stack -> Adafruit TinyUSB`).
5. Open `firmware/Standalone-SRP-Clutch.ino` and click **Upload**.

---

## 🎮 Calibration & Web Configurator

### Using the Web Configurator
1. Open the [Web Configurator](https://srp-clutch.pages.dev) *(or your self-hosted instance)* in Google Chrome, Microsoft Edge, or Opera.
2. Click **Connect** in the top navigation bar and select **TinyUSB Serial / Standalone SRP Clutch**.
3. **Calibrate Range:**
   - Leave the pedal at rest and press **Set Min (Rest)**.
   - Depress the pedal completely and press **Set Max (Pressed)**.
   - Or click **Auto-Calibrate** and perform a full pedal press cycle.
4. **Tune Response Curve:**
   - Drag the 6 control points on the live cubic spline curve editor to adjust deadzones, bite point sensitivity, and initial/final throttle limits.
5. **Save to Device:**
   - Click **Save Profile to Device** to persist the configuration to onboard flash memory.
6. Verify your axis scaling on [HardwareTester Gamepad Tool](https://hardwaretester.com/gamepad).

### Fallback: Serial CLI Terminal
If using a generic terminal (such as [WebSerial Terminal](https://webserialterminal.com/)) at **115200 baud**:

| Command | Action |
|:---|:---|
| `min` | Sets current pedal position as minimum angle (0% / rest). |
| `max` | Sets current pedal position as maximum angle (100% / depressed). |
| `hz <1-7400>` | Adjusts HID polling frequency (e.g. `hz 1000`). |
| `save` | Writes current calibration and curve points to EEPROM flash. |
| `load` | Reloads calibration and curve points from EEPROM flash. |
| `show` | Prints active raw angles, calibrated span, and current curve parameters. |
| `reset` | Restores factory default calibration. |

---

## 🌐 Self-Hosting & Running Offline

The Web Configurator is a completely client-side application that can be run offline on your local machine or hosted on any static hosting platform.

> [!IMPORTANT]
> **Browser Security Context:** The [WebSerial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API) requires a **Secure Context**. It will work on `http://localhost`, `http://127.0.0.1`, or any `https://` domain. Opening the HTML file directly via `file:///` in your browser will cause WebSerial to be blocked by browser security.

### Method A: Local Development (Node.js)
```bash
# Clone the repository
git clone https://github.com/Jclague/Standalone-SRP-Clutch.git
cd Standalone-SRP-Clutch/web

# Install dependencies and launch local server
npm install
npm run dev
```
Open `http://localhost:5173` in a Chromium-based browser.

### Method B: Local Static Server (Python / No Node needed)
If you already built the static assets or want to serve the production build:
```bash
cd Standalone-SRP-Clutch/web/dist
python -m http.server 8080
```
Open `http://localhost:8080` in your browser.

### Method C: Deploying to Cloudflare Pages (Free Tier)
1. Push this repository to GitHub.
2. In the [Cloudflare Dashboard](https://dash.cloudflare.com/), navigate to **Workers & Pages** > **Create application** > **Pages** > **Connect to Git**.
3. Select the `Standalone-SRP-Clutch` repository.
4. Configure Build settings:
   - **Framework preset:** `Vite`
   - **Root directory:** `web`
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
5. Click **Save and Deploy**. Cloudflare provides free automated HTTPS hosting with unlimited bandwidth.

---

## 🧪 Testing

The web application includes comprehensive automated unit tests covering WebSerial stream recovery, telemetry packet decoding, monotonic spline mathematics, and EEPROM parsing:

```bash
cd web
npm test
```

---

## 📜 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
Moza, S-RP, and S-RP2 are trademarks of Gudsen Moza Racing. This project is an independent open-source hardware mod and is not affiliated with or endorsed by Moza Racing.
