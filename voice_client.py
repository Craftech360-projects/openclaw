"""
OpenClaw Voice Client — Push-to-talk voice conversation via WebSocket.

Connects to the /cheeko/stream WebSocket endpoint on the OpenClaw gateway.
Hold SPACEBAR to speak, release to send. Audio responses play through speakers.

Usage:
    uv run voice_client.py
"""

import json
import sys
import time
import uuid
import struct
import logging
import threading
from queue import Queue, Empty

import pyaudio
import keyboard
import opuslib
import websocket  # websocket-client library

# --- Configuration ---
GATEWAY_HOST = "localhost"
GATEWAY_PORT = 18789
WS_URL = f"ws://{GATEWAY_HOST}:{GATEWAY_PORT}/cheeko/stream"

# Audio capture parameters (must match server expectations)
INPUT_SAMPLE_RATE = 16000
INPUT_CHANNELS = 1
INPUT_FRAME_DURATION_MS = 20
INPUT_SAMPLES_PER_FRAME = int(INPUT_SAMPLE_RATE * INPUT_FRAME_DURATION_MS / 1000)  # 320

# Audio playback parameters (must match server TTS output: 24kHz mono Opus)
OUTPUT_SAMPLE_RATE = 24000
OUTPUT_CHANNELS = 1
OUTPUT_FRAME_DURATION_MS = 20
OUTPUT_SAMPLES_PER_FRAME = int(OUTPUT_SAMPLE_RATE * OUTPUT_FRAME_DURATION_MS / 1000)  # 480

# Playback jitter buffer
PLAYBACK_BUFFER_START_FRAMES = 8  # Buffer this many frames before starting playback
PLAYBACK_BUFFER_MIN_FRAMES = 2    # Re-buffer if drops below this

# --- Logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("VoiceClient")

# --- Global state ---
stop_event = threading.Event()


