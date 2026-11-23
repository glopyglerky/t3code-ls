"""Exercise the Linux desktop showcase through X11 input and its AT-SPI tree."""

import os
import json
import subprocess
import sys
import signal
import time
import urllib.request
import urllib.parse

import pyatspi
from Xlib import X, display, protocol
from gi.repository import GLib


def wait_for(condition, message, application, timeout=20):
    deadline = time.monotonic() + timeout
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


def find(name, application, state=None, timeout=20):
    def matching_node():
        for node in accessible_nodes(pyatspi.Registry.getDesktop(0)):
            try:
                if node.name == name and (state is None or node.getState().contains(state)):
                    return node
            except (GLib.Error, RuntimeError, AttributeError):
                pass
        return None

    return wait_for(matching_node, f"No matching accessible node for {name}", application, timeout)


def x11(*args):
    return subprocess.run(["xdotool", *args], check=True, text=True, capture_output=True).stdout


def find_window():
    try:
        return x11("search", "--onlyvisible", "--name", "T3 Code").splitlines()[0]
    except (subprocess.CalledProcessError, IndexError):
        return None


def request_window_close(window):
    server = display.Display()
    try:
        target = server.create_resource_object("window", int(window))
        delete = server.intern_atom("WM_DELETE_WINDOW")
        assert delete in target.get_wm_protocols()
        target.send_event(protocol.event.ClientMessage(
            window=target,
            client_type=server.intern_atom("WM_PROTOCOLS"),
            data=(32, [delete, X.CurrentTime, 0, 0, 0]),
        ))
        server.sync()
    finally:
        server.close()


def check_thread_snapshot(executable):
    connection = json.load(sys.stdin)
    cases = [
        ({**connection, "environmentId": "wrong-environment"}, False),
        ({**connection, "token": "invalid.fixture.token"}, False),
        ({**connection, "threadId": "missing-fixture-thread"}, False),
        (connection, True),
    ]
    for request, success in cases:
        application = subprocess.Popen(
            [executable, "--thread-snapshot"], stdin=subprocess.PIPE, text=True,
        )
        try:
            application.stdin.write(json.dumps(request))
            application.stdin.close()
            window = wait_for(find_window, "The GPUI server view did not open", application)
            x11("windowfocus", "--sync", window)
            if success:
                document = find("Server thread snapshot", application)
                text = document.queryText()
                body = text.getText(0, text.characterCount)
                assert "GPUI saved conversation prompt" in body
                assert "GPUI server reply café 🦀" in body
                assert connection["threadId"] in body
                assert not document.getState().contains(pyatspi.STATE_EDITABLE)
            else:
                find("Could not read the selected server thread.", application)
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
    print("GPUI authenticated snapshot passed AT-SPI content and identity, credential and missing-thread refusal checks")


def check_thread_compose(executable):
    connection = json.load(sys.stdin)
    prompt = "GPUI sends one recorded prompt."
    failure = "Could not confirm submission. Draft kept. Check the thread before retrying."

    def projection():
        path = urllib.parse.quote(connection["threadId"], safe="")
        request = urllib.request.Request(
            f"http://127.0.0.1:{connection['port']}/api/orchestration/threads/{path}/bounded",
            headers={"Authorization": f"Bearer {connection['token']}", "x-t3-orchestration-protocol": "2"},
        )
        with urllib.request.urlopen(request, timeout=5) as reply:
            return json.load(reply)["projection"]

    cases = [
        ({**connection, "environmentId": "wrong-environment"}, False),
        ({**connection, "token": "invalid.fixture.token"}, False),
        ({**connection, "projectId": "wrong-project"}, False),
        ({**connection, "threadId": "missing-fixture-thread"}, False),
        (connection, True),
    ]
    for request, success in cases:
        application = subprocess.Popen([executable, "--thread-compose"], stdin=subprocess.PIPE, text=True)
        try:
            application.stdin.write(json.dumps(request))
            application.stdin.close()
            window = wait_for(find_window, "The GPUI composer did not open", application)
            x11("windowfocus", "--sync", window)
            composer = find("Message", application, pyatspi.STATE_FOCUSED)
            x11("type", "--clearmodifiers", prompt)
            x11("key", "ctrl+Return")
            if success:
                find("Server submission confirmed.", application, timeout=60)
                document = find("Server thread snapshot", application)
                text = document.queryText()
                body = text.getText(0, text.characterCount)
                assert prompt in body and "todo list fixture complete" in body
                assert connection["threadId"] in body
                assert not document.getState().contains(pyatspi.STATE_EDITABLE)
                field = composer.queryText()
                assert field.getText(0, field.characterCount) == ""
            else:
                find(failure, application, timeout=60)
                field = composer.queryText()
                assert field.getText(0, field.characterCount) == prompt
            # A second submit does not allocate a new command or message identity.
            x11("key", "ctrl+Return")
            observed = projection()
            assert observed["thread"]["id"] == connection["threadId"]
            assert observed["thread"]["projectId"] == connection["projectId"]
            assert len(observed["runs"]) == (1 if success else 0)
            users = [message for message in observed["messages"] if message["role"] == "user"]
            assert len(users) == (1 if success else 0)
            if success:
                assert users[0]["id"] == connection["messageId"]
                assert users[0]["text"] == prompt
                assert users[0]["runId"] == observed["runs"][0]["id"]
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
    print("GPUI composer passed X11 input, AT-SPI acceptance/refusal and exactly-one projected run checks")


def main():
    def terminate(_signal, _frame):
        raise SystemExit(1)
    signal.signal(signal.SIGTERM, terminate)
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
    if sys.argv[2:] == ["--thread-compose"]:
        check_thread_compose(executable)
        return
    if sys.argv[2:] == ["--thread-snapshot"]:
        check_thread_snapshot(executable)
        return
    assert len(sys.argv) == 2
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
        request_window_close(window)
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
