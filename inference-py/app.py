"""Digital Umuganda / Mbaza inference sidecar.

Runs Kinyarwanda models that aren't available on HF serverless inference and
can't run in transformers.js (PyTorch-only): an NLLB translation finetune and,
optionally, a Whisper-Kinyarwanda ASR finetune. The Node server proxies to this
service for the "Rwanda-local" engine.
"""
import os
import threading
from typing import List, Optional

from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel

HF_TOKEN = os.environ.get("HF_TOKEN")
MBAZA_MODEL = os.environ.get("MBAZA_MODEL", "mbazaNLP/Nllb_finetuned_general_en_kin")
MBAZA_ASR_MODEL = os.environ.get("MBAZA_ASR_MODEL", "mbazaNLP/Whisper-Small-Kinyarwanda")
# Greedy by default: this is a 1.3B model on CPU, where 4-beam search is ~4x
# slower (~80s/sentence). Bump MBAZA_NUM_BEAMS on a GPU host for quality.
MBAZA_NUM_BEAMS = int(os.environ.get("MBAZA_NUM_BEAMS", "1"))
# htdemucs, not the "extra"/"_q" bag-of-models variants: those are
# ensembles of 3-4 full models, and constructing each one (plain PyTorch
# weight init, before the pretrained weights even load) took minutes on
# this CPU-only sidecar — a one-time cost per process, but bad enough to
# risk the request that pays it timing out. htdemucs is a single model:
# ~18s to load. Separation itself is still slow on CPU either way (~6-7x
# real-time here) — dub-music's HTTP timeouts are sized for that.
DEMUCS_MODEL = os.environ.get("DEMUCS_MODEL", "htdemucs")
# How much to duck the instrumental under the narration, and how loud the
# narration sits on top — plain gain, no dynamic ducking (that would need
# per-cue envelope shaping, a bigger job than this first pass warrants).
DUB_MUSIC_INSTRUMENTAL_GAIN = float(os.environ.get("DUB_MUSIC_INSTRUMENTAL_GAIN", "0.45"))

app = FastAPI(title="Captioneer Mbaza sidecar")

_translate = {"ready": False, "tok": None, "model": None, "error": None}
_asr = {"ready": False, "pipe": None, "error": None}
# Keyed by ISO 639-3 code (the FLORES target code's prefix, e.g. "kin" from
# "kin_Latn" — conveniently identical to the code MMS-TTS repos use).
_tts = {"models": {}, "tokenizers": {}, "errors": {}}
_demucs = {"model": None, "error": None}
_lock = threading.Lock()
_asr_lock = threading.Lock()
_tts_lock = threading.Lock()
_demucs_lock = threading.Lock()


def _load_translate():
    """Lazy-load the NLLB finetune on first use (keeps startup fast)."""
    if _translate["ready"] or _translate["error"]:
        return
    with _lock:
        if _translate["ready"] or _translate["error"]:
            return
        try:
            import torch  # noqa: F401
            from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

            print(f"[mbaza] loading {MBAZA_MODEL} …", flush=True)
            tok = AutoTokenizer.from_pretrained(MBAZA_MODEL, token=HF_TOKEN)
            model = AutoModelForSeq2SeqLM.from_pretrained(MBAZA_MODEL, token=HF_TOKEN)
            model.eval()
            # int8 dynamic quantization: 2-4x faster Linear layers on CPU (this
            # is a 1.3B model with no GPU), with negligible translation-quality
            # loss. Disable with MBAZA_QUANTIZE=0.
            if os.environ.get("MBAZA_QUANTIZE", "1") == "1":
                try:
                    model = torch.quantization.quantize_dynamic(
                        model, {torch.nn.Linear}, dtype=torch.qint8
                    )
                    print("[mbaza] applied int8 dynamic quantization", flush=True)
                except Exception as qe:
                    print(f"[mbaza] quantization skipped: {qe}", flush=True)
            torch.set_num_threads(os.cpu_count() or 4)
            _translate.update(tok=tok, model=model, ready=True)
            print("[mbaza] translation ready", flush=True)
        except Exception as e:  # pragma: no cover - surfaced via /health
            _translate["error"] = str(e)
            print(f"[mbaza] load failed: {e}", flush=True)


