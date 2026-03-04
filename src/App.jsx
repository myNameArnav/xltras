import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const APP_VERSION = import.meta.env.VITE_APP_VERSION || 'v1.0.0'

const SYNC_1 = 0xaa
const SYNC_2 = 0xd3
const PREAMBLE_BYTES = [0x55, 0x55, 0x55, 0x55]
const MAX_PAYLOAD = 180
const ANALYSIS_HOP_MS = 20
const PILOT_LOCK_HOPS = 4
const TX_PROGRESS_TICK_MS = 50
const SYNC_ACQUIRE_TARGET_BITS = 48
const MAX_SYNC_SEARCH_BITS = 2048
const MIN_BITS_BEFORE_SYNC_SCAN = 40

const STORAGE_KEYS = {
  profile: 'xltras.profile',
  ultra: 'xltras.calibration.ultra',
  audible: 'xltras.calibration.audible',
}

const PROFILE_CONFIGS = {
  ultra: {
    label: 'Near-ultrasonic',
    shortLabel: 'Ultra',
    defaults: {
      pilotFreq: 16400,
      bit0Freq: 17200,
      bit1Freq: 17800,
      symbolMs: 110,
      pilotMs: 450,
      repetition: 3,
    },
    calibrationCandidates: [15400, 15800, 16200, 16600, 17000, 17400, 17800, 18200],
    minPairSeparation: 600,
    maxPairSeparation: 3200,
  },
  audible: {
    label: 'Audible fallback',
    shortLabel: 'Audible',
    defaults: {
      pilotFreq: 4200,
      bit0Freq: 5600,
      bit1Freq: 7000,
      symbolMs: 90,
      pilotMs: 380,
      repetition: 3,
    },
    calibrationCandidates: [3200, 3800, 4400, 5000, 5600, 6200, 6800, 7400],
    minPairSeparation: 700,
    maxPairSeparation: 3600,
  },
}

