"""Optical flow tracking using OpenCV Lucas-Kanade pyramidal method."""
import cv2
import numpy as np
from vibecut_tracker.utils import report_progress, read_frame_at_time, get_video_info, clamp


def track_optical_flow(
    video_path: str,
    start_time: float,
    end_time: float | None,
    initial_points: list[list[float]] | None = None,
    sample_interval: float = 0.1,
) -> dict:
    """Track multiple points using Lucas-Kanade optical flow.

    Args:
        video_path: Path to the video file.
        start_time: Start time in seconds.
        end_time: End time in seconds (None = end of video).
        initial_points: List of [x, y] pixel coordinates to track.
        sample_interval: Time between samples in seconds.

    Returns:
        Dict with success, positions array, and metadata.
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return {'success': False, 'error': 'Cannot open video'}

    info = get_video_info(cap)
    vw, vh = info['width'], info['height']

    if end_time is None:
        end_time = info['duration']

    if not initial_points or len(initial_points) == 0:
        cap.release()
        return {'success': False, 'error': 'No initial points provided for optical flow'}

    # Read first frame
    first_frame = read_frame_at_time(cap, start_time)
    if first_frame is None:
        cap.release()
        return {'success': False, 'error': 'Cannot read first frame'}

    prev_gray = cv2.cvtColor(first_frame, cv2.COLOR_BGR2GRAY)
    points = np.array(initial_points, dtype=np.float32).reshape(-1, 1, 2)

    lk_params = dict(
        winSize=(21, 21),
        maxLevel=3,
        criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01),
    )

    total_frames = int((end_time - start_time) / sample_interval)
    positions = [{
        'time': round(start_time, 3),
        'points': [[round(p[0], 1), round(p[1], 1)] for p in points.reshape(-1, 2).tolist()],
        'status': [1] * len(initial_points),
    }]

    frame_count = 0
    current_time = start_time + sample_interval

    while current_time <= end_time:
        frame = read_frame_at_time(cap, current_time)
        if frame is None:
            current_time += sample_interval
            frame_count += 1
            continue

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        new_points, status, _ = cv2.calcOpticalFlowPyrLK(
            prev_gray, gray, points, None, **lk_params
        )

        if new_points is None:
            current_time += sample_interval
            frame_count += 1
            continue

        # Clamp to valid range
        for i in range(len(new_points)):
            new_points[i][0][0] = clamp(new_points[i][0][0], 0, vw)
            new_points[i][0][1] = clamp(new_points[i][0][1], 0, vh)

        positions.append({
            'time': round(current_time, 3),
            'points': [[round(p[0], 1), round(p[1], 1)] for p in new_points.reshape(-1, 2).tolist()],
            'status': status.flatten().tolist(),
        })

        # Only keep good points for next iteration
        good_mask = status.flatten() == 1
        if np.any(good_mask):
            points = new_points[good_mask].reshape(-1, 1, 2)
        else:
            break  # All points lost

        prev_gray = gray
        frame_count += 1
        current_time += sample_interval

        if frame_count % 10 == 0:
            progress = frame_count / max(total_frames, 1)
            report_progress(progress, f'Optical flow frame {frame_count}/{total_frames}')

    cap.release()
    report_progress(1.0, 'Optical flow complete')

    return {
        'success': True,
        'positions': positions,
        'videoWidth': vw,
        'videoHeight': vh,
        'frameCount': frame_count,
        'method': 'optical_flow',
    }
