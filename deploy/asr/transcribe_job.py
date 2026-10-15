#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import resource
import select
import stat
import subprocess
import tempfile
import threading
import time
import unicodedata
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Optional

MAX_STDERR_BYTES = 256 * 1024
MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024
MAX_TRANSCRIPT_BYTES_PER_AUDIO_SECOND = 48
TRANSCRIPT_SEGMENT_SLACK_BYTES = 256
MAX_CAPTURE_SEGMENT_BYTES = 2 * 1024 * 1024
MAX_CAPTURE_SEGMENT_MS = 15_000
MAX_CAPTURE_AUDIO_MS = 3 * 60 * 60 * 1000
MAX_CAPTURE_SEGMENTS = 100_000


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json_object(path: Path) -> dict:
    value = json.loads(path.read_bytes(), parse_constant=reject_constant)
    if not isinstance(value, dict):
        raise TypeError(f"{path.name} must contain a JSON object")
    return value


def reject_constant(value: str) -> None:
    raise ValueError(f"invalid JSON numeric constant: {value}")


def verify_bundle(root: Path, provenance: dict) -> None:
    files = provenance.get("files")
    if not isinstance(files, dict) or not files:
        raise ValueError(f"{root} provenance has no files")
    resolved_root = root.resolve(strict=True)
    for name, record in files.items():
        if not isinstance(record, dict):
            raise TypeError(f"invalid provenance record: {name}")
        relative = record.get("path")
        expected_digest = record.get("sha256")
        expected_bytes = record.get("bytes")
        if (
            not isinstance(relative, str)
            or relative.startswith("/")
            or ".." in Path(relative).parts
            or not isinstance(expected_digest, str)
            or len(expected_digest) != 64
            or isinstance(expected_bytes, bool)
            or not isinstance(expected_bytes, int)
        ):
            raise ValueError(f"invalid provenance fields: {name}")
        path = root / relative
        stat = path.lstat()
        if not path.is_file() or path.is_symlink() or stat.st_nlink != 1:
            raise ValueError(f"bundle file is unsafe: {name}")
        if path.resolve(strict=True).parent != (resolved_root / Path(relative).parent).resolve(strict=True):
            raise ValueError(f"bundle file escapes its root: {name}")
        if stat.st_size != expected_bytes or sha256_file(path) != expected_digest:
            raise ValueError(f"bundle file does not match provenance: {name}")


def load_manifest(path: Path, expected_job_id: str, expected_digest: str) -> dict:
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_digest:
        raise ValueError("manifest digest mismatch inside sandbox")
    manifest = json.loads(raw, parse_constant=reject_constant)
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema_version") != 1
        or manifest.get("job_id") != expected_job_id
        or not isinstance(manifest.get("segments"), list)
        or len(manifest["segments"]) > MAX_CAPTURE_SEGMENTS
    ):
        raise ValueError("manifest identity or schema mismatch inside sandbox")
    if manifest.get("capture") != {
        "codec": "pcm_s16le",
        "sample_rate": 48_000,
        "channels": 1,
        "sample_width": 2,
        "dave": True,
    }:
        raise ValueError("manifest capture format is unsupported inside sandbox")
    seen: set[str] = set()
    total_audio_ms = 0
    for segment in manifest["segments"]:
        if not isinstance(segment, dict):
            raise TypeError("manifest segment must be an object")
        segment_id = segment.get("segment_id")
        start_ms = segment.get("start_ms")
        end_ms = segment.get("end_ms")
        duration_ms = segment.get("duration_ms")
        expected_bytes = segment.get("bytes")
        pcm_bytes = segment.get("pcm_bytes")
        expected_sha256 = segment.get("sha256")
        if (
            not isinstance(segment_id, str)
            or len(segment_id) != 6
            or not segment_id.isascii()
            or not segment_id.isdigit()
            or segment_id in seen
            or segment.get("path") != f"segments/{segment_id}.wav"
            or not isinstance(segment.get("speaker_id"), str)
            or isinstance(start_ms, bool)
            or not isinstance(start_ms, int)
            or start_ms < 0
            or isinstance(duration_ms, bool)
            or not isinstance(duration_ms, int)
            or not 0 < duration_ms <= MAX_CAPTURE_SEGMENT_MS
            or isinstance(end_ms, bool)
            or not isinstance(end_ms, int)
            or end_ms != start_ms + duration_ms
            or isinstance(expected_bytes, bool)
            or not isinstance(expected_bytes, int)
            or not 44 <= expected_bytes <= MAX_CAPTURE_SEGMENT_BYTES
            or isinstance(pcm_bytes, bool)
            or not isinstance(pcm_bytes, int)
            or pcm_bytes <= 0
            or not isinstance(expected_sha256, str)
            or len(expected_sha256) != 64
            or any(character not in "0123456789abcdef" for character in expected_sha256)
        ):
            raise ValueError("manifest segment metadata is invalid")
        seen.add(segment_id)
        total_audio_ms += duration_ms
        if total_audio_ms > MAX_CAPTURE_AUDIO_MS:
            raise ValueError("manifest aggregate audio exceeds its sandbox bound")
    return manifest