def _load_asr():
    """Lazy-load the Kinyarwanda Whisper finetune for ASR."""
    if _asr["ready"] or _asr["error"]:
        return
    with _asr_lock:
        if _asr["ready"] or _asr["error"]:
            return
        try:
            import torch
            from transformers import GenerationConfig, pipeline

            print(f"[mbaza] loading ASR {MBAZA_ASR_MODEL} …", flush=True)
            pipe = pipeline(
                "automatic-speech-recognition",
                model=MBAZA_ASR_MODEL,
                token=HF_TOKEN,
            )
            # This finetune ships no generation_config.json, so transformers falls
            # back to a default that lacks the timestamp-token setup (e.g.
            # no_timestamps_token_id) return_timestamps=True needs, and every
            # request 500s. It's a whisper-small finetune (same tokenizer/vocab),
            # so the base model's generation config is the correct one to borrow.
            if getattr(pipe.model.generation_config, "no_timestamps_token_id", None) is None:
                base_config = GenerationConfig.from_pretrained(
                    "openai/whisper-small", token=HF_TOKEN
                )
                pipe.model.generation_config = base_config
                # The ASR pipeline snapshots model.generation_config into its own
                # `self.generation_config` at construction time and passes THAT to
                # generate() — not a live reference to the model's — so it has to
                # be patched separately or it keeps using the broken one.
                pipe.generation_config = base_config
                print("[mbaza] borrowed generation_config from openai/whisper-small", flush=True)
            # Same int8 dynamic quantization as the translation model above —
            # matters more here, since live mode needs each ~4s window
            # transcribed faster than it took to record for captions to keep up.
            if os.environ.get("MBAZA_QUANTIZE", "1") == "1":
                try:
                    pipe.model = torch.quantization.quantize_dynamic(
                        pipe.model, {torch.nn.Linear}, dtype=torch.qint8
                    )
                    print("[mbaza] applied int8 dynamic quantization to ASR", flush=True)
                except Exception as qe:
                    print(f"[mbaza] ASR quantization skipped: {qe}", flush=True)
            _asr.update(pipe=pipe, ready=True)
            print("[mbaza] ASR ready", flush=True)
        except Exception as e:  # pragma: no cover
            _asr["error"] = str(e)
            print(f"[mbaza] ASR load failed: {e}", flush=True)


def _load_tts(lang_code: str):
    """Lazy-load a Meta MMS-TTS voice for one language (VITS, Latin-script,
    ISO 639-3 code — e.g. "kin" for Kinyarwanda). MMS is the only broadly
    available open TTS with real Kinyarwanda coverage, which is why dubbing
    uses it instead of a Coqui/XTTS voice (XTTS's language list has no
    Kinyarwanda)."""
    if lang_code in _tts["models"] or lang_code in _tts["errors"]:
        return
    with _tts_lock:
        if lang_code in _tts["models"] or lang_code in _tts["errors"]:
            return
        try:
            from transformers import AutoTokenizer, VitsModel

            repo = f"facebook/mms-tts-{lang_code}"
            print(f"[tts] loading {repo} …", flush=True)
            tok = AutoTokenizer.from_pretrained(repo, token=HF_TOKEN)
            model = VitsModel.from_pretrained(repo, token=HF_TOKEN)
            model.eval()
            _tts["tokenizers"][lang_code] = tok
            _tts["models"][lang_code] = model
            print(f"[tts] {repo} ready", flush=True)
        except Exception as e:  # pragma: no cover - surfaced via /dub
            _tts["errors"][lang_code] = str(e)
            print(f"[tts] load failed for {lang_code}: {e}", flush=True)


def _load_demucs():
    """Lazy-load Demucs (source separation) for /dub-music — never touched
    by plain dubbing, so sessions that don't use it pay nothing. Uses the
    low-level pretrained/apply API, not demucs.api.Separator — that module
    doesn't exist in demucs==4.0.1 (added in a later release)."""
    if _demucs["model"] or _demucs["error"]:
        return
    with _demucs_lock:
        if _demucs["model"] or _demucs["error"]:
            return
        try:
            from demucs.pretrained import get_model

            print(f"[demucs] loading {DEMUCS_MODEL} …", flush=True)
            model = get_model(DEMUCS_MODEL)
            model.eval()
            _demucs["model"] = model
            print("[demucs] ready", flush=True)
        except Exception as e:  # pragma: no cover - surfaced via /dub-music
            _demucs["error"] = str(e)
            print(f"[demucs] load failed: {e}", flush=True)


@app.on_event("startup")
def _startup():
    threading.Thread(target=_load_translate, daemon=True).start()


@app.get("/health")
def health():
    return {
        "ok": True,
        "translate_ready": _translate["ready"],
        "asr_ready": _asr["ready"],
        "error": _translate["error"],
        "asr_error": _asr["error"],
        "model": MBAZA_MODEL,
        "asr_model": MBAZA_ASR_MODEL,
        "tts_languages_loaded": sorted(_tts["models"].keys()),
    }


