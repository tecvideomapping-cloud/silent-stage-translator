"""Local capability discovery and process telemetry; never reads credentials."""
import os
import sys
import time
import sysconfig
from pathlib import Path

_dll_handles = []


def configure_cuda_libraries():
    if sys.platform != 'win32':
        return
    root = Path(sysconfig.get_paths()['purelib']) / 'nvidia'
    folders = [root / component / folder for component in ['cublas', 'cudnn', 'cuda_runtime', 'cuda_nvrtc'] for folder in ['bin', 'lib']]
    found = [str(folder) for folder in folders if folder.is_dir()]
    for folder in found:
        _dll_handles.append(os.add_dll_directory(folder))
    os.environ['PATH'] = os.pathsep.join(found + [os.environ.get('PATH', '')])


def capabilities():
    configure_cuda_libraries()
    import ctranslate2
    devices = []
    for index in range(ctranslate2.get_cuda_device_count()):
        try:
            types = sorted(ctranslate2.get_supported_compute_types('cuda', index))
            devices.append({'index': index, 'computeTypes': types})
        except Exception:
            pass
    torch_cuda = []
    try:
        import torch
        if torch.cuda.is_available():
            torch_cuda = [{'index': index, 'name': torch.cuda.get_device_name(index)}
                          for index in range(torch.cuda.device_count())]
    except ImportError:
        pass
    return {'engine': 'Faster-Whisper', 'version': ctranslate2.__version__,
            'cpuTypes': sorted(ctranslate2.get_supported_compute_types('cpu')),
            'cuda': devices, 'diarizationCuda': torch_cuda,
            'logicalCores': os.cpu_count() or 1,
            'note': 'A detecção não substitui o carregamento e aquecimento do modelo.'}


def memory_usage():
    if sys.platform == 'win32':
        import ctypes
        from ctypes import wintypes
        class Counters(ctypes.Structure):
            _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [
                (field, ctypes.c_size_t) for field in ['PeakWorkingSetSize', 'WorkingSetSize',
                'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage',
                'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage']]
        data = Counters()
        data.cb = ctypes.sizeof(data)
        ctypes.windll.kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        handle = ctypes.windll.kernel32.GetCurrentProcess()
        ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        ctypes.windll.psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
        if ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(data), data.cb):
            return {'memoryMb': round(data.WorkingSetSize / 1048576, 1), 'memoryKind': 'resident'}
    elif sys.platform.startswith('linux'):
        try:
            with open('/proc/self/statm', encoding='ascii') as source:
                resident = int(source.read().split()[1]) * os.sysconf('SC_PAGE_SIZE')
            return {'memoryMb': round(resident / 1048576, 1), 'memoryKind': 'resident'}
        except OSError:
            pass
    else:
        import resource
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return {'memoryMb': round(peak / (1048576 if sys.platform == 'darwin' else 1024), 1), 'memoryKind': 'peak'}
    return {'memoryMb': None, 'memoryKind': 'unavailable'}


class Sampler:
    def __init__(self):
        self.wall = time.monotonic()
        self.cpu = time.process_time()

    def sample(self):
        wall, cpu = time.monotonic(), time.process_time()
        elapsed = wall - self.wall
        percent = (cpu - self.cpu) / elapsed * 100 if elapsed > 0 else 0
        self.wall, self.cpu = wall, cpu
        return {'cpuPercent': round(min(100, percent / (os.cpu_count() or 1)), 1),
                'cpuCorePercent': round(max(0, percent), 1), 'pid': os.getpid(), **memory_usage()}