def copy_verified_segment(source: Path, destination: Path, segment: dict) -> None:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(source, flags)
    digest = hashlib.sha256()
    copied = 0
    try:
        source_stat = os.fstat(descriptor)
        if (
            not stat.S_ISREG(source_stat.st_mode)
            or source_stat.st_nlink != 1
            or source_stat.st_size != segment["bytes"]
            or source_stat.st_size > MAX_CAPTURE_SEGMENT_BYTES
        ):
            raise ValueError(f"segment {segment['segment_id']} has an unsafe source file")
        with os.fdopen(descriptor, "rb", closefd=False) as source_handle, destination.open("xb") as output:
            while True:
                chunk = source_handle.read(1024 * 1024)
                if not chunk:
                    break
                copied += len(chunk)
                if copied > segment["bytes"]:
                    raise ValueError(f"segment {segment['segment_id']} grew while being copied")
                digest.update(chunk)
                output.write(chunk)
        final_stat = os.fstat(descriptor)
        if (
            copied != segment["bytes"]
            or final_stat.st_size != source_stat.st_size
            or digest.hexdigest() != segment["sha256"]
        ):
            raise ValueError(f"segment {segment['segment_id']} does not match its sealed digest")
    finally:
        os.close(descriptor)

    with wave.open(str(destination), "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != 48_000:
            raise ValueError(f"segment {segment['segment_id']} WAV format is invalid")
        pcm_bytes = wav.getnframes() * wav.getsampwidth()
        duration_ms = round(wav.getnframes() * 1000 / wav.getframerate())
    if pcm_bytes != segment["pcm_bytes"] or duration_ms != segment["duration_ms"]:
        raise ValueError(f"segment {segment['segment_id']} WAV duration is invalid")


def normalized_hotwords(manifest: dict) -> str:
    names: list[str] = []
    participants = manifest.get("participants", [])
    if not isinstance(participants, list):
        return ""
    for participant in participants[:20]:
        if not isinstance(participant, dict):
            continue
        name = participant.get("display_name_snapshot")
        if not isinstance(name, str):
            continue
        cleaned = "".join(
            character
            for character in unicodedata.normalize("NFKC", name)
            if character.isprintable() and character not in "\r\n\t"
        ).strip()
        if cleaned:
            names.append(cleaned[:64])
    return ", ".join(names)[:512]


def normalize_audio(ffmpeg: Path, source: Path, destination: Path, sample_rate: int) -> None:
    command = [
        str(ffmpeg),
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-map_metadata",
        "-1",
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-sample_fmt",
        "s16",
        "-y",
        str(destination),
    ]
    completed = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, timeout=180, check=False)
    if completed.returncode != 0:
        error = completed.stderr[:8192].decode("utf-8", "replace").replace("\n", " ")
        raise RuntimeError(f"ffmpeg normalization failed: {error}")
    with wave.open(str(destination), "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != sample_rate:
            raise RuntimeError("ffmpeg produced an unexpected WAV format")


class BoundedStderr:
    def __init__(self, stream: Optional[BinaryIO]):
        self.stream = stream
        self.buffer = bytearray()
        self.thread = threading.Thread(target=self._drain, daemon=True)

    def start(self) -> None:
        self.thread.start()

    def join(self, timeout: float = 10) -> None:
        self.thread.join(timeout)

    def _drain(self) -> None:
        if self.stream is None:
            return
        while True:
            chunk = self.stream.read(4096)
            if not chunk:
                return
            remaining = MAX_STDERR_BYTES - len(self.buffer)
            if remaining > 0:
                self.buffer.extend(chunk[:remaining])


class VibeEngine:
    def __init__(self, runtime_root: Path, model_root: Path, threads: int, context: str):
        runtime = runtime_root / "bin" / "asr_stream_server"
        model_provenance = load_json_object(model_root / "provenance.json")
        files = model_provenance["files"]
        vae = model_root / files["vae"]["path"]
        lm = model_root / files["lm"]["path"]
        command = [
            str(runtime),
            "--vae-model",
            str(vae),
            "--lm-model",
            str(lm),
            "-t",
            str(threads),
            "-c",
            "2048",
            "--greedy",
            "--max-tokens",
            "256",
            "--prompt-format",
            "text",
            "--no-token-stream",
        ]
        if context:
            command.extend(["--context", context])
        self.process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,
            bufsize=0,
        )
        self.stderr = BoundedStderr(self.process.stderr)
        self.stderr.start()
        ready = self._readline(timeout=20 * 60)
        if ready != b"---READY---\n":
            self.close()
            raise RuntimeError("VibeASR server did not emit its ready signal")

    def transcribe(self, path: Path) -> str:
        if self.process.stdin is None:
            raise RuntimeError("VibeASR server stdin is unavailable")
        self.process.stdin.write(f"{path}\n".encode())
        self.process.stdin.flush()
        pieces: list[bytes] = []
        total = 0
        while True:
            line = self._readline(timeout=30 * 60)
            if line.rstrip(b"\r\n") == b"---END---":
                break
            if line.startswith(b"[ERROR]"):
                raise RuntimeError(line.decode("utf-8", "replace").strip())
            total += len(line)
            if total > MAX_TRANSCRIPT_BYTES:
                raise RuntimeError("VibeASR output exceeded its bound")
            pieces.append(line)
        return clean_transcript(b"".join(pieces).decode("utf-8", "replace"))

    def close(self) -> bytes:
        if self.process.poll() is None and self.process.stdin is not None:
            try:
                self.process.stdin.write(b"EXIT\n")
                self.process.stdin.flush()
            except BrokenPipeError:
                pass
        try:
            self.process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=10)
        self.stderr.join()
        return bytes(self.stderr.buffer)

    def _readline(self, timeout: float) -> bytes:
        if self.process.stdout is None:
            raise RuntimeError("VibeASR server stdout is unavailable")
        ready, _, _ = select.select([self.process.stdout], [], [], timeout)
        if not ready:
            raise TimeoutError("VibeASR server output timed out")
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError(f"VibeASR server exited early with code {self.process.poll()}")
        return line


