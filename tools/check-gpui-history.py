"""Real X11 control and AT-SPI text check; server lifecycle stays with its parent."""
import json
import os
from pathlib import Path
import runpy
import signal
import subprocess
import sys
import traceback

import pyatspi

# Reuse the existing X11/AT-SPI adapter without changing its fixture entry.
helpers = runpy.run_path(str(Path(__file__).with_name("check-gpui-showcase.py")))
find = helpers["find"]
accessible_nodes = helpers["accessible_nodes"]
find_window = helpers["find_window"]
request_window_close = helpers["request_window_close"]
wait_for = helpers["wait_for"]
x11 = helpers["x11"]


def body(application):
    document = find("Saved thread history", application)
    assert not document.getState().contains(pyatspi.STATE_EDITABLE)
    text = document.queryText()
    return text.getText(0, text.characterCount)


def history_records(value, fixture):
    thread_id = fixture["connection"]["threadId"]
    header = f"\nThread {thread_id}\nSnapshot {fixture['snapshotSequence']}\n"
    assert value.count(header) == 1
    _, rows = value.split(header)
    lines = rows.splitlines()
    assert len(lines) % 3 == 0
    prefixes = dict(zip(("user", "assistant"), fixture["prefixes"], strict=True))
    result = []
    for index in range(0, len(lines), 3):
        separator, role, text = lines[index:index + 3]
        assert separator == "" and role in prefixes and text.startswith(prefixes[role])
        result.append(text)
    return result


def assert_no_load_action():
    nodes = accessible_nodes(pyatspi.Registry.getDesktop(0))
    assert all(node.name != "Load older" for node in nodes)

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
                assert_no_load_action()
            else:
                def loaded():
                    value = body(application)
                    return value if newest[-1] in value else None
                initial = wait_for(loaded, "Newest bounded page not displayed", application)
                assert history_records(initial, fixture) == newest
                find("Saved thread history", application, pyatspi.STATE_FOCUSED)
                if scenario == "page-refusal":
                    print("T14 STOP OWNED SERVER", flush=True)
                    assert sys.stdin.readline().strip() == "SERVER STOPPED"
                    activate_older(application)
                    find("Could not load older history. Reopen to refresh.", application)
                    assert body(application) == initial
                    assert_no_load_action()
                    find("Saved thread history", application, pyatspi.STATE_FOCUSED)
                else:
                    previous = newest
                    for _ in range(7):
                        activate_older(application)
                        def advanced():
                            value = body(application)
                            rows = history_records(value, fixture)
                            return (value, rows) if len(rows) > len(previous) else None
                        value, rows = wait_for(advanced, "Older page not displayed", application)
                        assert rows == expected[-len(rows):]
                        assert rows[-len(previous):] == previous
                        find("Saved thread history", application, pyatspi.STATE_FOCUSED)
                        previous = rows
                        if len(rows) == 80:
                            break
                    assert previous == expected
                    find("80 saved records loaded. All saved history loaded.", application)
                    assert_no_load_action()
            request_window_close(window)
            assert application.wait(timeout=10) == 0
        except Exception as error:
            frames = traceback.extract_tb(error.__traceback__)
            line = next(frame.lineno for frame in reversed(frames) if frame.filename == __file__)
            print(f"T14 history check: {scenario} line {line}", file=sys.stderr, flush=True)
            raise
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