const DEFAULT_RX_PARAMS = {
  minToneScore: 14,
  minDiff: 5,
  pilotScoreMin: 16,
  pilotDominance: 4,
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const sleep = ms => new Promise(resolve => window.setTimeout(resolve, ms))

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function formatEta(ms) {
  const seconds = ms / 1000
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`
}

function crc8(data) {
  let crc = 0x00
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) {
      if (crc & 0x80) {
        crc = ((crc << 1) ^ 0x07) & 0xff
      } else {
        crc = (crc << 1) & 0xff
      }
    }
  }
  return crc
}

function bytesToBits(bytes) {
  const bits = []
  for (const byte of bytes) {
    for (let i = 7; i >= 0; i -= 1) {
      bits.push((byte >> i) & 1)
    }
  }
  return bits
}

function bitsToBytes(bits) {
  const bytes = []
  for (let i = 0; i + 7 < bits.length; i += 8) {
    let value = 0
    for (let j = 0; j < 8; j += 1) {
      value = (value << 1) | bits[i + j]
    }
    bytes.push(value)
  }
  return bytes
}

function makeFrame(message) {
  const payload = textEncoder.encode(message)
  const length = Math.min(payload.length, MAX_PAYLOAD)
  const slicedPayload = payload.slice(0, length)
  const crc = crc8([length, ...slicedPayload])
  return [SYNC_1, SYNC_2, length, ...slicedPayload, crc]
}

function parseFrame(frame) {
  if (frame.length < 4) {
    return { ok: false, reason: 'Frame too short' }
  }

  if (frame[0] !== SYNC_1 || frame[1] !== SYNC_2) {
    return { ok: false, reason: 'Sync mismatch' }
  }

  const length = frame[2]
  const expectedLength = 4 + length
  if (frame.length !== expectedLength) {
    return { ok: false, reason: 'Length mismatch' }
  }

  if (length > MAX_PAYLOAD) {
    return { ok: false, reason: 'Length out of range' }
  }

  const payload = frame.slice(3, 3 + length)
  const rxCrc = frame[3 + length]
  const calcCrc = crc8([length, ...payload])

  if (rxCrc !== calcCrc) {
    return { ok: false, reason: 'CRC mismatch' }
  }

  return {
    ok: true,
    text: textDecoder.decode(Uint8Array.from(payload)),
    length,
  }
}

function getMicCapability() {
  const isSecure = window.isSecureContext
  const hasMediaDevices = typeof navigator !== 'undefined' && !!navigator.mediaDevices
  const hasGetUserMedia = hasMediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function'

  if (!isSecure) {
    return {
      ok: false,
      reason: 'insecure_context',
      message: 'Microphone requires HTTPS or localhost. Current page is not a secure context.',
    }
  }

  if (!hasMediaDevices) {
    return {
      ok: false,
      reason: 'media_devices_missing',
      message: 'navigator.mediaDevices is unavailable in this browser/context.',
    }
  }

  if (!hasGetUserMedia) {
    return {
      ok: false,
      reason: 'getusermedia_missing',
      message: 'getUserMedia is unavailable in this browser/context.',
    }
  }

  return { ok: true, reason: 'ok', message: 'Microphone APIs available.' }
}

function getAudioOutputCapability() {
  const hasAudioContext = typeof window.AudioContext === 'function' || typeof window.webkitAudioContext === 'function'
  if (!hasAudioContext) {
    return {
      ok: false,
      message: 'Web Audio is unavailable in this browser.',
    }
  }

  return {
    ok: true,
    message: 'Web Audio available.',
  }
}

function scheduleTone(ctx, destination, freq, startTime, durationSec, gain) {
  const oscillator = ctx.createOscillator()
  const gainNode = ctx.createGain()

  oscillator.type = 'sine'
  oscillator.frequency.setValueAtTime(freq, startTime)

  gainNode.gain.setValueAtTime(0, startTime)
  gainNode.gain.linearRampToValueAtTime(gain, startTime + 0.007)
  gainNode.gain.setValueAtTime(gain, startTime + durationSec - 0.007)
  gainNode.gain.linearRampToValueAtTime(0, startTime + durationSec)

  oscillator.connect(gainNode)
  gainNode.connect(destination)

  oscillator.start(startTime)
  oscillator.stop(startTime + durationSec)
}

function freqToBin(freq, sampleRate, fftSize) {
  return Math.round((freq * fftSize) / sampleRate)
}

function average(array) {
  if (array.length === 0) {
    return 0
  }
  return array.reduce((sum, value) => sum + value, 0) / array.length
}

function getNoiseFloor(bins, centerBin, gap = 2, width = 4) {
  const values = []
  for (let i = centerBin - gap - width; i <= centerBin - gap; i += 1) {
    if (i >= 0 && i < bins.length) {
      values.push(bins[i])
    }
  }
  for (let i = centerBin + gap; i <= centerBin + gap + width; i += 1) {
    if (i >= 0 && i < bins.length) {
      values.push(bins[i])
    }
  }
  return average(values)
}

function analyzeTone(bins, bin) {
  const level = bins[bin] ?? 0
  const noise = getNoiseFloor(bins, bin)
  return {
    level,
    noise,
    score: level - noise,
  }
}

function decodeRepeatedGroup(symbols) {
  let zeros = 0
  let ones = 0
  for (const symbol of symbols) {
    if (symbol === 0) {
      zeros += 1
    } else if (symbol === 1) {
      ones += 1
    }
  }

  if (zeros === 0 && ones === 0) {
    return null
  }

  if (Math.abs(zeros - ones) < 1) {
    return null
  }

  return ones > zeros ? 1 : 0
}

function findSyncInBits(bits, minBitStart = 0) {
  for (let offset = 0; offset < 8; offset += 1) {
    const bytes = bitsToBytes(bits.slice(offset))
    for (let i = 0; i + 1 < bytes.length; i += 1) {
      if (bytes[i] === SYNC_1 && bytes[i + 1] === SYNC_2) {
        const bitStart = offset + i * 8
        if (bitStart < minBitStart) {
          continue
        }
        return {
          bitStart,
        }
      }
    }
  }
  return null
}

function selectProtocolFromScores(scores, profileName) {
  const profileConfig = PROFILE_CONFIGS[profileName]
  const sorted = [...scores].sort((a, b) => b.score - a.score)
  if (sorted.length < 3) {
    return profileConfig.defaults
  }

  let bestPair = null
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const f1 = sorted[i].freq
      const f2 = sorted[j].freq
      const sep = Math.abs(f1 - f2)
      if (sep < profileConfig.minPairSeparation || sep > profileConfig.maxPairSeparation) {
        continue
      }
      const score = sorted[i].score + sorted[j].score
      if (!bestPair || score > bestPair.score) {
        bestPair = {
          bit0Freq: Math.min(f1, f2),
          bit1Freq: Math.max(f1, f2),
          score,
        }
      }
    }
  }

  if (!bestPair) {
    return profileConfig.defaults
  }

  const pilotCandidate = sorted.find(item => {
    return (
      item.freq !== bestPair.bit0Freq &&
      item.freq !== bestPair.bit1Freq &&
      Math.abs(item.freq - bestPair.bit0Freq) >= Math.floor(profileConfig.minPairSeparation * 0.65) &&
      Math.abs(item.freq - bestPair.bit1Freq) >= Math.floor(profileConfig.minPairSeparation * 0.65)
    )
  })

  if (!pilotCandidate) {
    return profileConfig.defaults
  }

  return {
    ...profileConfig.defaults,
    pilotFreq: pilotCandidate.freq,
    bit0Freq: bestPair.bit0Freq,
    bit1Freq: bestPair.bit1Freq,
  }
}

function deriveRxParams(scores, protocol) {
  const pilot = scores.find(row => row.freq === protocol.pilotFreq)
  const b0 = scores.find(row => row.freq === protocol.bit0Freq)
  const b1 = scores.find(row => row.freq === protocol.bit1Freq)

  const pilotScore = pilot?.score ?? 30
  const bit0Score = b0?.score ?? 30
  const bit1Score = b1?.score ?? 30
  const avgBitScore = (bit0Score + bit1Score) / 2

  return {
    minToneScore: Math.max(9, Math.round(avgBitScore * 0.35)),
    minDiff: Math.max(4, Math.round(avgBitScore * 0.25)),
    pilotScoreMin: Math.max(10, Math.round(pilotScore * 0.38)),
    pilotDominance: Math.max(3, Math.round(avgBitScore * 0.2)),
  }
}

function getCalibrationKey(profileName) {
  return profileName === 'audible' ? STORAGE_KEYS.audible : STORAGE_KEYS.ultra
}

function loadStoredCalibration(profileName) {
  try {
    const raw = window.localStorage.getItem(getCalibrationKey(profileName))
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw)
    if (!parsed?.protocol || !parsed?.rxParams) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function saveStoredCalibration(profileName, data) {
  try {
    window.localStorage.setItem(getCalibrationKey(profileName), JSON.stringify(data))
  } catch {
    // Ignore storage failures.
  }
}

function formatClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour12: false })
}

function App() {
  const initialProfile = useMemo(() => {
    const stored = window.localStorage.getItem(STORAGE_KEYS.profile)
    return stored && PROFILE_CONFIGS[stored] ? stored : 'ultra'
  }, [])

  const [profileName, setProfileName] = useState(initialProfile)
  const [protocol, setProtocol] = useState(PROFILE_CONFIGS[initialProfile].defaults)
  const [rxParams, setRxParams] = useState(DEFAULT_RX_PARAMS)

  const [message, setMessage] = useState('hello from xltras')
  const [txStatus, setTxStatus] = useState('Idle')
  const [rxStatus, setRxStatus] = useState('Receiver stopped')
  const [receivedText, setReceivedText] = useState('')
  const [txProgress, setTxProgress] = useState({
    active: false,
    percent: 0,
    sentSymbols: 0,
    totalSymbols: 0,
    etaMs: 0,
    startedAtMs: 0,
    endAtMs: 0,
  })
  const [rxProgress, setRxProgress] = useState({
    active: false,
    phase: 'idle',
    percent: 0,
    decodedBits: 0,
    expectedFrameBits: 0,
    detail: 'Idle',
  })
  const [rxPreview, setRxPreview] = useState({
    text: '',
    status: 'idle',
    bytesRead: 0,
  })
  const [syncStats, setSyncStats] = useState({
    attempts: 0,
    candidates: 0,
    resyncCount: 0,
  })

  const [calibrationStatus, setCalibrationStatus] = useState('Not calibrated')
  const [calibrationRows, setCalibrationRows] = useState([])
  const [isCalibrating, setIsCalibrating] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [micCapability, setMicCapability] = useState(getMicCapability)
  const [audioCapability, setAudioCapability] = useState(getAudioOutputCapability)

  const [showDebug, setShowDebug] = useState(false)
  const [debugState, setDebugState] = useState({
    fsm: 'search_pilot',
    pilotScore: 0,
    bit0Score: 0,
    bit1Score: 0,
    confidence: 0,
    decodedBits: 0,
    expectedFrameBits: 0,
    timeoutCount: 0,
    lastResetReason: 'none',
  })
  const [eventLog, setEventLog] = useState([])

  const timeoutCountRef = useRef(0)
  const loopbackExpectationRef = useRef('')
  const txProgressIntervalRef = useRef(null)
  const txProgressResetTimeoutRef = useRef(null)
  const rxProgressResetTimeoutRef = useRef(null)
  const nextPreviewLogBytesRef = useRef(4)

  const rxRefs = useRef({
    stream: null,
    context: null,
    analyser: null,
    loopId: null,
    fsm: 'search_pilot',
    pilotLockCount: 0,
    nextSymbolAtMs: 0,
    symbolBuffer: [],
    decodedBits: [],
    syncScanStartBit: 0,
    syncBitStart: null,
    expectedFrameBits: null,
    expectedPayloadLen: 0,
    lastStrongToneTs: 0,
    bins: null,
  })

  function appendEvent(level, messageText) {
    const item = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      ts: Date.now(),
      level,
      text: messageText,
    }

    setEventLog(prev => [item, ...prev].slice(0, 40))
  }

  function clearTxProgressTimers() {
    if (txProgressIntervalRef.current) {
      window.clearInterval(txProgressIntervalRef.current)
      txProgressIntervalRef.current = null
    }
    if (txProgressResetTimeoutRef.current) {
      window.clearTimeout(txProgressResetTimeoutRef.current)
      txProgressResetTimeoutRef.current = null
    }
  }

  function clearRxProgressResetTimer() {
    if (rxProgressResetTimeoutRef.current) {
      window.clearTimeout(rxProgressResetTimeoutRef.current)
      rxProgressResetTimeoutRef.current = null
    }
  }

  function resetTxProgress() {
    clearTxProgressTimers()
    setTxProgress({
      active: false,
      percent: 0,
      sentSymbols: 0,
      totalSymbols: 0,
      etaMs: 0,
      startedAtMs: 0,
      endAtMs: 0,
    })
  }

  function setRxProgressPhase(phase, percent, decodedBits, expectedFrameBits, detail) {
    setRxProgress({
      active: phase !== 'idle',
      phase,
      percent: clamp(percent, 0, 100),
      decodedBits,
      expectedFrameBits,
      detail,
    })
  }

  function resetPreview(status = 'idle', text = '', bytesRead = 0) {
    setRxPreview({
      text,
      status,
      bytesRead,
    })
    nextPreviewLogBytesRef.current = 4
  }

  useEffect(() => {
    const stored = loadStoredCalibration(profileName)
    if (stored) {
      setProtocol(stored.protocol)
      setRxParams(stored.rxParams)
      setCalibrationRows(stored.scores ?? [])
      setCalibrationStatus(`Loaded saved calibration for ${PROFILE_CONFIGS[profileName].label}`)
      appendEvent('info', `Loaded stored calibration for ${PROFILE_CONFIGS[profileName].shortLabel}`)
    } else {
      setProtocol(PROFILE_CONFIGS[profileName].defaults)
      setRxParams(DEFAULT_RX_PARAMS)
      setCalibrationRows([])
      setCalibrationStatus('Not calibrated')
      appendEvent('warn', `No stored calibration for ${PROFILE_CONFIGS[profileName].shortLabel}`)
    }

    timeoutCountRef.current = 0
    window.localStorage.setItem(STORAGE_KEYS.profile, profileName)
  }, [profileName])

  useEffect(() => {
    const updateCapability = () => {
      setMicCapability(getMicCapability())
      setAudioCapability(getAudioOutputCapability())
    }

    updateCapability()
    window.addEventListener('focus', updateCapability)
    document.addEventListener('visibilitychange', updateCapability)
    return () => {
      window.removeEventListener('focus', updateCapability)
      document.removeEventListener('visibilitychange', updateCapability)
      clearTxProgressTimers()
      clearRxProgressResetTimer()
      stopListening()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function resetReceivePipeline(reason = 'reset') {
    const refs = rxRefs.current
    refs.fsm = 'search_pilot'
    refs.pilotLockCount = 0
    refs.nextSymbolAtMs = 0
    refs.symbolBuffer = []
    refs.decodedBits = []
    refs.syncScanStartBit = 0
    refs.syncBitStart = null
    refs.expectedFrameBits = null
    refs.expectedPayloadLen = 0
    refs.lastStrongToneTs = Date.now()

    setDebugState(prev => ({
      ...prev,
      fsm: 'search_pilot',
      expectedFrameBits: 0,
      decodedBits: 0,
      timeoutCount: timeoutCountRef.current,
      lastResetReason: reason,
    }))

    if (reason === 'listening_started') {
      setSyncStats({ attempts: 0, candidates: 0, resyncCount: 0 })
      resetPreview('idle', '', 0)
      setRxProgressPhase('pilot_lock', 0, 0, 0, 'Locking pilot...')
      return
    }

    if (reason === 'frame_complete') {
      return
    }

    if (reason !== 'frame_invalid') {
      resetPreview('idle', '', 0)
    }
    setRxProgressPhase('idle', 0, 0, 0, 'Idle')
  }

  function stopListening() {
    const refs = rxRefs.current
    clearRxProgressResetTimer()

    if (refs.loopId) {
      window.clearInterval(refs.loopId)
      refs.loopId = null
    }

    if (refs.stream) {
      refs.stream.getTracks().forEach(track => track.stop())
      refs.stream = null
    }

    if (refs.context) {
      refs.context.close().catch(() => {})
      refs.context = null
    }

    refs.analyser = null
    refs.bins = null
    resetReceivePipeline('stopped')

    setIsListening(false)
    setRxStatus('Receiver stopped')
    setRxProgressPhase('idle', 0, 0, 0, 'Idle')
    appendEvent('info', 'Receiver stopped')
  }

  function getMicErrorMessage(prefix) {
    if (micCapability.ok) {
      return prefix
    }

    if (micCapability.reason === 'insecure_context') {
      return `${prefix}: ${micCapability.message} On Android, HTTP LAN URLs like http://192.168.x.x are not secure.`
    }

    return `${prefix}: ${micCapability.message}`
  }

  async function sendMessage(textOverride = null) {
    if (txProgress.active) {
      return
    }

    if (!audioCapability.ok) {
      resetTxProgress()
      setTxStatus(`Send unavailable: ${audioCapability.message}`)
      return
    }

    try {
      const payload = textOverride ?? message
      const frame = makeFrame(payload)
      const txBytes = [...PREAMBLE_BYTES, ...frame]
      const bits = bytesToBits(txBytes)
      const encodedBits = bits.flatMap(bit => Array(protocol.repetition).fill(bit))

      const context = new (window.AudioContext || window.webkitAudioContext)()
      await context.resume()

      const t0 = context.currentTime + 0.05
      const symbolSec = protocol.symbolMs / 1000
      const pilotSec = protocol.pilotMs / 1000

      scheduleTone(context, context.destination, protocol.pilotFreq, t0, pilotSec, 0.09)

      let cursor = t0 + pilotSec
      for (const bit of encodedBits) {
        scheduleTone(context, context.destination, bit ? protocol.bit1Freq : protocol.bit0Freq, cursor, symbolSec, 0.085)
        cursor += symbolSec
      }

      const durationMs = Math.ceil((cursor - t0) * 1000)
      const startAtMs = performance.now() + 50
      const endAtMs = startAtMs + durationMs

      clearTxProgressTimers()
      setTxProgress({
        active: true,
        percent: 0,
        sentSymbols: 0,
        totalSymbols: encodedBits.length,
        etaMs: durationMs,
        startedAtMs: startAtMs,
        endAtMs,
      })

      txProgressIntervalRef.current = window.setInterval(() => {
        const now = performance.now()
        const elapsedMs = clamp(now - startAtMs, 0, durationMs)
        const progressRatio = durationMs > 0 ? elapsedMs / durationMs : 1
        const percent = Math.round(progressRatio * 100)
        const sentSymbols = Math.floor(progressRatio * encodedBits.length)
        const etaMs = Math.max(0, endAtMs - now)

        setTxProgress({
          active: elapsedMs < durationMs,
          percent: clamp(percent, 0, 100),
          sentSymbols: clamp(sentSymbols, 0, encodedBits.length),
          totalSymbols: encodedBits.length,
          etaMs,
          startedAtMs: startAtMs,
          endAtMs,
        })

        if (elapsedMs >= durationMs) {
          clearTxProgressTimers()
          txProgressResetTimeoutRef.current = window.setTimeout(() => {
            resetTxProgress()
          }, 700)
        }
      }, TX_PROGRESS_TICK_MS)

      setTxStatus(`Sent ${frame.length} frame bytes (${encodedBits.length} symbols) in ${durationMs}ms using ${PROFILE_CONFIGS[profileName].label}`)
      appendEvent('info', `TX ${frame.length}B frame in ${durationMs}ms (${PROFILE_CONFIGS[profileName].shortLabel})`)

      window.setTimeout(() => {
        context.close().catch(() => {})
      }, durationMs + 150)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      resetTxProgress()
      setTxStatus(`Send failed: ${msg}`)
      appendEvent('error', `TX failed: ${msg}`)
    }
  }

  async function runCalibration() {
    if (isListening || isCalibrating) {
      return
    }

    if (!micCapability.ok) {
      setCalibrationStatus(getMicErrorMessage('Calibration unavailable'))
      return
    }

    setIsCalibrating(true)
    setCalibrationStatus('Requesting microphone...')

    let stream = null
    let context = null

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
          channelCount: 1,
        },
      })

      context = new (window.AudioContext || window.webkitAudioContext)()
      await context.resume()

      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 8192
      analyser.smoothingTimeConstant = 0.05
      source.connect(analyser)

      const bins = new Uint8Array(analyser.frequencyBinCount)
      const candidates = PROFILE_CONFIGS[profileName].calibrationCandidates
      const scoreRows = []

      for (const freq of candidates) {
        setCalibrationStatus(`Calibrating ${freq}Hz...`)

        const bin = freqToBin(freq, context.sampleRate, analyser.fftSize)
        const baselineReads = []
        for (let i = 0; i < 6; i += 1) {
          analyser.getByteFrequencyData(bins)
          baselineReads.push(analyzeTone(bins, bin).score)
          await sleep(22)
        }

        const startAt = context.currentTime + 0.04
        scheduleTone(context, context.destination, freq, startAt, 0.25, 0.1)

        await sleep(55)
        const activeReads = []
        for (let i = 0; i < 8; i += 1) {
          analyser.getByteFrequencyData(bins)
          activeReads.push(analyzeTone(bins, bin).score)
          await sleep(28)
        }

        const baseline = average(baselineReads)
        const active = average(activeReads)
        scoreRows.push({
          freq,
          baseline,
          active,
          score: active - baseline,
        })

        await sleep(35)
      }

      const selectedProtocol = selectProtocolFromScores(scoreRows, profileName)
      const selectedRxParams = deriveRxParams(scoreRows, selectedProtocol)

      const savedRows = scoreRows
        .sort((a, b) => b.score - a.score)
        .map(row => ({
          freq: row.freq,
          score: row.score.toFixed(1),
          baseline: row.baseline.toFixed(1),
          active: row.active.toFixed(1),
        }))

      setProtocol(selectedProtocol)
      setRxParams(selectedRxParams)
      setCalibrationRows(savedRows)
      setCalibrationStatus(
        `Calibrated ${PROFILE_CONFIGS[profileName].label}: pilot ${selectedProtocol.pilotFreq}Hz, bit0 ${selectedProtocol.bit0Freq}Hz, bit1 ${selectedProtocol.bit1Freq}Hz`,
      )
      appendEvent('info', `Calibration complete (${PROFILE_CONFIGS[profileName].shortLabel})`)

      saveStoredCalibration(profileName, {
        protocol: selectedProtocol,
        rxParams: selectedRxParams,
        scores: savedRows,
        timestamp: Date.now(),
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      setCalibrationStatus(`Calibration failed: ${msg}`)
      appendEvent('error', `Calibration failed: ${msg}`)
    } finally {
      if (stream) {
        stream.getTracks().forEach(track => track.stop())
      }
      if (context) {
        context.close().catch(() => {})
      }
      setIsCalibrating(false)
    }
  }

  async function startListening() {
    if (isListening) {
      return
    }

    if (!micCapability.ok) {
      setRxStatus(getMicErrorMessage('Receiver unavailable'))
      resetPreview('idle', '', 0)
      setRxProgressPhase('idle', 0, 0, 0, 'Idle')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
          channelCount: 1,
        },
      })

      const context = new (window.AudioContext || window.webkitAudioContext)()
      await context.resume()

      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 8192
      analyser.smoothingTimeConstant = 0.04
      source.connect(analyser)

      const refs = rxRefs.current
      refs.stream = stream
      refs.context = context
      refs.analyser = analyser
      refs.bins = new Uint8Array(analyser.frequencyBinCount)
      resetReceivePipeline('listening_started')

      const pilotBin = freqToBin(protocol.pilotFreq, context.sampleRate, analyser.fftSize)
      const bit0Bin = freqToBin(protocol.bit0Freq, context.sampleRate, analyser.fftSize)
      const bit1Bin = freqToBin(protocol.bit1Freq, context.sampleRate, analyser.fftSize)

      setIsListening(true)
      setRxStatus('Listening for pilot...')
      setRxProgressPhase('pilot_lock', 0, 0, 0, 'Locking pilot...')
      appendEvent('info', 'Receiver listening for pilot')

      const tryResyncFromNextBit = () => {
        if (refs.syncBitStart === null) {
          return false
        }

        const nextStart = refs.syncBitStart + 1
        const syncHit = findSyncInBits(refs.decodedBits, nextStart)
        if (!syncHit) {
          return false
        }

        refs.syncBitStart = syncHit.bitStart
        refs.expectedFrameBits = null
        refs.expectedPayloadLen = 0
        refs.fsm = 'read_len'
        setSyncStats(prev => ({ ...prev, resyncCount: prev.resyncCount + 1 }))
        setRxStatus('Resync candidate found, reading frame length...')
        setRxProgressPhase('syncing', 45, refs.decodedBits.length, 0, 'Resyncing...')
        appendEvent('warn', 'Resync candidate accepted')
        return true
      }

      refs.loopId = window.setInterval(() => {
        if (!refs.analyser || !refs.bins) {
          return
        }

        refs.analyser.getByteFrequencyData(refs.bins)

        const pilot = analyzeTone(refs.bins, pilotBin)
        const bit0 = analyzeTone(refs.bins, bit0Bin)
        const bit1 = analyzeTone(refs.bins, bit1Bin)

        const nowPerf = performance.now()
        const nowEpoch = Date.now()

        const confidence = Math.abs(bit1.score - bit0.score)
        const strongestBitScore = Math.max(bit0.score, bit1.score)

        if (refs.expectedFrameBits && refs.syncBitStart !== null) {
          const frameBitsRead = refs.decodedBits.slice(refs.syncBitStart).length
          const decodeRatio = refs.expectedFrameBits > 0 ? frameBitsRead / refs.expectedFrameBits : 0
          const readingPercent = 65 + clamp(decodeRatio * 35, 0, 35)
          setRxProgressPhase(
            'reading',
            readingPercent,
            frameBitsRead,
            refs.expectedFrameBits,
            `Reading frame ${Math.min(frameBitsRead, refs.expectedFrameBits)}/${refs.expectedFrameBits} bits`,
          )
        } else if (refs.fsm === 'lock_sync' || refs.fsm === 'read_len') {
          const syncBits = refs.decodedBits.length
          const syncRatio = clamp(syncBits / SYNC_ACQUIRE_TARGET_BITS, 0, 1)
          const syncPulse = (Math.sin(nowPerf / 150) + 1) * 2
          const syncingPercent = 25 + syncRatio * 36 + syncPulse
          const syncDetail = refs.fsm === 'read_len' ? 'Reading LEN...' : 'Searching sync bytes...'
          setRxProgressPhase('syncing', syncingPercent, syncBits, 0, syncDetail)
        } else {
          const pilotRatio = clamp(refs.pilotLockCount / PILOT_LOCK_HOPS, 0, 1)
          const pilotPercent = pilotRatio * 25
          setRxProgressPhase('pilot_lock', pilotPercent, refs.decodedBits.length, 0, 'Locking pilot...')
        }

        setDebugState({
          fsm: refs.fsm,
          pilotScore: Number(pilot.score.toFixed(1)),
          bit0Score: Number(bit0.score.toFixed(1)),
          bit1Score: Number(bit1.score.toFixed(1)),
          confidence: Number(confidence.toFixed(1)),
          decodedBits: refs.decodedBits.length,
          expectedFrameBits: refs.expectedFrameBits ?? 0,
          timeoutCount: timeoutCountRef.current,
          lastResetReason: 'none',
        })

        const pilotDominant =
          pilot.score >= rxParams.pilotScoreMin &&
          pilot.score >= strongestBitScore + rxParams.pilotDominance

        if (pilotDominant) {
          refs.lastStrongToneTs = nowEpoch
        }

        if (refs.fsm === 'search_pilot') {
          if (pilotDominant) {
            refs.pilotLockCount += 1
          } else {
            refs.pilotLockCount = Math.max(0, refs.pilotLockCount - 1)
          }

          if (refs.pilotLockCount >= PILOT_LOCK_HOPS) {
            refs.fsm = 'lock_sync'
            refs.nextSymbolAtMs = nowPerf + protocol.symbolMs * 0.55
            refs.lastStrongToneTs = nowEpoch
            setRxStatus('Pilot lock acquired, syncing frame...')
            setRxProgressPhase('syncing', 25, refs.decodedBits.length, 0, 'Searching sync bytes...')
            appendEvent('info', 'Pilot lock acquired')
          }
          return
        }

        if (nowPerf < refs.nextSymbolAtMs) {
          if (nowEpoch - refs.lastStrongToneTs > 2600) {
            timeoutCountRef.current += 1
            resetReceivePipeline('frame_timeout')
            setRxProgressPhase('pilot_lock', 0, 0, 0, 'Locking pilot...')

            if (timeoutCountRef.current >= 3 && profileName === 'ultra') {
              setRxStatus('Timed out waiting for frame; switch to Audible fallback profile')
            } else {
              setRxStatus('Timed out waiting for full frame; reset decoder')
            }

            appendEvent('warn', 'Frame timeout; decoder reset')
          }
          return
        }

        refs.nextSymbolAtMs += protocol.symbolMs

        let symbol = null
        if (strongestBitScore >= rxParams.minToneScore && confidence >= rxParams.minDiff) {
          symbol = bit1.score > bit0.score ? 1 : 0
          refs.lastStrongToneTs = nowEpoch
        }

        refs.symbolBuffer.push(symbol)

        if (refs.symbolBuffer.length < protocol.repetition) {
          return
        }

        const decodedBit = decodeRepeatedGroup(refs.symbolBuffer)
        refs.symbolBuffer = []

        if (decodedBit === null) {
          return
        }

        refs.decodedBits.push(decodedBit)

        if (refs.syncBitStart === null && refs.decodedBits.length > MAX_SYNC_SEARCH_BITS) {
          const drop = refs.decodedBits.length - MAX_SYNC_SEARCH_BITS
          refs.decodedBits = refs.decodedBits.slice(drop)
          refs.syncScanStartBit = Math.max(0, refs.syncScanStartBit - drop)
        } else if (refs.decodedBits.length > 8192) {
          refs.decodedBits = refs.decodedBits.slice(-4096)
        }

        if (refs.syncBitStart === null) {
          if (refs.decodedBits.length < MIN_BITS_BEFORE_SYNC_SCAN) {
            return
          }

          setSyncStats(prev => ({ ...prev, attempts: prev.attempts + 1 }))
          const syncHit = findSyncInBits(refs.decodedBits, refs.syncScanStartBit)
          if (!syncHit) {
            return
          }

          setSyncStats(prev => ({ ...prev, candidates: prev.candidates + 1 }))
          appendEvent('info', `Sync candidate at bit ${syncHit.bitStart}`)

          if (refs.decodedBits.length - syncHit.bitStart < 24) {
            refs.syncScanStartBit = syncHit.bitStart
            return
          }

          refs.syncBitStart = syncHit.bitStart
          refs.fsm = 'read_len'
          setRxStatus('Sync found, reading frame length...')
          setRxProgressPhase('syncing', 60, refs.decodedBits.length, 0, 'Sync acquired, reading LEN...')
          appendEvent('info', 'Sync detected')
        }

        const frameBits = refs.decodedBits.slice(refs.syncBitStart)

        if (refs.fsm === 'read_len') {
          if (frameBits.length < 24) {
            return
          }
          const len = bitsToBytes(frameBits.slice(16, 24))[0]
          if (len > MAX_PAYLOAD) {
            if (!tryResyncFromNextBit()) {
              resetReceivePipeline('invalid_len')
              setRxProgressPhase('pilot_lock', 0, 0, 0, 'Locking pilot...')
              setRxStatus('Invalid length detected; reset decoder')
              appendEvent('warn', `Invalid LEN ${len}; decoder reset`)
            }
            return
          }
          refs.expectedFrameBits = (4 + len) * 8
          refs.expectedPayloadLen = len
          refs.fsm = 'read_payload'
          setRxStatus(`Reading payload (${len} bytes)...`)
          setRxProgressPhase('reading', 65, frameBits.length, refs.expectedFrameBits, `Reading frame ${frameBits.length}/${refs.expectedFrameBits} bits`)
        }

        if (refs.expectedFrameBits && refs.expectedPayloadLen > 0) {
          const payloadBitsMax = refs.expectedPayloadLen * 8
          const payloadBitsAvailable = clamp(frameBits.length - 24, 0, payloadBitsMax)
          const payloadWholeBits = payloadBitsAvailable - (payloadBitsAvailable % 8)
          const previewBytes = bitsToBytes(frameBits.slice(24, 24 + payloadWholeBits))
          const previewText = textDecoder.decode(Uint8Array.from(previewBytes))
          const previewStatus = 'provisional'
          setRxPreview(prev => {
            if (prev.text === previewText && prev.bytesRead === previewBytes.length && prev.status === previewStatus) {
              return prev
            }
            return {
              text: previewText,
              status: previewStatus,
              bytesRead: previewBytes.length,
            }
          })

          if (previewBytes.length >= nextPreviewLogBytesRef.current) {
            appendEvent('info', `Preview updated (${previewBytes.length}B)`)
            nextPreviewLogBytesRef.current += 4
          }
        }

        if (!refs.expectedFrameBits || frameBits.length < refs.expectedFrameBits) {
          return
        }

        const frameBytes = bitsToBytes(frameBits.slice(0, refs.expectedFrameBits))
        const parsed = parseFrame(frameBytes)

        if (parsed.ok) {
          setReceivedText(parsed.text)
          timeoutCountRef.current = 0
          setRxPreview({
            text: parsed.text,
            status: 'final',
            bytesRead: parsed.length,
          })
          setRxProgressPhase('reading', 100, refs.expectedFrameBits, refs.expectedFrameBits, 'Frame complete')
          if (loopbackExpectationRef.current && parsed.text === loopbackExpectationRef.current) {
            setRxStatus(`Frame received (${parsed.length} bytes payload), loopback verified`)
            appendEvent('info', `RX ${parsed.length}B frame (loopback verified)`)
            loopbackExpectationRef.current = ''
          } else {
            setRxStatus(`Frame received (${parsed.length} bytes payload)`)
            appendEvent('info', `RX ${parsed.length}B frame`)
          }
        } else {
          if (parsed.reason === 'CRC mismatch' && tryResyncFromNextBit()) {
            setRxPreview(prev => ({ ...prev, status: 'invalid' }))
            setRxStatus('CRC mismatch; retrying resync with provisional preview retained')
            appendEvent('warn', 'CRC mismatch; preview retained as invalid')
            return
          }

          setRxPreview(prev => ({ ...prev, status: 'invalid' }))
          setRxStatus(`Decode error: ${parsed.reason}`)
          setRxProgressPhase('syncing', 0, 0, 0, 'Decoder reset')
          appendEvent('warn', `Decode error: ${parsed.reason}`)
        }

        resetReceivePipeline(parsed.ok ? 'frame_complete' : 'frame_invalid')
        if (parsed.ok) {
          clearRxProgressResetTimer()
          rxProgressResetTimeoutRef.current = window.setTimeout(() => {
            setRxProgressPhase('pilot_lock', 0, 0, 0, 'Locking pilot...')
          }, 600)
        }
      }, ANALYSIS_HOP_MS)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      setRxStatus(`Receiver failed: ${msg}`)
      appendEvent('error', `Receiver failed: ${msg}`)
      stopListening()
    }
  }

  async function sendLoopbackTest() {
    const probe = '[xltras-loopback-ping]'
    loopbackExpectationRef.current = probe
    await sendMessage(probe)
  }

  function resetCalibrationForCurrentProfile() {
    try {
      window.localStorage.removeItem(getCalibrationKey(profileName))
    } catch {
      // Ignore storage failures.
    }

    setProtocol(PROFILE_CONFIGS[profileName].defaults)
    setRxParams(DEFAULT_RX_PARAMS)
    setCalibrationRows([])
    setCalibrationStatus(`Calibration reset for ${PROFILE_CONFIGS[profileName].label}`)
    appendEvent('info', `Calibration reset for ${PROFILE_CONFIGS[profileName].shortLabel}`)
  }

  function switchToProfile(nextProfile) {
    if (profileName === nextProfile) {
      return
    }

    if (isListening) {
      stopListening()
    }

    setProfileName(nextProfile)
    setRxStatus(`Switched to ${PROFILE_CONFIGS[nextProfile].label}`)
  }

  const canTransmit = audioCapability.ok
  const canUseMic = micCapability.ok
  const canStartTx = canTransmit && !txProgress.active

  const txProgressLabel = txProgress.active
    ? `Sending ${txProgress.percent}% • ${txProgress.sentSymbols}/${txProgress.totalSymbols} symbols • ETA ${formatEta(txProgress.etaMs)}`
    : 'No active transmission'

  const rxPhaseLabelMap = {
    idle: 'Idle',
    pilot_lock: 'Pilot lock',
    syncing: 'Syncing',
    reading: 'Reading',
  }

  const rxProgressLabel = `${rxPhaseLabelMap[rxProgress.phase] ?? 'Idle'} ${Math.round(rxProgress.percent)}%`

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <h1>xltras audio messaging</h1>
          <p>Clocked BFSK protocol runtime for reliable device-to-device text transfer.</p>
        </div>
        <div className="hero-meta">
          <span className="chip">{APP_VERSION}</span>
          <span className="chip chip-muted">{PROFILE_CONFIGS[profileName].shortLabel}</span>
        </div>
      </header>

      <section className="notice-row">
        <article className="notice">
          <h3>Deployment mode</h3>
          <p>Production defaults are reliability-first. Use two devices for near-ultrasonic mode.</p>
        </article>
        <article className="notice">
          <h3>Same-device testing</h3>
          <p>Use <strong>Audible fallback</strong> and run on secure context (`https://` or `localhost`).</p>
        </article>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Profile and calibration</h2>
          <div className="inline-actions">
            <button type="button" onClick={() => switchToProfile('ultra')} disabled={profileName === 'ultra' || isCalibrating}>
              Use ultra
            </button>
            <button type="button" onClick={() => switchToProfile('audible')} disabled={profileName === 'audible' || isCalibrating}>
              Use audible
            </button>
          </div>
        </div>

        <label className="field">
          <span>Audio profile</span>
          <select
            value={profileName}
            onChange={event => setProfileName(event.target.value)}
            disabled={isListening || isCalibrating}
          >
            <option value="ultra">Near-ultrasonic (primary)</option>
            <option value="audible">Audible fallback</option>
          </select>
        </label>

        <p className="status" aria-live="polite">
          Active frequencies: pilot {protocol.pilotFreq}Hz, bit0 {protocol.bit0Freq}Hz, bit1 {protocol.bit1Freq}Hz
        </p>
        <p className="status">
          Timing: symbol {protocol.symbolMs}ms, pilot {protocol.pilotMs}ms, repetition {protocol.repetition} | Thresholds: tone{' '}
          {rxParams.minToneScore}, diff {rxParams.minDiff}
        </p>

        {!audioCapability.ok && <p className="warning">Audio unavailable: {audioCapability.message}</p>}
        {!canUseMic && <p className="warning">Mic unavailable: {micCapability.message}</p>}

        <div className="actions">
          <button type="button" onClick={runCalibration} disabled={isCalibrating || isListening || !canUseMic}>
            {isCalibrating ? 'Calibrating...' : 'Run calibration'}
          </button>
          <button type="button" onClick={resetCalibrationForCurrentProfile} disabled={isCalibrating || isListening}>
            Reset calibration
          </button>
        </div>

        <p className="status" aria-live="polite">
          {calibrationStatus}
        </p>

        {calibrationRows.length > 0 && (
          <div className="scores">
            {calibrationRows.map(row => (
              <div key={row.freq} className="score-row">
                <span>{row.freq}Hz</span>
                <span>score {row.score} (base {row.baseline}, active {row.active})</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="grid">
        <section className="panel">
          <h2>Transmitter</h2>
          <textarea
            value={message}
            onChange={event => setMessage(event.target.value)}
            rows={4}
            maxLength={MAX_PAYLOAD}
            placeholder="Type message to send"
          />
          <div className="actions">
            <button type="button" onClick={() => sendMessage()} disabled={!canStartTx}>
              Send message
            </button>
            <button type="button" onClick={sendLoopbackTest} disabled={!canStartTx}>
              Loopback test
            </button>
          </div>
          <div className={`progress-wrap ${txProgress.active ? 'is-active' : ''}`} aria-live="polite">
            <div className="progress-head">
              <span className="progress-label">{txProgressLabel}</span>
              <span className="progress-value">{Math.round(txProgress.percent)}%</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill phase-reading" style={{ width: `${txProgress.percent}%` }} />
            </div>
          </div>
          <p className="status" aria-live="polite">
            {txStatus}
          </p>
        </section>

        <section className="panel">
          <h2>Receiver</h2>
          <div className="actions">
            <button type="button" onClick={startListening} disabled={isListening || !canUseMic}>
              Start listening
            </button>
            <button type="button" onClick={stopListening} disabled={!isListening}>
              Stop listening
            </button>
            <button type="button" onClick={() => setShowDebug(v => !v)}>
              {showDebug ? 'Hide debug' : 'Show debug'}
            </button>
          </div>

          {timeoutCountRef.current >= 3 && profileName === 'ultra' && (
            <div className="assist">
              <p>Repeated frame timeouts detected in ultra profile.</p>
              <button type="button" onClick={() => switchToProfile('audible')}>
                Switch to audible fallback
              </button>
            </div>
          )}

          <p className="status" aria-live="polite">
            {rxStatus}
          </p>
          <div className={`progress-wrap ${rxProgress.active ? 'is-active' : ''}`} aria-live="polite">
            <div className="progress-head">
              <span className="progress-label">
                {rxProgressLabel} • {rxProgress.detail}
              </span>
              <span className="progress-value">{Math.round(rxProgress.percent)}%</span>
            </div>
            <div className="progress-track">
              <div className={`progress-fill phase-${rxProgress.phase.replace('_', '-')}`} style={{ width: `${rxProgress.percent}%` }} />
            </div>
          </div>
          <div className="preview-box">
            <div className="preview-head">
              <span>Live preview</span>
              <span className={`chip chip-muted preview-chip preview-${rxPreview.status}`}>
                {rxPreview.status}
              </span>
            </div>
            <div className="preview-text">{rxPreview.text || 'No provisional decode yet.'}</div>
          </div>
          <div className="rx-box">{receivedText || 'No message decoded yet.'}</div>
        </section>
      </section>

      {showDebug && (
        <section className="panel debug-panel">
          <div className="panel-head">
            <h2>Debug console</h2>
            <span className="chip chip-muted">Live metrics</span>
          </div>

          <div className="debug-metrics">
            <div className="metric">
              <label>FSM</label>
              <strong>{debugState.fsm}</strong>
            </div>
            <div className="metric">
              <label>Pilot score</label>
              <strong>{debugState.pilotScore}</strong>
            </div>
            <div className="metric">
              <label>Bit0 score</label>
              <strong>{debugState.bit0Score}</strong>
            </div>
            <div className="metric">
              <label>Bit1 score</label>
              <strong>{debugState.bit1Score}</strong>
            </div>
            <div className="metric">
              <label>Confidence</label>
              <strong>{debugState.confidence}</strong>
            </div>
            <div className="metric">
              <label>Decoded bits</label>
              <strong>{debugState.decodedBits}</strong>
            </div>
            <div className="metric">
              <label>Frame bits target</label>
              <strong>{debugState.expectedFrameBits}</strong>
            </div>
            <div className="metric">
              <label>Last reset</label>
              <strong>{debugState.lastResetReason}</strong>
            </div>
            <div className="metric">
              <label>TX progress</label>
              <strong>{Math.round(txProgress.percent)}%</strong>
            </div>
            <div className="metric">
              <label>RX phase</label>
              <strong>{rxProgress.phase}</strong>
            </div>
            <div className="metric">
              <label>RX progress</label>
              <strong>{Math.round(rxProgress.percent)}%</strong>
            </div>
            <div className="metric">
              <label>Preview bytes</label>
              <strong>{rxPreview.bytesRead}</strong>
            </div>
            <div className="metric">
              <label>Sync attempts</label>
              <strong>{syncStats.attempts}</strong>
            </div>
            <div className="metric">
              <label>Sync candidates</label>
              <strong>{syncStats.candidates}</strong>
            </div>
            <div className="metric">
              <label>Resync count</label>
              <strong>{syncStats.resyncCount}</strong>
            </div>
          </div>

          <div className="debug-log">
            <h3>Event log</h3>
            {eventLog.length === 0 ? (
              <p>No events yet.</p>
            ) : (
              <ul>
                {eventLog.map(item => (
                  <li key={item.id} data-level={item.level}>
                    <span>{formatClock(item.ts)}</span>
                    <span>{item.level}</span>
                    <span>{item.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </main>
  )
}

export default App
