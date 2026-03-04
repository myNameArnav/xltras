# xltras

`xltras` is a browser-based infra/ultrasonic messaging app that sends text as audio tones and decodes it on another device.

## Features

- Clocked BFSK protocol with frame format:
  - `PREAMBLE + SYNC1 + SYNC2 + LEN + PAYLOAD + CRC8`
- Two audio profiles:
  - `Near-ultrasonic` (primary, two-device mode)
  - `Audible fallback` (debug/reliability mode)
- Profile-aware calibration with saved settings in `localStorage`
- Receiver state machine with pilot lock, sync scan, length guard, CRC validation
- TX and RX progress bars
- Realtime RX provisional preview during payload read
- Debug console with live RF metrics and event log

## Requirements

- Modern browser with Web Audio + `getUserMedia`
- Secure context for microphone access:
  - `https://...` or `localhost`
  - Android Chrome may block mic APIs on `http://192.168.x.x`

## Run locally

```bash
npm install
npm run dev
```

## Build for production

```bash
npm run lint
npm run build
npm run preview
```

## Basic usage

1. Open app on a secure origin.
2. Select profile (`Near-ultrasonic` or `Audible fallback`).
3. Run calibration.
4. Start receiver on target device.
5. Send a message from source device.

If RX repeatedly times out in ultrasonic mode, switch to `Audible fallback`.

## Notes

- `MAX_PAYLOAD` is capped in code (`src/App.jsx`).
- Realtime preview is provisional until final CRC passes.