class TranslateReq(BaseModel):
    texts: List[str]
    source: str
    target: str
    max_length: Optional[int] = 256


@app.post("/translate")
def translate(req: TranslateReq):
    _load_translate()
    if not _translate["ready"]:
        return {"error": _translate["error"] or "model still loading"}

    import torch

    tok = _translate["tok"]
    model = _translate["model"]
    tok.src_lang = req.source
    forced_bos = tok.convert_tokens_to_ids(req.target)

    out: List[str] = []
    # One sentence at a time keeps NLLB output clean (no batch-padding artifacts).
    with torch.no_grad():
        for text in req.texts:
            enc = tok(text, return_tensors="pt", truncation=True, max_length=512)
            gen = model.generate(
                **enc,
                forced_bos_token_id=forced_bos,
                max_length=req.max_length,
                num_beams=MBAZA_NUM_BEAMS,
            )
            out.append(tok.batch_decode(gen, skip_special_tokens=True)[0])
    return {"translations": out}


class TranscribeReq(BaseModel):
    # base64 of little-endian float32 PCM samples (mono), already resampled.
    audio_b64: str
    sampling_rate: int = 16000


@app.post("/transcribe")
def transcribe(req: TranscribeReq):
    """Kinyarwanda speech -> timestamped chunks (Digital Umuganda Whisper)."""
    _load_asr()
    if not _asr["ready"]:
        return {"error": _asr["error"] or "ASR model still loading"}

    import base64

    import numpy as np

    samples = np.frombuffer(base64.b64decode(req.audio_b64), dtype=np.float32).copy()
    result = _asr["pipe"](
        {"raw": samples, "sampling_rate": req.sampling_rate},
        return_timestamps=True,
        chunk_length_s=30,
        stride_length_s=5,
    )
    chunks = result.get("chunks") or [
        {"timestamp": [0, None], "text": result.get("text", "")}
    ]
    return {"chunks": chunks}


class DubCue(BaseModel):
    text: str
    start: float
    end: float


class DubReq(BaseModel):
    cues: List[DubCue]
    # FLORES target code (e.g. "kin_Latn") — only the ISO 639-3 prefix is
    # used, which happens to match the MMS-TTS repo suffix directly.
    target: str


def _synthesize_narration_track(cues: "List[DubCue]", target: str):
    """Shared by /dub and /dub-music: synthesize one continuous mono
    narration track (raw float32, NOT normalized/encoded yet) spanning all
    cues, each placed at its own start time. A cue whose speech runs longer
    than its slot is re-synthesized faster (capped at 1.6x) to fit; beyond
    that cap it's left to overflow slightly rather than distort the voice
    further. A cue that finishes early just leaves natural silence in its
    slot. Returns (waveform, sampling_rate)."""
    lang_code = target.split("_")[0].lower()
    _load_tts(lang_code)
    if lang_code in _tts["errors"]:
        raise HTTPException(status_code=500, detail=_tts["errors"][lang_code])
    if lang_code not in _tts["models"]:
        raise HTTPException(status_code=503, detail="TTS model still loading")
    if not cues:
        raise HTTPException(status_code=400, detail="No cues to dub")

    import numpy as np
    import torch

    model = _tts["models"][lang_code]
    tok = _tts["tokenizers"][lang_code]
    sampling_rate = model.config.sampling_rate

    total_samples = int(max(c.end for c in cues) * sampling_rate) + sampling_rate
    master = np.zeros(total_samples, dtype=np.float32)

    def synth(text: str, rate: float) -> "Optional[np.ndarray]":
        try:
            model.speaking_rate = rate
        except Exception:
            pass
        inputs = tok(text, return_tensors="pt")
        # Text that's entirely punctuation/emoji/symbols (e.g. "...", "🎵" for
        # background music) tokenizes to zero valid VITS vocab tokens — an
        # empty float32 tensor rather than int64, which crashes the model's
        # embedding lookup. Treat it as silence instead.
        if inputs["input_ids"].numel() == 0:
            return None
        with torch.no_grad():
            out = model(**inputs).waveform
        return out.squeeze().cpu().numpy()

    for cue in cues:
        text = cue.text.strip()
        if not text:
            continue
        slot_sec = max(cue.end - cue.start, 0.1)

        wav = synth(text, 1.0)
        if wav is None:
            continue
        actual_sec = len(wav) / sampling_rate
        if actual_sec > slot_sec:
            needed_rate = min(actual_sec / slot_sec, 1.6)
            wav = synth(text, needed_rate)

        start_idx = int(cue.start * sampling_rate)
        end_idx = min(start_idx + len(wav), len(master))
        if end_idx > start_idx:
            master[start_idx:end_idx] += wav[: end_idx - start_idx]

    return master, sampling_rate


