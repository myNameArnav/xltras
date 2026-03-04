# xltras

Browser-based acoustic messaging prototype using Web Audio + WebRTC microphone capture.

## What it does

- Encodes a text frame into BFSK audio symbols.
- Sends frame as: `preamble + SYNC1 + SYNC2 + LEN + PAYLOAD + CRC8`.
- Decodes incoming audio with a clocked receiver state machine.
- Supports two profiles:
  - `Near-ultrasonic` (primary, two-device use)
  - `Audible fallback` (debug/reliability profile)

## Key reliability features

- Pilot lock before decode start.
- Clocked symbol-center sampling (not blind interval bit slicing).
- Confidence-gated bit decisions with erasure handling.
- Repetition coding for bit robustness.
- CRC8 frame validation.
- Profile-aware calibration and threshold tuning.
- Calibration persistence in `localStorage`.

## Android / microphone requirements

Microphone features (`Run calibration`, `Start listening`) require a **secure context**.

- Works on `https://...` origins.
- Works on `localhost` secure-context environments.
- Often fails on Android Chrome over `http://192.168.x.x` with missing `navigator.mediaDevices`.

If mic APIs are unavailable, the app shows an explicit error and disables mic actions.

## Scripts

- `npm run dev` - start Vite dev server
- `npm run build` - production build
- `npm run preview` - preview production build
- `npm run lint` - run ESLint

## Test flow

1. Open the app in a secure context.
2. Select profile (`Near-ultrasonic` or `Audible fallback`).
3. Run calibration.
4. Start receiver.
5. Send message (or use `Loopback test`).

If repeated timeouts occur in `Near-ultrasonic`, switch to `Audible fallback`.
