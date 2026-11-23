"""Exercise the Linux desktop showcase through X11 input and its AT-SPI tree."""

import os
import subprocess
import sys
import time

import pyatspi
from gi.repository import GLib


def wait_for(condition, message, application):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if application.poll() is not None:
            raise AssertionError(f"Desktop process exited with status {application.returncode}")
        value = condition()
        if value is not None:
            return value
        time.sleep(0.1)
    raise AssertionError(message)


def accessible_nodes(root):
    pending = [root]
    count = 0
    while pending and count < 512:
        node = pending.pop()
        count += 1
        yield node
        try:
            pending.extend(child for child in node if child is not None)
        except (GLib.Error, RuntimeError, AttributeError):
            pass


def find(name, application, state=None):
    def matching_node():
        for node in accessible_nodes(pyatspi.Registry.getDesktop(0)):
            try:
                if node.name == name and (state is None or node.getState().contains(state)):
                    return node
            except (GLib.Error, RuntimeError, AttributeError):
                pass
        return None

    return wait_for(matching_node, f"No matching accessible node for {name}", application)


def x11(*args):
    return subprocess.run(["xdotool", *args], check=True, text=True, capture_output=True).stdout


def find_window():
    try:
        return x11("search", "--onlyvisible", "--name", "Showcase fixture").splitlines()[0]
    except (subprocess.CalledProcessError, IndexError):
        return None


def main():
    executable = sys.argv[1]
    assert os.path.isabs(executable)
    subprocess.run(
        [
            "gdbus", "call", "--session", "--dest", "org.a11y.Bus", "--object-path",
            "/org/a11y/bus", "--method", "org.freedesktop.DBus.Properties.Set",
            "org.a11y.Status", "IsEnabled", "<true>",
        ],
        check=True,
    )
    application = subprocess.Popen([executable, "--fixture", "showcase"])
    try:
        window = wait_for(find_window, "The GPUI fixture did not open an X11 window", application)
        x11("windowfocus", "--sync", window)
        find("Message", application, pyatspi.STATE_FOCUSED)

        x11("key", "ctrl+Return")
        find("Enter a message before submitting.", application)
        find("Message", application, pyatspi.STATE_FOCUSED)

        x11("type", "--clearmodifiers", "Replay: showcase")
        x11("key", "ctrl+Return")
        find("Recorded reply loaded.", application)
        reply = find("Recorded assistant reply", application)
        text = reply.queryText()
        assert "This turn is a replay." in text.getText(0, text.characterCount)
        assert not reply.getState().contains(pyatspi.STATE_EDITABLE)
        find("Message", application, pyatspi.STATE_FOCUSED)
        x11("windowclose", window)
        assert application.wait(timeout=10) == 0
        print("GPUI showcase passed X11 keyboard input and AT-SPI text and focus checks")
    finally:
        if application.poll() is None:
            application.terminate()
            try:
                application.wait(timeout=3)
            except subprocess.TimeoutExpired:
                application.kill()
                application.wait(timeout=3)


if __name__ == "__main__":
    main()