def append_bounded(destination: bytearray, source: bytes | bytearray) -> None:
    destination.extend(source[: max(0, MAX_STDERR_BYTES - len(destination))])


def transcribe_whisper(
    runtime_root: Path,
    model_root: Path,
    audio: Path,
    prefix: Path,
    threads: int,
    captured_stderr: bytearray,
) -> str:
    provenance = load_json_object(model_root / "provenance.json")
    model_path = model_root / provenance["files"]["model"]["path"]
    command = [
        str(runtime_root / "bin" / "whisper-cli"),
        "-m",
        str(model_path),
        "-f",
        str(audio),
        "-t",
        str(threads),
        "-nt",
        "-otxt",
        "-of",
        str(prefix),
    ]
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    stderr = BoundedStderr(process.stderr)
    stderr.start()
    try:
        exit_code = process.wait(timeout=30 * 60)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)
        raise TimeoutError("whisper.cpp segment timed out")
    finally:
        stderr.join()
        append_bounded(captured_stderr, stderr.buffer)
    if exit_code != 0:
        raise RuntimeError(f"whisper.cpp failed with exit code {exit_code}")
    text_path = prefix.with_suffix(".txt")
    text = text_path.read_bytes()
    if len(text) > MAX_TRANSCRIPT_BYTES:
        raise RuntimeError("whisper.cpp output exceeded its bound")
    return clean_transcript(text.decode("utf-8", "replace"))


def clean_transcript(value: str) -> str:
    return " ".join(value.replace("\x00", "").split()).strip()


