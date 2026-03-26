import os
import requests
import json
from typing import Dict, Any

def get_transcription(audio_path: str, api_key: str = None) -> Dict[str, Any]:
    """
    Get transcription from AssemblyAI.
    """
    # Key validation at the top
    api_key = os.environ.get('ASSEMBLYAI_API_KEY', '').strip()
    if not api_key:
        return {"error": "ASSEMBLYAI_API_KEY not set in .env.local — see .env.example"}

    # Validate key format (real keys are 32+ chars alphanumeric)
    if len(api_key) < 20:
        return {"error": f"ASSEMBLYAI_API_KEY looks too short — check .env.local. Key length: {len(api_key)}"}

    # Test the key before uploading audio
    test_resp = requests.get(
        "https://api.assemblyai.com/v2/transcript",
        headers={"authorization": api_key}
    )
    if test_resp.status_code == 401:
        return {"error": "Invalid AssemblyAI API key — check .env.local settings. Get a new key at assemblyai.com"}
    if test_resp.status_code == 429:
        return {"error": "AssemblyAI rate limit hit — try again in a few minutes"}

    # Upload audio file
    with open(audio_path, 'rb') as f:
        upload_resp = requests.post(
            "https://api.assemblyai.com/v2/upload",
            headers={"authorization": api_key},
            data=f
        )

    if upload_resp.status_code != 200:
        return {"error": f"Upload failed: {upload_resp.status_code} {upload_resp.text}"}

    audio_url = upload_resp.json()['upload_url']

    # Start transcription
    transcript_resp = requests.post(
        "https://api.assemblyai.com/v2/transcript",
        headers={"authorization": api_key, "content-type": "application/json"},
        json={"audio_url": audio_url}
    )

    if transcript_resp.status_code != 200:
        return {"error": f"Transcription request failed: {transcript_resp.status_code}"}

    transcript_id = transcript_resp.json()['id']

    # Poll for completion
    while True:
        status_resp = requests.get(
            f"https://api.assemblyai.com/v2/transcript/{transcript_id}",
            headers={"authorization": api_key}
        )
        status_data = status_resp.json()
        if status_data['status'] == 'completed':
            return {
                "text": status_data['text'],
                "words": status_data.get('words', [])
            }
        elif status_data['status'] == 'error':
            return {"error": f"Transcription error: {status_data.get('error', 'unknown')}"}
