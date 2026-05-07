// native.ts - runs in electron main process
// handles the http server for cs2 gsi + external api calls
// has to be here because the renderer has CSP issues with node modules and external requests
//
// k1ng_op

import { IpcMainInvokeEvent } from "electron";
import http from "http";
import https from "https";

// gsi http server
let server: http.Server | null = null;
let lastPayload: string | null = null;
let lastPayloadTime = 0;

export function startServer(_e: IpcMainInvokeEvent, port: number): string {
    if (server) return "already_running";

    try {
        server = http.createServer((req, res) => {
            if (req.method !== "POST") {
                res.writeHead(405);
                res.end();
                return;
            }

            let body = "";
            req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
            req.on("end", () => {
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end("OK");
                lastPayload = body;
                lastPayloadTime = Date.now();
            });
        });

        server.listen(port, "127.0.0.1");
        server.on("error", (e: NodeJS.ErrnoException) => {
            if (e.code === "EADDRINUSE") {
                console.error(`[CS2RPC] port ${port} is already in use, change it in plugin settings`);
            } else {
                console.error("[CS2RPC] server error:", e.message);
            }
        });

        console.log(`[CS2RPC] listening on 127.0.0.1:${port}`);
        return "ok";
    } catch (e) {
        console.error("[CS2RPC] failed to start server:", e);
        return "error";
    }
}

export function stopServer(_e: IpcMainInvokeEvent): string {
    if (!server) return "not_running";
    server.close();
    server = null;
    lastPayload = null;
    console.log("[CS2RPC] server stopped");
    return "ok";
}

export function getLastPayload(_e: IpcMainInvokeEvent): { payload: string | null; time: number } {
    return { payload: lastPayload, time: lastPayloadTime };
}

// generic https get helper
function get(url: string, headers?: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        https.get(
            {
                hostname: u.hostname,
                path: u.pathname + u.search,
                headers: headers ?? {},
            },
            res => {
                let data = "";
                res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
                res.on("end", () => resolve(data));
            }
        ).on("error", reject);
    });
}

// steam web api proxy
export async function steamRequest(
    _e: IpcMainInvokeEvent,
    path: string,
    params: Record<string, string>
): Promise<string | null> {
    try {
        const url = `https://api.steampowered.com${path}?${new URLSearchParams(params)}`;
        return await get(url);
    } catch (e) {
        console.error("[CS2RPC] steam api request failed:", e);
        return null;
    }
}

// faceit data api proxy
export async function faceitRequest(
    _e: IpcMainInvokeEvent,
    path: string,
    apiKey: string
): Promise<string | null> {
    try {
        return await get(
            `https://open.faceit.com/data/v4${path}`,
            { "Authorization": `Bearer ${apiKey}` }
        );
    } catch (e) {
        console.error("[CS2RPC] faceit api request failed:", e);
        return null;
    }
}
