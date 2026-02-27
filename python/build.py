"""Build vibecut-tracker as a standalone executable using PyInstaller."""
import PyInstaller.__main__
import platform
import os

script_dir = os.path.dirname(os.path.abspath(__file__))
entry_point = os.path.join(script_dir, 'vibecut_tracker', 'main.py')

# Output to the project's bin/ directory
output_dir = os.path.join(script_dir, '..', 'bin')
os.makedirs(output_dir, exist_ok=True)

# Find mediapipe's native C library (libmediapipe.dll / .so)
# PyInstaller doesn't auto-discover this since it's loaded dynamically
mediapipe_data_args = []
try:
    import mediapipe
    mp_dir = os.path.dirname(mediapipe.__file__)
    tasks_c_dir = os.path.join(mp_dir, 'tasks', 'c')
    if os.path.isdir(tasks_c_dir):
        # Bundle the entire mediapipe/tasks/c/ directory (contains libmediapipe.dll)
        mediapipe_data_args = [
            '--add-data', f'{tasks_c_dir}{os.pathsep}mediapipe/tasks/c',
        ]
        print(f'Found mediapipe native library at: {tasks_c_dir}')

    # Also bundle the metadata directory if it exists
    tasks_metadata_dir = os.path.join(mp_dir, 'tasks', 'metadata')
    if os.path.isdir(tasks_metadata_dir):
        mediapipe_data_args += [
            '--add-data', f'{tasks_metadata_dir}{os.pathsep}mediapipe/tasks/metadata',
        ]
except ImportError:
    print('WARNING: mediapipe not installed, building without it')

args = [
    entry_point,
    '--onefile',
    '--name', 'vibecut-tracker',
    '--distpath', output_dir,
    '--hidden-import', 'mediapipe',
    '--hidden-import', 'mediapipe.tasks',
    '--hidden-import', 'mediapipe.tasks.c',
    '--hidden-import', 'mediapipe.tasks.python',
    '--hidden-import', 'mediapipe.tasks.python.vision',
    '--hidden-import', 'mediapipe.tasks.python.core',
    '--hidden-import', 'mediapipe.tasks.python.core.mediapipe_c_bindings',
    '--hidden-import', 'cv2',
    '--hidden-import', 'numpy',
    '--hidden-import', 'vibecut_tracker',
    '--hidden-import', 'vibecut_tracker.person_detect',
    '--hidden-import', 'vibecut_tracker.optical_flow',
    '--hidden-import', 'vibecut_tracker.template_match',
    '--hidden-import', 'vibecut_tracker.utils',
    *mediapipe_data_args,
    '--clean',
    '--noconfirm',
]

print(f'Building vibecut-tracker for {platform.system()} ({platform.machine()})...')
PyInstaller.__main__.run(args)
print(f'Build complete! Output: {os.path.join(output_dir, "vibecut-tracker")}')
