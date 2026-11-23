import * as Assert from "node:assert/strict";
import * as FS from "node:fs";
import * as Http from "node:http";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "version") {
  console.log("cloudflared version 2026.10.4");
} else {
  Assert.equal(args[0], "tunnel");
  Assert.equal(args.at(-1), "run");
  Assert.equal(args[args.indexOf("--metrics") + 1], "127.0.0.1:0");
  Assert.equal(process.env.TUNNEL_TOKEN, "fixture-guest-connector");
  const hostnameFile = new URL("./connector-hostname", import.meta.url);
  const server = Http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/ready") {
      response.end(JSON.stringify({ readyConnections: 1 }));
    } else if (request.method === "GET" && request.url === "/config") {
      const hostname = FS.readFileSync(hostnameFile, "utf8");
      response.end(JSON.stringify({ config: { ingress: [{ hostname }] } }));
    } else {
      response.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    Assert.ok(address && typeof address !== "string");
    console.log(`Starting metrics server on 127.0.0.1:${address.port}/metrics`);
    console.log("Registered tunnel connection protocol=http2");
  });
}
