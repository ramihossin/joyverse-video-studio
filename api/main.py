import os
import shutil
import tempfile
import uuid
import subprocess
from pathlib import Path
from typing import List

import requests
import imageio_ffmpeg
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from gradio_client import Client

SPACE = os.getenv("HF_SPACE", "zerogpu-aoti/wan2-2-fp8da-aoti-faster")
MAX_IMAGE_BYTES = 12 * 1024 * 1024
ALLOWED_TYPES = {"image/png", "image/jpeg", "image/webp"}

app = FastAPI(title="JoyVerse Video Engine", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

@app.get("/health")
def health():
    return {"status": "ok", "engine": "wan2.2-image-to-video", "audio": False,
            "max_scenes": 4, "space": SPACE}

def extract_file(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("path", "video", "url"):
            if key in value:
                found = extract_file(value[key])
                if found:
                    return found
    if isinstance(value, (list, tuple)):
        for item in value:
            found = extract_file(item)
            if found:
                return found
    return None

def materialize_video(value, target: Path):
    candidate = extract_file(value)
    if not candidate:
        raise RuntimeError("Hugging Face returned no recognizable video file")
    if candidate.startswith(("http://", "https://")):
        response = requests.get(candidate, timeout=180)
        response.raise_for_status()
        target.write_bytes(response.content)
    else:
        source = Path(candidate)
        if not source.exists():
            raise RuntimeError("Generated video file was not found in the Gradio cache")
        shutil.copyfile(source, target)
    if target.stat().st_size < 1024:
        raise RuntimeError("Generated video file is unexpectedly small")

@app.post("/generate")
async def generate(
    image: UploadFile = File(...),
    prompts: List[str] = Form(...),
    duration: float = Form(2.0),
    steps: int = Form(6),
):
    if image.content_type not in ALLOWED_TYPES:
        raise HTTPException(400, "Use PNG, JPG or WEBP.")
    if not 1 <= len(prompts) <= 4 or any(not p.strip() for p in prompts):
        raise HTTPException(400, "Provide between one and four non-empty scene prompts.")
    if not 0.5 <= duration <= 5:
        raise HTTPException(400, "Scene duration must be between 0.5 and 5 seconds.")
    if steps not in (4, 6, 8, 10):
        raise HTTPException(400, "Unsupported inference steps.")

    work = Path(tempfile.mkdtemp(prefix="joyverse-"))
    try:
        image_bytes = await image.read()
        if len(image_bytes) > MAX_IMAGE_BYTES:
            raise HTTPException(413, "Image exceeds the 12 MB limit.")
        suffix = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[image.content_type]
        image_path = work / ("reference" + suffix)
        image_path.write_bytes(image_bytes)

        client = Client(SPACE)
        clips = []
        for index, prompt in enumerate(prompts, start=1):
            result = client.predict(
                str(image_path), prompt.strip(), "", float(duration),
                1, 3, int(steps), 42 + index, True,
                api_name="/generate_video"
            )
            raw_video = result[0] if isinstance(result, (list, tuple)) else result
            clip_path = work / f"scene-{index:02d}.mp4"
            materialize_video(raw_video, clip_path)
            clips.append(clip_path)

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        concat_file = work / "concat.txt"
        concat_file.write_text(
            "".join("file '" + str(p).replace("'", "'\\''") + "'\n" for p in clips),
            encoding="utf-8"
        )
        output_path = work / "joyverse-final.mp4"
        command = [
            ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output_path)
        ]
        proc = subprocess.run(command, capture_output=True, text=True, timeout=300)
        if proc.returncode != 0 or not output_path.exists():
            raise RuntimeError("Video assembly failed: " + proc.stderr[-1200:])
        return FileResponse(
            output_path, media_type="video/mp4",
            filename="joyverse-video.mp4",
            background=None
        )
    except HTTPException:
        shutil.rmtree(work, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(work, ignore_errors=True)
        raise HTTPException(502, f"Generation failed: {str(exc)[:700]}")
