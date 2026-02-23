import os
import tempfile
import importlib
import subprocess
import base64
from asyncio import to_thread


def _co_initialize_if_windows() -> bool:
    if os.name != "nt":
        return False
    try:
        import ctypes

        ctypes.windll.ole32.CoInitialize(None)
        return True
    except Exception:
        return False


def _co_uninitialize_if_needed(initialized: bool) -> None:
    if not initialized or os.name != "nt":
        return
    try:
        import ctypes

        ctypes.windll.ole32.CoUninitialize()
    except Exception:
        pass


def _list_voices_powershell_sync() -> list[dict[str, str]]:
    if os.name != "nt":
        return []
    script = r"""
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $synth.GetInstalledVoices() | ForEach-Object {
  $vi = $_.VoiceInfo
  [PSCustomObject]@{ id = $vi.Name; name = $vi.Name }
}
$voices | ConvertTo-Json -Compress
""".strip()
    result = subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        check=True,
        capture_output=True,
        text=True,
    )
    raw = (result.stdout or "").strip()
    if not raw:
        return []
    import json

    parsed = json.loads(raw)
    if isinstance(parsed, dict):
        parsed = [parsed]
    if not isinstance(parsed, list):
        return []
    output: list[dict[str, str]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        vid = str(item.get("id", "")).strip()
        name = str(item.get("name", vid)).strip() or vid
        if vid:
            output.append({"id": vid, "name": name})
    return output


def _synthesize_wav_powershell_sync(text: str, rate: int = 168, voice_id: str | None = None) -> bytes:
    if os.name != "nt":
        raise RuntimeError("PowerShell speech fallback is only available on Windows")

    # System.Speech rate range is -10..10
    norm_rate = max(120, min(220, int(rate)))
    ps_rate = int(round((norm_rate - 170) / 5))
    ps_rate = max(-10, min(10, ps_rate))

    text_b64 = base64.b64encode(text.encode("utf-8")).decode("ascii")
    voice_literal = (voice_id or "").replace("'", "''")

    script = f"""
Add-Type -AssemblyName System.Speech
$bytes = [System.Convert]::FromBase64String('{text_b64}')
$text = [System.Text.Encoding]::UTF8.GetString($bytes)
$tmp = [System.IO.Path]::GetTempFileName()
$wav = [System.IO.Path]::ChangeExtension($tmp, 'wav')
Move-Item -Path $tmp -Destination $wav -Force
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = {ps_rate}
if ('{voice_literal}' -ne '') {{
  try {{ $synth.SelectVoice('{voice_literal}') }} catch {{ }}
}}
$synth.SetOutputToWaveFile($wav)
$synth.Speak($text)
$synth.Dispose()
$outBytes = [System.IO.File]::ReadAllBytes($wav)
[System.IO.File]::Delete($wav)
[System.Convert]::ToBase64String($outBytes)
""".strip()

    result = subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        check=True,
        capture_output=True,
        text=True,
    )
    out = (result.stdout or "").strip()
    if not out:
        raise RuntimeError("PowerShell did not return audio bytes")
    return base64.b64decode(out)


def _available_voices_sync() -> list[dict[str, str]]:
    co_init = _co_initialize_if_windows()
    try:
        try:
            pyttsx3 = importlib.import_module("pyttsx3")
        except Exception:
            return _list_voices_powershell_sync()

        engine = pyttsx3.init()
        try:
            voices = engine.getProperty("voices") or []
            results: list[dict[str, str]] = []
            for voice in voices:
                vid = getattr(voice, "id", "") or ""
                name = getattr(voice, "name", "") or vid
                results.append({"id": str(vid), "name": str(name)})
            if results:
                return results
        finally:
            engine.stop()
        return _list_voices_powershell_sync()
    finally:
        _co_uninitialize_if_needed(co_init)


def _synthesize_wav_sync(text: str, rate: int = 168, voice_id: str | None = None) -> bytes:
    co_init = _co_initialize_if_windows()
    try:
        pyttsx3 = importlib.import_module("pyttsx3")

        engine = pyttsx3.init()
        normalized_rate = max(120, min(220, int(rate)))
        engine.setProperty("rate", normalized_rate)
        if voice_id:
            engine.setProperty("voice", voice_id)

        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
            wav_path = tmp.name

        try:
            engine.save_to_file(text, wav_path)
            engine.runAndWait()
            engine.stop()
            with open(wav_path, "rb") as fp:
                return fp.read()
        finally:
            if os.path.exists(wav_path):
                os.remove(wav_path)
    except Exception:
        return _synthesize_wav_powershell_sync(text, rate=rate, voice_id=voice_id)
    finally:
        _co_uninitialize_if_needed(co_init)


async def list_voices() -> list[dict[str, str]]:
    return await to_thread(_available_voices_sync)


async def synthesize_wav(text: str, rate: int = 168, voice_id: str | None = None) -> bytes:
    normalized = (text or "").strip()
    if not normalized:
        raise ValueError("Text is empty")
    return await to_thread(_synthesize_wav_sync, normalized, rate, voice_id)
