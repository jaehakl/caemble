import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
from urllib.parse import urlsplit


class TransferServer:
    def __init__(self):
        self.operations, self.archives, self.parts = {}, {}, {}
        self.fail_registration = False
        self.put_count = 0
        self.rotate_tickets = False
        self.ticket_sequence = 0
        self.expire_parts, self.expired_tickets = set(), set()
        self.part_requests = []
        fixture = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_PUT(self):
                if fixture.reject_expired("PUT", self.path):
                    self.send_error(403)
                    return
                fixture.put_count += 1
                fixture.parts[urlsplit(self.path).path] = self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200)
                self.end_headers()

            def do_GET(self):
                if self.path.startswith("/objects/"):
                    if fixture.reject_expired("GET", self.path):
                        self.send_error(403)
                        return
                    raw = fixture.parts[urlsplit(self.path).path]
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                    return
                operation_id = self.path.split("/")[3]
                operation = fixture.operations[operation_id]
                value = {"operation": operation}
                if operation["kind"] == "restore":
                    for slot, archive in fixture.archives.items():
                        value[slot] = {**archive, "parts": fixture.ticket_parts(slot, archive["manifest"])}
                self.reply(value)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
                pieces = self.path.split("/")
                if "archives" in pieces:
                    slot = pieces[5]
                    if pieces[-1] == "uploads":
                        manifest = body["manifest"]
                        reference = {"kind": "caemble.object", "version": 1, "id": f"object-{slot}",
                                     **{key: manifest[key] for key in ("encoding", "sha256", "byteLength")}}
                        previous = fixture.archives.get(slot)
                        fixture.archives[slot] = {"reference": reference, "artifact": body["artifact"], "manifest": manifest}
                        self.reply({"reference": reference, "ready": previous is not None and previous.get("ready", False),
                                    "parts": fixture.ticket_parts(slot, manifest)})
                    else:
                        archive = fixture.archives[slot]
                        raw = b"".join(fixture.parts[f"/objects/{slot}/{index}"] for index in range(len(archive["manifest"]["chunks"])))
                        assert hashlib.sha256(raw).hexdigest() == archive["reference"]["sha256"]
                        archive["ready"] = True
                        self.reply({"reference": archive["reference"], "ready": True})
                elif fixture.fail_registration:
                    self.send_error(503)
                else:
                    self.reply({"id": pieces[3], "state": "completed"})

            def reply(self, value):
                raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def ticket_parts(self, slot, manifest):
        self.ticket_sequence += 1
        query = f"?ticket={self.ticket_sequence}" if self.rotate_tickets else ""
        return [{**part, "url": f"{self.url}/objects/{slot}/{index}{query}"} for index, part in enumerate(manifest["chunks"])]

    def reject_expired(self, method, url):
        path = urlsplit(url)
        index = int(path.path.rsplit("/", 1)[1])
        self.part_requests.append((method, index, path.query))
        if (method, index) in self.expire_parts:
            self.expire_parts.remove((method, index))
            self.expired_tickets.add(path.query)
        return path.query in self.expired_tickets

    def grant(self, identity):
        base = f"{self.url}/prediction/operations/{identity}"
        return {"operation_id": identity, "token": "scoped-test-token", "manifest_url": base + "/transfer",
                "prepare_url": base + "/archives/{slot}/uploads", "complete_url": base + "/archives/{slot}/complete",
                "register_url": base + "/complete"}

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
