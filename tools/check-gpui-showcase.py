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


def check_thread_workspace_race(executable):
    # Hold A until B is painted. Release the old request while B remains selected.
    import http.server
    import threading
    release = threading.Event()
    started = threading.Event()
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_GET(self):
            if self.path == "/.well-known/t3/environment":
                value = {"environmentId": "race-env"}
            else:
                assert self.headers.get("Authorization") == "Bearer fixture.token"
                assert self.headers.get("x-t3-orchestration-protocol") == "2"
                if self.path == "/api/orchestration/shell?omitOlderSettled=1":
                    value = {"schemaVersion": 2, "snapshotSequence": 1, "threads": [
                        {"id": "a", "title": "First"}, {"id": "b", "title": "Second"}]}
                else:
                    assert self.path in ["/api/orchestration/threads/a/bounded", "/api/orchestration/threads/b/bounded"]
                    thread = self.path.split("/")[-2]
                    if thread == "a":
                        started.set()
                        assert release.wait(4), "B was not selected before the bounded A deadline"
                    value = {"snapshotSequence": 2, "projection": {
                        "thread": {"id": thread, "title": thread}, "messages": []}}
            body = json.dumps(value).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever)
    worker.start()
    application = subprocess.Popen([executable, "--thread-workspace"], stdin=subprocess.PIPE, text=True)
    def click(node):
        bounds = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
        x11("mousemove", str(bounds.x + bounds.width // 2), str(bounds.y + bounds.height // 2))
        x11("click", "1")
    def text():
        node = find("Server thread snapshot", application)
        field = node.queryText()
        return field.getText(0, field.characterCount)
    try:
        application.stdin.write(json.dumps({"port": server.server_port, "token": "fixture.token",
            "environmentId": "race-env", "threadId": "a"}))
        application.stdin.close()
        window = wait_for(find_window, "Race workspace did not open", application)
        x11("windowfocus", "--sync", window)
        assert started.wait(2)
        click(find("Open thread b", application))
        wait_for(lambda: True if "Thread b\n" in text() else None, "B never painted", application)
        release.set()
        # Let A's receiver consume its response, then verify the selected document is still B.
        time.sleep(0.3)
        assert "Thread b\n" in text()
        click(find("Open thread a", application))
        wait_for(lambda: True if "Thread a\n" in text() else None, "A reply was lost", application)
        request_window_close(window)
        assert application.wait(timeout=10) == 0
    finally:
        release.set()
        if application.poll() is None:
            application.terminate()
            try:
                application.wait(timeout=3)
            except subprocess.TimeoutExpired:
                application.kill()
                application.wait(timeout=3)
        server.shutdown()
        server.server_close()
        worker.join(timeout=3)
    print("GPUI late A reply stayed with A while B remained selected")


def check_thread_workspace(executable):
    connection = json.load(sys.stdin)
    second = connection.pop("secondThreadId")
    application = subprocess.Popen([executable, "--thread-workspace"], stdin=subprocess.PIPE, text=True)
    def body(node):
        field = node.queryText()
        return field.getText(0, field.characterCount)
    def observation(node):
        # Never emit raw accessible names, document text, URLs or credentials.
        states = node.getState()
        bounds = node.queryComponent().getExtents(pyatspi.WINDOW_COORDS)
        own_process = node.getApplication().get_process_id() == application.pid
        showing = states.contains(pyatspi.STATE_SHOWING)
        visible = states.contains(pyatspi.STATE_VISIBLE)
        return {"ownProcess": own_process, "showing": showing, "visible": visible,
                "focused": states.contains(pyatspi.STATE_FOCUSED),
                "bounds": [bounds.x, bounds.y, bounds.width, bounds.height]}
    def diagnostic(thread, phase, click=None):
        rows = []
        names = {"Open thread " + thread: "targetButton",
                 "Selected thread " + connection["threadId"]: "selectedA",
                 "Selected thread " + second: "selectedB",
                 "Server thread snapshot": "snapshot",
                 "Could not read the selected server thread.": "readFailure"}
        for node in accessible_nodes(pyatspi.Registry.getDesktop(0)):
            try:
                kind = names.get(node.name)
                if kind is None:
                    continue
                row = {"kind": kind, **observation(node)}
                if kind == "snapshot":
                    text = body(node)
                    row.update(threadA="Thread " + connection["threadId"] + "\n" in text,
                               threadB="Thread " + second + "\n" in text,
                               exactPrompt="GPUI saved conversation prompt" in text,
                               exactReply="GPUI server reply café 🦀" in text)
                rows.append(row)
            except (GLib.Error, RuntimeError, AttributeError, NotImplementedError):
                rows.append({"kind": "unavailable"})
        print(json.dumps({"navigationPhase": phase, "target": "A" if thread == connection["threadId"] else "B",
                          "click": click, "nodes": rows[:16]}), flush=True)
    def current(name):
        def matching():
            for node in accessible_nodes(pyatspi.Registry.getDesktop(0)):
                try:
                    if node.name == name:
                        seen = observation(node)
                        if seen["ownProcess"] and seen["showing"] and seen["visible"]:
                            return node
                except (GLib.Error, RuntimeError, AttributeError, NotImplementedError):
                    pass
            return None
        return wait_for(matching, "No current visible node for " + name, application)
    def click(node):
        observed = observation(node)
        bounds = observed["bounds"]
        assert observed["ownProcess"] and observed["showing"] and observed["visible"], "Click target is not current and visible"
        assert bounds[2] > 0 and bounds[3] > 0, "Click target has empty bounds"
        x, y = bounds[0] + bounds[2] // 2, bounds[1] + bounds[3] // 2
        geometry = dict(
            line.split("=", 1)
            for line in x11("getwindowgeometry", "--shell", window).splitlines()
            if line.startswith(("WIDTH=", "HEIGHT="))
        )
        width, height = int(geometry["WIDTH"]), int(geometry["HEIGHT"])
        assert 0 <= x < width and 0 <= y < height, "Click target is outside the X11 client window"
        # Resolve accessibility bounds in the centered window through X11.
        x11("mousemove", "--window", window, str(x), str(y))
        x11("click", "1")
        return {**observed, "windowPoint": [x, y], "windowSize": [width, height]}
    def select(thread):
        try:
            clicked = click(current("Open thread " + thread))
            diagnostic(thread, "pointer-dispatched", clicked)
            current("Selected thread " + thread)
            diagnostic(thread, "selection-accepted")
        except AssertionError:
            diagnostic(thread, "selection-unconfirmed")
            raise
    def snapshot(thread):
        def matches():
            for document in accessible_nodes(pyatspi.Registry.getDesktop(0)):
                try:
                    if document.name != "Server thread snapshot":
                        continue
                    seen = observation(document)
                    if (seen["ownProcess"] and seen["showing"] and seen["visible"]
                            and "Thread " + thread + "\n" in body(document)):
                        return document
                except (GLib.Error, RuntimeError, AttributeError, NotImplementedError):
                    pass
            return None
        try:
            return wait_for(matches, "Wrong selected thread content", application)
        except AssertionError:
            diagnostic(thread, "snapshot-unconfirmed")
            raise
    try:
        application.stdin.write(json.dumps(connection))
        application.stdin.close()
        window = wait_for(find_window, "Thread workspace did not open", application)
        x11("windowfocus", "--sync", window)
        snapshot(connection["threadId"])
        find("Message", application, pyatspi.STATE_FOCUSED)
        x11("type", "--clearmodifiers", "first draft")
        x11("key", "shift+Left", "shift+Left", "shift+Left")
        select(second)
        snapshot(second)
        composer = find("Message", application, pyatspi.STATE_FOCUSED)
        assert body(composer) == ""
        x11("type", "--clearmodifiers", "second draft")
        select(connection["threadId"])
        snapshot(connection["threadId"])
        composer = find("Message", application, pyatspi.STATE_FOCUSED)
        assert body(composer) == "first draft"
        field = composer.queryText()
        assert field.getSelection(0) == (8, 11)
        # Extending from the retained left endpoint proves direction, beyond sorted bounds.
        x11("key", "shift+Left")
        assert composer.queryText().getSelection(0) == (7, 11)
        reply = snapshot(connection["threadId"])
        click(reply)
        find("Server thread snapshot", application, pyatspi.STATE_FOCUSED)
        select(second)
        composer = find("Message", application, pyatspi.STATE_FOCUSED)
        assert body(composer) == "second draft"
        select(connection["threadId"])
        find("Server thread snapshot", application, pyatspi.STATE_FOCUSED)
        assert len(x11("search", "--onlyvisible", "--name", "T3 Code").splitlines()) == 1
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
    print("GPUI two-thread navigation retained independent drafts, directed selection and editor focus")


def check_thread_compose(executable, approval=False, follow_up=False, stop=False):
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
    cases = [(connection, True)] if approval or follow_up or stop else [
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
            if stop:
                button = find("Stop", application)
                assert button.getRole() == pyatspi.ROLE_PUSH_BUTTON
                for _ in range(8):
                    if button.getState().contains(pyatspi.STATE_FOCUSED):
                        break
                    x11("key", "Tab")
                    try:
                        button = find("Stop", application, pyatspi.STATE_FOCUSED, timeout=1)
                    except AssertionError:
                        continue
                assert button.getState().contains(pyatspi.STATE_FOCUSED), "Stop must accept keyboard focus"
                x11("key", "space")
                find("Server run interrupted. Draft kept.", application, timeout=60)
                # Repeated submission stays fenced, and Stop is no longer actionable.
                x11("key", "ctrl+Return")
                field = composer.queryText()
                assert field.getText(0, field.characterCount) == unsent
                observed = projection()
                assert len(observed["runs"]) == 1 and observed["runs"][0]["status"] == "interrupted"
                reply, = [row for row in observed["messages"] if row["id"] == streamed_id]
                assert reply["role"] == "assistant" and reply["runId"] == run["id"]
                stop_requests = [item for item in observed["turnItems"] if item["type"] == "run_interrupt_request"]
                assert len(stop_requests) == 1 and stop_requests[0]["runId"] == run["id"]
                results = [item for item in observed["turnItems"] if item["type"] == "run_interrupt_result"]
                assert len(results) == 1 and results[0]["runId"] == run["id"]
                field = document.queryText()
                assert f"Message {streamed_id}\n" in field.getText(0, field.characterCount)
            elif success:
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
                assert run["status"] == ("interrupted" if stop else "completed")
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
            assert f"Message {streamed_id}\n" in body
            if stop:
                assert projection()["runs"][0]["status"] == "interrupted"
                reply, = [row for row in projection()["messages"] if row["id"] == streamed_id]
                assert reply["text"] in body
                assert len([item for item in projection()["turnItems"] if item["type"] == "run_interrupt_request"]) == 1
            else:
                assert "todo list fixture complete" in body
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
        print("GPUI Stop passed partial/active run, keyboard Stop, interrupted reopen and unsent draft checks" if stop else
              "GPUI stream passed original partial text before completion, same reply identity on final/reopen and unsent draft checks")
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
    if sys.argv[2:] == ["--thread-compose-stop"]:
        check_thread_compose(executable, stop=True)
        return
    if sys.argv[2:] == ["--thread-compose-approval"]:
        check_thread_compose(executable, approval=True)
        return
    if sys.argv[2:] == ["--thread-compose-follow-up"]:
        check_thread_compose(executable, follow_up=True)
        return
    if sys.argv[2:] == ["--thread-workspace-race"]:
        check_thread_workspace_race(executable)
        return
    if sys.argv[2:] == ["--thread-workspace"]:
        check_thread_workspace(executable)
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
