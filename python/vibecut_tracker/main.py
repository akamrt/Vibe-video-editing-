"""
VibeCut Tracker - Entry point for Python-enhanced video tracking.

Communication protocol:
  - Reads JSON request from stdin
  - Writes JSON response to stdout
  - Writes progress updates to stderr as JSON lines
"""
import sys
import json
import os

from vibecut_tracker.person_detect import detect_person_mediapipe, track_person_through_segment
from vibecut_tracker.optical_flow import track_optical_flow
from vibecut_tracker.template_match import track_template_opencv
from vibecut_tracker.utils import report_progress


def handle_track(request: dict) -> dict:
    """Route tracking request to the appropriate method."""
    mode = request.get('mode', 'person_center')
    video_path = request['videoPath']
    start_time = request.get('startTime', 0)
    end_time = request.get('endTime', None)
    sample_interval = request.get('sampleInterval', 0.1)
    options = request.get('options', {})

    if not os.path.exists(video_path):
        return {'success': False, 'error': f'Video file not found: {video_path}'}

    if mode == 'person_center':
        return track_person_through_segment(
            video_path, start_time, end_time,
            sample_interval=sample_interval,
            initial_x=options.get('initialPersonX'),
            initial_y=options.get('initialPersonY'),
        )
    elif mode == 'template':
        return track_template_opencv(
            video_path, start_time, end_time,
            template_x=options.get('templateX', 0),
            template_y=options.get('templateY', 0),
            patch_size=options.get('patchSize', 32),
            search_window=options.get('searchWindow', 60),
            sample_interval=sample_interval,
        )
    elif mode == 'optical_flow':
        initial_points = options.get('initialPoints', [])
        return track_optical_flow(
            video_path, start_time, end_time,
            initial_points=initial_points,
            sample_interval=sample_interval,
        )
    else:
        return {'success': False, 'error': f'Unknown tracking mode: {mode}'}


def handle_detect_person(request: dict) -> dict:
    """Detect person position in a single frame."""
    video_path = request['videoPath']
    time = request.get('time', 0)

    if not os.path.exists(video_path):
        return {'success': False, 'error': f'Video file not found: {video_path}'}

    return detect_person_mediapipe(video_path, time)


def handle_capabilities(_request: dict) -> dict:
    """Report available tracking capabilities."""
    caps = {
        'success': True,
        'modes': ['person_center', 'template', 'optical_flow'],
        'features': ['mediapipe_pose', 'opencv_optical_flow', 'opencv_template_match'],
    }

    try:
        import mediapipe  # noqa: F401
        caps['mediapipe'] = True
    except ImportError:
        caps['mediapipe'] = False

    try:
        import cv2  # noqa: F401
        caps['opencv'] = True
        caps['opencv_version'] = cv2.__version__
    except ImportError:
        caps['opencv'] = False

    return caps


def main():
    try:
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            print(json.dumps({'success': False, 'error': 'Empty input'}))
            return

        request = json.loads(raw_input)
    except json.JSONDecodeError as e:
        print(json.dumps({'success': False, 'error': f'Invalid JSON input: {str(e)}'}))
        return

    command = request.get('command', 'track')

    try:
        if command == 'track':
            result = handle_track(request)
        elif command == 'detect_person':
            result = handle_detect_person(request)
        elif command == 'capabilities':
            result = handle_capabilities(request)
        else:
            result = {'success': False, 'error': f'Unknown command: {command}'}
    except Exception as e:
        result = {'success': False, 'error': str(e)}

    print(json.dumps(result))


if __name__ == '__main__':
    main()
