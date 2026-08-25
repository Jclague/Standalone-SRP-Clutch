# Standalone-SRP-Clutch
Simple project to convert a Moza S-RP/S-RP2 Clutch into a standalone universal joystick axis to be connected to a PC over USB. 

Inspired by Yok0-99's [SR-P-Lite-Plus project](https://github.com/Yok0-99/SR-P-Lite-Plus)

# Features
- 1-7400hz Adjustable stable polling rate (1000hz default)
- 16 bit single pedal emulation
- Pedal calibration stored between use

# Requirements
- Moza S-RP or Moza S-RP 2 clutch pedal
- Waveshare RP2040-Zero arduino (or any other TinyUSB supported microcontroller after a gpio pin remap, *NO GUARANTEE*)
- 6p6c RJ11 socket
    - Ideally with wires already attached (I used the [Concactum Media Modular RJ11 Telephone Socket](https://www.screwfix.com/p/contactum-media-modular-rj11-telephone-data-socket-black/210rk))
    - If using a through hole/punch down socket, wires are also required
- Soldering Iron
- USB-C cable

# Description
This project came around due to being sent the wrong clutch pedal from a distributor, but as the pedal I received was better than the one I ordered I decided to try and make it work. The pedal itself is simply an Infineon TLI5012B-E1000 GMR Angle Sensor attached to a lever, which typically communicates with the rest of the pedal set over a 3 pin half-duplex SPI implementation, using a single data wire for communication both ways. This means that the SPI controller on the microcontroller can't be used, and instead the communication has been bitbanged.

# 3D Printed parts
No 3D printed parts have been created for this project as I don't have a 3D printer. However, the [original inspiration project](https://github.com/Yok0-99/SR-P-Lite-Plus) provides 3D makerfiles that can likely be used with this implementation (may need modification)

# Assembly
Sensor cable RJ11 pinout:
- UNUSED          - Wire 1
- Black - CS      - Wire 2 --> GPIO Pin 26
- Red - SCK       - Wire 3 --> GPIO Pin 27
- Green - Ground  - Wire 4 --> GPIO Pin Ground
- Yellow - Data   - Wire 5 --> GPIO Pin 28
- Blue - 3.3v     - Wire 6 --> GPIO Pin 3.3v (NOT THE 5v)

### Note: 
pin identifiers are screen printed above the pin on the waveshare RP2040-Zero, not below 


<img width="1536" height="2048" alt="Clutch breakout" src="https://github.com/user-attachments/assets/1818e604-7bc5-4b26-b879-b148b8bb61f5" style="width: 50%;" />

# Instructions
1. Solder RJ11 Socket to respective pins in the breakout above
2. Flash RP2040-Zero with provided .uf2 file
   - If plugging the microcontroller in for the first time it should automatically appear as a removable storage device
   - If not, unplug the microcontroller, then hold down the BOOT button while plugging the microcontroller in
   - If neither of these work, make sure your usb cable supports data transfer
   - Drag .uf2 file onto the RP2040-Zero
4. Check [HARDWARETESTER](https://hardwaretester.com/gamepad) on a chrome-based browser, the pedal should show up as Standalone SRP Clutch with a single axis. ENSURE THIS AXIS SCALES FROM -0.99997 TO 1.0, IF NOT, FOLLOW THE CALIBRATION TUTORIAL BELOW
5. Assign controller axis to clutch pedal in game settings

# Calibration
If your pedal doesn't fit the pre-calibrated mapping:
1. Go to https://webserialterminal.com/ on any chrome-based browser
2. Set the Baud Rate to 115200

   <p align="center"><img width="590" height="180" alt="image" src="https://github.com/user-attachments/assets/48bfaf36-26f9-4d19-8195-07b6a2fb84a0" style=""/></p>

3. Press connect and select TinyUSB Serial from the drop down
4. Type **min** into the terminal text box
5. Hold the pedal fully pressed and type **max**
6. Type **show** into the terminal to check the current settings
   - Joystick Axis should sweep between -32767 and 32767
7. Type **save** into the terminal to save the current calibration into the microcontroller's memory

# Serial terminal command key
- Min - Sets the minimum angle for calibration
- Max - Sets the maximum angle for calibration
- Save - Saves the current calibration to memory
- Load - Loads the current calibration from memory
- Hz 1-7400 - Sets the current polling rate in Hz between 1-7400 inclusive 
- Show - Shows current calibration information
- Reset - Resets pedal to default pedal calibration
