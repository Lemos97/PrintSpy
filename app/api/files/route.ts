import { NextRequest, NextResponse } from 'next/server';
import WebSocket from 'ws';

const WEBSOCKET_PORT = 3030;
const CMD_REQUEST_ATTRIBUTES = 1;
const CMD_REQUEST_FILE_LIST = 258;

function generateRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface FileEntry {
  name: string;
  usedSize: number;
  totalSize: number;
  storageType: number; // 0: Internal, 1: External
  type: number; // 0: Folder, 1: File
}

async function getElegooFileList(ip: string, path: string): Promise<{ files: FileEntry[]; error: string | null }> {
  return new Promise((resolve) => {
    let mainboardId = 'ffffffff';
    let connectionId = '00000000';
    let hasAttributes = false;
    let resolved = false; // prevent double-resolve
    let ws: WebSocket | null = null;
    let timeout: NodeJS.Timeout;
    let attributeTimeout: NodeJS.Timeout;
    let fileListTimeout: NodeJS.Timeout;

    const done = (result: { files: FileEntry[]; error: string | null }) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      clearTimeout(attributeTimeout);
      clearTimeout(fileListTimeout);
      if (ws) {
        try { ws.removeAllListeners(); } catch { /* ignore */ }
        try { ws.close(); } catch { /* ignore */ }
        ws = null;
      }
      resolve(result);
    };

    // Overall timeout: 12 seconds
    timeout = setTimeout(() => {
      done({ files: [], error: 'Connection timed out. The printer may be offline or unreachable.' });
    }, 12000);

    let fileCmdSent = false;

    function sendFileListRequest() {
      if (!ws || ws.readyState !== WebSocket.OPEN || fileCmdSent) return;
      fileCmdSent = true;
      const requestId = generateRequestId();
      const command = {
        Id: connectionId,
        Data: {
          Cmd: CMD_REQUEST_FILE_LIST,
          Data: { Url: path },
          RequestID: requestId,
          MainboardID: mainboardId,
          TimeStamp: Math.floor(Date.now() / 1000),
          From: 0,
        },
        Topic: `sdcp/request/${mainboardId}`,
      };
      ws.send(JSON.stringify(command));

      // If no reply within 8s, surface an error
      fileListTimeout = setTimeout(() => {
        done({ files: [], error: 'No response from printer for file list command. The path may be invalid or the printer firmware may not support this command.' });
      }, 8000);
    }

    try {
      ws = new WebSocket(`ws://${ip}:${WEBSOCKET_PORT}/websocket`);

      ws.on('open', () => {
        // First request attributes to learn the real MainboardID
        const requestId = generateRequestId();
        const attrCommand = {
          Id: connectionId,
          Data: {
            Cmd: CMD_REQUEST_ATTRIBUTES,
            Data: {},
            RequestID: requestId,
            MainboardID: mainboardId,
            TimeStamp: Math.floor(Date.now() / 1000),
            From: 0,
          },
          Topic: `sdcp/request/${mainboardId}`,
        };
        ws!.send(JSON.stringify(attrCommand));

        // Fallback: if we don't get attributes within 3s, send file list anyway
        attributeTimeout = setTimeout(() => {
          if (!hasAttributes) {
            sendFileListRequest();
          }
        }, 3000);
      });

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const response = JSON.parse(data.toString());
          const topic: string = response.Topic || response.topic || '';
          const responseData = response.Data;
          if (!responseData) return;

          // Capture the real MainboardID from any message
          if (responseData.MainboardID && responseData.MainboardID !== 'ffffffff') {
            mainboardId = responseData.MainboardID;
            connectionId = responseData.MainboardID;
          }

          // Attributes response (Cmd: 1) — extract MainboardID and immediately send file list
          if (responseData.Cmd === CMD_REQUEST_ATTRIBUTES) {
            const attrs = responseData.Data?.Attributes || responseData.Data || {};
            if (attrs.MainboardID) {
              mainboardId = attrs.MainboardID;
              connectionId = attrs.MainboardID;
            }
            hasAttributes = true;
            clearTimeout(attributeTimeout);
            sendFileListRequest();
            return;
          }

          // File list response (Cmd: 258)
          if (responseData.Cmd === CMD_REQUEST_FILE_LIST) {
            const fileData = responseData.Data || {};
            if (fileData.Ack !== undefined && fileData.Ack !== 0) {
              done({ files: [], error: `Printer returned error code ${fileData.Ack} for file list request.` });
              return;
            }
            const files: FileEntry[] = (fileData.FileList || []).map((f: any) => ({
              name: f.name || '',
              usedSize: f.usedSize ?? 0,
              totalSize: f.totalSize ?? 0,
              storageType: f.storageType ?? 0,
              type: f.type ?? 0,
            }));
            done({ files, error: null });
          }

          // Status broadcast topics also contain attributes embedded
          if (topic.startsWith('sdcp/response/')) {
            // Already handled above via Cmd check
          } else if (topic.startsWith('sdcp/status/')) {
            // Unsolicited status — no action needed here
          }
        } catch {
          // Ignore parse errors for individual messages
        }
      });

      ws.on('error', (error: Error) => {
        if (error.message.includes('ECONNREFUSED')) {
          done({ files: [], error: `Connection refused (port ${WEBSOCKET_PORT}). Is the printer online?` });
        } else if (error.message.includes('ETIMEDOUT') || error.message.includes('timeout')) {
          done({ files: [], error: 'Connection timed out reaching the printer.' });
        } else {
          done({ files: [], error: `WebSocket error: ${error.message}` });
        }
      });

      ws.on('close', (code: number) => {
        if (!resolved) {
          done({ files: [], error: `Connection closed unexpectedly (code: ${code}).` });
        }
      });
    } catch (error: any) {
      done({ files: [], error: `Failed to establish connection: ${error.message}` });
    }
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { ip, path } = body;

    if (!ip) {
      return NextResponse.json({ error: 'IP address is required' }, { status: 400 });
    }

    const browsePath = path || '/local/';
    const result = await getElegooFileList(ip, browsePath);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json(
      { files: [], error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
