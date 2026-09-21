"""Global Ctrl+Alt+U unlock hotkey (Windows).

The overlay's click-through mode (WS_EX_TRANSPARENT) makes the window ignore the
mouse, so the right-click menu that could switch it back off is unreachable.
This poller is the way back: GetAsyncKeyState is process-global, so it works
even when the overlay has no focus.

Polling an injected state reader (rather than RegisterHotKey plus a native event
filter) keeps this dependency-free and unit-testable.
"""
from __future__ import annotations

VK_CONTROL = 0x11
VK_MENU = 0x12      # Alt
VK_U = 0x55
COMBO = (VK_CONTROL, VK_MENU, VK_U)
DOWN = 0x8000


def system_reader():
    """Read real key states; a no-op reader on non-Windows."""
    import sys
    if sys.platform != "win32":
        return lambda vk: 0
    import ctypes
    return ctypes.windll.user32.GetAsyncKeyState


class ComboWatcher:
    """True exactly once per press of the key combo (rising edge only), so a held
    key cannot retrigger the action on every poll."""

    def __init__(self, keys=COMBO, reader=None):
        self.keys = tuple(keys)
        self._reader = reader or system_reader()
        self._was_down = False

    def down(self):
        try:
            return all(self._reader(vk) & DOWN for vk in self.keys)
        except Exception:  # a broken/absent user32 must never kill the timer
            return False

    def poll(self):
        down = self.down()
        fired = down and not self._was_down
        self._was_down = down
        return fired
