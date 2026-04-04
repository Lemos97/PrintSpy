import { NextRequest, NextResponse } from 'next/server';

const HTTP_PORT = 3030;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const ip = searchParams.get('ip');
  const filePath = searchParams.get('path');

  if (!ip || !filePath) {
    return NextResponse.json(
      { error: 'Both ip and path parameters are required' },
      { status: 400 }
    );
  }

  try {
    // Ensure clean path and remove double slashes (e.g., /local//file -> /local/file)
    const cleanPath = filePath.replace(/\/+/g, '/').replace(/^\/?/, '/');
    const fileUrl = `http://${ip}:${HTTP_PORT}${cleanPath}`;

    console.log(`[File Download] Downloading file: ${fileUrl}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

    const response = await fetch(fileUrl, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    if (!response.ok) {
      return NextResponse.json(
        { error: `Printer returned HTTP ${response.status}` },
        { status: response.status }
      );
    }

    // Extract filename from path
    const pathParts = filePath.split('/');
    const filename = pathParts[pathParts.length - 1] || 'download';

    // Stream the response body to the client
    const headers = new Headers();
    headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);

    const contentType = response.headers.get('content-type');
    headers.set('Content-Type', contentType || 'application/octet-stream');

    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      headers.set('Content-Length', contentLength);
    }

    return new NextResponse(response.body as any, {
      status: 200,
      headers,
    });
  } catch (error: any) {
    if (error.name === 'AbortError') {
      return NextResponse.json(
        { error: 'Download timeout — the printer took too long to respond' },
        { status: 504 }
      );
    }
    return NextResponse.json(
      { error: error.message || 'Failed to download file' },
      { status: 500 }
    );
  }
}
