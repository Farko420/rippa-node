/**
 * POSTs a bundle to a running node's /api/brain/upload-backup, byte-for-byte.
 * Used because PowerShell re-encodes UTF-8 on read and corrupts smart quotes.
 *
 * Not part of the shipped app.
 */
import fs from "node:fs";
import http from "node:http";

const [, , file, port, pin] = process.argv;

function call(method: string, path: string, body: Buffer | null, token?: string) {
  return new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
    const req = http.request(
      {
        method,
        hostname: "127.0.0.1",
        port: Number(port),
        path,
        headers: Object.assign(
          body ? { "Content-Type": "application/json", "Content-Length": body.length } : {},
          token ? { Authorization: `Bearer ${token}` } : {},
        ),
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode || 0, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode || 0, data: { raw: data } });
          }
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

void (async () => {
  const auth = await call("POST", "/api/system/auth", Buffer.from(JSON.stringify({ pin })));
  const token = String(auth.data["token"] ?? "");

  const raw = fs.readFileSync(file);
  const uploaded = await call("POST", "/api/brain/upload-backup", raw, token);
  console.log("=== POST /api/brain/upload-backup ->", uploaded.status, "===");
  console.log(JSON.stringify(uploaded.data, null, 2));

  const status = await call("GET", "/api/brain/status", null, token);
  console.log("=== GET /api/brain/status ===");
  console.log(JSON.stringify(status.data, null, 2));
})();