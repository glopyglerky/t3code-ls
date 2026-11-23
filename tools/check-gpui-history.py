"""Real X11 control and AT-SPI text check; server lifecycle stays with its parent."""
import json
import os
from pathlib import Path
import runpy
import signal
import subprocess
import sys

import pyatspi

# Reuse the existing X11/AT-SPI adapter without changing its fixture entry.
helpers = runpy.run_path(str(Path(__file__).with_name("check-gpui-showcase.py")))
find = helpers["find"]
find_window = helpers["find_window"]
request_window_close = helpers["request_window_close"]
wait_for = helpers["wait_for"]
x11 = helpers["x11"]


def body(application):
    document = find("Saved thread history", application)
    assert not document.getState().contains(pyatspi.STATE_EDITABLE)
    text = document.queryText()
    return text.getText(0, text.characterCount)


def activate_older(application):
    button = find("Load older", application, pyatspi.STATE_ENABLED)
    assert button.getRole() == pyatspi.ROLE_PUSH_BUTTON
    for _ in range(6):
        if button.getState().contains(pyatspi.STATE_FOCUSED):
            break
        x11("key", "Tab")
        try:
            button = find("Load older", application, pyatspi.STATE_FOCUSED, timeout=1)
        except AssertionError:
            continue
    assert button.getState().contains(pyatspi.STATE_FOCUSED)
    x11("key", "space")


def main():
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
    executable = sys.argv[1]
    assert os.path.isabs(executable) and len(sys.argv) == 2
    # A line protocol lets the parent stop only its owned packaged server and ACK.
    fixture = json.loads(sys.stdin.readline())
    connection = fixture["connection"]
    expected = fixture["expected"]
    newest = fixture["newest"]
    assert len(expected) == 80 and 0 < len(newest) < 80
    assert newest == expected[-len(newest):]
    subprocess.run([
        "gdbus", "call", "--session", "--dest", "org.a11y.Bus", "--object-path",
        "/org/a11y/bus", "--method", "org.freedesktop.DBus.Properties.Set",
        "org.a11y.Status", "IsEnabled", "<true>",
    ], check=True, stdout=subprocess.DEVNULL)
    cases = [
        ({**connection, "environmentId": "wrong-environment"}, "initial-refusal"),
        ({**connection, "token": "invalid.fixture.token"}, "initial-refusal"),
        ({**connection, "threadId": "missing-fixture-thread"}, "initial-refusal"),
        (connection, "complete"),
        (connection, "page-refusal"),
    ]
    for request, scenario in cases:
        application = subprocess.Popen([executable, "--thread-history"],
                                       stdin=subprocess.PIPE, text=True)
        try:
            application.stdin.write(json.dumps(request))
            application.stdin.close()
            window = wait_for(find_window, "GPUI history window did not open", application)
            x11("windowfocus", "--sync", window)
            if scenario == "initial-refusal":
                find("Could not read the selected server thread. Reopen to refresh.", application)
                assert body(application) == ""
                assert not find("Load older", application).getState().contains(pyatspi.STATE_ENABLED)
            else:
                def loaded():
                    value = body(application)
                    return value if newest[-1] in value else None
                initial = wait_for(loaded, "Newest bounded page not displayed", application)
                assert f"Thread {connection['threadId']}\n" in initial
                def records(value):
                    return [line for line in value.splitlines() if line.startswith(tuple(fixture["prefixes"]))]
                assert records(initial) == newest
                find("Saved thread history", application, pyatspi.STATE_FOCUSED)
                if scenario == "page-refusal":
                    print("T14 STOP OWNED SERVER", flush=True)
                    assert sys.stdin.readline().strip() == "SERVER STOPPED"
                    activate_older(application)
                    find("Could not load older history. Reopen to refresh.", application)
                    assert body(application) == initial
                    assert not find("Load older", application).getState().contains(pyatspi.STATE_ENABLED)
                    find("Saved thread history", application, pyatspi.STATE_FOCUSED)
                else:
                    previous = newest
                    for _ in range(7):
                        activate_older(application)
                        def advanced():
                            value = body(application)
                            rows = records(value)
                            return (value, rows) if len(rows) > len(previous) else None
                        value, rows = wait_for(advanced, "Older page not displayed", application)
                        assert rows == expected[-len(rows):]
                        assert rows[-len(previous):] == previous
                        assert f"Thread {connection['threadId']}\n" in value
                        find("Saved thread history", application, pyatspi.STATE_FOCUSED)
                        previous = rows
                        if len(rows) == 80:
                            break
                    assert previous == expected
                    assert not find("Load older", application).getState().contains(pyatspi.STATE_ENABLED)
            request_window_close(window)
            assert application.wait(timeout=10) == 0
        finally:
            if application.poll() is None:
                application.terminate()
                try:
                    application.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    application.kill()
                    application.wait(timeout=3)
    print("T14 GPUI history X11 AT-SPI passed", flush=True)


if __name__ == "__main__":
    main()