def write_result(path: Path, value: dict) -> None:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
    temporary = path.with_suffix(".json.tmp")
    with temporary.open("xb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", choices=("vibeasr-bitnet", "whisper-small-en"), required=True)
    parser.add_argument("--engine", choices=("vibe", "whisper"), required=True)
    parser.add_argument("--threads", type=int, required=True)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--model-root", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not 1 <= args.threads <= 8:
        raise ValueError("threads must be from 1 through 8")
    expected_job_id = os.environ["PHANES_EXPECTED_JOB_ID"]
    expected_digest = os.environ["PHANES_EXPECTED_MANIFEST_SHA256"]
    manifest = load_manifest(args.manifest, expected_job_id, expected_digest)
    runtime_provenance = load_json_object(args.runtime_root / "provenance.json")
    model_provenance = load_json_object(args.model_root / "provenance.json")
    if model_provenance.get("name") != args.model:
        raise ValueError("model bundle name does not match the requested model")
    verify_bundle(args.runtime_root, runtime_provenance)
    verify_bundle(args.model_root, model_provenance)
    runtime_commit_field = "vibeasr_commit" if args.engine == "vibe" else "whisper_cpp_commit"
    runtime_commit = runtime_provenance.get(runtime_commit_field)
    model_revision = model_provenance.get("model_revision")
    if not isinstance(runtime_commit, str) or not isinstance(model_revision, str):
        raise TypeError("ASR provenance is incomplete")

    started = time.monotonic()
    audio_seconds = sum(float(segment["duration_ms"]) for segment in manifest["segments"]) / 1000
    results: list[dict] = []
    transcript_bytes = 0
    captured_stderr = bytearray()
    with tempfile.TemporaryDirectory(prefix="phanes-asr-") as temporary:
        scratch = Path(temporary)
        vibe: Optional[VibeEngine] = None
        try:
            if args.engine == "vibe" and manifest["segments"]:
                vibe = VibeEngine(
                    args.runtime_root,
                    args.model_root,
                    args.threads,
                    normalized_hotwords(manifest),
                )
            for index, segment in enumerate(manifest["segments"]):
                source = args.manifest.parent / segment["path"]
                verified_source = scratch / f"source-{segment['segment_id']}.wav"
                copy_verified_segment(source, verified_source, segment)
                normalized = scratch / f"{segment['segment_id']}.wav"
                normalize_audio(
                    args.runtime_root / "bin" / "ffmpeg",
                    verified_source,
                    normalized,
                    24_000 if args.engine == "vibe" else 16_000,
                )
                if vibe is not None:
                    text = vibe.transcribe(normalized)
                else:
                    text = transcribe_whisper(
                        args.runtime_root,
                        args.model_root,
                        normalized,
                        scratch / f"whisper-{index:06d}",
                        args.threads,
                        captured_stderr,
                    )
                segment_text_bytes = len(text.encode("utf-8"))
                segment_text_limit = (
                    TRANSCRIPT_SEGMENT_SLACK_BYTES
                    + int(float(segment["duration_ms"]) / 1000 * MAX_TRANSCRIPT_BYTES_PER_AUDIO_SECOND)
                )
                if segment_text_bytes > segment_text_limit:
                    raise RuntimeError(
                        f"segment {segment['segment_id']} transcript expanded beyond its audio-duration bound"
                    )
                transcript_bytes += segment_text_bytes
                if transcript_bytes > MAX_TRANSCRIPT_BYTES:
                    raise RuntimeError("combined transcript exceeded its bound")
                results.append(
                    {
                        "segment_id": segment["segment_id"],
                        "speaker_id": segment["speaker_id"],
                        "start_ms": segment["start_ms"],
                        "end_ms": segment["end_ms"],
                        "text": text,
                        "confidence": None,
                    }
                )
        finally:
            if vibe is not None:
                stderr = vibe.close()
                append_bounded(captured_stderr, stderr)
            if captured_stderr:
                stderr_path = args.output.parent / "model.stderr"
                with stderr_path.open("xb") as handle:
                    handle.write(captured_stderr)
                stderr_path.chmod(0o660)
    wall_seconds = time.monotonic() - started
    self_peak_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    child_peak_rss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    warnings = [
        str(warning)[:1000]
        for warning in manifest.get("capture_warnings", [])[:1000]
        if isinstance(warning, str)
    ]
    write_result(
        args.output,
        {
            "schema_version": 1,
            "job_id": expected_job_id,
            "manifest_sha256": expected_digest,
            "model": {
                "name": args.model,
                "runtime_commit": runtime_commit,
                "model_revision": model_revision,
                "threads": args.threads,
            },
            "segments": results,
            "warnings": warnings,
            "metrics": {
                "audio_seconds": audio_seconds,
                "wall_seconds": wall_seconds,
                "rtf": wall_seconds / audio_seconds if audio_seconds else 0,
                "peak_rss_bytes": max(self_peak_rss, child_peak_rss) * 1024,
            },
            "completed_at": datetime.now(timezone.utc).isoformat(),
        },
    )


if __name__ == "__main__":
    main()