def _encode_wav(waveform, sampling_rate: int) -> bytes:
    import io

    import numpy as np
    from scipy.io import wavfile

    peak = float(np.max(np.abs(waveform))) or 1.0
    pcm16 = (np.clip(waveform / peak, -1.0, 1.0) * 32767).astype(np.int16)
    buf = io.BytesIO()
    wavfile.write(buf, sampling_rate, pcm16)
    return buf.getvalue()


@app.post("/dub")
def dub(req: DubReq):
    """Synthesize one continuous dub track (WAV) spanning all cues — see
    _synthesize_narration_track for the per-cue fitting behavior. This is
    narration that REPLACES the original audio entirely; for music sources
    where the instrumental should survive, see /dub-music."""
    waveform, sampling_rate = _synthesize_narration_track(req.cues, req.target)
    return Response(content=_encode_wav(waveform, sampling_rate), media_type="audio/wav")


@app.post("/dub-music")
async def dub_music(
    file: UploadFile = File(...),
    cues: str = Form(...),
    target: str = Form(...),
):
    """Separate the source track into vocals/instrumental (Demucs), keep the
    instrumental, and mix translated narration on top of it in place of the
    original vocal — this is NOT sung dubbing (no melody/pitch synthesis;
    see the project's dubbing research for why real singing translation
    isn't feasible here), just spoken narration over the original music bed
    instead of narration replacing the whole mix. Quality ceiling is
    "understandable narration over a ducked instrumental," not "sounds like
    a real dub" — set expectations accordingly."""
    import json

    import numpy as np
    import torch
    import torchaudio

    try:
        cue_list = [DubCue(**c) for c in json.loads(cues)]
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid cues: {e}")

    _load_demucs()
    if _demucs["error"]:
        raise HTTPException(status_code=500, detail=_demucs["error"])
    if not _demucs["model"]:
        raise HTTPException(status_code=503, detail="Demucs model still loading")

    from demucs.apply import apply_model

    model = _demucs["model"]
    music_sr = model.samplerate

    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        tmp.write(await file.read())
        tmp.flush()
        wav, sr = torchaudio.load(tmp.name)  # [channels, samples]

    if sr != music_sr:
        wav = torchaudio.functional.resample(wav, sr, music_sr)
    if wav.shape[0] == 1 and model.audio_channels == 2:
        wav = wav.repeat(2, 1)

    # Demucs's own normalize-by-reference-stats convention (matches its CLI):
    # improves separation quality and needs un-doing on the output.
    ref = wav.mean(0)
    ref_mean, ref_std = ref.mean(), ref.std()
    wav_norm = (wav - ref_mean) / ref_std

    print("[demucs] separating vocals/instrumental …", flush=True)
    with torch.no_grad():
        sources = apply_model(model, wav_norm[None], device="cpu", progress=False)[0]
    sources = sources * ref_std + ref_mean
    stems = dict(zip(model.sources, sources))

    # Every stem except "vocals" makes up the instrumental bed.
    instrumental = sum(w for name, w in stems.items() if name != "vocals")

    narration, narration_sr = _synthesize_narration_track(cue_list, target)
    narration_t = torch.from_numpy(narration).unsqueeze(0)  # [1, samples]
    if narration_sr != music_sr:
        narration_t = torchaudio.functional.resample(narration_t, narration_sr, music_sr)
    # Match the instrumental's channel count (mono narration -> every channel).
    narration_t = narration_t.expand(instrumental.shape[0], -1)

    length = instrumental.shape[1]
    if narration_t.shape[1] < length:
        narration_t = torch.nn.functional.pad(narration_t, (0, length - narration_t.shape[1]))
    else:
        narration_t = narration_t[:, :length]

    mixed = instrumental * DUB_MUSIC_INSTRUMENTAL_GAIN + narration_t
    waveform = mixed.numpy()
    peak = float(np.max(np.abs(waveform))) or 1.0
    pcm16 = (np.clip(waveform / peak, -1.0, 1.0) * 32767).astype(np.int16).T  # [samples, channels]

    import io

    from scipy.io import wavfile

    buf = io.BytesIO()
    wavfile.write(buf, music_sr, pcm16)
    return Response(content=buf.getvalue(), media_type="audio/wav")
