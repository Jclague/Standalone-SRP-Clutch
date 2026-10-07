# Standalone-SRP-Clutch
Simple project to convert a Moza S-RP/S-RP2 Clutch into a standalone universal joystick axis to be connected to a PC over USB. 

Inspired by Yok0-99's [SR-P-Lite-Plus project](https://github.com/Yok0-99/SR-P-Lite-Plus)

# Features
- 1-4000hz Adjustable stable polling rate (1000hz default and max usb polling rate)
- 16 bit single pedal emulation
- Pedal calibration stored between use
- Custom web app configurator for custom calibration and response curves

# Requirements
- Moza S-RP or Moza S-RP 2 clutch pedal
- Waveshare RP2040-Zero arduino
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
4. Use https://microclutch.pages.dev/ to calibrate and configure the pedal 
5. Assign controller axis to clutch pedal in game settings

# Calibration
If your pedal doesn't fit the pre-calibrated mapping or if you want a non-linear input curve:
1. Go to https://microclutch.pages.dev/ on any browser
2. Press connect and select TinyUSB Serial from the drop down
3. Press Auto Calibrate and fully press and release pedal
   - If auto calibration doesnt provide a satisfactory calibration the handles either side of the calibration gauge can be clicked and dragged
   - The output number at the top of the screen should be a static 0 on pedal release and 1 on comfortable pedal depression
4. If you wish to change the input curve of the pedal click and drag any of the handles along the graph line
   - Input curve spline types can be changed using the buttons below the graph
5. Click Save button to save the configuration to the pedal for all future use
