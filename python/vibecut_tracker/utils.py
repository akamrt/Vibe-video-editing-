"""Shared utilities for VibeCut tracker."""
import sys
import json
import cv2
import numpy as np


def report_progress(progress: float, label: str = ''):
    """Write a progress update to stderr (read by Express server)."""
    msg = json.dumps({'progress': progress, 'label': label})
    sys.stderr.write(msg + '\n')
    sys.stderr.flush()


def read_frame_at_time(cap: cv2.VideoCapture, time_sec: float) -> np.ndarray | None:
    """Seek to a specific time and read a frame.

    NOTE: This uses random seeking which is unreliable in long videos.
    OpenCV seeks to the nearest keyframe, which can be seconds away.
    For sequential tracking, use sequential cap.read() instead.
    """
    cap.set(cv2.CAP_PROP_POS_MSEC, time_sec * 1000)
    ret, frame = cap.read()
    return frame if ret else None


def get_video_info(cap: cv2.VideoCapture) -> dict:
    """Get basic video metadata."""
    return {
        'width': int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
        'height': int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
        'fps': cap.get(cv2.CAP_PROP_FPS),
        'totalFrames': int(cap.get(cv2.CAP_PROP_FRAME_COUNT)),
        'duration': cap.get(cv2.CAP_PROP_FRAME_COUNT) / max(cap.get(cv2.CAP_PROP_FPS), 1),
    }


def clamp(value: float, min_val: float, max_val: float) -> float:
    return max(min_val, min(max_val, value))
