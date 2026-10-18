"""Local CPU recognition worker. JSON lines over stdio, never a network server."""
import argparse
import base64
import contextlib
import json
import os
import sys
import time
import threading
from runtime_info import Sampler, capabilities, configure_cuda_libraries


class SpeakerTimeline:
    """Match rolling-window clusters by shared audio, not their arbitrary names.

    Identity is only retained while there is overlap in the 30 second window.
    A returning speaker outside that context receives a new number.
    """
    def __init__(self):
        self.previous = []
        self.next_id = 0

    def assign(self, turns):
        scores = {}
        for start, end, label in turns:
            for old_start, old_end, identity in self.previous:
                overlap = max(0, min(end, old_end) - max(start, old_start))
                if overlap:
                    key = (label, identity)
                    scores[key] = scores.get(key, 0) + overlap
        mapping, used = {}, set()
        for (label, identity), score in sorted(scores.items(), key=lambda pair: -pair[1]):
            if score >= .15 and label not in mapping and identity not in used:
                mapping[label] = identity
                used.add(identity)
        for _, _, label in turns:
            if label not in mapping:
                mapping[label] = self.next_id
                self.next_id += 1
        self.previous = [(start, end, mapping[label]) for start, end, label in turns]
        return self.previous


def speaker_at(start, end, turns):
    scores = {}
    for left, right, identity in turns:
        overlap = max(0, min(end, right) - max(start, left))
        scores[identity] = scores.get(identity, 0) + overlap
    ranked = sorted(scores.items(), key=lambda pair: -pair[1])
    if not ranked or ranked[0][1] <= 0:
        return None
    # Overlapping voices with nearly equal support stay unlabelled.
    if len(ranked) > 1 and ranked[1][1] > ranked[0][1] * .8:
        return None
    return ranked[0][0]


