"""Person detection and tracking using MediaPipe Pose (Tasks API)."""
import os
import sys
import traceback
import urllib.request
import cv2
import numpy as np
from vibecut_tracker.utils import report_progress, read_frame_at_time, get_video_info, clamp

HAS_MEDIAPIPE = False
PoseLandmarker = None
mp_image_mod = None
BaseOptions = None
VisionRunningMode = None
PoseLandmarkerOptions = None

try:
    import mediapipe as mp
    from mediapipe.tasks.python import vision
    from mediapipe.tasks.python import BaseOptions as _BaseOptions

    PoseLandmarker = vision.PoseLandmarker
    PoseLandmarkerOptions = vision.PoseLandmarkerOptions
    VisionRunningMode = vision.RunningMode
    BaseOptions = _BaseOptions
    mp_image_mod = mp
    HAS_MEDIAPIPE = True
    sys.stderr.write(f'[vibecut-tracker] MediaPipe loaded OK (version: {mp.__version__})\n')
    sys.stderr.flush()
except (ImportError, AttributeError) as e:
    sys.stderr.write(f'[vibecut-tracker] MediaPipe import failed: {e}\n')
    sys.stderr.flush()

# Model file URL and local cache path
MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"
MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'models')
MODEL_PATH = os.path.join(MODEL_DIR, 'pose_landmarker_lite.task')


def _ensure_model() -> str | None:
    """Download the pose landmarker model if not cached. Returns path or None."""
    if os.path.exists(MODEL_PATH):
        return MODEL_PATH

    os.makedirs(MODEL_DIR, exist_ok=True)
    try:
        report_progress(0.0, 'Downloading pose model (first run only)...')
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
        report_progress(0.05, 'Pose model downloaded')
        return MODEL_PATH
    except Exception as e:
        sys.stderr.write(f'[vibecut-tracker] Failed to download pose model: {e}\n')
        sys.stderr.flush()
        return None


def _create_landmarker(mode: str = 'IMAGE'):
    """Create a PoseLandmarker instance."""
    model_path = _ensure_model()
    if model_path is None:
        sys.stderr.write('[vibecut-tracker] No model path available\n')
        sys.stderr.flush()
        return None

    if not HAS_MEDIAPIPE:
        sys.stderr.write('[vibecut-tracker] MediaPipe not available\n')
        sys.stderr.flush()
        return None

    try:
        running_mode = VisionRunningMode.IMAGE if mode == 'IMAGE' else VisionRunningMode.VIDEO
        landmarker = PoseLandmarker.create_from_options(
            PoseLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=model_path),
                running_mode=running_mode,
                min_pose_detection_confidence=0.5,
                min_tracking_confidence=0.5,
            )
        )
        sys.stderr.write(f'[vibecut-tracker] Landmarker created OK (mode={mode})\n')
        sys.stderr.flush()
        return landmarker
    except Exception as e:
        sys.stderr.write(f'[vibecut-tracker] Failed to create landmarker: {e}\n')
        sys.stderr.write(traceback.format_exc())
        sys.stderr.flush()
        return None


def _extract_torso_center(result) -> tuple[float, float, float] | None:
    """Extract torso center from PoseLandmarker result.

    Returns (centerX_normalized, centerY_normalized, avg_visibility) or None.
    Torso landmarks: 11=left shoulder, 12=right shoulder, 23=left hip, 24=right hip
    """
    if not result.pose_landmarks or len(result.pose_landmarks) == 0:
        return None

    landmarks = result.pose_landmarks[0]  # First detected person
    torso_indices = [11, 12, 23, 24]

    visible = []
    for i in torso_indices:
        if i < len(landmarks):
            lm = landmarks[i]
            vis = lm.visibility if hasattr(lm, 'visibility') and lm.visibility is not None else 0.5
            if vis > 0.3:
                visible.append((lm.x, lm.y, vis))

    if not visible:
        return None

    cx = sum(v[0] for v in visible) / len(visible)
    cy = sum(v[1] for v in visible) / len(visible)
    avg_vis = sum(v[2] for v in visible) / len(visible)

    return (cx, cy, avg_vis)


