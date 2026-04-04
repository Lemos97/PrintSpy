import { NextRequest } from 'next/server';

/**
 * Stream Proxy API Route
 * 
 * This route proxies HTTP streams (like OctoPrint MJPEG) to avoid CORS issues.
 * By routing streams through our server, we can:
 * 1. Add proper CORS headers
 * 2. Allow canvas capture of frames for pause functionality
 */

export const dynamic = 'force-dynamic'; // Disable caching for streaming

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const streamUrl = searchParams.get('url');

  if (!streamUrl) {
    // console.log('[Stream Proxy] Missing url parameter');
    return new Response('Missing url parameter', { status: 400 });
  }

  // Decode the URL
  let decodedUrl = streamUrl;
  try {
    decodedUrl = decodeURIComponent(streamUrl);
  } catch {
    decodedUrl = streamUrl;
  }

  // console.log(`[Stream Proxy] Proxying stream: ${decodedUrl}`);

  // Validate it's an HTTP URL
  if (!decodedUrl.startsWith('http://') && !decodedUrl.startsWith('https://')) {
    // console.log(`[Stream Proxy] Invalid URL format: ${decodedUrl}`);
    return new Response('Invalid URL format - must be http:// or https://', { status: 400 });
  }

  try {
    // Fetch the stream from the original source
    const response = await fetch(decodedUrl, {
      headers: {
        'Accept': '*/*',
      },
    });

    if (!response.ok) {
      // console.log(`[Stream Proxy] Upstream error: ${response.status} ${response.statusText}`);
      return new Response(`Upstream error: ${response.status}`, { status: response.status });
    }

    if (!response.body) {
      // console.log('[Stream Proxy] No response body');
      return new Response('No response body from upstream', { status: 502 });
    }

    // Get content type from upstream
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    // console.log(`[Stream Proxy] Content-Type: ${contentType}`);

    // Create response headers with CORS
    const headers = new Headers({
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });

    // Pipe the response body through
    return new Response(response.body, {
      status: 200,
      headers,
    });
  } catch (error) {
    // console.error('[Stream Proxy] Error:', error);
    return new Response(`Stream proxy error: ${error}`, { status: 500 });
  }
}

// Handle CORS preflight
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    },
  });
}