class VoiceClient:
    """Push-to-talk voice client for the OpenClaw cheeko stream endpoint."""

    def __init__(self):
        self.ws: websocket.WebSocketApp | None = None
        self.session_id: str | None = None
        self.device_id = f"voice-client-{uuid.uuid4().hex[:8]}"
        self.connected = False
        self.handshake_done = threading.Event()

        # Audio state
        self.is_recording = False
        self.playback_queue: Queue[bytes] = Queue()
        self.audio_end_received = threading.Event()

        # Opus codecs
        self.encoder = opuslib.Encoder(
            INPUT_SAMPLE_RATE, INPUT_CHANNELS, opuslib.APPLICATION_VOIP
        )
        self.decoder = opuslib.Decoder(OUTPUT_SAMPLE_RATE, OUTPUT_CHANNELS)

        # Pipeline state
        self.current_stage = "idle"

    # ─── WebSocket handlers ──────────────────────────────────────────

    def on_open(self, ws):
        """Send hello handshake on connection open."""
        log.info("WebSocket connected, sending handshake...")
        hello = json.dumps({
            "type": "hello",
            "deviceId": self.device_id,
        })
        ws.send(hello)

    def on_message(self, ws, message):
        """Route incoming text (JSON) and binary (Opus audio) messages."""
        if isinstance(message, bytes):
            # Binary frame: Opus audio from TTS
            self.playback_queue.put(message)
            return

        # Text frame: JSON control message
        try:
            msg = json.loads(message)
        except json.JSONDecodeError:
            log.warning(f"Invalid JSON: {message[:100]}")
            return

        msg_type = msg.get("type")

        if msg_type == "hello_ack":
            self.session_id = msg.get("sessionId")
            log.info(f"Session established: {self.session_id}")
            self.handshake_done.set()

        elif msg_type == "transcript":
            partial = msg.get("partial", True)
            text = msg.get("text", "")
            prefix = "..." if partial else "YOU:"
            if text.strip():
                print(f"  {prefix} {text}", flush=True)

        elif msg_type == "response_text":
            partial = msg.get("partial", True)
            text = msg.get("text", "")
            if not partial:
                print(f"  AI: {text}", flush=True)

        elif msg_type == "audio_end":
            self.audio_end_received.set()

        elif msg_type == "music_start":
            query = msg.get("query", "")
            print(f"  [music playing: {query}]", flush=True)

        elif msg_type == "music_end":
            print("  [music stopped]", flush=True)
            self.audio_end_received.set()

        elif msg_type == "status":
            stage = msg.get("stage", "")
            self.current_stage = stage
            if stage == "thinking":
                print("  [thinking...]", flush=True)
            elif stage == "speaking":
                print("  [speaking...]", flush=True)

        elif msg_type == "error":
            log.error(f"Server error: {msg.get('message', 'unknown')}")

    def on_error(self, ws, error):
        log.error(f"WebSocket error: {error}")

    def on_close(self, ws, close_status_code, close_msg):
        log.info(f"WebSocket closed (code={close_status_code})")
        self.connected = False
        self.handshake_done.set()  # Unblock anything waiting

    # ─── Audio recording (push-to-talk) ──────────────────────────────

    def start_recording(self):
        """Begin capturing mic audio and streaming Opus frames."""
        if self.is_recording:
            return
        self.is_recording = True
        self.audio_end_received.clear()
        log.info("Recording started (spacebar held)")

        t = threading.Thread(target=self._record_loop, daemon=True)
        t.start()

    def stop_recording(self):
        """Stop recording and send speech_end to finalize STT."""
        if not self.is_recording:
            return
        self.is_recording = False
        log.info("Recording stopped (spacebar released)")

        # Tell server to finalize transcript
        if self.ws and self.connected:
            try:
                self.ws.send(json.dumps({"type": "speech_end"}))
            except Exception as e:
                log.error(f"Failed to send speech_end: {e}")

    def _record_loop(self):
        """Capture mic audio, encode to Opus, send as binary frames."""
        p = pyaudio.PyAudio()
        stream = None
        try:
            stream = p.open(
                format=pyaudio.paInt16,
                channels=INPUT_CHANNELS,
                rate=INPUT_SAMPLE_RATE,
                input=True,
                frames_per_buffer=INPUT_SAMPLES_PER_FRAME,
            )

            while self.is_recording and not stop_event.is_set():
                try:
                    pcm_data = stream.read(
                        INPUT_SAMPLES_PER_FRAME, exception_on_overflow=False
                    )
                    opus_data = self.encoder.encode(pcm_data, INPUT_SAMPLES_PER_FRAME)

                    if self.ws and self.connected:
                        self.ws.send(opus_data, opcode=websocket.ABNF.OPCODE_BINARY)
                except Exception as e:
                    log.error(f"Recording error: {e}")
                    break

        except Exception as e:
            log.error(f"Failed to open microphone: {e}")
        finally:
            if stream:
                stream.stop_stream()
                stream.close()
            p.terminate()

    # ─── Audio playback ──────────────────────────────────────────────

    def _playback_loop(self):
        """Decode incoming Opus frames and play through speakers."""
        p = pyaudio.PyAudio()
        stream = p.open(
            format=pyaudio.paInt16,
            channels=OUTPUT_CHANNELS,
            rate=OUTPUT_SAMPLE_RATE,
            output=True,
        )

        log.info("Playback thread started")
        is_playing = False

        while not stop_event.is_set():
            try:
                if not is_playing:
                    # Buffer before starting playback
                    if self.playback_queue.qsize() >= PLAYBACK_BUFFER_START_FRAMES:
                        is_playing = True
                    elif self.audio_end_received.is_set() and self.playback_queue.qsize() > 0:
                        # Audio stream ended but we have remaining frames — play them
                        is_playing = True
                    else:
                        time.sleep(0.01)
                        continue

                # Drain and play
                try:
                    opus_frame = self.playback_queue.get(timeout=0.1)
                except Empty:
                    if self.audio_end_received.is_set():
                        is_playing = False
                        self.audio_end_received.clear()
                    continue

                pcm_data = self.decoder.decode(opus_frame, OUTPUT_SAMPLES_PER_FRAME)
                stream.write(pcm_data)

                # Re-buffer if queue runs low (and we haven't received audio_end)
                if (
                    self.playback_queue.qsize() < PLAYBACK_BUFFER_MIN_FRAMES
                    and not self.audio_end_received.is_set()
                ):
                    is_playing = False

            except Exception as e:
                log.error(f"Playback error: {e}")
                is_playing = False

        stream.stop_stream()
        stream.close()
        p.terminate()
        log.info("Playback thread stopped")

    # ─── Keyboard handling ───────────────────────────────────────────

    def _setup_keyboard(self):
        """Set up spacebar push-to-talk and Escape to quit."""
        keyboard.on_press_key("space", lambda _: self.start_recording(), suppress=True)
        keyboard.on_release_key("space", lambda _: self.stop_recording(), suppress=True)
        keyboard.on_press_key("escape", lambda _: self._shutdown(), suppress=False)

    def _shutdown(self):
        """Graceful shutdown."""
        log.info("Shutting down...")
        stop_event.set()
        self.is_recording = False
        if self.ws:
            self.ws.close()

    # ─── Main entry point ────────────────────────────────────────────

    def run(self):
        """Connect to the gateway and start the voice client."""
        print()
        print("=" * 50)
        print("  OpenClaw Voice Client")
        print("=" * 50)
        print()
        print("  SPACEBAR  = Push-to-talk (hold to speak)")
        print("  ESCAPE    = Quit")
        print()
        print(f"  Connecting to {WS_URL}")
        print()

        # Start playback thread
        playback_thread = threading.Thread(target=self._playback_loop, daemon=True)
        playback_thread.start()

        # Set up keyboard hooks
        self._setup_keyboard()

        # Connect WebSocket (blocking run_forever in a thread)
        self.ws = websocket.WebSocketApp(
            WS_URL,
            on_open=self.on_open,
            on_message=self.on_message,
            on_error=self.on_error,
            on_close=self.on_close,
        )

        ws_thread = threading.Thread(
            target=lambda: self.ws.run_forever(ping_interval=30, ping_timeout=10),
            daemon=True,
        )
        ws_thread.start()

        # Wait for handshake
        self.handshake_done.wait(timeout=10)
        if not self.session_id:
            log.error("Handshake failed — could not connect to gateway")
            stop_event.set()
            return

        self.connected = True
        print("  Ready! Hold SPACEBAR to speak.\n")

        # Main loop — keep alive until shutdown
        try:
            while not stop_event.is_set():
                time.sleep(0.1)
        except KeyboardInterrupt:
            pass
        finally:
            self._shutdown()
            # Give threads a moment to clean up
            time.sleep(0.5)
            print("\n  Goodbye!\n")


if __name__ == "__main__":
    client = VoiceClient()
    client.run()
