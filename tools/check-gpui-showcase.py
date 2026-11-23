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


def check_thread_compose(executable, approval=False, follow_up=False):
    connection = json.load(sys.stdin)
    prompt = "GPUI sends a follow-up in the same thread." if follow_up else "GPUI sends one recorded prompt."
    failure = "Could not confirm submission. Draft kept. Check the thread before retrying."
    unsent = "Keep this unsent draft."
    streamed_id = None

    def projection():
        path = urllib.parse.quote(connection["threadId"], safe="")
        request = urllib.request.Request(
            f"http://127.0.0.1:{connection['port']}/api/orchestration/threads/{path}/bounded",
            headers={"Authorization": f"Bearer {connection['token']}", "x-t3-orchestration-protocol": "2"},
        )
        with urllib.request.urlopen(request, timeout=5) as reply:
            return json.load(reply)["projection"]

    previous = projection() if follow_up else None
    if previous is not None:
        assert len(previous["runs"]) == 1 and previous["runs"][0]["status"] == "completed"
        assert len([message for message in previous["messages"] if message["role"] == "user"]) == 1
    cases = [(connection, True)] if approval or follow_up else [
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
            approval_id = None
            if approval:
                find("Command permission requested.", application, timeout=45)
                button = find("Allow once", application)
                assert button.getRole() == pyatspi.ROLE_PUSH_BUTTON
                pending = projection()
                assert len(pending["runs"]) == 1
                assert pending["runs"][0]["status"] in ("running", "waiting")
                request, = pending["runtimeRequests"]
                assert request["status"] == "pending" and request["kind"] == "command"
                approval_id = request["id"]
                item, = [
                    item for item in pending["turnItems"]
                    if item["type"] == "approval_request" and item["requestId"] == approval_id
                ]
                assert item["runId"] == pending["runs"][0]["id"]
                assert "probe" in item["prompt"]
                find(item["prompt"], application)
                field = composer.queryText()
                assert field.getText(0, field.characterCount) == prompt
                for _ in range(6):
                    if button.getState().contains(pyatspi.STATE_FOCUSED):
                        break
                    x11("key", "Tab")
                    try:
                        button = find("Allow once", application, pyatspi.STATE_FOCUSED, timeout=1)
                    except AssertionError:
                        continue
                assert button.getState().contains(pyatspi.STATE_FOCUSED), "Allow once must accept keyboard focus"
                x11("key", "space")
            streaming = success and not approval and not follow_up
            if streaming:
                document = find("Server thread snapshot", application)
                def partial_reply():
                    field = document.queryText()
                    body = field.getText(0, field.characterCount)
                    if "I'll track" in body and "todo list fixture complete" not in body:
                        return body
                    return None
                partial = wait_for(partial_reply, "Original ACP partial text was never visible before final text", application)
                pending = projection()
                user, = [row for row in pending["messages"] if row["id"] == connection["messageId"]]
                run, = [row for row in pending["runs"] if row["id"] == user["runId"]]
                assert run["status"] in ("running", "waiting"), "Partial text must precede completed turn"
                assistant, = [row for row in pending["messages"] if row["role"] == "assistant" and row["runId"] == run["id"]]
                streamed_id = assistant["id"]
                assert f"Message {streamed_id}\n" in partial
                assert not document.getState().contains(pyatspi.STATE_EDITABLE)
                # Completion may clear only the captured prompt, never a later draft.
                x11("key", "ctrl+a")
                x11("type", "--clearmodifiers", unsent)
            if success:
                try:
                    find("Server submission confirmed.", application, timeout=60)
                except AssertionError:
                    if approval:
                        observed = projection()
                        runtime_request = next((item for item in observed["runtimeRequests"]
                                                if item["id"] == approval_id), {})
                        unconfirmed = "Could not confirm approval and turn completion. Draft kept. Check the server thread."
                        try:
                            find(unconfirmed, application, timeout=1)
                            unconfirmed_visible = True
                        except AssertionError:
                            unconfirmed_visible = False
                        print(json.dumps({
                            "approvalStillPending": runtime_request.get("status") == "pending",
                            "approvalResolved": runtime_request.get("status") == "resolved",
                            "decisionAccepted": runtime_request.get("decision") == "accept",
                            "runCompleted": any(run["status"] == "completed" for run in observed["runs"]),
                            "unconfirmedVisible": unconfirmed_visible,
                        }), flush=True)
                    raise
                document = find("Server thread snapshot", application)
                text = document.queryText()
                body = text.getText(0, text.characterCount)
                expected_reply = "Created the requested probe file." if approval else "todo list fixture complete"
                assert prompt in body and expected_reply in body
                assert connection["threadId"] in body
                assert not document.getState().contains(pyatspi.STATE_EDITABLE)
                field = composer.queryText()
                assert field.getText(0, field.characterCount) == (unsent if streaming else "")
                if streaming:
                    assert f"Message {streamed_id}\n" in body
            else:
                find(failure, application, timeout=60)
                field = composer.queryText()
                assert field.getText(0, field.characterCount) == prompt
            # A second submit does not allocate a new command or message identity.
            x11("key", "ctrl+Return")
            observed = projection()
            assert observed["thread"]["id"] == connection["threadId"]
            assert observed["thread"]["projectId"] == connection["projectId"]
            assert len(observed["runs"]) == (int(success) + int(follow_up))
            users = [message for message in observed["messages"] if message["role"] == "user"]
            assert len(users) == (int(success) + int(follow_up))
            if success:
                message, = [user for user in users if user["id"] == connection["messageId"]]
                assert message["text"] == prompt
                run, = [run for run in observed["runs"] if run["id"] == message["runId"]]
                assert run["status"] == "completed"
            if previous is not None:
                assert previous["runs"][0] in observed["runs"]
                assert all(message in observed["messages"] for message in previous["messages"])
            if approval:
                request, = observed["runtimeRequests"]
                assert request["id"] == approval_id and request["status"] == "resolved"
                assert request["decision"] == "accept" and observed["runs"][0]["status"] == "completed"
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
    if streamed_id is not None:
        application = subprocess.Popen([executable, "--thread-snapshot"], stdin=subprocess.PIPE, text=True)
        try:
            application.stdin.write(json.dumps({key: connection[key] for key in ("port", "token", "environmentId", "threadId")}))
            application.stdin.close()
            window = wait_for(find_window, "Reopened GPUI snapshot did not open", application)
            document = find("Server thread snapshot", application)
            field = document.queryText()
            body = field.getText(0, field.characterCount)
            assert f"Message {streamed_id}\n" in body and "todo list fixture complete" in body
            assert len(projection()["runs"]) == 1
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
        print("GPUI stream passed original partial text before completion, same reply identity on final/reopen and unsent draft checks")
    if approval:
        print("GPUI approval passed named AT-SPI button, X11 decision and same-request completion checks")
    elif follow_up:
        print("GPUI follow-up passed keyboard submission and preserved the earlier completed turn")
    else:
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
    if sys.argv[2:] == ["--thread-compose-approval"]:
        check_thread_compose(executable, approval=True)
        return
    if sys.argv[2:] == ["--thread-compose-follow-up"]:
        check_thread_compose(executable, follow_up=True)
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