def _detect_person_opencv(frame: np.ndarray, vw: int, vh: int) -> tuple[float, float] | None:
    """Detect person region using OpenCV-only methods (no MediaPipe needed).

    Uses skin-tone detection in YCrCb color space + contour analysis to find
    the most likely person region. Returns (x, y) pixel coords or None.
    """
    try:
        # Convert to YCrCb for skin-tone detection
        ycrcb = cv2.cvtColor(frame, cv2.COLOR_BGR2YCrCb)

        # Skin-tone range in YCrCb (works for diverse skin tones)
        lower_skin = np.array([40, 133, 77], dtype=np.uint8)
        upper_skin = np.array([240, 173, 127], dtype=np.uint8)
        skin_mask = cv2.inRange(ycrcb, lower_skin, upper_skin)

        # Morphological cleanup
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))
        skin_mask = cv2.morphologyEx(skin_mask, cv2.MORPH_CLOSE, kernel)
        skin_mask = cv2.morphologyEx(skin_mask, cv2.MORPH_OPEN, kernel)

        # Find contours of skin regions
        contours, _ = cv2.findContours(skin_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        if not contours:
            return None

        # Find the largest skin blob (likely the person)
        # Weight by size and vertical position (people are usually in upper-center)
        best_score = 0
        best_center = None

        for contour in contours:
            area = cv2.contourArea(contour)
            if area < (vw * vh * 0.005):  # Ignore tiny blobs (< 0.5% of frame)
                continue

            M = cv2.moments(contour)
            if M['m00'] == 0:
                continue

            cx = M['m10'] / M['m00']
            cy = M['m01'] / M['m00']

            # Score: larger area + center-horizontal bias + upper-vertical bias
            area_score = min(area / (vw * vh), 0.3)  # Cap at 30% of frame
            h_center_bias = 1.0 - 0.5 * abs(cx / vw - 0.5) * 2
            v_upper_bias = 1.0 - 0.3 * max(0, cy / vh - 0.5) * 2

            score = area_score * h_center_bias * v_upper_bias
            if score > best_score:
                best_score = score
                best_center = (cx, cy)

        return best_center

    except Exception as e:
        sys.stderr.write(f'[vibecut-tracker] OpenCV person detection error: {e}\n')
        sys.stderr.flush()
        return None


def detect_person_mediapipe(video_path: str, time_sec: float = 0) -> dict:
    """Detect person position in a single frame using MediaPipe PoseLandmarker."""
    if not HAS_MEDIAPIPE:
        return {
            'success': False, 'error': 'MediaPipe not installed',
            'personVisible': False, 'centerX': 50, 'centerY': 50, 'confidence': 0,
        }

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return {'success': False, 'error': 'Cannot open video', 'personVisible': False,
                'centerX': 50, 'centerY': 50, 'confidence': 0}

    frame = read_frame_at_time(cap, time_sec)
    cap.release()

    if frame is None:
        return {'success': False, 'error': 'Cannot read frame',
                'personVisible': False, 'centerX': 50, 'centerY': 50, 'confidence': 0}

    landmarker = _create_landmarker('IMAGE')
    if landmarker is None:
        return {'success': False, 'error': 'Cannot create pose landmarker',
                'personVisible': False, 'centerX': 50, 'centerY': 50, 'confidence': 0}

    try:
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp_image_mod.Image(image_format=mp_image_mod.ImageFormat.SRGB, data=rgb)
        result = landmarker.detect(mp_image)

        center = _extract_torso_center(result)
        if center is None:
            return {
                'success': True, 'personVisible': False,
                'centerX': 50, 'centerY': 50, 'confidence': 0,
            }

        cx, cy, avg_vis = center
        return {
            'success': True, 'personVisible': True,
            'centerX': clamp(cx * 100, 0, 100),
            'centerY': clamp(cy * 100, 0, 100),
            'confidence': clamp(avg_vis * 100, 0, 100),
        }
    finally:
        landmarker.close()


def _smooth_positions(positions: list[dict], window: int = 7) -> list[dict]:
    """Apply temporal smoothing to tracked positions using median + EMA filter.

    Steps:
      1. Median filter to reject outlier spikes (e.g., one bad frame)
      2. EMA (exponential moving average) for smooth continuous output
    """
    if len(positions) <= 2:
        return positions

    xs = [p['x'] for p in positions]
    ys = [p['y'] for p in positions]

    # Step 1: Median filter — kills outlier spikes
    half = window // 2
    med_xs = []
    med_ys = []
    for i in range(len(xs)):
        lo = max(0, i - half)
        hi = min(len(xs), i + half + 1)
        med_xs.append(float(np.median(xs[lo:hi])))
        med_ys.append(float(np.median(ys[lo:hi])))

    # Step 2: EMA — smooth continuous movement
    alpha = 0.25  # Low alpha = heavy smoothing (less reactive to noise)
    ema_xs = [med_xs[0]]
    ema_ys = [med_ys[0]]
    for i in range(1, len(med_xs)):
        ema_xs.append(alpha * med_xs[i] + (1 - alpha) * ema_xs[-1])
        ema_ys.append(alpha * med_ys[i] + (1 - alpha) * ema_ys[-1])

    smoothed = []
    for i, p in enumerate(positions):
        smoothed.append({
            **p,
            'x': round(ema_xs[i], 1),
            'y': round(ema_ys[i], 1),
        })

    return smoothed


def _get_torso_landmarks(result, vw: int, vh: int) -> list[tuple[float, float]] | None:
    """Extract multiple torso landmark positions from PoseLandmarker result.

    Returns list of (x_px, y_px) for visible torso landmarks, or None.
    Landmarks: 11=left shoulder, 12=right shoulder, 23=left hip, 24=right hip,
               0=nose (for head tracking stability)
    """
    if not result.pose_landmarks or len(result.pose_landmarks) == 0:
        return None

    landmarks = result.pose_landmarks[0]
    # Torso + nose for stability
    indices = [0, 11, 12, 23, 24]

    points = []
    for i in indices:
        if i < len(landmarks):
            lm = landmarks[i]
            vis = lm.visibility if hasattr(lm, 'visibility') and lm.visibility is not None else 0.5
            if vis > 0.3:
                points.append((lm.x * vw, lm.y * vh))

    return points if len(points) >= 2 else None


def _find_feature_points(gray: np.ndarray, center_x: float, center_y: float,
                         vw: int, vh: int, max_points: int = 10) -> np.ndarray | None:
    """Find good feature points to track near a position.

    Uses cv2.goodFeaturesToTrack in a region around (center_x, center_y).
    This replenishes optical flow when tracked points are lost.
    """
    # Define search region: ~20% of frame around the person
    margin_x = int(vw * 0.15)
    margin_y = int(vh * 0.20)
    x1 = max(0, int(center_x) - margin_x)
    y1 = max(0, int(center_y) - margin_y)
    x2 = min(vw, int(center_x) + margin_x)
    y2 = min(vh, int(center_y) + margin_y)

    if x2 - x1 < 20 or y2 - y1 < 20:
        return None

    roi = gray[y1:y2, x1:x2]
    corners = cv2.goodFeaturesToTrack(roi, maxCorners=max_points, qualityLevel=0.05,
                                      minDistance=15, blockSize=7)

    if corners is None or len(corners) == 0:
        return None

    # Offset corners back to full-frame coordinates
    corners[:, 0, 0] += x1
    corners[:, 0, 1] += y1

    return corners.astype(np.float32)


def track_person_through_segment(
    video_path: str,
    start_time: float,
    end_time: float | None,
    sample_interval: float = 0.1,
    initial_x: float | None = None,
    initial_y: float | None = None,
) -> dict:
    """Track a person through a video segment using MediaPipe every frame.

    Strategy:
    1. Run MediaPipe every frame for authoritative person position
    2. Use MediaPipe position DIRECTLY (no blending with running average)
    3. Optical flow ONLY as fallback when MediaPipe fails a frame
    4. Coast on last known position when both fail
    5. Post-processing: median filter + EMA for final smooth output
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return {'success': False, 'error': f'Cannot open video: {video_path}'}

    info = get_video_info(cap)
    vw, vh = info['width'], info['height']
    sys.stderr.write(f'[vibecut-tracker] Video info: {vw}x{vh}, {info["fps"]}fps, {info["totalFrames"]} frames, duration={info["duration"]:.1f}s\n')
    sys.stderr.flush()

    if end_time is None:
        end_time = info['duration']

    sys.stderr.write(f'[vibecut-tracker] Tracking from {start_time:.1f}s to {end_time:.1f}s (sample_interval={sample_interval})\n')
    sys.stderr.flush()

    # --- Configuration ---
    COAST_MAX_FRAMES = 10       # Hold last position for up to 10 frames when lost

    positions = []
    frame_count = 0

    total_frames = int((end_time - start_time) / sample_interval)
    if total_frames <= 0:
        cap.release()
        return {'success': False, 'error': f'Invalid time range: {start_time}-{end_time}'}

    # --- SEQUENTIAL FRAME READING ---
    # Instead of seeking to each time (unreliable in long videos),
    # we seek ONCE to start_time, then read frames sequentially.
    # This avoids OpenCV's inaccurate seeking which can return wrong frames.
    fps = info['fps']
    frames_per_sample = max(1, round(sample_interval * fps))

    # Seek once to start time
    cap.set(cv2.CAP_PROP_POS_MSEC, start_time * 1000)

    # Verify the seek landed reasonably close
    actual_pos_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
    sys.stderr.write(f'[vibecut-tracker] Seeked to {start_time:.1f}s, landed at {actual_pos_ms/1000:.2f}s '
                     f'(reading every {frames_per_sample} frames for {sample_interval}s intervals)\n')
    sys.stderr.flush()

    # Read and verify first frame
    ret, test_frame = cap.read()
    if not ret or test_frame is None:
        # Try seeking to beginning as fallback
        sys.stderr.write(f'[vibecut-tracker] WARNING: Cannot read frame after seek to {start_time}s. Trying from 0...\n')
        sys.stderr.flush()
        cap.set(cv2.CAP_PROP_POS_MSEC, 0)
        ret, test_frame = cap.read()
        if not ret or test_frame is None:
            cap.release()
            return {'success': False, 'error': 'Cannot read any frames from video'}
        # Read forward to approximate start_time
        skip_frames = int(start_time * fps)
        for _ in range(skip_frames):
            cap.read()

    sys.stderr.write(f'[vibecut-tracker] First frame OK: {test_frame.shape}, dtype={test_frame.dtype}\n')
    sys.stderr.flush()

    # Initialize MediaPipe landmarker
    landmarker = None
    if HAS_MEDIAPIPE:
        landmarker = _create_landmarker('VIDEO')
        if landmarker is None:
            sys.stderr.write('[vibecut-tracker] WARNING: MediaPipe landmarker creation failed\n')
            sys.stderr.flush()

    # If no MediaPipe, detect person on first frame using OpenCV skin-tone
    if landmarker is None and initial_x is None:
        sys.stderr.write('[vibecut-tracker] Using OpenCV fallback for initial person detection\n')
        sys.stderr.flush()
        detection = _detect_person_opencv(test_frame, vw, vh)
        if detection is not None:
            initial_x, initial_y = detection
            sys.stderr.write(f'[vibecut-tracker] OpenCV detected person at ({initial_x:.0f}, {initial_y:.0f})\n')
            sys.stderr.flush()
        else:
            initial_x = vw / 2
            initial_y = vh * 0.4
            sys.stderr.write(f'[vibecut-tracker] No detection, using center of frame ({initial_x:.0f}, {initial_y:.0f})\n')
            sys.stderr.flush()

    # Optical flow setup — only used as fallback when MediaPipe fails
    prev_gray = None
    prev_points = None  # shape: (N, 1, 2)
    lk_params = dict(
        winSize=(31, 31),
        maxLevel=4,
        criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01)
    )

    mediapipe_detections = 0
    optical_flow_detections = 0
    coast_count = 0
    failed_frames = 0

    # Last known good position (for coasting)
    last_x = initial_x
    last_y = initial_y
    lost_streak = 0

    # Process the first frame we already read
    current_time = start_time
    sequential_frame_idx = 0  # Counts every frame read from cap
    frame = test_frame

    while current_time <= end_time:
        if frame is None:
            failed_frames += 1
            # Coast: emit last known position even on failed frames
            if last_x is not None and lost_streak < COAST_MAX_FRAMES:
                lost_streak += 1
                positions.append({
                    'time': round(current_time, 3),
                    'x': round(clamp(last_x, 0, vw), 1),
                    'y': round(clamp(last_y, 0, vh), 1),
                    'confidence': round(max(0, 40 - lost_streak * 5), 1),
                })
            if failed_frames <= 3:
                sys.stderr.write(f'[vibecut-tracker] Cannot read frame at t={current_time:.2f}s\n')
                sys.stderr.flush()
        else:
            # --- Process this frame ---
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            detected_x, detected_y, confidence = None, None, 0.0

            # --- Step 1: Try MediaPipe (primary detection — runs every frame) ---
            if landmarker is not None:
                try:
                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    mp_image = mp_image_mod.Image(image_format=mp_image_mod.ImageFormat.SRGB, data=rgb)
                    timestamp_ms = int(current_time * 1000)
                    result = landmarker.detect_for_video(mp_image, timestamp_ms)

                    center = _extract_torso_center(result)
                    if center is not None:
                        cx_norm, cy_norm, avg_vis = center
                        # USE MEDIAPIPE POSITION DIRECTLY — no blending
                        detected_x = cx_norm * vw
                        detected_y = cy_norm * vh
                        confidence = avg_vis
                        mediapipe_detections += 1
                        lost_streak = 0

                        # Set up optical flow anchors from torso landmarks
                        # (used as fallback if MediaPipe fails next frame)
                        torso_pts = _get_torso_landmarks(result, vw, vh)
                        if torso_pts and len(torso_pts) >= 2:
                            prev_points = np.array(torso_pts, dtype=np.float32).reshape(-1, 1, 2)
                        else:
                            prev_points = np.array([[detected_x, detected_y]], dtype=np.float32).reshape(-1, 1, 2)
                except Exception as e:
                    if frame_count < 3:
                        sys.stderr.write(f'[vibecut-tracker] MediaPipe detect_for_video failed: {e}\n')
                        sys.stderr.write(traceback.format_exc())
                        sys.stderr.flush()

            # --- Step 2: Optical flow fallback (only when MediaPipe failed) ---
            if detected_x is None and prev_gray is not None and prev_points is not None and prev_points.shape[0] > 0:
                try:
                    new_points, status, _ = cv2.calcOpticalFlowPyrLK(
                        prev_gray, gray, prev_points, None, **lk_params
                    )
                    if status is not None:
                        good_mask = status.flatten() == 1
                        if np.any(good_mask):
                            good_pts = new_points[good_mask].reshape(-1, 2)

                            # Forward-backward validation
                            back_points, back_status, _ = cv2.calcOpticalFlowPyrLK(
                                gray, prev_gray, new_points[good_mask].reshape(-1, 1, 2),
                                None, **lk_params
                            )
                            if back_status is not None:
                                orig_pts = prev_points[good_mask].reshape(-1, 2)
                                back_pts = back_points.reshape(-1, 2)
                                fb_error = np.sqrt(np.sum((orig_pts - back_pts) ** 2, axis=1))
                                fb_good = fb_error < 5.0
                                combined_mask = back_status.flatten() == 1
                                combined_mask = combined_mask & fb_good

                                if np.any(combined_mask):
                                    validated_pts = good_pts[combined_mask]
                                    detected_x = float(np.mean(validated_pts[:, 0]))
                                    detected_y = float(np.mean(validated_pts[:, 1]))
                                    confidence = 0.6
                                    prev_points = new_points[good_mask][combined_mask].reshape(-1, 1, 2)
                                    optical_flow_detections += 1
                                    lost_streak = 0
                            if detected_x is None:
                                # Validation failed but we have forward points
                                detected_x = float(np.mean(good_pts[:, 0]))
                                detected_y = float(np.mean(good_pts[:, 1]))
                                confidence = 0.3
                                prev_points = new_points[good_mask].reshape(-1, 1, 2)
                                optical_flow_detections += 1
                except Exception as e:
                    if frame_count < 5:
                        sys.stderr.write(f'[vibecut-tracker] Optical flow failed at frame {frame_count}: {e}\n')
                        sys.stderr.flush()

            # --- Step 3: Initial position fallback (first frame only) ---
            if detected_x is None and frame_count == 0:
                if initial_x is not None and initial_y is not None:
                    detected_x = initial_x
                    detected_y = initial_y
                    confidence = 0.5
                    prev_points = np.array([[detected_x, detected_y]], dtype=np.float32).reshape(-1, 1, 2)

            # --- Step 4: Coast on last known position ---
            if detected_x is None and last_x is not None:
                lost_streak += 1
                if lost_streak <= COAST_MAX_FRAMES:
                    detected_x = last_x
                    detected_y = last_y
                    confidence = max(0.1, 0.5 - lost_streak * 0.05)
                    coast_count += 1

            if detected_x is not None:
                last_x = detected_x
                last_y = detected_y

                positions.append({
                    'time': round(current_time, 3),
                    'x': round(clamp(detected_x, 0, vw), 1),
                    'y': round(clamp(detected_y, 0, vh), 1),
                    'confidence': round(clamp(confidence, 0, 1) * 100, 1),
                })

            prev_gray = gray

        frame_count += 1
        current_time += sample_interval

        if frame_count % 10 == 0:
            progress = frame_count / total_frames
            report_progress(min(0.95, 0.1 + progress * 0.85), f'Tracking frame {frame_count}/{total_frames}')

        # Read forward to the next sample: skip (frames_per_sample - 1) frames,
        # then read the frame we actually want to process
        frame = None
        for skip_i in range(frames_per_sample):
            ret, f = cap.read()
            if not ret:
                frame = None
                break
            if skip_i == frames_per_sample - 1:
                frame = f

    if landmarker is not None:
        landmarker.close()
    cap.release()

    # Apply temporal smoothing to remove MediaPipe frame-to-frame noise
    positions = _smooth_positions(positions, window=7)

    report_progress(1.0, 'Tracking complete')

    method = 'mediapipe' if mediapipe_detections > 0 else 'optical_flow'
    sys.stderr.write(
        f'[vibecut-tracker] Done: {len(positions)} positions, '
        f'{mediapipe_detections} mediapipe, {optical_flow_detections} optical_flow, '
        f'{coast_count} coasted, {failed_frames} failed frames\n'
    )
    sys.stderr.flush()

    return {
        'success': True,
        'positions': positions,
        'videoWidth': vw,
        'videoHeight': vh,
        'frameCount': frame_count,
        'method': method,
    }