def run(args, emit):
    if args.probe:
        emit({'type': 'capabilities', **capabilities()})
        return
    configure_cuda_libraries()
    sampler = Sampler()
    heartbeat_stop = threading.Event()
    def heartbeat():
        while not heartbeat_stop.wait(2):
            try:
                emit({'type': 'telemetry', **sampler.sample()})
            except Exception:
                pass
    threading.Thread(target=heartbeat, daemon=True).start()
    import numpy as np
    from faster_whisper import WhisperModel
    import ctranslate2
    if args.device == 'cuda' and args.gpu_index >= ctranslate2.get_cuda_device_count():
        raise RuntimeError('CUDA_SELECTION_UNAVAILABLE')
    if args.compute_type not in ctranslate2.get_supported_compute_types(args.device, args.gpu_index):
        raise RuntimeError('COMPUTE_TYPE_UNAVAILABLE')
    model = WhisperModel(args.model, device=args.device, device_index=args.gpu_index,
                         compute_type=args.compute_type, cpu_threads=args.cpu_threads)
    diarizer = None
    if args.diarization:
        import torch
        from pyannote.audio import Pipeline
        torch.set_num_threads(min(8, os.cpu_count() or 2))
        diarizer = Pipeline.from_pretrained("pyannote/speaker-diarization-community-1", token=os.environ.get("HF_TOKEN"))
        if diarizer is None:
            raise RuntimeError("Diarization model unavailable")
        if args.diarization_device == 'cuda':
            if not torch.cuda.is_available() or args.diarization_gpu_index >= torch.cuda.device_count():
                raise RuntimeError('DIARIZATION_CUDA_UNAVAILABLE')
            diarizer.to(torch.device('cuda:' + str(args.diarization_gpu_index)))
    # Force warm-up before claiming readiness.
    list(model.transcribe(np.zeros(16000, dtype=np.float32), language=args.language, vad_filter=False)[0])
    emit({'type': 'ready', 'runtime': {'device': args.device, 'gpuIndex': args.gpu_index if args.device == 'cuda' else None,
          'computeType': args.compute_type, 'cpuThreads': args.cpu_threads,
          'diarizationDevice': args.diarization_device if args.diarization else None,
          'diarizationGpuIndex': args.diarization_gpu_index if args.diarization and args.diarization_device == 'cuda' else None}})
    history = np.empty(0, dtype=np.float32)
    history_start, history_end = 0.0, 0.0
    timeline = SpeakerTimeline()
    for line in sys.stdin:
        started = time.monotonic()
        packet = json.loads(line)
        raw = base64.b64decode(packet["pcm"], validate=True)
        if len(raw) > 224000 or len(raw) % 2:
            raise ValueError("Invalid audio")
        audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        offset = float(packet["start"])
        turns = []
        if diarizer is not None:
            # Preserve real silence between phrases for consistent absolute timing.
            gap = max(0, offset - history_end)
            if gap > 30:
                history = np.empty(0, dtype=np.float32)
            if not len(history):
                history_start = offset
            else:
                history = np.concatenate((history, np.zeros(min(480000, round(gap * 16000)), dtype=np.float32)))
            history = np.concatenate((history, audio))
            history_end = offset + len(audio) / 16000
            if len(history) > 480000:
                history = history[-480000:]
                history_start = history_end - len(history) / 16000
            output = diarizer({"waveform": torch.from_numpy(history.copy()).unsqueeze(0), "sample_rate": 16000})
            turns = timeline.assign([(history_start + turn.start, history_start + turn.end, label) for turn, _, label in output.speaker_diarization.itertracks(yield_label=True)])
        segments, info = model.transcribe(audio, language=args.language, word_timestamps=True, beam_size=1, vad_filter=True, condition_on_previous_text=False)
        result = []
        for segment in segments:
            if segment.no_speech_prob > .65:
                continue
            for word in segment.words or []:
                identity = speaker_at(offset + word.start, offset + word.end, turns)
                if result and result[-1]["speakerId"] == identity:
                    result[-1]["text"] += word.word
                else:
                    result.append({"text": word.word, "speakerId": identity})
            if not segment.words and segment.text.strip():
                result.append({"text": segment.text, "speakerId": None})
        processing_ms = round((time.monotonic() - started) * 1000)
        emit({'type': 'result', 'id': packet['id'], 'segments': result, 'processingMs': processing_ms,
              'audioSeconds': len(audio) / 16000, 'rtf': round(processing_ms / max(1, len(audio) / 16), 3),
              'queueWaitMs': max(0, round(time.time() * 1000 - packet.get('queuedAt', time.time() * 1000) - processing_ms))})
    heartbeat_stop.set()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=["tiny", "base", "small"], default="base")
    parser.add_argument("--language", default="pt")
    parser.add_argument("--diarization", action="store_true")
    parser.add_argument('--probe', action='store_true')
    parser.add_argument('--device', choices=['cpu', 'cuda'], default='cpu')
    parser.add_argument('--gpu-index', type=int, default=0)
    parser.add_argument('--compute-type', choices=['int8', 'int8_float16', 'float16', 'float32'], default='int8')
    parser.add_argument('--cpu-threads', type=int, default=min(8, os.cpu_count() or 2))
    parser.add_argument('--diarization-device', choices=['cpu', 'cuda'], default='cpu')
    parser.add_argument('--diarization-gpu-index', type=int, default=0)
    args = parser.parse_args()
    protocol = sys.stdout
    protocol_lock = threading.Lock()
    def emit(value):
        with protocol_lock:
            protocol.write(json.dumps(value, ensure_ascii=False) + "\n")
            protocol.flush()
    try:
        # Libraries sometimes print startup messages: keep protocol stdout clean.
        with contextlib.redirect_stdout(sys.stderr):
            run(args, emit)
    except Exception as error:
        code = 'LOCAL_ENGINE_UNAVAILABLE'
        detail = str(error).lower()
        if 'diarization_cuda_unavailable' in detail:
            code = 'DIARIZATION_CUDA_UNAVAILABLE'
        elif 'cuda_selection_unavailable' in detail or 'compute_type_unavailable' in detail:
            code = 'DEVICE_CONFIGURATION_UNAVAILABLE'
        elif any(name in detail for name in ['cublas', 'cudnn', 'cuda', 'cufft']):
            code = 'CUDA_RUNTIME_UNAVAILABLE'
        emit({'type': 'error', 'code': code})
        sys.exit(1)
